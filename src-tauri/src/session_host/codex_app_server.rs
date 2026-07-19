//! Private Codex app-server v2 process supervisor and lifecycle decoder fixtures.

#![allow(dead_code)]

use super::*;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_INBOUND_RECORD: usize = 1024 * 1024;
const MAX_OUTBOUND_RECORD: usize = 64 * 1024;
const CHILD_CHANNEL_CAPACITY: usize = 32;
const PRODUCTION_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const PRODUCTION_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
enum RequestId {
    Integer(i64),
    String(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    Client,
    Server,
}

#[derive(Debug, PartialEq, Eq)]
enum HandshakeMarker {
    InitializeRequested,
    InitializeAccepted,
    Initialized,
    ThreadStartRequested,
    ThreadBound,
}

enum DecodeOutput {
    Ignored,
    Handshake(HandshakeMarker),
    Ready(Envelope),
    Activity(Envelope),
}

struct SupervisorConfig {
    executable: PathBuf,
    cwd: PathBuf,
    session_id: String,
    stream_id: String,
    handshake_timeout: Duration,
    shutdown_grace: Duration,
}

impl SupervisorConfig {
    fn new(executable: PathBuf, cwd: PathBuf, session_id: String, stream_id: String) -> Self {
        Self {
            executable,
            cwd,
            session_id,
            stream_id,
            handshake_timeout: PRODUCTION_HANDSHAKE_TIMEOUT,
            shutdown_grace: PRODUCTION_SHUTDOWN_GRACE,
        }
    }

    fn with_deadlines(mut self, handshake_timeout: Duration, shutdown_grace: Duration) -> Self {
        self.handshake_timeout = handshake_timeout;
        self.shutdown_grace = shutdown_grace;
        self
    }
}

enum ChildRecord {
    Message(Value),
    Error(String),
    Eof,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShutdownOutcome {
    AlreadyClosed,
    Exited { forced: bool, success: bool },
}

struct CodexAppServerSupervisor {
    session_id: String,
    cwd: String,
    stream: StreamState,
    decoder: Decoder,
    stdin: Option<ChildStdin>,
    child: Option<Child>,
    stdout_rx: Receiver<ChildRecord>,
    reader_stopping: Arc<AtomicBool>,
    stdout_join: Option<JoinHandle<()>>,
    stderr_join: Option<JoinHandle<()>>,
    next_request_id: i64,
    handshake_timeout: Duration,
    shutdown_grace: Duration,
}

impl CodexAppServerSupervisor {
    fn launch(config: SupervisorConfig) -> Result<Self, String> {
        validate_identity(&config.session_id, "Session ID")?;
        validate_identity(&config.stream_id, "Session stream")?;
        let cwd = config
            .cwd
            .to_str()
            .filter(|value| !value.is_empty() && !value.contains('\0'))
            .ok_or_else(|| "Codex cwd is invalid".to_string())?
            .to_owned();
        if !config.cwd.is_dir() {
            return Err("Codex cwd is not a directory".into());
        }

        let mut child = Command::new(&config.executable)
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Unable to start Codex app-server: {error}"))?;
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                force_reap_child(&mut child);
                return Err("Codex app-server stdin was unavailable".into());
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                drop(stdin);
                force_reap_child(&mut child);
                return Err("Codex app-server stdout was unavailable".into());
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                drop(stdin);
                force_reap_child(&mut child);
                return Err("Codex app-server stderr was unavailable".into());
            }
        };

        let (stdout_tx, stdout_rx) = mpsc::sync_channel(CHILD_CHANNEL_CAPACITY);
        let reader_stopping = Arc::new(AtomicBool::new(false));
        let stdout_join = match spawn_stdout_reader(stdout, stdout_tx, Arc::clone(&reader_stopping))
        {
            Ok(join) => join,
            Err(error) => {
                drop(stdin);
                force_reap_child(&mut child);
                return Err(error);
            }
        };
        let stderr_join = match spawn_stderr_drain(stderr) {
            Ok(join) => join,
            Err(error) => {
                drop(stdin);
                force_reap_child(&mut child);
                reader_stopping.store(true, AtomicOrdering::SeqCst);
                let _ = stdout_join.join();
                return Err(error);
            }
        };

        Ok(Self {
            session_id: config.session_id,
            cwd,
            stream: StreamState {
                agent_id: "codex".into(),
                stream_id: config.stream_id,
                sequence: 0,
                transport_kind: BindingTransport::Protocol,
                source: None,
                prompt_readiness: PromptReadiness::AwaitingAuthoritative,
                current_turn: None,
                pending_attention_keys: HashSet::new(),
                terminal_outcome: None,
            },
            decoder: Decoder::default(),
            stdin: Some(stdin),
            child: Some(child),
            stdout_rx,
            reader_stopping,
            stdout_join: Some(stdout_join),
            stderr_join: Some(stderr_join),
            next_request_id: 1,
            handshake_timeout: config.handshake_timeout,
            shutdown_grace: config.shutdown_grace,
        })
    }

    fn start_new_thread(&mut self) -> Result<Envelope, String> {
        let initialize_id = self.allocate_request_id()?;
        self.send_client(
            serde_json::json!({
                "method": "initialize",
                "id": initialize_id,
                "params": {
                    "clientInfo": {
                        "name": "pelican",
                        "title": "Pelican",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }),
            HandshakeMarker::InitializeRequested,
        )?;
        self.wait_for_handshake(
            HandshakeMarker::InitializeAccepted,
            Instant::now() + self.handshake_timeout,
        )?;
        self.send_client(
            serde_json::json!({"method": "initialized"}),
            HandshakeMarker::Initialized,
        )?;
        let thread_start_id = self.allocate_request_id()?;
        self.send_client(
            serde_json::json!({
                "method": "thread/start",
                "id": thread_start_id,
                "params": { "cwd": self.cwd.clone() }
            }),
            HandshakeMarker::ThreadStartRequested,
        )?;
        self.wait_for_ready(Instant::now() + self.handshake_timeout)
    }

    fn next_envelope(&mut self, timeout: Duration) -> Result<Option<Envelope>, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let Some(message) = self.receive_message(deadline)? else {
                return Ok(None);
            };
            match self.decoder.decode(
                Direction::Server,
                message,
                &self.session_id,
                &mut self.stream,
            )? {
                DecodeOutput::Ignored | DecodeOutput::Handshake(_) => {}
                DecodeOutput::Ready(envelope) | DecodeOutput::Activity(envelope) => {
                    return Ok(Some(envelope));
                }
            }
        }
    }

