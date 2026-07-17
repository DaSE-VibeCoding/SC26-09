use crate::agents::resolve_agent_executable;
use crate::process::run_command;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CODEX_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);
const CLAUDE_COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_PROTOCOL_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSION_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DISCOVERED_SESSIONS: usize = 500;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredAgentSession {
    agent_id: &'static str,
    external_session_id: String,
    workspace_path: String,
    title: String,
    created_at_ms: u64,
    updated_at_ms: u64,
    status: &'static str,
    running: bool,
    resume_handle: Option<String>,
    attach_handle: Option<String>,
    origin: &'static str,
}

#[tauri::command]
pub async fn discover_agent_sessions(workspace_paths: Vec<String>) -> Vec<DiscoveredAgentSession> {
    tauri::async_runtime::spawn_blocking(move || discover_sessions_blocking(&workspace_paths))
        .await
        .unwrap_or_default()
}

fn discover_sessions_blocking(workspace_paths: &[String]) -> Vec<DiscoveredAgentSession> {
    if workspace_paths.is_empty() {
        return Vec::new();
    }

    let mut sessions = HashMap::<(&'static str, String), DiscoveredAgentSession>::new();

    for session in discover_codex_sessions(workspace_paths).unwrap_or_default() {
        insert_preferred(&mut sessions, session);
    }

    for workspace in workspace_paths {
        for session in discover_claude_history(workspace) {
            insert_preferred(&mut sessions, session);
        }
        for session in discover_pi_sessions(workspace) {
            insert_preferred(&mut sessions, session);
        }
        for session in discover_live_claude_sessions(workspace).unwrap_or_default() {
            // Live inventory is more authoritative than a matching transcript.
            sessions.insert(
                (session.agent_id, session.external_session_id.clone()),
                session,
            );
        }
    }

    let mut sessions = sessions.into_values().collect::<Vec<_>>();
    sessions.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then_with(|| left.agent_id.cmp(right.agent_id))
            .then_with(|| left.external_session_id.cmp(&right.external_session_id))
    });
    sessions.truncate(MAX_DISCOVERED_SESSIONS);
    sessions
}

fn insert_preferred(
    sessions: &mut HashMap<(&'static str, String), DiscoveredAgentSession>,
    session: DiscoveredAgentSession,
) {
    let key = (session.agent_id, session.external_session_id.clone());
    match sessions.get(&key) {
        Some(existing) if existing.running && !session.running => {}
        Some(existing) if existing.updated_at_ms > session.updated_at_ms => {}
        _ => {
            sessions.insert(key, session);
        }
    }
}

fn discover_codex_sessions(
    workspace_paths: &[String],
) -> Result<Vec<DiscoveredAgentSession>, String> {
    let executable = resolve_agent_executable("codex")
        .ok_or_else(|| "Codex executable was not found".to_owned())?;
    let (mut child, receiver) = spawn_codex_app_server(&executable)?;
    let result = (|| {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "Codex app-server stdin was unavailable".to_owned())?;
        write_json_line(
            stdin,
            &json!({
                "method": "initialize",
                "id": 0,
                "params": {
                    "clientInfo": { "name": "pelican", "title": "Pelican", "version": "0.1.0" },
                    "capabilities": null
                }
            }),
        )?;
        receive_response(&receiver, 0, CODEX_RESPONSE_TIMEOUT)?;
        write_json_line(stdin, &json!({ "method": "initialized" }))?;

        let canonical_paths = workspace_paths
            .iter()
            .flat_map(|path| {
                let mut paths = vec![path.clone()];
                if let Ok(canonical) = fs::canonicalize(path) {
                    let canonical = canonical.to_string_lossy().into_owned();
                    if canonical != *path {
                        paths.push(canonical);
                    }
                }
                paths
            })
            .collect::<Vec<_>>();
        write_json_line(
            stdin,
            &json!({
                "method": "thread/list",
                "id": 1,
                "params": {
                    "cwd": canonical_paths,
                    "limit": 200,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true,
                    "sourceKinds": ["cli", "vscode", "appServer"]
                }
            }),
        )?;
        let response = receive_response(&receiver, 1, CODEX_RESPONSE_TIMEOUT)?;
        parse_codex_thread_list(&response, workspace_paths)
    })();
    terminate_child(&mut child);
    result
}

