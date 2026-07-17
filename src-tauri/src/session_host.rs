use crate::terminal::{self, PtyEvent, PtyHandle, PtySpawnSpec, PtyStopWait, PtyStopper};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

mod codex_app_server;

const VERSION: u8 = 2;
const MAX_ID: usize = 256;
const MAX_ACTIVITY_KEY: usize = 512;
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
    Bound(Box<HostedBinding>),
}
struct HostedBinding {
    stream: StreamState,
    pty: Arc<Mutex<PtyHandle>>,
    stopper: PtyStopper,
    stop_accepted: bool,
    legacy: bool,
}

struct StreamState {
    agent_id: String,
    stream_id: String,
    sequence: u64,
    transport_kind: BindingTransport,
    source: Option<SourceIdentity>,
    current_turn: Option<TurnIdentity>,
    pending_attention_keys: HashSet<String>,
    turn_completed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BindingTransport {
    Pty,
    Protocol,
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
    Pty {
        lifecycle_evidence: LifecycleEvidence,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<SourceIdentity>,
    },
    Protocol {
        lifecycle_evidence: LifecycleEvidence,
        source: SourceIdentity,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum LifecycleEvidence {
    Fallback,
    Structured,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum SourceIntegration {
    AppServer,
    Hooks,
    Rpc,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
enum SourceProvenance {
    ProviderEvent,
    ProviderHandshake,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceIdentity {
    agent_id: String,
    integration: SourceIntegration,
    provider_session_id: String,
    provenance: SourceProvenance,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
enum TurnProvenance {
    ProviderTurn,
    ProviderPrompt,
    AdapterStream,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnIdentity {
    key: String,
    provenance: TurnProvenance,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityContext {
    turn: TurnIdentity,
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[allow(dead_code)]
enum CandidateActivity {
    TurnStarted {
        evidence: LifecycleEvidence,
    },
    AttentionRequested {
        evidence: LifecycleEvidence,
        key: String,
    },
    AttentionResolved {
        evidence: LifecycleEvidence,
        key: String,
    },
    TurnCompleted {
        evidence: LifecycleEvidence,
    },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
enum StructuredEvidence {
    Structured,
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum HostActivity {
    TurnStarted {
        evidence: StructuredEvidence,
    },
    AttentionRequested {
        evidence: StructuredEvidence,
        key: String,
    },
    AttentionResolved {
        evidence: StructuredEvidence,
        key: String,
    },
    TurnCompleted {
        evidence: StructuredEvidence,
    },
}
#[derive(Clone)]
struct StructuredActivityInput {
    source: SourceIdentity,
    context: ActivityContext,
    activity: CandidateActivity,
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
    Opened {
        transport: Transport,
    },
    Activity {
        source: SourceIdentity,
        context: ActivityContext,
        activity: HostActivity,
    },
    TerminalOutput {
        data: String,
    },
    Closed {
        outcome: CloseOutcome,
    },
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
        lifecycle_evidence: LifecycleEvidence::Fallback,
        source: None,
    };
    let stopper = pty.stopper();
    let binding = HostedBinding {
        stream: StreamState {
            agent_id: r.agent_id.clone(),
            stream_id: stream_id.clone(),
            sequence: 0,
            transport_kind: BindingTransport::Pty,
            source: None,
            current_turn: None,
            pending_attention_keys: HashSet::new(),
            turn_completed: false,
        },
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
) -> Result<(), (Box<HostedBinding>, String)> {
    let binding = Box::new(binding);
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

fn cleanup_spawned_binding(binding: Box<HostedBinding>) {
    if let Ok(wait) = binding.stopper.request_stop() {
        let _ = wait.wait();
    }
}

fn transport_for_stream(stream: &StreamState) -> Option<Transport> {
    match (&stream.transport_kind, &stream.source) {
        (BindingTransport::Pty, None) => Some(Transport::Pty {
            lifecycle_evidence: LifecycleEvidence::Fallback,
            source: None,
        }),
        (BindingTransport::Pty, Some(source)) => Some(Transport::Pty {
            lifecycle_evidence: LifecycleEvidence::Structured,
            source: Some(source.clone()),
        }),
        (BindingTransport::Protocol, Some(source)) => Some(Transport::Protocol {
            lifecycle_evidence: LifecycleEvidence::Structured,
            source: source.clone(),
        }),
        (BindingTransport::Protocol, None) => None,
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
    if binding.stream.stream_id != stream_id {
        return None;
    };
    binding.stream.sequence += 1;
    let sequence = binding.stream.sequence;
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
        Some(HostedEntry::Bound(binding)) if binding.stream.stream_id == stream_id
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
            HostedEntry::Bound(b) if !b.legacy => {
                transport_for_stream(&b.stream).map(|transport| HostedSessionSnapshot {
                    protocol_version: VERSION,
                    session_id: id.clone(),
                    stream_id: b.stream.stream_id.clone(),
                    last_sequence: b.stream.sequence,
                    transport,
                })
            }
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

fn expected_integration(agent_id: &str) -> Option<SourceIntegration> {
    match agent_id {
        "codex" => Some(SourceIntegration::AppServer),
        "claude-code" => Some(SourceIntegration::Hooks),
        "pi" => Some(SourceIntegration::Rpc),
        _ => None,
    }
}

fn expected_structured_transport(agent_id: &str) -> Option<BindingTransport> {
    match agent_id {
        "codex" | "pi" => Some(BindingTransport::Protocol),
        "claude-code" => Some(BindingTransport::Pty),
        _ => None,
    }
}

#[allow(dead_code)]
fn accept_structured_activity(
    session_id: &str,
    stream: &mut StreamState,
    input: StructuredActivityInput,
) -> Result<Envelope, String> {
    validate_identity(session_id, "Session ID")?;
    validate_structured_input(&input)?;
    validate_structured_binding(stream, &input.source)?;
    validate_activity_order(stream, &input)?;

    match &input.activity {
        CandidateActivity::TurnStarted { .. } => {
            stream.current_turn = Some(input.context.turn.clone());
            stream.pending_attention_keys.clear();
            stream.turn_completed = false;
        }
        CandidateActivity::AttentionRequested { key, .. } => {
            stream.pending_attention_keys.insert(key.clone());
        }
        CandidateActivity::AttentionResolved { key, .. } => {
            stream.pending_attention_keys.remove(key);
        }
        CandidateActivity::TurnCompleted { .. } => {
            stream.turn_completed = true;
        }
    }

    stream.sequence += 1;
    Ok(Envelope {
        protocol_version: VERSION,
        session_id: session_id.into(),
        stream_id: stream.stream_id.clone(),
        sequence: stream.sequence,
        event: HostEvent::Activity {
            source: input.source,
            context: input.context,
            activity: host_activity(input.activity),
        },
    })
}

fn host_activity(activity: CandidateActivity) -> HostActivity {
    match activity {
        CandidateActivity::TurnStarted { .. } => HostActivity::TurnStarted {
            evidence: StructuredEvidence::Structured,
        },
        CandidateActivity::AttentionRequested { key, .. } => HostActivity::AttentionRequested {
            evidence: StructuredEvidence::Structured,
            key,
        },
        CandidateActivity::AttentionResolved { key, .. } => HostActivity::AttentionResolved {
            evidence: StructuredEvidence::Structured,
            key,
        },
        CandidateActivity::TurnCompleted { .. } => HostActivity::TurnCompleted {
            evidence: StructuredEvidence::Structured,
        },
    }
}

fn validate_structured_input(input: &StructuredActivityInput) -> Result<(), String> {
    validate_identity(&input.source.agent_id, "Source agent ID")?;
    validate_identity(&input.source.provider_session_id, "Provider session ID")?;
    validate_activity_key(&input.context.turn.key, "Turn key")?;
    if activity_evidence(&input.activity) != &LifecycleEvidence::Structured {
        return Err("Host activity evidence must be structured".into());
    }
    if let Some(key) = activity_attention_key(&input.activity) {
        validate_activity_key(key, "Attention key")?;
    }
    Ok(())
}

fn validate_structured_binding(
    stream: &StreamState,
    source: &SourceIdentity,
) -> Result<(), String> {
    let Some(bound_source) = &stream.source else {
        return Err("Structured activity requires a structured source binding".into());
    };
    if stream.agent_id != source.agent_id || bound_source.agent_id != source.agent_id {
        return Err("Structured activity source agent does not match binding".into());
    }
    let Some(expected_integration) = expected_integration(&stream.agent_id) else {
        return Err("Structured activity source agent is unsupported".into());
    };
    if source.integration != expected_integration || bound_source.integration != source.integration
    {
        return Err("Structured activity source integration does not match binding".into());
    }
    let Some(expected_transport) = expected_structured_transport(&stream.agent_id) else {
        return Err("Structured activity transport is unsupported".into());
    };
    if stream.transport_kind != expected_transport {
        return Err("Structured activity transport does not match source integration".into());
    }
    if bound_source.provider_session_id != source.provider_session_id {
        return Err("Structured activity provider session does not match binding".into());
    }
    Ok(())
}

fn validate_activity_order(
    stream: &StreamState,
    input: &StructuredActivityInput,
) -> Result<(), String> {
    let turn = &input.context.turn;
    match &input.activity {
        CandidateActivity::TurnStarted { .. } => {
            if let Some(current_turn) = &stream.current_turn {
                if current_turn == turn {
                    return Err("Duplicate structured turn start".into());
                }
                if !stream.turn_completed || !stream.pending_attention_keys.is_empty() {
                    return Err("Structured turn start is out of order".into());
                }
            }
        }
        CandidateActivity::AttentionRequested { key, .. } => {
            require_current_turn(stream, turn)?;
            if stream.turn_completed {
                return Err("Structured attention request is stale".into());
            }
            if stream.pending_attention_keys.contains(key) {
                return Err("Duplicate structured attention request".into());
            }
        }
        CandidateActivity::AttentionResolved { key, .. } => {
            require_current_turn(stream, turn)?;
            if !stream.pending_attention_keys.contains(key) {
                return Err("Structured attention resolution is uncorrelated".into());
            }
        }
        CandidateActivity::TurnCompleted { .. } => {
            require_current_turn(stream, turn)?;
            if stream.turn_completed {
                return Err("Duplicate structured turn completion".into());
            }
        }
    }
    Ok(())
}

fn require_current_turn(stream: &StreamState, turn: &TurnIdentity) -> Result<(), String> {
    match &stream.current_turn {
        Some(current) if current == turn => Ok(()),
        Some(_) => Err("Structured activity turn does not match current turn".into()),
        None => Err("Structured activity arrived before turn establishment".into()),
    }
}

fn activity_evidence(activity: &CandidateActivity) -> &LifecycleEvidence {
    match activity {
        CandidateActivity::TurnStarted { evidence }
        | CandidateActivity::TurnCompleted { evidence }
        | CandidateActivity::AttentionRequested { evidence, .. }
        | CandidateActivity::AttentionResolved { evidence, .. } => evidence,
    }
}

fn activity_attention_key(activity: &CandidateActivity) -> Option<&str> {
    match activity {
        CandidateActivity::AttentionRequested { key, .. }
        | CandidateActivity::AttentionResolved { key, .. } => Some(key),
        CandidateActivity::TurnStarted { .. } | CandidateActivity::TurnCompleted { .. } => None,
    }
}

fn validate_activity_key(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.encode_utf16().count() > MAX_ACTIVITY_KEY
        || value.contains('\0')
        || value.chars().any(char::is_control)
    {
        Err(format!("{label} is invalid"))
    } else {
        Ok(())
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
    if b.stream.stream_id != stream {
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

    fn source(
        agent_id: &str,
        integration: SourceIntegration,
        provider_session_id: &str,
        provenance: SourceProvenance,
    ) -> SourceIdentity {
        SourceIdentity {
            agent_id: agent_id.into(),
            integration,
            provider_session_id: provider_session_id.into(),
            provenance,
        }
    }

    fn turn(key: &str) -> TurnIdentity {
        TurnIdentity {
            key: key.into(),
            provenance: TurnProvenance::ProviderTurn,
        }
    }

    fn stream_state(
        agent_id: &str,
        transport_kind: BindingTransport,
        source: Option<SourceIdentity>,
    ) -> StreamState {
        StreamState {
            agent_id: agent_id.into(),
            stream_id: "stream-1".into(),
            sequence: 0,
            transport_kind,
            source,
            current_turn: None,
            pending_attention_keys: HashSet::new(),
            turn_completed: false,
        }
    }

    fn input(
        source: SourceIdentity,
        turn: TurnIdentity,
        activity: CandidateActivity,
    ) -> StructuredActivityInput {
        StructuredActivityInput {
            source,
            context: ActivityContext { turn },
            activity,
        }
    }

    fn turn_started() -> CandidateActivity {
        CandidateActivity::TurnStarted {
            evidence: LifecycleEvidence::Structured,
        }
    }

    fn turn_completed() -> CandidateActivity {
        CandidateActivity::TurnCompleted {
            evidence: LifecycleEvidence::Structured,
        }
    }

    fn attention_requested(key: &str) -> CandidateActivity {
        CandidateActivity::AttentionRequested {
            evidence: LifecycleEvidence::Structured,
            key: key.into(),
        }
    }

    fn attention_resolved(key: &str) -> CandidateActivity {
        CandidateActivity::AttentionResolved {
            evidence: LifecycleEvidence::Structured,
            key: key.into(),
        }
    }

    #[test]
    fn serialization_matches_v2() {
        let value = serde_json::to_value(HostedSessionSnapshot {
            protocol_version: VERSION,
            session_id: "s".into(),
            stream_id: "stream-1".into(),
            last_sequence: 0,
            transport: Transport::Pty {
                lifecycle_evidence: LifecycleEvidence::Fallback,
                source: None,
            },
        })
        .unwrap();
        assert_eq!(value["protocolVersion"], 2);
        assert_eq!(value["transport"]["type"], "pty");
        assert_eq!(value["transport"]["lifecycleEvidence"], "fallback");
        assert!(value["transport"].get("source").is_none());

        let structured = serde_json::to_value(HostedSessionSnapshot {
            protocol_version: VERSION,
            session_id: "s".into(),
            stream_id: "stream-1".into(),
            last_sequence: 1,
            transport: Transport::Protocol {
                lifecycle_evidence: LifecycleEvidence::Structured,
                source: source(
                    "codex",
                    SourceIntegration::AppServer,
                    "codex-thread-1",
                    SourceProvenance::ProviderHandshake,
                ),
            },
        })
        .unwrap();
        assert_eq!(structured["transport"]["type"], "protocol");
        assert_eq!(structured["transport"]["lifecycleEvidence"], "structured");
        assert_eq!(structured["transport"]["source"]["agentId"], "codex");
        assert_eq!(
            structured["transport"]["source"]["integration"],
            "app-server"
        );
        assert_eq!(
            structured["transport"]["source"]["providerSessionId"],
            "codex-thread-1"
        );
        assert_eq!(
            structured["transport"]["source"]["provenance"],
            "provider-handshake"
        );
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

    #[test]
    fn structured_gate_accepts_valid_codex_claude_and_pi_identity_modes() {
        let cases = [
            (
                "codex",
                SourceIntegration::AppServer,
                BindingTransport::Protocol,
                "codex-thread",
            ),
            (
                "claude-code",
                SourceIntegration::Hooks,
                BindingTransport::Pty,
                "claude-session",
            ),
            (
                "pi",
                SourceIntegration::Rpc,
                BindingTransport::Protocol,
                "pi-session",
            ),
        ];

        for (agent_id, integration, transport, provider_session_id) in cases {
            let bound_source = source(
                agent_id,
                integration.clone(),
                provider_session_id,
                SourceProvenance::ProviderHandshake,
            );
            let event_source = source(
                agent_id,
                integration,
                provider_session_id,
                SourceProvenance::ProviderEvent,
            );
            let mut stream = stream_state(agent_id, transport, Some(bound_source));

            let envelope = accept_structured_activity(
                "session-1",
                &mut stream,
                input(event_source, turn("turn-1"), turn_started()),
            )
            .expect("valid structured activity");

            assert_eq!(envelope.protocol_version, VERSION);
            assert_eq!(envelope.sequence, 1);
            assert_eq!(stream.sequence, 1);
            assert_eq!(stream.current_turn, Some(turn("turn-1")));
        }
    }

    #[test]
    fn structured_gate_rejects_wrong_source_session_integration_and_turn_without_sequence() {
        let bound_source = source(
            "codex",
            SourceIntegration::AppServer,
            "codex-thread",
            SourceProvenance::ProviderHandshake,
        );
        let event_source = source(
            "codex",
            SourceIntegration::AppServer,
            "codex-thread",
            SourceProvenance::ProviderEvent,
        );
        let mut stream = stream_state("codex", BindingTransport::Protocol, Some(bound_source));

        assert!(accept_structured_activity(
            "session-1",
            &mut stream,
            input(
                source(
                    "pi",
                    SourceIntegration::Rpc,
                    "codex-thread",
                    SourceProvenance::ProviderEvent,
                ),
                turn("turn-1"),
                turn_started(),
            ),
        )
        .is_err());
        assert_eq!(stream.sequence, 0);

        assert!(accept_structured_activity(
            "session-1",
            &mut stream,
            input(
                source(
                    "codex",
                    SourceIntegration::AppServer,
                    "other-thread",
                    SourceProvenance::ProviderEvent,
                ),
                turn("turn-1"),
                turn_started(),
            ),
        )
        .is_err());
        assert_eq!(stream.sequence, 0);

        assert!(accept_structured_activity(
            "session-1",
            &mut stream,
            input(
                source(
                    "codex",
                    SourceIntegration::Hooks,
                    "codex-thread",
                    SourceProvenance::ProviderEvent,
                ),
                turn("turn-1"),
                turn_started(),
            ),
        )
        .is_err());
        assert_eq!(stream.sequence, 0);

        accept_structured_activity(
            "session-1",
            &mut stream,
            input(event_source.clone(), turn("turn-1"), turn_started()),
        )
        .expect("turn starts");
        assert_eq!(stream.sequence, 1);

        assert!(accept_structured_activity(
            "session-1",
            &mut stream,
            input(event_source, turn("turn-2"), turn_completed()),
        )
        .is_err());
        assert_eq!(stream.sequence, 1);
    }

    #[test]
    fn structured_gate_rejects_fallback_binding_and_fallback_evidence_without_sequence() {
        let event_source = source(
            "codex",
            SourceIntegration::AppServer,
            "codex-thread",
            SourceProvenance::ProviderEvent,
        );
        let mut fallback = stream_state("codex", BindingTransport::Pty, None);
        assert!(accept_structured_activity(
            "session-1",
            &mut fallback,
            input(event_source.clone(), turn("turn-1"), turn_started()),
        )
        .is_err());
        assert_eq!(fallback.sequence, 0);

        let bound_source = source(
            "codex",
            SourceIntegration::AppServer,
            "codex-thread",
            SourceProvenance::ProviderHandshake,
        );
        let mut structured = stream_state("codex", BindingTransport::Protocol, Some(bound_source));
        assert!(accept_structured_activity(
            "session-1",
            &mut structured,
            input(
                event_source,
                turn("turn-1"),
                CandidateActivity::TurnStarted {
                    evidence: LifecycleEvidence::Fallback,
                },
            ),
        )
        .is_err());
        assert_eq!(structured.sequence, 0);
    }

    #[test]
    fn structured_gate_correlates_attention_completion_and_new_turn_order() {
        let bound_source = source(
            "codex",
            SourceIntegration::AppServer,
            "codex-thread",
            SourceProvenance::ProviderHandshake,
        );
        let event_source = source(
            "codex",
            SourceIntegration::AppServer,
            "codex-thread",
            SourceProvenance::ProviderEvent,
        );
        let mut stream = stream_state("codex", BindingTransport::Protocol, Some(bound_source));

        assert!(accept_structured_activity(
            "session-1",
            &mut stream,
            input(event_source.clone(), turn("turn-1"), turn_completed()),
        )
        .is_err());
        assert_eq!(stream.sequence, 0);

        accept_structured_activity(
            "session-1",
            &mut stream,
            input(event_source.clone(), turn("turn-1"), turn_started()),
        )
        .expect("turn start accepted");
        assert_eq!(stream.sequence, 1);

        assert!(accept_structured_activity(
            "session-1",
            &mut stream,
            input(event_source.clone(), turn("turn-1"), turn_started()),
        )
        .is_err());
        assert_eq!(stream.sequence, 1);

        accept_structured_activity(
            "session-1",
            &mut stream,
            input(
                event_source.clone(),
                turn("turn-1"),
                attention_requested("approval-1"),
            ),
        )
        .expect("attention request accepted");
        assert_eq!(stream.sequence, 2);

        assert!(accept_structured_activity(
            "session-1",
            &mut stream,
            input(
                event_source.clone(),
                turn("turn-1"),
                attention_requested("approval-1")
            ),
        )
        .is_err());
        assert_eq!(stream.sequence, 2);

        assert!(accept_structured_activity(
            "session-1",
            &mut stream,
            input(
                event_source.clone(),
                turn("turn-1"),
                attention_resolved("unknown")
            ),
        )
        .is_err());
        assert_eq!(stream.sequence, 2);

        accept_structured_activity(
            "session-1",
            &mut stream,
            input(event_source.clone(), turn("turn-1"), turn_completed()),
        )
        .expect("completion accepted while attention remains pending");
        assert_eq!(stream.sequence, 3);
        assert!(stream.turn_completed);

        assert!(accept_structured_activity(
            "session-1",
            &mut stream,
            input(event_source.clone(), turn("turn-1"), turn_completed()),
        )
        .is_err());
        assert_eq!(stream.sequence, 3);

        assert!(accept_structured_activity(
            "session-1",
            &mut stream,
            input(event_source.clone(), turn("turn-2"), turn_started()),
        )
        .is_err());
        assert_eq!(stream.sequence, 3);

        accept_structured_activity(
            "session-1",
            &mut stream,
            input(
                event_source.clone(),
                turn("turn-1"),
                attention_resolved("approval-1"),
            ),
        )
        .expect("pending attention resolution accepted after completion");
        assert_eq!(stream.sequence, 4);

        accept_structured_activity(
            "session-1",
            &mut stream,
            input(event_source.clone(), turn("turn-2"), turn_started()),
        )
        .expect("new turn accepted after completed turn is clear");
        assert_eq!(stream.sequence, 5);

        assert!(accept_structured_activity(
            "session-1",
            &mut stream,
            input(event_source, turn("turn-1"), turn_completed()),
        )
        .is_err());
        assert_eq!(stream.sequence, 5);
    }
}