    fn shutdown(&mut self) -> Result<ShutdownOutcome, String> {
        drop(self.stdin.take());
        let Some(mut child) = self.child.take() else {
            self.join_readers();
            return Ok(ShutdownOutcome::AlreadyClosed);
        };

        let deadline = Instant::now() + self.shutdown_grace;
        loop {
            self.drain_stdout_channel();
            match child.try_wait() {
                Ok(Some(status)) => {
                    let success = status.success();
                    self.join_readers();
                    return Ok(ShutdownOutcome::Exited {
                        forced: false,
                        success,
                    });
                }
                Ok(None) => {}
                Err(error) => {
                    self.child = Some(child);
                    return Err(format!("Unable to reap Codex app-server: {error}"));
                }
            }
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            thread::sleep((deadline - now).min(Duration::from_millis(5)));
        }

        let status = match kill_and_wait(&mut child) {
            Ok(status) => status,
            Err(error) => {
                self.child = Some(child);
                return Err(error);
            }
        };
        let success = status.success();
        self.drain_stdout_channel();
        self.join_readers();
        Ok(ShutdownOutcome::Exited {
            forced: true,
            success,
        })
    }

    fn send_client(&mut self, message: Value, expected: HandshakeMarker) -> Result<(), String> {
        let mut staged_decoder = self.decoder.clone();
        let mut staged_stream = self.stream.clone();
        match staged_decoder.decode(
            Direction::Client,
            message.clone(),
            &self.session_id,
            &mut staged_stream,
        )? {
            DecodeOutput::Handshake(marker) if marker == expected => {}
            _ => return Err("Codex client handshake message was rejected".into()),
        }
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "Codex app-server stdin is closed".to_string())?;
        write_json_line(stdin, &message)?;
        self.decoder = staged_decoder;
        self.stream = staged_stream;
        Ok(())
    }

    fn allocate_request_id(&mut self) -> Result<i64, String> {
        let request_id = self.next_request_id;
        self.next_request_id = self
            .next_request_id
            .checked_add(1)
            .ok_or_else(|| "Codex request ID space is exhausted".to_string())?;
        Ok(request_id)
    }

    fn wait_for_handshake(
        &mut self,
        expected: HandshakeMarker,
        deadline: Instant,
    ) -> Result<(), String> {
        loop {
            let message = self
                .receive_message(deadline)?
                .ok_or_else(|| "Codex app-server closed before handshake completed".to_string())?;
            match self.decoder.decode(
                Direction::Server,
                message,
                &self.session_id,
                &mut self.stream,
            )? {
                DecodeOutput::Handshake(marker) if marker == expected => return Ok(()),
                DecodeOutput::Ignored | DecodeOutput::Handshake(_) => {}
                DecodeOutput::Ready(_) | DecodeOutput::Activity(_) => {
                    return Err("Codex app-server emitted lifecycle before readiness".into())
                }
            }
        }
    }

    fn wait_for_ready(&mut self, deadline: Instant) -> Result<Envelope, String> {
        loop {
            let message = self
                .receive_message(deadline)?
                .ok_or_else(|| "Codex app-server closed before thread binding".to_string())?;
            match self.decoder.decode(
                Direction::Server,
                message,
                &self.session_id,
                &mut self.stream,
            )? {
                DecodeOutput::Ready(envelope) => return Ok(envelope),
                DecodeOutput::Ignored | DecodeOutput::Handshake(_) => {}
                DecodeOutput::Activity(_) => {
                    return Err("Codex app-server emitted lifecycle before readiness".into())
                }
            }
        }
    }

    fn receive_message(&mut self, deadline: Instant) -> Result<Option<Value>, String> {
        let now = Instant::now();
        if now >= deadline {
            return Err("Codex app-server response timed out".into());
        }
        match self.stdout_rx.recv_timeout(deadline - now) {
            Ok(ChildRecord::Message(value)) => Ok(Some(value)),
            Ok(ChildRecord::Error(error)) => Err(error),
            Ok(ChildRecord::Eof) => Ok(None),
            Err(RecvTimeoutError::Timeout) => Err("Codex app-server response timed out".into()),
            Err(RecvTimeoutError::Disconnected) => Ok(None),
        }
    }

    fn drain_stdout_channel(&mut self) {
        while self.stdout_rx.try_recv().is_ok() {}
    }

    fn join_readers(&mut self) {
        self.reader_stopping.store(true, AtomicOrdering::SeqCst);
        self.drain_stdout_channel();
        if let Some(join) = self.stdout_join.take() {
            let _ = join.join();
        }
        if let Some(join) = self.stderr_join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for CodexAppServerSupervisor {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn spawn_stdout_reader(
    stdout: impl Read + Send + 'static,
    sender: SyncSender<ChildRecord>,
    stopping: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("pelican-codex-app-server-stdout".into())
        .spawn(move || read_stdout(stdout, sender, stopping))
        .map_err(|error| format!("Unable to start Codex app-server stdout reader: {error}"))
}

fn read_stdout(stdout: impl Read, sender: SyncSender<ChildRecord>, stopping: Arc<AtomicBool>) {
    let mut reader = BufReader::new(stdout);
    loop {
        match read_bounded_line(&mut reader, MAX_INBOUND_RECORD) {
            Ok(Some(line)) => match serde_json::from_slice(&line) {
                Ok(value) => {
                    if !send_child_record(&sender, &stopping, ChildRecord::Message(value)) {
                        break;
                    }
                }
                Err(error) => {
                    let _ = send_child_record(
                        &sender,
                        &stopping,
                        ChildRecord::Error(format!(
                            "Codex app-server returned invalid JSON: {error}"
                        )),
                    );
                    break;
                }
            },
            Ok(None) => {
                let _ = send_child_record(&sender, &stopping, ChildRecord::Eof);
                break;
            }
            Err(error) => {
                let _ = send_child_record(&sender, &stopping, ChildRecord::Error(error));
                break;
            }
        }
    }
}

fn send_child_record(
    sender: &SyncSender<ChildRecord>,
    stopping: &AtomicBool,
    mut record: ChildRecord,
) -> bool {
    while !stopping.load(AtomicOrdering::SeqCst) {
        match sender.try_send(record) {
            Ok(()) => return true,
            Err(TrySendError::Full(next_record)) => {
                record = next_record;
                thread::sleep(Duration::from_millis(1));
            }
            Err(TrySendError::Disconnected(_)) => return false,
        }
    }
    false
}

fn spawn_stderr_drain(stderr: impl Read + Send + 'static) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("pelican-codex-app-server-stderr".into())
        .spawn(move || drain_stderr(stderr))
        .map_err(|error| format!("Unable to start Codex app-server stderr drain: {error}"))
}

fn drain_stderr(mut stderr: impl Read) {
    let mut buffer = [0_u8; 8192];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

fn read_bounded_line<R: BufRead>(reader: &mut R, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::new();
    loop {
        let (consumed, complete) = {
            let available = reader
                .fill_buf()
                .map_err(|error| format!("Unable to read Codex app-server output: {error}"))?;
            if available.is_empty() {
                if line.is_empty() {
                    return Ok(None);
                }
                if line.ends_with(b"\r") {
                    line.pop();
                }
                return Ok(Some(line));
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let end = newline.unwrap_or(available.len());
            if line.len().saturating_add(end) > limit {
                return Err("Codex app-server response was too large".into());
            }
            line.extend_from_slice(&available[..end]);
            (end + usize::from(newline.is_some()), newline.is_some())
        };
        reader.consume(consumed);
        if complete {
            if line.ends_with(b"\r") {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

fn write_json_line(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("Unable to encode Codex request: {error}"))?;
    if bytes.len() > MAX_OUTBOUND_RECORD {
        return Err("Codex app-server request was too large".into());
    }
    writer
        .write_all(&bytes)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Unable to send Codex request: {error}"))
}

fn kill_and_wait(child: &mut Child) -> Result<ExitStatus, String> {
    if let Err(kill_error) = child.kill() {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Unable to reap Codex app-server: {error}"))?
        {
            return Ok(status);
        }
        return Err(format!("Unable to stop Codex app-server: {kill_error}"));
    }
    child
        .wait()
        .map_err(|error| format!("Unable to reap Codex app-server: {error}"))
}

fn force_reap_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Clone)]
struct PendingApproval {
    turn_id: String,
    key: String,
}

#[derive(Clone, Default)]
struct Decoder {
    initialize_id: Option<RequestId>,
    initialize_accepted: bool,
    initialized: bool,
    thread_start_id: Option<RequestId>,
    thread_id: Option<String>,
    pending: HashMap<RequestId, PendingApproval>,
}

impl Decoder {
    fn decode(
        &mut self,
        direction: Direction,
        message: Value,
        session_id: &str,
        stream: &mut StreamState,
    ) -> Result<DecodeOutput, String> {
        let object = message
            .as_object()
            .ok_or_else(|| "Codex message must be an object".to_string())?;
        if object.contains_key("jsonrpc") {
            return Err("Codex app-server v2 wire must omit jsonrpc".into());
        }

        if let Some(method) = object.get("method") {
            let method = method
                .as_str()
                .ok_or_else(|| "Codex method must be a string".to_string())?;
            return self.decode_method(direction, method, object, session_id, stream);
        }
        if object.contains_key("id") {
            return self.decode_response(direction, object, session_id, stream);
        }
        Ok(DecodeOutput::Ignored)
    }

    fn decode_method(
        &mut self,
        direction: Direction,
        method: &str,
        object: &Map<String, Value>,
        session_id: &str,
        stream: &mut StreamState,
    ) -> Result<DecodeOutput, String> {
        match (direction, method) {
            (Direction::Client, "initialize") => {
                if self.initialize_id.is_some() {
                    return Err("Codex initialize is out of order".into());
                }
                let id = required_id(object)?;
                self.initialize_id = Some(id);
                Ok(DecodeOutput::Handshake(
                    HandshakeMarker::InitializeRequested,
                ))
            }
            (Direction::Client, "initialized") => {
                if !self.initialize_accepted || self.initialized || object.contains_key("id") {
                    return Err("Codex initialized is out of order".into());
                }
                self.initialized = true;
                Ok(DecodeOutput::Handshake(HandshakeMarker::Initialized))
            }
            (Direction::Client, "thread/start") => {
                if !self.initialized || self.thread_start_id.is_some() || self.thread_id.is_some() {
                    return Err("Codex thread/start is out of order".into());
                }
                let id = required_id(object)?;
                self.thread_start_id = Some(id);
                Ok(DecodeOutput::Handshake(
                    HandshakeMarker::ThreadStartRequested,
                ))
            }
            (Direction::Server, "turn/started") => {
                let (thread_id, turn_id, status) = lifecycle_identity(object)?;
                require_bound_thread(self, thread_id)?;
                if status != "inProgress" {
                    return Err("Codex turn/started status is invalid".into());
                }
                let envelope = accept_structured_activity(
                    session_id,
                    stream,
                    activity_input(
                        thread_id,
                        turn_id,
                        CandidateActivity::TurnStarted {
                            evidence: LifecycleEvidence::Structured,
                        },
                    ),
                )?;
                Ok(DecodeOutput::Activity(envelope))
            }
            (Direction::Server, "item/commandExecution/requestApproval")
            | (Direction::Server, "item/fileChange/requestApproval") => {
                let request_id = required_id(object)?;
                let params = required_params(object)?;
                let thread_id = required_string(params, "threadId")?;
                let turn_id = required_string(params, "turnId")?;
                let _item_id = required_string(params, "itemId")?;
                require_bound_thread(self, thread_id)?;
                if self.pending.contains_key(&request_id) {
                    return Err("Duplicate Codex approval request ID".into());
                }
                let key = approval_key(&request_id)?;
                let envelope = accept_structured_activity(
                    session_id,
                    stream,
                    activity_input(
                        thread_id,
                        turn_id,
                        CandidateActivity::AttentionRequested {
                            evidence: LifecycleEvidence::Structured,
                            key: key.clone(),
                        },
                    ),
                )?;
                self.pending.insert(
                    request_id,
                    PendingApproval {
                        turn_id: turn_id.into(),
                        key,
                    },
                );
                Ok(DecodeOutput::Activity(envelope))
            }
            (Direction::Server, "serverRequest/resolved") => {
                let params = required_params(object)?;
                let thread_id = required_string(params, "threadId")?;
                require_bound_thread(self, thread_id)?;
                let request_id =
                    parse_id(params.get("requestId").ok_or("Missing Codex requestId")?)?;
                let pending = self
                    .pending
                    .get(&request_id)
                    .cloned()
                    .ok_or_else(|| "Unknown Codex approval resolution".to_string())?;
                let envelope = accept_structured_activity(
                    session_id,
                    stream,
                    activity_input(
                        thread_id,
                        &pending.turn_id,
                        CandidateActivity::AttentionResolved {
                            evidence: LifecycleEvidence::Structured,
                            key: pending.key,
                        },
                    ),
                )?;
                self.pending.remove(&request_id);
                Ok(DecodeOutput::Activity(envelope))
            }
            (Direction::Server, "turn/completed") => {
                let (thread_id, turn_id, status) = lifecycle_identity(object)?;
                require_bound_thread(self, thread_id)?;
                let outcome = match status {
                    "completed" => TerminalOutcome::Completed,
                    "failed" => TerminalOutcome::Failed,
                    "interrupted" => TerminalOutcome::Interrupted,
                    "inProgress" => return Err("Codex completion cannot remain in progress".into()),
                    _ => return Err("Unknown Codex completion status".into()),
                };
                Ok(DecodeOutput::Activity(accept_structured_activity(
                    session_id,
                    stream,
                    activity_input(
                        thread_id,
                        turn_id,
                        CandidateActivity::TurnEnded {
                            evidence: LifecycleEvidence::Structured,
                            outcome,
                        },
                    ),
                )?))
            }
            (_, "item/tool/requestUserInput")
            | (_, "mcpServer/elicitation/create")
            | (_, "applyPatchApproval")
            | (_, "execCommandApproval") => Ok(DecodeOutput::Ignored),
            _ => Ok(DecodeOutput::Ignored),
        }
    }

    fn decode_response(
        &mut self,
        direction: Direction,
        object: &Map<String, Value>,
        session_id: &str,
        stream: &mut StreamState,
    ) -> Result<DecodeOutput, String> {
        if direction != Direction::Server {
            return Ok(DecodeOutput::Ignored);
        }
        let id = required_id(object)?;
        if self.initialize_id.as_ref() == Some(&id) {
            if self.initialize_accepted
                || object.contains_key("error")
                || !object.contains_key("result")
            {
                return Err("Codex initialize response is not an exact success".into());
            }
            self.initialize_accepted = true;
            return Ok(DecodeOutput::Handshake(HandshakeMarker::InitializeAccepted));
        }
        if self.thread_start_id.as_ref() == Some(&id) {
            if !self.initialized || self.thread_id.is_some() || object.contains_key("error") {
                return Err("Codex thread/start response is not an exact success".into());
            }
            let result = object
                .get("result")
                .and_then(Value::as_object)
                .ok_or("Missing Codex thread/start result")?;
            let thread = result
                .get("thread")
                .and_then(Value::as_object)
                .ok_or("Missing Codex thread/start thread")?;
            let thread_id = required_string(thread, "id")?;
            validate_identity(thread_id, "Provider session ID")?;
            let source = SourceIdentity {
                agent_id: "codex".into(),
                integration: SourceIntegration::AppServer,
                provider_session_id: thread_id.into(),
                provenance: SourceProvenance::ProviderHandshake,
            };
            let envelope = accept_structured_source_ready(session_id, stream, source)?;
            self.thread_id = Some(thread_id.into());
            return Ok(DecodeOutput::Ready(envelope));
        }
        Ok(DecodeOutput::Ignored)
    }
}

fn required_params(object: &Map<String, Value>) -> Result<&Map<String, Value>, String> {
    object
        .get("params")
        .and_then(Value::as_object)
        .ok_or_else(|| "Missing Codex params".into())
}
fn required_string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing Codex {key}"))
}
fn required_id(object: &Map<String, Value>) -> Result<RequestId, String> {
    parse_id(object.get("id").ok_or("Missing Codex request ID")?)
}
fn parse_id(value: &Value) -> Result<RequestId, String> {
    match value {
        Value::String(value) if value.encode_utf16().count() <= MAX_ID => {
            Ok(RequestId::String(value.clone()))
        }
        Value::String(_) => Err("Codex request ID is too long".into()),
        Value::Number(value) => value
            .as_i64()
            .map(RequestId::Integer)
            .ok_or_else(|| "Codex request ID must be an integer".into()),
        _ => Err("Codex request ID must be a string or integer".into()),
    }
}
fn approval_key(id: &RequestId) -> Result<String, String> {
    let key = match id {
        RequestId::Integer(value) => format!("codex-request:i:{value}"),
        RequestId::String(value) => format!(
            "codex-request:s:{}",
            serde_json::to_string(value).map_err(|_| "Invalid Codex request ID")?
        ),
    };
    validate_activity_key(&key, "Attention key")?;
    Ok(key)
}
fn lifecycle_identity(object: &Map<String, Value>) -> Result<(&str, &str, &str), String> {
    let params = required_params(object)?;
    let thread_id = required_string(params, "threadId")?;
    let turn = params
        .get("turn")
        .and_then(Value::as_object)
        .ok_or("Missing Codex turn")?;
    Ok((
        thread_id,
        required_string(turn, "id")?,
        required_string(turn, "status")?,
    ))
}
fn require_bound_thread(decoder: &Decoder, thread_id: &str) -> Result<(), String> {
    match decoder.thread_id.as_deref() {
        Some(bound) if bound == thread_id => Ok(()),
        Some(_) => Err("Codex thread identity does not match binding".into()),
        None => Err("Codex lifecycle arrived before thread binding".into()),
    }
}
fn activity_input(
    thread_id: &str,
    turn_id: &str,
    activity: CandidateActivity,
) -> StructuredActivityInput {
    StructuredActivityInput {
        source: SourceIdentity {
            agent_id: "codex".into(),
            integration: SourceIntegration::AppServer,
            provider_session_id: thread_id.into(),
            provenance: SourceProvenance::ProviderEvent,
        },
        context: ActivityContext {
            turn: TurnIdentity {
                key: turn_id.into(),
                provenance: TurnProvenance::ProviderTurn,
            },
        },
        activity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::io::Cursor;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::sync::atomic::AtomicU64;

    #[cfg(unix)]
    static FAKE_COUNTER: AtomicU64 = AtomicU64::new(1);

    #[cfg(unix)]
    struct FakeCodex {
        root: PathBuf,
        executable: PathBuf,
        cwd: PathBuf,
    }

    #[cfg(unix)]
    impl FakeCodex {
        fn new(body: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "pelican-codex-app-server-test-{}-{}",
                std::process::id(),
                FAKE_COUNTER.fetch_add(1, AtomicOrdering::SeqCst)
            ));
            fs::create_dir(&root).expect("create fake root");
            let workspace = root.join("workspace");
            fs::create_dir(&workspace).expect("create fake workspace");
            let cwd = fs::canonicalize(&workspace).expect("canonical fake workspace");
            let executable = root.join("fake-codex");
            fs::write(&executable, format!("#!/bin/sh\nset -u\n{body}\n"))
                .expect("write fake codex");
            let mut permissions = fs::metadata(&executable)
                .expect("fake metadata")
                .permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&executable, permissions).expect("chmod fake codex");
            Self {
                root,
                executable,
                cwd,
            }
        }

        fn config(&self) -> SupervisorConfig {
            SupervisorConfig::new(
                self.executable.clone(),
                self.cwd.clone(),
                "session-1".into(),
                "stream-1".into(),
            )
            .with_deadlines(Duration::from_secs(5), Duration::from_millis(100))
        }
    }

    #[cfg(unix)]
    impl Drop for FakeCodex {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(unix)]
    fn successful_handshake_script(after_ready: &str) -> String {
        successful_handshake_script_with_prefix("", after_ready)
    }

    #[cfg(unix)]
    fn successful_handshake_script_with_prefix(
        before_initialize: &str,
        after_ready: &str,
    ) -> String {
        format!(
            r#"
if [ "$#" -ne 3 ] || [ "$1" != "app-server" ] || [ "$2" != "--listen" ] || [ "$3" != "stdio://" ]; then exit 41; fi
{before_initialize}
read init || exit 42
case "$init" in *'"method":"initialize"'*) ;; *) exit 43;; esac
case "$init" in *'"id":1'*) ;; *) exit 44;; esac
case "$init" in *'"capabilities"'*) exit 51;; esac
printf '%s\n' '{{"method":"notice/ignored","params":{{"ignored":true}}}}'
printf '%s\n' '{{"id":"1","result":{{}}}}'
printf '%s\n' '{{"id":1,"result":{{}}}}'
read initialized || exit 45
if [ "$initialized" != '{{"method":"initialized"}}' ]; then exit 46; fi
read start || exit 47
case "$start" in *'"method":"thread/start"'*) ;; *) exit 48;; esac
case "$start" in *'"id":2'*) ;; *) exit 49;; esac
case "$start" in *'"cwd":"'"$(pwd)"'"'*) ;; *) exit 50;; esac
printf '%s\n' '{{"id":999,"result":{{}}}}'
printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-xyz","sessionId":"ignored"}}}}}}'
{after_ready}
"#
        )
    }

    #[cfg(unix)]
    fn launch_fake(body: String) -> (FakeCodex, CodexAppServerSupervisor) {
        let fake = FakeCodex::new(&body);
        let supervisor =
            CodexAppServerSupervisor::launch(fake.config()).expect("launch fake codex");
        (fake, supervisor)
    }

    #[cfg(unix)]
    fn next_activity(supervisor: &mut CodexAppServerSupervisor) -> Envelope {
        supervisor
            .next_envelope(Duration::from_secs(5))
            .expect("next envelope")
            .expect("activity envelope")
    }

    #[cfg(unix)]
    fn process_is_gone(pid: u32) -> bool {
        let pid = pid.to_string();
        !std::process::Command::new("/bin/kill")
            .args(["-0", &pid])
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn stream() -> StreamState {
        StreamState {
            agent_id: "codex".into(),
            stream_id: "stream-1".into(),
            sequence: 0,
            transport_kind: BindingTransport::Protocol,
            source: None,
            prompt_readiness: PromptReadiness::AwaitingAuthoritative,
            current_turn: None,
            pending_attention_keys: HashSet::new(),
            terminal_outcome: None,
        }
    }
    fn handshake(decoder: &mut Decoder, stream: &mut StreamState) {
        for (direction, message) in [
            (
                Direction::Client,
                json!({"method":"initialize","id":1,"params":{}}),
            ),
            (Direction::Server, json!({"id":1,"result":{}})),
            (
                Direction::Client,
                json!({"method":"initialized","params":{}}),
            ),
            (
                Direction::Client,
                json!({"method":"thread/start","id":"start","params":{}}),
            ),
            (
                Direction::Server,
                json!({"id":"start","result":{"thread":{"id":"thread-1","sessionId":"conflict"}}}),
            ),
        ] {
            decoder
                .decode(direction, message, "session-1", stream)
                .unwrap();
        }
    }
    fn started() -> Value {
        json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"inProgress"}}})
    }
    fn approval(method: &str, id: Value) -> Value {
        json!({"method":method,"id":id,"params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1"}})
    }
    fn resolved(id: Value) -> Value {
        json!({"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":id}})
    }
    fn completed(status: &str) -> Value {
        json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":status}}})
    }

    #[test]
    fn handshake_enforces_exact_ids_order_success_and_thread_id() {
        let mut d = Decoder::default();
        let mut s = stream();
        assert!(d
            .decode(Direction::Server, json!({"id":1,"result":{}}), "s", &mut s)
            .is_ok());
        assert!(d
            .decode(
                Direction::Client,
                json!({"jsonrpc":"2.0","method":"initialize","id":1}),
                "s",
                &mut s
            )
            .is_err());
        d.decode(
            Direction::Client,
            json!({"method":"initialize","id":7}),
            "s",
            &mut s,
        )
        .unwrap();
        assert!(d
            .decode(
                Direction::Server,
                json!({"method":7,"id":7,"result":{}}),
                "s",
                &mut s
            )
            .is_err());
        assert!(!d.initialize_accepted && s.source.is_none());
        assert!(d
            .decode(
                Direction::Server,
                json!({"id":"7","result":{}}),
                "s",
                &mut s
            )
            .is_ok());
        assert!(d
            .decode(
                Direction::Client,
                json!({"method":"initialized"}),
                "s",
                &mut s
            )
            .is_err());
        assert!(d
            .decode(
                Direction::Server,
                json!({"id":7,"error":{"message":"no"}}),
                "s",
                &mut s
            )
            .is_err());
        d.decode(Direction::Server, json!({"id":7,"result":{}}), "s", &mut s)
            .unwrap();
        d.decode(
            Direction::Client,
            json!({"method":"initialized"}),
            "s",
            &mut s,
        )
        .unwrap();
        d.decode(
            Direction::Client,
            json!({"method":"thread/start","id":8}),
            "s",
            &mut s,
        )
        .unwrap();
        assert!(d
            .decode(
                Direction::Server,
                json!({"id":8,"result":{"thread":{"sessionId":"only"}}}),
                "s",
                &mut s
            )
            .is_err());
        let ready = d
            .decode(
                Direction::Server,
                json!({"id":8,"result":{"thread":{"id":"thread-1","sessionId":"other"}}}),
                "s",
                &mut s,
            )
            .unwrap();
        assert!(matches!(ready, DecodeOutput::Ready(_)));
        assert_eq!(s.source.as_ref().unwrap().provider_session_id, "thread-1");
        assert_eq!(
            s.source.as_ref().unwrap().provenance,
            SourceProvenance::ProviderHandshake
        );
        assert_eq!(s.prompt_readiness, PromptReadiness::Ready);
        assert_eq!(s.sequence, 1);

        let mut bounded = Decoder::default();
        assert!(bounded
            .decode(
                Direction::Client,
                json!({"method":"initialize","id":"x".repeat(MAX_ID + 1)}),
                "s",
                &mut stream()
            )
            .is_err());
        assert!(bounded.initialize_id.is_none());
    }

    #[test]
    fn lifecycle_uses_real_gate_and_serializes_only_normalized_fields() {
        let mut d = Decoder::default();
        let mut s = stream();
        handshake(&mut d, &mut s);
        let DecodeOutput::Activity(start) = d
            .decode(Direction::Server, started(), "session-1", &mut s)
            .unwrap()
        else {
            panic!()
        };
        let text = serde_json::to_string(&start).unwrap();
        assert!(
            text.contains("turn-started")
                && text.contains("provider-turn")
                && text.contains("provider-event")
        );
        for raw in ["method", "params", "itemId", "requestId"] {
            assert!(!text.contains(raw));
        }
        assert!(matches!(
            d.decode(
                Direction::Server,
                completed("completed"),
                "session-1",
                &mut s
            )
            .unwrap(),
            DecodeOutput::Activity(_)
        ));
        assert_eq!(s.sequence, 3);
    }

    #[test]
    fn typed_approval_ids_resolution_and_latent_completion_are_exact() {
        let mut d = Decoder::default();
        let mut s = stream();
        handshake(&mut d, &mut s);
        d.decode(Direction::Server, started(), "s", &mut s).unwrap();
        d.decode(
            Direction::Server,
            approval("item/commandExecution/requestApproval", json!(7)),
            "s",
            &mut s,
        )
        .unwrap();
        d.decode(
            Direction::Server,
            approval("item/fileChange/requestApproval", json!("7")),
            "s",
            &mut s,
        )
        .unwrap();
        assert_eq!(d.pending.len(), 2);
        assert!(s.pending_attention_keys.contains("codex-request:i:7"));
        assert!(s.pending_attention_keys.contains("codex-request:s:\"7\""));
        let before = s.sequence;
        for bad in [
            resolved(json!(8)),
            resolved(json!(7)),
            json!({"method":"serverRequest/resolved","params":{"threadId":"wrong","requestId":7}}),
        ] {
            let mut msg = bad;
            if msg["params"]["requestId"] == json!(7)
                && msg["params"]["threadId"] == json!("thread-1")
            {
                msg["params"]["requestId"] = json!("missing");
            }
            assert!(d.decode(Direction::Server, msg, "s", &mut s).is_err());
        }
        assert_eq!((s.sequence, d.pending.len()), (before, 2));
        d.decode(Direction::Server, completed("completed"), "s", &mut s)
            .unwrap();
        d.decode(Direction::Server, resolved(json!(7)), "s", &mut s)
            .unwrap();
        assert_eq!(d.pending.len(), 1);
        assert_eq!(s.terminal_outcome, Some(TerminalOutcome::Completed));
        assert!(d
            .decode(Direction::Server, resolved(json!(7)), "s", &mut s)
            .is_err());
        d.decode(Direction::Server, resolved(json!("7")), "s", &mut s)
            .unwrap();
        assert!(d.pending.is_empty());
    }

    #[test]
    fn malformed_lifecycle_never_mutates_gate_or_pending() {
        let mut d = Decoder::default();
        let mut s = stream();
        handshake(&mut d, &mut s);
        assert!(d
            .decode(
                Direction::Server,
                approval("item/fileChange/requestApproval", json!(1)),
                "s",
                &mut s
            )
            .is_err());
        assert_eq!((s.sequence, d.pending.len()), (1, 0));
        d.decode(Direction::Server, started(), "s", &mut s).unwrap();
        let before = s.sequence;
        for msg in [
            started(),
            json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1"},"status":"completed"}}),
            json!({"method":"turn/started","params":{"threadId":"wrong","turn":{"id":"x","status":"inProgress"}}}),
            json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"stale","status":"completed"}}}),
            approval("item/fileChange/requestApproval", json!(1)),
        ] {
            let result = d.decode(Direction::Server, msg.clone(), "s", &mut s);
            if msg["method"] == "item/fileChange/requestApproval" {
                assert!(result.is_ok());
            } else {
                assert!(result.is_err());
            }
        }
        assert_eq!(s.sequence, before + 1);
        let pending = d.pending.len();
        assert!(d
            .decode(
                Direction::Server,
                approval("item/commandExecution/requestApproval", json!(1)),
                "s",
                &mut s
            )
            .is_err());
        assert_eq!((s.sequence, d.pending.len()), (before + 1, pending));
    }

    #[test]
    fn completion_status_matrix_routes_all_terminal_outcomes_through_the_gate() {
        for status in ["failed", "interrupted", "inProgress", "future"] {
            let mut d = Decoder::default();
            let mut s = stream();
            handshake(&mut d, &mut s);
            d.decode(Direction::Server, started(), "s", &mut s).unwrap();
            let before = s.sequence;
            let result = d.decode(Direction::Server, completed(status), "s", &mut s);
            if matches!(status, "failed" | "interrupted") {
                assert!(matches!(result.unwrap(), DecodeOutput::Activity(_)));
                assert_eq!(s.sequence, before + 1);
                assert_eq!(
                    s.terminal_outcome,
                    Some(if status == "failed" {
                        TerminalOutcome::Failed
                    } else {
                        TerminalOutcome::Interrupted
                    })
                );
            } else {
                assert!(result.is_err());
                assert_eq!(s.sequence, before);
                assert!(s.terminal_outcome.is_none());
            }
        }
        let mut d = Decoder::default();
        let mut s = stream();
        handshake(&mut d, &mut s);
        d.decode(Direction::Server, started(), "s", &mut s).unwrap();
        assert!(matches!(
            d.decode(Direction::Server, completed("completed"), "s", &mut s)
                .unwrap(),
            DecodeOutput::Activity(_)
        ));
    }

    #[test]
    fn excluded_methods_are_ignored_without_mutation() {
        let mut d = Decoder::default();
        let mut s = stream();
        handshake(&mut d, &mut s);
        for method in [
            "item/tool/requestUserInput",
            "mcpServer/elicitation/create",
            "applyPatchApproval",
            "execCommandApproval",
            "unrelated/method",
        ] {
            assert!(matches!(
                d.decode(
                    Direction::Server,
                    json!({"method":method,"id":1,"params":{}}),
                    "s",
                    &mut s
                )
                .unwrap(),
                DecodeOutput::Ignored
            ));
        }
        assert_eq!((s.sequence, d.pending.len()), (1, 0));
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_handshake_correlates_typed_ids_and_routes_ordered_envelopes() {
        let (_fake, mut supervisor) = launch_fake(successful_handshake_script(
            r#"
printf '%s\n' '{"method":"turn/started","params":{"threadId":"thread-xyz","turn":{"id":"turn-1","status":"inProgress"}}}'
printf '%s\n' '{"method":"item/commandExecution/requestApproval","id":7,"params":{"threadId":"thread-xyz","turnId":"turn-1","itemId":"item-1"}}'
printf '%s\n' '{"method":"serverRequest/resolved","params":{"threadId":"thread-xyz","requestId":7}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-xyz","turn":{"id":"turn-1","status":"completed"}}}'
while read line; do :; done
"#,
        ));

        let ready = supervisor.start_new_thread().expect("ready handshake");
        assert_eq!(ready.sequence, 1);
        match ready.event {
            HostEvent::PromptReadinessChanged {
                source,
                prompt_readiness,
            } => {
                assert_eq!(prompt_readiness, PromptReadiness::Ready);
                assert_eq!(source.provider_session_id, "thread-xyz");
                assert_eq!(source.provenance, SourceProvenance::ProviderHandshake);
            }
            _ => panic!("expected readiness envelope"),
        }
        assert_eq!(supervisor.decoder.thread_id.as_deref(), Some("thread-xyz"));
        assert_eq!(supervisor.stream.prompt_readiness, PromptReadiness::Ready);

        let envelopes = [
            next_activity(&mut supervisor),
            next_activity(&mut supervisor),
            next_activity(&mut supervisor),
            next_activity(&mut supervisor),
        ];
        assert_eq!(
            envelopes
                .iter()
                .map(|envelope| envelope.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3, 4, 5]
        );
        assert!(matches!(
            envelopes[0].event,
            HostEvent::Activity {
                activity: HostActivity::TurnStarted { .. },
                ..
            }
        ));
        assert!(matches!(
            envelopes[1].event,
            HostEvent::Activity {
                activity: HostActivity::AttentionRequested { .. },
                ..
            }
        ));
        assert!(matches!(
            envelopes[2].event,
            HostEvent::Activity {
                activity: HostActivity::AttentionResolved { .. },
                ..
            }
        ));
        assert!(matches!(
            envelopes[3].event,
            HostEvent::Activity {
                activity: HostActivity::TurnEnded {
                    outcome: TerminalOutcome::Completed,
                    ..
                },
                ..
            }
        ));
        for envelope in envelopes {
            let serialized = serde_json::to_string(&envelope).expect("serialize envelope");
            for raw in ["method", "params", "itemId", "requestId"] {
                assert!(!serialized.contains(raw));
            }
        }

        assert!(matches!(
            supervisor.shutdown().expect("shutdown"),
            ShutdownOutcome::Exited {
                forced: false,
                success: true
            }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_rejects_atomic_thread_binding_failures_and_prebind_exit_emits_nothing() {
        let (_fake, mut supervisor) = launch_fake(
            r#"
if [ "$#" -ne 3 ] || [ "$1" != "app-server" ] || [ "$2" != "--listen" ] || [ "$3" != "stdio://" ]; then exit 41; fi
read init || exit 42
printf '%s\n' '{"id":1,"result":{}}'
read initialized || exit 43
read start || exit 44
printf '%s\n' '{"id":2,"result":{"thread":{"sessionId":"only"}}}'
while read line; do :; done
"#
            .into(),
        );
        assert!(supervisor.start_new_thread().is_err());
        assert!(supervisor.stream.source.is_none());
        assert_eq!(
            supervisor.stream.prompt_readiness,
            PromptReadiness::AwaitingAuthoritative
        );
        assert_eq!(supervisor.stream.sequence, 0);
        assert!(supervisor.decoder.thread_id.is_none());
        let _ = supervisor.shutdown();

        let (_fake, mut exits_before_binding) = launch_fake(
            r#"
if [ "$#" -ne 3 ] || [ "$1" != "app-server" ] || [ "$2" != "--listen" ] || [ "$3" != "stdio://" ]; then exit 41; fi
read init || exit 42
printf '%s\n' '{"id":1,"result":{}}'
exit 0
"#
            .into(),
        );
        assert!(exits_before_binding.start_new_thread().is_err());
        assert!(exits_before_binding.stream.source.is_none());
        assert_eq!(
            exits_before_binding.stream.prompt_readiness,
            PromptReadiness::AwaitingAuthoritative
        );
        assert_eq!(exits_before_binding.stream.sequence, 0);
        assert!(exits_before_binding.decoder.thread_id.is_none());
        let _ = exits_before_binding.shutdown();
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_framing_bounds_are_strict_and_fail_closed() {
        let mut reader = BufReader::new(Cursor::new(b"{\"ok\":true}\r\n".as_slice()));
        assert_eq!(
            read_bounded_line(&mut reader, MAX_INBOUND_RECORD)
                .expect("bounded read")
                .expect("line"),
            b"{\"ok\":true}".to_vec()
        );
        let mut too_large = BufReader::new(Cursor::new(vec![b'x'; MAX_INBOUND_RECORD + 1]));
        assert!(read_bounded_line(&mut too_large, MAX_INBOUND_RECORD).is_err());

        let mut outbound = Vec::new();
        assert!(write_json_line(
            &mut outbound,
            &json!({"payload":"x".repeat(MAX_OUTBOUND_RECORD)})
        )
        .is_err());
        assert!(outbound.is_empty());

        let (_fake, mut supervisor) = launch_fake(
            r#"
if [ "$#" -ne 3 ] || [ "$1" != "app-server" ] || [ "$2" != "--listen" ] || [ "$3" != "stdio://" ]; then exit 41; fi
read init || exit 42
printf '%s\n' 'not-json'
while read line; do :; done
"#
            .into(),
        );
        assert!(supervisor.start_new_thread().is_err());
        assert!(supervisor.stream.source.is_none());
        assert_eq!(supervisor.stream.sequence, 0);
        let _ = supervisor.shutdown();
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_continuously_drains_stderr_during_handshake() {
        let chunk = "x".repeat(1024);
        let before_initialize = format!(
            r#"
chunk='{chunk}'
i=0
while [ "$i" -lt 512 ]; do
  printf '%s\n' "$chunk" >&2
  i=$((i + 1))
done
"#
        );
        let (_fake, mut supervisor) = launch_fake(successful_handshake_script_with_prefix(
            &before_initialize,
            "while read line; do :; done",
        ));

        let ready = supervisor.start_new_thread().expect("ready despite stderr");
        assert_eq!(ready.sequence, 1);
        assert_eq!(supervisor.stream.prompt_readiness, PromptReadiness::Ready);
        assert!(matches!(
            supervisor.shutdown().expect("shutdown"),
            ShutdownOutcome::Exited { forced: false, .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_failed_write_does_not_advance_handshake_state() {
        let (_fake, mut supervisor) = launch_fake("exec /usr/bin/tail -f /dev/null".into());
        drop(supervisor.stdin.take());

        assert!(supervisor.start_new_thread().is_err());
        assert!(supervisor.decoder.initialize_id.is_none());
        assert!(!supervisor.decoder.initialize_accepted);
        assert!(!supervisor.decoder.initialized);
        assert!(supervisor.decoder.thread_start_id.is_none());
        assert!(supervisor.stream.source.is_none());
        assert_eq!(
            supervisor.stream.prompt_readiness,
            PromptReadiness::AwaitingAuthoritative
        );
        assert_eq!(supervisor.stream.sequence, 0);
        let _ = supervisor.shutdown();
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_shutdown_is_graceful_forced_idempotent_and_drop_reaps() {
        let (_fake, mut graceful) =
            launch_fake(successful_handshake_script("while read line; do :; done"));
        graceful.start_new_thread().expect("ready graceful");
        assert!(matches!(
            graceful.shutdown().expect("graceful shutdown"),
            ShutdownOutcome::Exited {
                forced: false,
                success: true
            }
        ));
        assert_eq!(
            graceful.shutdown().expect("idempotent shutdown"),
            ShutdownOutcome::AlreadyClosed
        );

        let (_fake, mut forced) = launch_fake(successful_handshake_script(
            "exec /usr/bin/tail -f /dev/null",
        ));
        forced.start_new_thread().expect("ready forced");
        assert!(matches!(
            forced.shutdown().expect("forced shutdown"),
            ShutdownOutcome::Exited { forced: true, .. }
        ));
        assert_eq!(
            forced.shutdown().expect("forced idempotent shutdown"),
            ShutdownOutcome::AlreadyClosed
        );

        let fake = FakeCodex::new(&successful_handshake_script(
            "exec /usr/bin/tail -f /dev/null",
        ));
        let mut dropped =
            CodexAppServerSupervisor::launch(fake.config()).expect("launch drop fake");
        dropped.start_new_thread().expect("ready drop");
        let pid = dropped.child.as_ref().expect("child").id();
        drop(dropped);
        assert!(process_is_gone(pid));
        drop(fake);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires an explicitly authorized native Codex installation and authentication"]
    fn native_supervisor_handshake_smoke() {
        let executable = std::env::var_os("PELICAN_CODEX_SMOKE_EXECUTABLE")
            .map(PathBuf::from)
            .expect("set PELICAN_CODEX_SMOKE_EXECUTABLE");
        let workspace = std::env::var_os("PELICAN_CODEX_SMOKE_WORKSPACE")
            .map(PathBuf::from)
            .expect("set PELICAN_CODEX_SMOKE_WORKSPACE");
        let mut supervisor = CodexAppServerSupervisor::launch(SupervisorConfig::new(
            executable,
            workspace,
            "native-smoke-session".into(),
            "native-smoke-stream".into(),
        ))
        .expect("launch native Codex app-server");

        let ready = supervisor
            .start_new_thread()
            .expect("complete native Codex handshake");
        assert_eq!(ready.sequence, 1);
        assert!(matches!(
            ready.event,
            HostEvent::PromptReadinessChanged {
                prompt_readiness: PromptReadiness::Ready,
                ..
            }
        ));
        assert!(supervisor
            .stream
            .source
            .as_ref()
            .is_some_and(|source| !source.provider_session_id.is_empty()));
        assert!(matches!(
            supervisor.shutdown().expect("reap native Codex"),
            ShutdownOutcome::Exited {
                forced: false,
                success: true
            }
        ));
    }
}