fn spawn_codex_app_server(
    executable: &Path,
) -> Result<(Child, Receiver<Result<String, String>>), String> {
    let mut child = Command::new(executable)
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to start Codex app-server: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable".to_owned())?;
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("pelican-codex-discovery".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) if line.len() > MAX_PROTOCOL_LINE_BYTES => {
                        let _ = sender.send(Err("Codex app-server response was too large".into()));
                        break;
                    }
                    Ok(_) => {
                        if sender.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(format!(
                            "Unable to read Codex app-server response: {error}"
                        )));
                        break;
                    }
                }
            }
        })
        .map_err(|error| format!("Unable to start Codex response reader: {error}"))?;
    Ok((child, receiver))
}

fn write_json_line(stdin: &mut impl Write, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, value)
        .map_err(|error| format!("Unable to encode Codex request: {error}"))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Unable to send Codex request: {error}"))
}

fn receive_response(
    receiver: &Receiver<Result<String, String>>,
    request_id: i64,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Codex app-server response timed out".into());
        }
        let line = receiver
            .recv_timeout(remaining)
            .map_err(|_| "Codex app-server response timed out".to_owned())??;
        let value: Value = serde_json::from_str(line.trim())
            .map_err(|error| format!("Codex app-server returned invalid JSON: {error}"))?;
        if value.get("id").and_then(Value::as_i64) != Some(request_id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!("Codex app-server rejected the request: {error}"));
        }
        return Ok(value);
    }
}

fn parse_codex_thread_list(
    response: &Value,
    workspace_paths: &[String],
) -> Result<Vec<DiscoveredAgentSession>, String> {
    let threads = response
        .pointer("/result/data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex app-server response did not contain a thread list".to_owned())?;
    let mut sessions = Vec::new();
    for thread in threads {
        let Some(id) = thread.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(cwd) = thread.get("cwd").and_then(Value::as_str) else {
            continue;
        };
        let Some(workspace) = matching_workspace(cwd, workspace_paths) else {
            continue;
        };
        let title = thread
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .or_else(|| thread.get("preview").and_then(Value::as_str))
            .map(|value| clean_title(value, "Codex thread"))
            .unwrap_or_else(|| "Codex thread".into());
        let created_at_ms = seconds_to_ms(thread.get("createdAt").and_then(Value::as_u64));
        let updated_at_ms = seconds_to_ms(
            thread
                .get("recencyAt")
                .and_then(Value::as_u64)
                .or_else(|| thread.get("updatedAt").and_then(Value::as_u64)),
        );
        let status = thread.pointer("/status/type").and_then(Value::as_str);
        let waiting = thread
            .pointer("/status/activeFlags")
            .and_then(Value::as_array)
            .is_some_and(|flags| !flags.is_empty());
        let (status, running) = match status {
            Some("active") if waiting => ("attention", true),
            Some("active") => ("working", true),
            Some("systemError") => ("attention", false),
            Some("idle") => ("idle", false),
            _ => ("available", false),
        };
        sessions.push(DiscoveredAgentSession {
            agent_id: "codex",
            external_session_id: id.to_owned(),
            workspace_path: workspace.to_owned(),
            title,
            created_at_ms,
            updated_at_ms: updated_at_ms.max(created_at_ms),
            status,
            running,
            resume_handle: Some(id.to_owned()),
            attach_handle: None,
            origin: "codex-history",
        });
    }
    Ok(sessions)
}

