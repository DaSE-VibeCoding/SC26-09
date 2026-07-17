use crate::agents::cached_executable_directories;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const OUTPUT_CHANNEL_CAPACITY: usize = 64;
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(20);
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_secs(1);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_SESSION_ID_BYTES: usize = 256;

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    control: Sender<TerminalControl>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        let sessions = match self.sessions.get_mut() {
            Ok(sessions) => sessions,
            Err(poisoned) => poisoned.into_inner(),
        };
        for session in sessions.values() {
            let (reply, _response) = sync_channel(1);
            let _ = session.control.send(TerminalControl::Stop(reply));
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnTerminalRequest {
    session_id: String,
    cwd: String,
    program: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    rows: u16,
    cols: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
    exit_code: u32,
    success: bool,
}

enum ReaderMessage {
    Data(Vec<u8>),
    Closed,
}

enum TerminalControl {
    Stop(SyncSender<Result<(), String>>),
}

#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    request: SpawnTerminalRequest,
) -> Result<(), String> {
    validate_spawn_request(&request)?;

    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "Terminal state is unavailable")?;
    if sessions.contains_key(&request.session_id) {
        return Err("A terminal with this session ID already exists".into());
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: request.rows.max(1),
            cols: request.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Unable to open terminal: {error}"))?;

    let mut command = CommandBuilder::new(&request.program);
    command.args(&request.args);
    command.cwd(&request.cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    #[cfg(unix)]
    command.env("PWD", &request.cwd);
    for (key, value) in &request.env {
        command.env(key, value);
    }
    // GUI apps often inherit a minimal PATH. The executable may be an npm
    // launcher whose `#!/usr/bin/env node` shebang still needs the Node binary
    // from the user's shell/version manager, even though the launcher itself is
    // absolute.
    if let Some(path) = terminal_path(&request) {
        command.env("PATH", path);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Unable to launch {}: {error}", request.program))?;
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            cleanup_failed_spawn(child);
            return Err(format!("Unable to read terminal: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            cleanup_failed_spawn(child);
            return Err(format!("Unable to write terminal: {error}"));
        }
    };

    let session_id = request.session_id;
    let (output_sender, output_receiver) = sync_channel(OUTPUT_CHANNEL_CAPACITY);
    let (control_sender, control_receiver) = channel();
    sessions.insert(
        session_id.clone(),
        TerminalSession {
            writer,
            master: pair.master,
            control: control_sender,
        },
    );
    drop(sessions);

    thread::spawn(move || read_output(reader, output_sender));
    thread::spawn(move || {
        manage_terminal(child, output_receiver, control_receiver, app, session_id)
    });

    Ok(())
}

fn validate_spawn_request(request: &SpawnTerminalRequest) -> Result<(), String> {
    if request.session_id.trim().is_empty()
        || request.session_id.len() > MAX_SESSION_ID_BYTES
        || request.session_id.chars().any(char::is_control)
    {
        return Err("Terminal session ID is invalid".into());
    }
    if request.program.is_empty() || request.program.contains('\0') {
        return Err("Terminal program is invalid".into());
    }
    if !Path::new(&request.cwd).is_dir() {
        return Err("Session workspace is not a directory".into());
    }
    if request.cwd.contains('\0') || request.args.iter().any(|argument| argument.contains('\0')) {
        return Err("Terminal command contains an invalid null byte".into());
    }
    if request
        .env
        .iter()
        .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'))
    {
        return Err("Terminal environment contains an invalid entry".into());
    }
    Ok(())
}

fn terminal_path(request: &SpawnTerminalRequest) -> Option<OsString> {
    let mut directories = Vec::new();
    if let Some(parent) = Path::new(&request.program)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        directories.push(parent.to_path_buf());
    }
    let requested_path = request
        .env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| OsString::from(value))
        .or_else(|| env::var_os("PATH"));
    if let Some(path) = requested_path {
        directories.extend(env::split_paths(&path));
    }
    if let Some(agent_directories) = cached_executable_directories() {
        directories.extend(agent_directories.iter().cloned());
    }

    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    env::join_paths(directories).ok()
}

