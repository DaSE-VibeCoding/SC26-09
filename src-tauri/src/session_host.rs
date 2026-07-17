use crate::terminal::{self, PtyEvent, PtyHandle, PtySpawnSpec, PtyStopWait, PtyStopper};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

const VERSION: u8 = 1;
const MAX_ID: usize = 256;
const MAX_TEXT: usize = 4096;
const MAX_ARGS: usize = 1024;
const MAX_ENV: usize = 256;
static NEXT_STREAM: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct SessionHost {
    bindings: Mutex<HashMap<String, HostedEntry>>,
}
enum HostedEntry {
    Opening,
    Bound(HostedBinding),
}
struct HostedBinding {
    stream_id: String,
    sequence: u64,
    pty: Arc<Mutex<PtyHandle>>,
    stopper: PtyStopper,
    stop_accepted: bool,
    legacy: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionOpenCommand {
    request: SessionOpenRequest,
    pty_launch: PtyLaunch,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionOpenRequest {
    protocol_version: u8,
    session_id: String,
    agent_id: String,
    workspace_path: String,
    title: String,
    transport: OpenTransport,
    terminal_size: TerminalSize,
    recovery: Recovery,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenTransport {
    #[serde(rename = "type")]
    kind: String,
    executable: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalSize {
    rows: u16,
    cols: u16,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum Recovery {
    New,
    Resume { handle: String },
    Attach { handle: String },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PtyLaunch {
    args: Vec<String>,
    env: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedSessionSnapshot {
    protocol_version: u8,
    session_id: String,
    stream_id: String,
    last_sequence: u64,
    transport: Transport,
}
#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Transport {
    Pty { lifecycle_evidence: String },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    protocol_version: u8,
    session_id: String,
    stream_id: String,
    sequence: u64,
    event: HostEvent,
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum HostEvent {
    Opened { transport: Transport },
    TerminalOutput { data: String },
    Closed { outcome: CloseOutcome },
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum CloseOutcome {
    Stopped,
    Exited { success: bool },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyOutput {
    session_id: String,
    data: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyExit {
    session_id: String,
    exit_code: u32,
    success: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSendRequest {
    protocol_version: u8,
    session_id: String,
    stream_id: String,
    input: SessionInput,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum SessionInput {
    Prompt { text: String },
    Terminal { data: String },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionResizeRequest {
    protocol_version: u8,
    session_id: String,
    stream_id: String,
    rows: u16,
    cols: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStopRequest {
    protocol_version: u8,
    session_id: String,
    stream_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpawnTerminalRequest {
    session_id: String,
    cwd: String,
    program: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    rows: u16,
    cols: u16,
}

fn validate(command: &SessionOpenCommand) -> Result<(), String> {
    let r = &command.request;
    if r.protocol_version != VERSION {
        return Err("Unsupported session protocol version".into());
    }
    if !matches!(r.agent_id.as_str(), "codex" | "claude-code" | "pi") {
        return Err("Unsupported agent ID".into());
    }
    validate_identity(&r.session_id, "Session ID")?;
    for value in [&r.title, &r.workspace_path, &r.transport.executable] {
        if value.trim().is_empty() || value.len() > MAX_TEXT || value.contains('\0') {
            return Err("Session request contains an invalid string".into());
        }
    }
    if !Path::new(&r.workspace_path).is_dir() {
        return Err("Session workspace or ID is invalid".into());
    }
    if r.transport.kind != "pty-fallback" || r.terminal_size.rows == 0 || r.terminal_size.cols == 0
    {
        return Err("Only a positive-size PTY fallback is supported".into());
    }
    match &r.recovery {
        Recovery::New => {}
        Recovery::Resume { handle } | Recovery::Attach { handle }
            if !handle.is_empty() && handle.len() <= MAX_TEXT && !handle.contains('\0') => {}
        _ => return Err("Session recovery is invalid".into()),
    }
    if command.pty_launch.args.len() > MAX_ARGS
        || command.pty_launch.env.len() > MAX_ENV
        || command
            .pty_launch
            .args
            .iter()
            .any(|v| v.len() > MAX_TEXT || v.contains('\0'))
        || command.pty_launch.env.iter().any(|(k, v)| {
            k.is_empty()
                || k.len() > MAX_TEXT
                || k.contains(['=', '\0'])
                || v.len() > MAX_TEXT
                || v.contains('\0')
        })
    {
        return Err("PTY launch arguments are invalid".into());
    }
    Ok(())
}

fn validate_identity(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.encode_utf16().count() > MAX_ID
        || value.contains('\0')
        || value.chars().any(char::is_control)
    {
        Err(format!("{label} is invalid"))
    } else {
        Ok(())
    }
}

fn validate_stream_identity(session_id: &str, stream_id: &str) -> Result<(), String> {
    validate_identity(session_id, "Session ID")?;
    validate_identity(stream_id, "Session stream")
}

fn open(
    app: AppHandle,
    host: State<'_, SessionHost>,
    command: SessionOpenCommand,
    legacy: bool,
) -> Result<HostedSessionSnapshot, String> {
    validate(&command)?;
    let r = command.request;
    reserve_session_id(&host.bindings, &r.session_id)?;
    let spawned = terminal::spawn(PtySpawnSpec {
        program: r.transport.executable.clone(),
        cwd: r.workspace_path.clone(),
        args: command.pty_launch.args,
        env: command.pty_launch.env,
        rows: r.terminal_size.rows,
        cols: r.terminal_size.cols,
    });
    let (pty, events) = match spawned {
        Ok(spawned) => spawned,
        Err(error) => {
            clear_opening(&host.bindings, &r.session_id);
            return Err(error);
        }
    };
    let stream_id = format!("stream-{}", NEXT_STREAM.fetch_add(1, Ordering::Relaxed));
    let transport = Transport::Pty {
        lifecycle_evidence: "fallback".into(),
    };
    let stopper = pty.stopper();
    let binding = HostedBinding {
        stream_id: stream_id.clone(),
        sequence: 0,
        pty: Arc::new(Mutex::new(pty)),
        stopper,
        stop_accepted: false,
        legacy,
    };
    if let Err((binding, error)) = install_reserved_binding(&host.bindings, &r.session_id, binding)
    {
        drop(events);
        cleanup_spawned_binding(binding);
        return Err(error);
    }
    let snapshot = HostedSessionSnapshot {
        protocol_version: VERSION,
        session_id: r.session_id.clone(),
        stream_id: stream_id.clone(),
        last_sequence: 0,
        transport: transport.clone(),
    };
    let _ = app.emit(
        "session-event",
        Envelope {
            protocol_version: VERSION,
            session_id: r.session_id.clone(),
            stream_id: stream_id.clone(),
            sequence: 0,
            event: HostEvent::Opened { transport },
        },
    );
    thread::spawn(move || {
        for event in events {
            publish_pty_event(&app, &r.session_id, &stream_id, event);
        }
    });
    Ok(snapshot)
}

fn reserve_session_id(
    bindings: &Mutex<HashMap<String, HostedEntry>>,
    session_id: &str,
) -> Result<(), String> {
    let mut map = bindings.lock().map_err(|_| "Session host is unavailable")?;
    if map.contains_key(session_id) {
        return Err("A session with this ID already exists".into());
    }
    map.insert(session_id.to_owned(), HostedEntry::Opening);
    Ok(())
}

fn clear_opening(bindings: &Mutex<HashMap<String, HostedEntry>>, session_id: &str) {
    let Ok(mut map) = bindings.lock() else {
        return;
    };
    if matches!(map.get(session_id), Some(HostedEntry::Opening)) {
        map.remove(session_id);
    }
}

fn install_reserved_binding(
    bindings: &Mutex<HashMap<String, HostedEntry>>,
    session_id: &str,
    binding: HostedBinding,
) -> Result<(), (HostedBinding, String)> {
    let mut map = match bindings.lock() {
        Ok(map) => map,
        Err(_) => return Err((binding, "Session host is unavailable".into())),
    };
    if !matches!(map.get(session_id), Some(HostedEntry::Opening)) {
        return Err((binding, "Session open was superseded".into()));
    }
    map.insert(session_id.to_owned(), HostedEntry::Bound(binding));
    Ok(())
}

fn cleanup_spawned_binding(binding: HostedBinding) {
    if let Ok(wait) = binding.stopper.request_stop() {
        let _ = wait.wait();
    }
}
fn publish_pty_event(app: &AppHandle, session_id: &str, stream_id: &str, event: PtyEvent) {
    let Some(publication) = build_publication(app, session_id, stream_id, event) else {
        return;
    };
    let final_event = publication.final_event;
    let _ = app.emit("session-event", publication.envelope);
    if let Some(data) = publication.legacy_output {
        let _ = app.emit(
            "terminal-output",
            LegacyOutput {
                session_id: session_id.into(),
                data,
            },
        );
    }
    if let Some((exit_code, success)) = publication.legacy_exit {
        let _ = app.emit(
            "terminal-exit",
            LegacyExit {
                session_id: session_id.into(),
                exit_code,
                success,
            },
        );
    }
    if final_event {
        remove_closed_binding(app, session_id, stream_id);
    }
}

struct Publication {
    envelope: Envelope,
    legacy_output: Option<String>,
    legacy_exit: Option<(u32, bool)>,
    final_event: bool,
}

fn build_publication(
    app: &AppHandle,
    session_id: &str,
    stream_id: &str,
    event: PtyEvent,
) -> Option<Publication> {
    let host = app.try_state::<SessionHost>()?;
    let Ok(mut map) = host.bindings.lock() else {
        return None;
    };
    let Some(HostedEntry::Bound(binding)) = map.get_mut(session_id) else {
        return None;
    };
    if binding.stream_id != stream_id {
        return None;
    };
    binding.sequence += 1;
    let sequence = binding.sequence;
    let legacy = binding.legacy;
    let (host_event, legacy_output, legacy_exit, final_event) = match event {
        PtyEvent::Output(data) => (
            HostEvent::TerminalOutput { data: data.clone() },
            Some(data),
            None,
            false,
        ),
        PtyEvent::Exited { exit_code, success } => {
            let outcome = if binding.stop_accepted {
                CloseOutcome::Stopped
            } else {
                CloseOutcome::Exited { success }
            };
            (
                HostEvent::Closed { outcome },
                None,
                Some((exit_code, success)),
                true,
            )
        }
    };
    let envelope = Envelope {
        protocol_version: VERSION,
        session_id: session_id.into(),
        stream_id: stream_id.into(),
        sequence,
        event: host_event,
    };
    Some(Publication {
        envelope,
        legacy_output: if legacy { legacy_output } else { None },
        legacy_exit: if legacy { legacy_exit } else { None },
        final_event,
    })
}

fn remove_closed_binding(app: &AppHandle, session_id: &str, stream_id: &str) {
    let Some(host) = app.try_state::<SessionHost>() else {
        return;
    };
    let Ok(mut map) = host.bindings.lock() else {
        return;
    };
    if matches!(
        map.get(session_id),
        Some(HostedEntry::Bound(binding)) if binding.stream_id == stream_id
    ) {
        map.remove(session_id);
    }
}

#[tauri::command]
pub fn session_open(
    app: AppHandle,
    host: State<'_, SessionHost>,
    command: SessionOpenCommand,
) -> Result<HostedSessionSnapshot, String> {
    open(app, host, command, false)
}
#[tauri::command]
pub fn session_send(
    host: State<'_, SessionHost>,
    request: SessionSendRequest,
) -> Result<(), String> {
    check_version(request.protocol_version)?;
    validate_stream_identity(&request.session_id, &request.stream_id)?;
    let pty = binding_pty(
        &host.bindings,
        &request.session_id,
        &request.stream_id,
        false,
    )?;
    let mut pty = pty.lock().map_err(|_| "Terminal session is unavailable")?;
    match request.input {
        SessionInput::Terminal { data } => pty.send(&data),
        SessionInput::Prompt { text } => {
            let _ = text;
            Err("Prompt input is not supported by PTY fallback".into())
        }
    }
}
#[tauri::command]
pub fn session_resize(
    host: State<'_, SessionHost>,
    request: SessionResizeRequest,
) -> Result<(), String> {
    check_version(request.protocol_version)?;
    validate_stream_identity(&request.session_id, &request.stream_id)?;
    if request.rows == 0 || request.cols == 0 {
        return Err("Terminal dimensions must be positive".into());
    }
    let pty = binding_pty(
        &host.bindings,
        &request.session_id,
        &request.stream_id,
        false,
    )?;
    let pty = pty.lock().map_err(|_| "Terminal session is unavailable")?;
    pty.resize(request.rows, request.cols)
}
#[tauri::command]
pub async fn session_stop(
    host: State<'_, SessionHost>,
    request: SessionStopRequest,
) -> Result<(), String> {
    check_version(request.protocol_version)?;
    validate_stream_identity(&request.session_id, &request.stream_id)?;
    let wait = accept_stop(
        &host.bindings,
        &request.session_id,
        &request.stream_id,
        false,
    )?;
    wait_for_stop(wait).await
}
#[tauri::command]
pub fn session_list(host: State<'_, SessionHost>) -> Result<Vec<HostedSessionSnapshot>, String> {
    let map = host
        .bindings
        .lock()
        .map_err(|_| "Session host is unavailable")?;
    Ok(map
        .iter()
        .filter_map(|(id, entry)| match entry {
            HostedEntry::Opening => None,
            HostedEntry::Bound(b) if !b.legacy => Some(HostedSessionSnapshot {
                protocol_version: VERSION,
                session_id: id.clone(),
                stream_id: b.stream_id.clone(),
                last_sequence: b.sequence,
                transport: Transport::Pty {
                    lifecycle_evidence: "fallback".into(),
                },
            }),
            HostedEntry::Bound(_) => None,
        })
        .collect())
}
fn check_version(v: u8) -> Result<(), String> {
    if v == VERSION {
        Ok(())
    } else {
        Err("Unsupported session protocol version".into())
    }
}
fn bound_binding_mut<'a>(
    map: &'a mut HashMap<String, HostedEntry>,
    id: &str,
    stream: &str,
) -> Result<&'a mut HostedBinding, String> {
    let Some(HostedEntry::Bound(b)) = map.get_mut(id) else {
        return Err("Session is not running".into());
    };
    if b.stream_id != stream {
        return Err("Session stream is stale".into());
    }
    Ok(b)
}

fn binding_pty(
    bindings: &Mutex<HashMap<String, HostedEntry>>,
    id: &str,
    stream: &str,
    legacy_only: bool,
) -> Result<Arc<Mutex<PtyHandle>>, String> {
    let mut map = bindings.lock().map_err(|_| "Session host is unavailable")?;
    let b = bound_binding_mut(&mut map, id, stream)?;
    if legacy_only && !b.legacy {
        return Err("Terminal session is not running".into());
    }
    Ok(Arc::clone(&b.pty))
}

fn legacy_pty(
    bindings: &Mutex<HashMap<String, HostedEntry>>,
    session_id: &str,
) -> Result<Arc<Mutex<PtyHandle>>, String> {
    let mut map = bindings.lock().map_err(|_| "Session host is unavailable")?;
    let Some(HostedEntry::Bound(b)) = map.get_mut(session_id) else {
        return Err("Terminal session is not running".into());
    };
    if !b.legacy {
        return Err("Terminal session is not running".into());
    }
    Ok(Arc::clone(&b.pty))
}

fn accept_stop(
    bindings: &Mutex<HashMap<String, HostedEntry>>,
    id: &str,
    stream: &str,
    legacy_only: bool,
) -> Result<PtyStopWait, String> {
    let mut map = bindings.lock().map_err(|_| "Session host is unavailable")?;
    let b = bound_binding_mut(&mut map, id, stream)?;
    if legacy_only && !b.legacy {
        return Err("Terminal session is not running".into());
    }
    let wait = b.stopper.request_stop()?;
    b.stop_accepted = true;
    Ok(wait)
}

fn accept_legacy_stop(
    bindings: &Mutex<HashMap<String, HostedEntry>>,
    session_id: &str,
) -> Result<PtyStopWait, String> {
    let mut map = bindings.lock().map_err(|_| "Session host is unavailable")?;
    let Some(HostedEntry::Bound(b)) = map.get_mut(session_id) else {
        return Err("Terminal session is not running".into());
    };
    if !b.legacy {
        return Err("Terminal session is not running".into());
    }
    let wait = b.stopper.request_stop()?;
    b.stop_accepted = true;
    Ok(wait)
}

async fn wait_for_stop(wait: PtyStopWait) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || wait.wait())
        .await
        .map_err(|error| format!("Unable to schedule terminal stop: {error}"))?
}

#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    host: State<'_, SessionHost>,
    request: SpawnTerminalRequest,
) -> Result<(), String> {
    let command = SessionOpenCommand {
        request: SessionOpenRequest {
            protocol_version: VERSION,
            session_id: request.session_id,
            agent_id: "codex".into(),
            workspace_path: request.cwd,
            title: "Legacy terminal".into(),
            transport: OpenTransport {
                kind: "pty-fallback".into(),
                executable: request.program,
            },
            terminal_size: TerminalSize {
                rows: request.rows.max(1),
                cols: request.cols.max(1),
            },
            recovery: Recovery::New,
        },
        pty_launch: PtyLaunch {
            args: request.args,
            env: request.env,
        },
    };
    open(app, host, command, true).map(|_| ())
}
#[tauri::command]
pub fn terminal_write(
    host: State<'_, SessionHost>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    validate_identity(&session_id, "Session ID")?;
    let pty = legacy_pty(&host.bindings, &session_id)?;
    let mut pty = pty.lock().map_err(|_| "Terminal session is unavailable")?;
    pty.send(&data)
}
#[tauri::command]
pub fn terminal_resize(
    host: State<'_, SessionHost>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    validate_identity(&session_id, "Session ID")?;
    let pty = legacy_pty(&host.bindings, &session_id)?;
    let pty = pty.lock().map_err(|_| "Terminal session is unavailable")?;
    pty.resize(rows.max(1), cols.max(1))
}
#[tauri::command]
pub async fn terminal_stop(host: State<'_, SessionHost>, session_id: String) -> Result<(), String> {
    validate_identity(&session_id, "Session ID")?;
    let wait = accept_legacy_stop(&host.bindings, &session_id)?;
    wait_for_stop(wait).await
}
#[tauri::command]
pub fn terminal_list_sessions(host: State<'_, SessionHost>) -> Result<Vec<String>, String> {
    Ok(host
        .bindings
        .lock()
        .map_err(|_| "Session host is unavailable")?
        .iter()
        .filter_map(|(id, entry)| match entry {
            HostedEntry::Bound(binding) if binding.legacy => Some(id.clone()),
            HostedEntry::Opening | HostedEntry::Bound(_) => None,
        })
        .collect())
}

impl Drop for SessionHost {
    fn drop(&mut self) {
        let map = match self.bindings.get_mut() {
            Ok(map) => map,
            Err(poisoned) => poisoned.into_inner(),
        };
        for entry in map.values() {
            if let HostedEntry::Bound(binding) = entry {
                let _ = binding.stopper.request_stop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_command(session_id: String) -> SessionOpenCommand {
        SessionOpenCommand {
            request: SessionOpenRequest {
                protocol_version: VERSION,
                session_id,
                agent_id: "codex".into(),
                workspace_path: std::env::current_dir()
                    .expect("current directory")
                    .to_string_lossy()
                    .into_owned(),
                title: "Test session".into(),
                transport: OpenTransport {
                    kind: "pty-fallback".into(),
                    executable: "codex".into(),
                },
                terminal_size: TerminalSize { rows: 24, cols: 80 },
                recovery: Recovery::New,
            },
            pty_launch: PtyLaunch {
                args: Vec::new(),
                env: HashMap::new(),
            },
        }
    }

    #[test]
    fn serialization_matches_v1() {
        let value = serde_json::to_value(HostedSessionSnapshot {
            protocol_version: 1,
            session_id: "s".into(),
            stream_id: "stream-1".into(),
            last_sequence: 0,
            transport: Transport::Pty {
                lifecycle_evidence: "fallback".into(),
            },
        })
        .unwrap();
        assert_eq!(value["protocolVersion"], 1);
        assert_eq!(value["transport"]["type"], "pty");
        assert_eq!(value["transport"]["lifecycleEvidence"], "fallback");
    }

    #[test]
    fn validation_aligns_session_identity_with_frontend_bound() {
        assert!(validate(&open_command("s".repeat(MAX_ID))).is_ok());
        assert!(validate(&open_command("鹈".repeat(MAX_ID))).is_ok());
        assert!(validate(&open_command("s".repeat(MAX_ID + 1))).is_err());
    }

    #[test]
    fn opening_reservation_blocks_duplicate_and_can_be_released() {
        let host = SessionHost::default();

        reserve_session_id(&host.bindings, "session-1").expect("reserve session");
        assert!(matches!(
            host.bindings.lock().expect("bindings").get("session-1"),
            Some(HostedEntry::Opening)
        ));
        assert!(reserve_session_id(&host.bindings, "session-1").is_err());

        clear_opening(&host.bindings, "session-1");
        assert!(reserve_session_id(&host.bindings, "session-1").is_ok());
    }
}