fn discover_live_claude_sessions(workspace: &str) -> Result<Vec<DiscoveredAgentSession>, String> {
    let executable = resolve_agent_executable("claude")
        .ok_or_else(|| "Claude executable was not found".to_owned())?;
    let output = run_command(
        Command::new(executable).args(["agents", "--json", "--all", "--cwd", workspace]),
        CLAUDE_COMMAND_TIMEOUT,
        4 * 1024 * 1024,
        128 * 1024,
    )
    .map_err(|error| error.to_string())?;
    if !output.status.success() || output.stdout_truncated {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Claude returned invalid agent inventory JSON: {error}"))?;
    Ok(parse_claude_inventory(&value, workspace))
}

fn parse_claude_inventory(value: &Value, workspace: &str) -> Vec<DiscoveredAgentSession> {
    let rows = value
        .as_array()
        .or_else(|| value.get("agents").and_then(Value::as_array))
        .or_else(|| value.get("data").and_then(Value::as_array));
    let Some(rows) = rows else {
        return Vec::new();
    };
    let now = unix_time_ms(SystemTime::now());
    rows.iter()
        .filter_map(|row| {
            let cwd = row.get("cwd").and_then(Value::as_str)?;
            if !same_path(cwd, workspace) {
                return None;
            }
            let background_id = row.get("id").and_then(Value::as_str);
            let session_id = row.get("sessionId").and_then(Value::as_str);
            let pid = row.get("pid").and_then(Value::as_u64);
            let external_id = session_id
                .map(str::to_owned)
                .or_else(|| background_id.map(|id| format!("background:{id}")))
                .or_else(|| pid.map(|pid| format!("process:{pid}")))?;
            let state = row
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("working");
            let waiting = row.get("status").and_then(Value::as_str) == Some("waiting");
            let status = if waiting || state == "blocked" {
                "attention"
            } else {
                match state {
                    "done" => "done",
                    "failed" => "attention",
                    "stopped" => "offline",
                    _ => "working",
                }
            };
            let running = !matches!(state, "done" | "failed" | "stopped");
            let title = row
                .get("name")
                .and_then(Value::as_str)
                .map(|name| clean_title(name, "Claude session"))
                .unwrap_or_else(|| "Claude session".into());
            Some(DiscoveredAgentSession {
                agent_id: "claude-code",
                external_session_id: external_id,
                workspace_path: workspace.to_owned(),
                title,
                created_at_ms: now,
                updated_at_ms: now,
                status,
                running,
                resume_handle: (!running).then(|| session_id.map(str::to_owned)).flatten(),
                attach_handle: running.then(|| background_id.map(str::to_owned)).flatten(),
                origin: if background_id.is_some() {
                    "claude-background"
                } else {
                    "claude-foreground"
                },
            })
        })
        .collect()
}

fn discover_claude_history(workspace: &str) -> Vec<DiscoveredAgentSession> {
    let Some(config_root) = claude_config_root() else {
        return Vec::new();
    };
    let project_dir = config_root
        .join("projects")
        .join(encode_claude_project(workspace));
    let Ok(entries) = fs::read_dir(project_dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .filter_map(|entry| parse_claude_transcript(&entry.path(), workspace))
        .collect()
}

fn parse_claude_transcript(path: &Path, workspace: &str) -> Option<DiscoveredAgentSession> {
    let text = read_bounded_text(path)?;
    let mut session_id = path.file_stem()?.to_string_lossy().into_owned();
    let mut title = None;
    let mut transcript_cwd = None;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(value_session_id) = value.get("sessionId").and_then(Value::as_str) {
            session_id = value_session_id.to_owned();
        }
        if transcript_cwd.is_none() {
            transcript_cwd = value.get("cwd").and_then(Value::as_str).map(str::to_owned);
        }
        if title.is_none() && value.get("type").and_then(Value::as_str) == Some("user") {
            title = value
                .pointer("/message/content")
                .and_then(extract_text)
                .map(|text| clean_title(&text, "Claude session"));
        }
    }
    if transcript_cwd
        .as_deref()
        .is_some_and(|cwd| !same_path(cwd, workspace))
    {
        return None;
    }
    let (created_at_ms, updated_at_ms) = file_times(path);
    Some(DiscoveredAgentSession {
        agent_id: "claude-code",
        external_session_id: session_id.clone(),
        workspace_path: workspace.to_owned(),
        title: title.unwrap_or_else(|| "Claude session".into()),
        created_at_ms,
        updated_at_ms,
        status: "available",
        running: false,
        resume_handle: Some(session_id),
        attach_handle: None,
        origin: "claude-history",
    })
}

fn discover_pi_sessions(workspace: &str) -> Vec<DiscoveredAgentSession> {
    let Some(session_dir) = pi_session_directory(workspace) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(session_dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .filter_map(|entry| parse_pi_session(&entry.path(), workspace))
        .collect()
}

fn parse_pi_session(path: &Path, workspace: &str) -> Option<DiscoveredAgentSession> {
    let text = read_bounded_text(path)?;
    let mut lines = text.lines();
    let header: Value = serde_json::from_str(lines.next()?).ok()?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let id = header.get("id").and_then(Value::as_str)?.to_owned();
    let cwd = header.get("cwd").and_then(Value::as_str)?;
    if !same_path(cwd, workspace) {
        return None;
    }
    let mut title = None;
    let mut first_message = None;
    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            // A process may be in the middle of appending the final line.
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session_info") {
            if let Some(name) = value.get("name").and_then(Value::as_str) {
                title = Some(clean_title(name, "Pi session"));
            }
        }
        if first_message.is_none()
            && value.pointer("/message/role").and_then(Value::as_str) == Some("user")
        {
            first_message = value
                .pointer("/message/content")
                .and_then(extract_text)
                .map(|text| clean_title(&text, "Pi session"));
        }
    }
    let (created_at_ms, updated_at_ms) = file_times(path);
    Some(DiscoveredAgentSession {
        agent_id: "pi",
        external_session_id: id,
        workspace_path: workspace.to_owned(),
        title: title
            .or(first_message)
            .unwrap_or_else(|| "Pi session".into()),
        created_at_ms,
        updated_at_ms,
        status: "available",
        running: false,
        resume_handle: Some(path.to_string_lossy().into_owned()),
        attach_handle: None,
        origin: "pi-history",
    })
}