fn cleanup_failed_spawn(mut child: Box<dyn Child + Send + Sync>) {
    let _ = child.kill();
    thread::spawn(move || {
        let _ = child.wait();
    });
}

fn read_output(mut reader: Box<dyn Read + Send>, sender: SyncSender<ReaderMessage>) {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(length) => {
                if sender
                    .send(ReaderMessage::Data(buffer[..length].to_vec()))
                    .is_err()
                {
                    return;
                }
            }
        }
    }
    let _ = sender.send(ReaderMessage::Closed);
}

fn manage_terminal(
    mut child: Box<dyn Child + Send + Sync>,
    output: Receiver<ReaderMessage>,
    control: Receiver<TerminalControl>,
    app: AppHandle,
    session_id: String,
) {
    let mut decoder = Utf8StreamDecoder::default();
    let mut output_closed = false;
    let mut exit: Option<(u32, bool)> = None;
    let mut drain_deadline: Option<Instant> = None;

    loop {
        while let Ok(message) = control.try_recv() {
            handle_control(message, child.as_mut());
        }

        let wait = drain_deadline
            .map(|deadline| {
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(CHILD_POLL_INTERVAL)
            })
            .unwrap_or(CHILD_POLL_INTERVAL);
        if output_closed {
            thread::sleep(wait);
        } else {
            match output.recv_timeout(wait) {
                Ok(ReaderMessage::Data(bytes)) => {
                    let data = decoder.push(&bytes);
                    emit_output(&app, &session_id, data);
                }
                Ok(ReaderMessage::Closed) | Err(RecvTimeoutError::Disconnected) => {
                    output_closed = true;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }

        if exit.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    exit = Some((status.exit_code(), status.success()));
                    drain_deadline = Some(Instant::now() + OUTPUT_DRAIN_GRACE);
                }
                Ok(None) => {}
                Err(_) => {
                    exit = Some((1, false));
                    drain_deadline = Some(Instant::now() + OUTPUT_DRAIN_GRACE);
                }
            }
        }

        if exit.is_some()
            && (output_closed || drain_deadline.is_some_and(|deadline| Instant::now() >= deadline))
        {
            break;
        }
    }

    // Preserve already-buffered trailing output, but never emit terminal output
    // after the terminal-exit event.
    while let Ok(ReaderMessage::Data(bytes)) = output.try_recv() {
        let data = decoder.push(&bytes);
        emit_output(&app, &session_id, data);
    }
    emit_output(&app, &session_id, decoder.finish());

    if let Some(state) = app.try_state::<TerminalManager>() {
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.remove(&session_id);
        }
    }
    let (exit_code, success) = exit.unwrap_or((1, false));
    let _ = app.emit(
        "terminal-exit",
        TerminalExit {
            session_id,
            exit_code,
            success,
        },
    );
}

fn handle_control(message: TerminalControl, child: &mut (dyn Child + Send + Sync)) {
    match message {
        TerminalControl::Stop(response) => {
            let result = child
                .kill()
                .map_err(|error| format!("Unable to stop terminal: {error}"));
            let _ = response.send(result);
        }
    }
}

fn emit_output(app: &AppHandle, session_id: &str, data: String) {
    if data.is_empty() {
        return;
    }
    let _ = app.emit(
        "terminal-output",
        TerminalOutput {
            session_id: session_id.to_owned(),
            data,
        },
    );
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut decoded = String::new();

        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    decoded.push_str(valid);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid_length = error.valid_up_to();
                    if valid_length > 0 {
                        let valid = std::str::from_utf8(&self.pending[..valid_length])
                            .expect("UTF-8 validator returned an invalid prefix");
                        decoded.push_str(valid);
                        self.pending.drain(..valid_length);
                    }
                    if let Some(invalid_length) = error.error_len() {
                        decoded.push(char::REPLACEMENT_CHARACTER);
                        self.pending.drain(..invalid_length);
                    } else {
                        // Retain an incomplete multi-byte character for the next
                        // PTY read rather than rendering a replacement character.
                        break;
                    }
                }
            }
        }

        decoded
    }

    fn finish(&mut self) -> String {
        let decoded = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        decoded
    }
}