fn matching_workspace<'a>(path: &str, workspaces: &'a [String]) -> Option<&'a str> {
    workspaces
        .iter()
        .find(|workspace| same_path(path, workspace))
        .map(String::as_str)
}

fn same_path(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn home_directory() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn claude_config_root() -> Option<PathBuf> {
    env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_directory().map(|home| home.join(".claude")))
}

fn encode_claude_project(workspace: &str) -> String {
    workspace
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn pi_session_directory(workspace: &str) -> Option<PathBuf> {
    if let Some(directory) = env::var_os("PI_CODING_AGENT_SESSION_DIR") {
        return Some(PathBuf::from(directory));
    }
    let agent_root = env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| home_directory().map(|home| home.join(".pi/agent")))?;
    let resolved = fs::canonicalize(workspace).unwrap_or_else(|_| PathBuf::from(workspace));
    let path = resolved.to_string_lossy();
    let without_root = path
        .strip_prefix('/')
        .or_else(|| path.strip_prefix('\\'))
        .unwrap_or(&path);
    let encoded = without_root
        .chars()
        .map(|character| {
            if matches!(character, '/' | '\\' | ':') {
                '-'
            } else {
                character
            }
        })
        .collect::<String>();
    Some(agent_root.join("sessions").join(format!("--{encoded}--")))
}

fn read_bounded_text(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut text = String::new();
    file.take(MAX_SESSION_FILE_BYTES)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

fn extract_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| item.as_str())
                })
                .collect::<Vec<_>>()
                .join(" ");
            (!text.trim().is_empty()).then_some(text)
        }
        Value::Object(map) => map.get("text").and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

fn clean_title(value: &str, fallback: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return fallback.into();
    }
    let mut characters = compact.chars();
    let title = characters.by_ref().take(96).collect::<String>();
    if characters.next().is_some() {
        format!("{title}…")
    } else {
        title
    }
}

fn seconds_to_ms(seconds: Option<u64>) -> u64 {
    seconds.unwrap_or_default().saturating_mul(1_000)
}

fn file_times(path: &Path) -> (u64, u64) {
    let Ok(metadata) = path.metadata() else {
        return (0, 0);
    };
    let created = metadata
        .created()
        .unwrap_or_else(|_| metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH));
    let modified = metadata.modified().unwrap_or(created);
    (unix_time_ms(created), unix_time_ms(modified))
}

fn unix_time_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::{
        encode_claude_project, parse_claude_inventory, parse_claude_transcript,
        parse_codex_thread_list, parse_pi_session, pi_session_directory,
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn parses_codex_threads_as_available_resume_targets() {
        let response = json!({
            "result": { "data": [{
                "id": "thread-1",
                "name": "Fix the session browser",
                "cwd": "/tmp/pelican",
                "createdAt": 100,
                "updatedAt": 120,
                "recencyAt": 130,
                "status": { "type": "notLoaded" }
            }] }
        });
        let sessions = parse_codex_thread_list(&response, &["/tmp/pelican".into()])
            .expect("parse thread list");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "thread-1");
        assert_eq!(sessions[0].status, "available");
        assert_eq!(sessions[0].resume_handle.as_deref(), Some("thread-1"));
        assert!(!sessions[0].running);
    }

    #[test]
    fn maps_attachable_claude_background_agents() {
        let sessions = parse_claude_inventory(
            &json!([{
                "id": "a1b2c3",
                "sessionId": "conversation-1",
                "cwd": "/tmp/pelican",
                "name": "Review tests",
                "state": "blocked",
                "pid": 42
            }]),
            "/tmp/pelican",
        );
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].status, "attention");
        assert_eq!(sessions[0].attach_handle.as_deref(), Some("a1b2c3"));
        assert!(sessions[0].running);
    }

    #[test]
    fn encodes_provider_workspace_directories() {
        assert_eq!(
            encode_claude_project("/Users/tang yue/Pelican"),
            "-Users-tang-yue-Pelican"
        );
        let directory =
            pi_session_directory("/Users/tangyue/Downloads/Pelican").expect("Pi session directory");
        assert!(directory.ends_with("sessions/--Users-tangyue-Downloads-Pelican--"));
    }

    #[test]
    fn parses_claude_transcript_identity_and_title() {
        let directory = std::env::temp_dir().join(format!(
            "pelican-claude-session-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create transcript directory");
        let path = directory.join("conversation-1.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"sessionId\":\"conversation-1\",",
                "\"cwd\":\"/tmp/pelican\",\"message\":{\"content\":\"Fix the tests\"}}\n"
            ),
        )
        .expect("write transcript");

        let session = parse_claude_transcript(&path, "/tmp/pelican").expect("parse transcript");
        assert_eq!(session.external_session_id, "conversation-1");
        assert_eq!(session.title, "Fix the tests");
        assert_eq!(session.status, "available");
        assert_eq!(session.resume_handle.as_deref(), Some("conversation-1"));
        fs::remove_dir_all(directory).expect("remove transcript directory");
    }

    #[test]
    fn parses_pi_session_and_prefers_its_name() {
        let directory =
            std::env::temp_dir().join(format!("pelican-pi-session-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create Pi directory");
        let path = directory.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"session\",\"id\":\"pi-1\",\"cwd\":\"/tmp/pelican\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"Initial task\"}}\n",
                "{\"type\":\"session_info\",\"name\":\"Named Pi session\"}\n"
            ),
        )
        .expect("write Pi session");

        let session = parse_pi_session(&path, "/tmp/pelican").expect("parse Pi session");
        assert_eq!(session.external_session_id, "pi-1");
        assert_eq!(session.title, "Named Pi session");
        assert_eq!(session.status, "available");
        assert_eq!(session.resume_handle.as_deref(), path.to_str());
        fs::remove_dir_all(directory).expect("remove Pi directory");
    }
}