#[tauri::command]
pub fn terminal_write(
    manager: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "Terminal state is unavailable")?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or("Terminal session is not running")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("Unable to write to terminal: {error}"))?;
    session
        .writer
        .flush()
        .map_err(|error| format!("Unable to flush terminal input: {error}"))
}

#[tauri::command]
pub fn terminal_resize(
    manager: State<'_, TerminalManager>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = manager
        .sessions
        .lock()
        .map_err(|_| "Terminal state is unavailable")?;
    let session = sessions
        .get(&session_id)
        .ok_or("Terminal session is not running")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Unable to resize terminal: {error}"))
}

#[tauri::command]
pub async fn terminal_stop(
    manager: State<'_, TerminalManager>,
    session_id: String,
) -> Result<(), String> {
    let control = {
        let sessions = manager
            .sessions
            .lock()
            .map_err(|_| "Terminal state is unavailable")?;
        sessions
            .get(&session_id)
            .ok_or("Terminal session is not running")?
            .control
            .clone()
    };
    tauri::async_runtime::spawn_blocking(move || request_terminal_stop(control))
        .await
        .map_err(|error| format!("Unable to schedule terminal stop: {error}"))?
}

fn request_terminal_stop(control: Sender<TerminalControl>) -> Result<(), String> {
    let (reply, response) = sync_channel(1);
    control
        .send(TerminalControl::Stop(reply))
        .map_err(|_| "Terminal session is no longer running")?;
    response
        .recv_timeout(STOP_TIMEOUT)
        .map_err(|_| "Timed out while stopping terminal")?
}

#[cfg(test)]
mod tests {
    use super::{validate_spawn_request, SpawnTerminalRequest, Utf8StreamDecoder};
    use std::collections::HashMap;

    fn request() -> SpawnTerminalRequest {
        SpawnTerminalRequest {
            session_id: "session-1".into(),
            cwd: std::env::current_dir()
                .expect("current directory")
                .to_string_lossy()
                .into_owned(),
            program: "test".into(),
            args: Vec::new(),
            env: HashMap::new(),
            rows: 24,
            cols: 80,
        }
    }

    #[test]
    fn preserves_utf8_characters_split_between_reads() {
        let mut decoder = Utf8StreamDecoder::default();
        let text = "Pelican 鹈鹕 🐦";
        let bytes = text.as_bytes();
        let mut decoded = String::new();
        for byte in bytes {
            decoded.push_str(&decoder.push(&[*byte]));
        }
        decoded.push_str(&decoder.finish());
        assert_eq!(decoded, text);
    }

    #[test]
    fn replaces_invalid_utf8_without_losing_following_text() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.push(b"ok\xffdone"), "ok\u{fffd}done");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn flushes_incomplete_utf8_on_close() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.push(&[0xe7, 0x95]), "");
        assert_eq!(decoder.finish(), "\u{fffd}");
    }

    #[test]
    fn rejects_invalid_spawn_requests() {
        let mut invalid = request();
        invalid.session_id = "\n".into();
        assert!(validate_spawn_request(&invalid).is_err());

        let mut invalid = request();
        invalid.env.insert("BAD=KEY".into(), "value".into());
        assert!(validate_spawn_request(&invalid).is_err());

        let mut valid = request();
        valid.env.insert("PELICAN_AGENT".into(), "codex".into());
        assert!(validate_spawn_request(&valid).is_ok());
    }
}
