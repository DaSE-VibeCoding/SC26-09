//! Narrow, fixture-only decoder for Pi's RPC/session lifecycle protocol.

#![allow(dead_code)]

use super::*;
use serde_json::{Map, Value};
use std::collections::HashMap;

const MAX_RECORD: usize = 1024 * 1024;

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
enum RpcId {
    Integer(i64),
    String(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    Outbound,
    Inbound,
}

#[derive(Clone)]
struct SessionHeader {
    version: u64,
    id: String,
    timestamp: String,
    cwd: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UiMethod {
    Select,
    Confirm,
    Input,
    Editor,
}

#[derive(Clone)]
struct PendingUi {
    method: UiMethod,
    key: String,
    turn: TurnIdentity,
}

#[derive(Clone, Default)]
struct Epoch {
    id: Option<RpcId>,
    accepted: bool,
    started: bool,
    early_start: bool,
    stop_reason: Option<String>,
    settled: bool,
}

enum DecodeOutput {
    Ignored,
    Bound,
    Activity(Envelope),
}

struct Decoder {
    expected_path: String,
    expected_workspace: String,
    header: SessionHeader,
    get_state_id: Option<RpcId>,
    provider_session_id: Option<String>,
    epoch: Epoch,
    pending_ui: HashMap<RpcId, PendingUi>,
}

impl Decoder {
    fn new(expected_path: String, expected_workspace: String, header: SessionHeader) -> Self {
        Self {
            expected_path,
            expected_workspace,
            header,
            get_state_id: None,
            provider_session_id: None,
            epoch: Epoch::default(),
            pending_ui: HashMap::new(),
        }
    }

    fn decode(
        &mut self,
        direction: Direction,
        message: Value,
        session_id: &str,
        stream: &mut StreamState,
    ) -> Result<DecodeOutput, String> {
        let object = message
            .as_object()
            .ok_or_else(|| "Pi RPC record must be an object".to_string())?;
        let kind = required_string(object, "type")?;
        match (direction, kind) {
            (Direction::Outbound, "get_state") => self.get_state_request(object),
            (Direction::Inbound, "response") => self.response(object, session_id, stream),
            (Direction::Outbound, "prompt") => self.prompt(object),
            (Direction::Outbound, "steer" | "follow_up") => {
                Err("Queued Pi prompts are unsupported".into())
            }
            (Direction::Inbound, "agent_start") => self.agent_start(session_id, stream),
            (Direction::Inbound, "turn_end") => self.turn_end(object),
            (Direction::Inbound, "agent_settled") => self.agent_settled(session_id, stream),
            (Direction::Inbound, "extension_ui_request") => {
                self.ui_request(object, session_id, stream)
            }
            (Direction::Outbound, "extension_ui_response") => {
                self.ui_response(object, session_id, stream)
            }
            (
                _,
                "agent_end" | "auto_retry_start" | "auto_retry_end" | "compaction_start"
                | "compaction_end" | "queue_update",
            ) => Ok(DecodeOutput::Ignored),
            _ => Ok(DecodeOutput::Ignored),
        }
    }

    fn get_state_request(&mut self, o: &Map<String, Value>) -> Result<DecodeOutput, String> {
        if self.get_state_id.is_some() || self.provider_session_id.is_some() {
            return Err("Pi get_state is out of order".into());
        }
        let id = required_id(o)?;
        self.get_state_id = Some(id);
        Ok(DecodeOutput::Ignored)
    }

    fn response(
        &mut self,
        o: &Map<String, Value>,
        session_id: &str,
        stream: &mut StreamState,
    ) -> Result<DecodeOutput, String> {
        let id = required_id(o)?;
        let command = required_string(o, "command")?;
        let success = o
            .get("success")
            .and_then(Value::as_bool)
            .ok_or("Missing Pi success")?;
        if self.get_state_id.as_ref() == Some(&id) {
            if command != "get_state" || !success || self.provider_session_id.is_some() {
                return Err("Pi get_state response is not an exact success".into());
            }
            let data = o
                .get("data")
                .and_then(Value::as_object)
                .ok_or("Missing Pi state")?;
            let provider_id = required_string(data, "sessionId")?;
            let path = required_string(data, "sessionFile")?;
            validate_identity(provider_id, "Provider session ID")?;
            if !Path::new(path).is_absolute()
                || path != self.expected_path
                || self.header.version != 3
                || self.header.id != provider_id
                || self.header.cwd != self.expected_workspace
                || self.header.timestamp.is_empty()
                || stream.agent_id != "pi"
                || stream.transport_kind != BindingTransport::Protocol
                || stream.source.is_some()
            {
                return Err("Pi session identity handshake does not match".into());
            }
            stream.source = Some(SourceIdentity {
                agent_id: "pi".into(),
                integration: SourceIntegration::Rpc,
                provider_session_id: provider_id.into(),
                provenance: SourceProvenance::ProviderHandshake,
            });
            self.get_state_id = None;
            self.provider_session_id = Some(provider_id.into());
            return Ok(DecodeOutput::Bound);
        }
        if self.epoch.id.as_ref() == Some(&id) {
            if command != "prompt" || self.epoch.accepted || self.epoch.settled {
                return Err("Pi prompt response is stale or mismatched".into());
            }
            if !success {
                self.epoch = Epoch::default();
                return Ok(DecodeOutput::Ignored);
            }
            if self.epoch.early_start {
                let output = self.emit_start(session_id, stream)?;
                self.epoch.accepted = true;
                return Ok(output);
            }
            self.epoch.accepted = true;
        }
        Ok(DecodeOutput::Ignored)
    }

    fn prompt(&mut self, o: &Map<String, Value>) -> Result<DecodeOutput, String> {
        self.require_bound()?;
        if o.contains_key("streamingBehavior")
            || self.epoch.id.is_some()
            || !self.pending_ui.is_empty()
        {
            return Err("Concurrent or queued Pi prompt is unsupported".into());
        }
        self.epoch.id = Some(required_id(o)?);
        Ok(DecodeOutput::Ignored)
    }

    fn agent_start(
        &mut self,
        session_id: &str,
        stream: &mut StreamState,
    ) -> Result<DecodeOutput, String> {
        self.require_bound()?;
        if self.epoch.id.is_none() || self.epoch.started || self.epoch.early_start {
            return Err("Pi agent_start is uncorrelated or duplicate".into());
        }
        if !self.epoch.accepted {
            self.epoch.early_start = true;
            return Ok(DecodeOutput::Ignored);
        }
        self.emit_start(session_id, stream)
    }

    fn emit_start(
        &mut self,
        session_id: &str,
        stream: &mut StreamState,
    ) -> Result<DecodeOutput, String> {
        let turn = self.turn()?;
        let envelope = accept_structured_activity(
            session_id,
            stream,
            self.activity(
                turn,
                CandidateActivity::TurnStarted {
                    evidence: LifecycleEvidence::Structured,
                },
            ),
        )?;
        self.epoch.started = true;
        self.epoch.early_start = false;
        Ok(DecodeOutput::Activity(envelope))
    }

    fn turn_end(&mut self, o: &Map<String, Value>) -> Result<DecodeOutput, String> {
        if !self.epoch.started || self.epoch.settled {
            return Err("Pi turn_end is stale".into());
        }
        let message = o
            .get("message")
            .and_then(Value::as_object)
            .ok_or("Missing Pi turn message")?;
        let reason = required_string(message, "stopReason")?;
        if !matches!(reason, "stop" | "length" | "error" | "aborted" | "toolUse") {
            return Err("Unknown Pi stopReason".into());
        }
        // Retries and tool use can produce multiple turns in one prompt epoch.
        // Settlement is authoritative, so retain the latest validated candidate.
        self.epoch.stop_reason = Some(reason.into());
        Ok(DecodeOutput::Ignored)
    }

    fn agent_settled(
        &mut self,
        session_id: &str,
        stream: &mut StreamState,
    ) -> Result<DecodeOutput, String> {
        if !self.epoch.started || self.epoch.settled {
            return Err("Pi settlement is stale".into());
        }
        let outcome = match self.epoch.stop_reason.as_deref() {
            Some("stop" | "length") => TerminalOutcome::Completed,
            Some("error") => TerminalOutcome::Failed,
            Some("aborted") => TerminalOutcome::Interrupted,
            Some("toolUse") | None => return Ok(DecodeOutput::Ignored),
            Some(_) => return Err("Unknown Pi settlement candidate".into()),
        };
        let turn = self.turn()?;
        let envelope = accept_structured_activity(
            session_id,
            stream,
            self.activity(
                turn,
                CandidateActivity::TurnEnded {
                    evidence: LifecycleEvidence::Structured,
                    outcome,
                },
            ),
        )?;
        self.epoch.settled = true;
        if self.pending_ui.is_empty() {
            self.epoch = Epoch::default();
        }
        Ok(DecodeOutput::Activity(envelope))
    }

    fn ui_request(
        &mut self,
        o: &Map<String, Value>,
        session_id: &str,
        stream: &mut StreamState,
    ) -> Result<DecodeOutput, String> {
        self.require_bound()?;
        let method = match required_string(o, "method")? {
            "select" => UiMethod::Select,
            "confirm" => UiMethod::Confirm,
            "input" => UiMethod::Input,
            "editor" => UiMethod::Editor,
            "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" => {
                return Ok(DecodeOutput::Ignored)
            }
            _ => return Ok(DecodeOutput::Ignored),
        };
        if o.contains_key("timeout") {
            return Ok(DecodeOutput::Ignored);
        }
        if !self.epoch.started || self.epoch.settled {
            return Err("Pi UI request has no active epoch".into());
        }
        let id = required_id(o)?;
        if self.pending_ui.contains_key(&id) {
            return Err("Duplicate Pi UI request".into());
        }
        let key = id_key("pi-ui", &id)?;
        let turn = self.turn()?;
        let envelope = accept_structured_activity(
            session_id,
            stream,
            self.activity(
                turn.clone(),
                CandidateActivity::AttentionRequested {
                    evidence: LifecycleEvidence::Structured,
                    key: key.clone(),
                },
            ),
        )?;
        self.pending_ui.insert(id, PendingUi { method, key, turn });
        Ok(DecodeOutput::Activity(envelope))
    }

    fn ui_response(
        &mut self,
        o: &Map<String, Value>,
        session_id: &str,
        stream: &mut StreamState,
    ) -> Result<DecodeOutput, String> {
        let id = required_id(o)?;
        let pending = self
            .pending_ui
            .get(&id)
            .cloned()
            .ok_or("Unknown Pi UI response")?;
        let cancelled = o.get("cancelled") == Some(&Value::Bool(true));
        let compatible = match pending.method {
            UiMethod::Confirm => o.get("confirmed").and_then(Value::as_bool).is_some() || cancelled,
            UiMethod::Select | UiMethod::Input | UiMethod::Editor => {
                o.get("value").and_then(Value::as_str).is_some() || cancelled
            }
        };
        if !compatible {
            return Err("Pi UI response shape is incompatible".into());
        }
        let envelope = accept_structured_activity(
            session_id,
            stream,
            self.activity(
                pending.turn,
                CandidateActivity::AttentionResolved {
                    evidence: LifecycleEvidence::Structured,
                    key: pending.key,
                },
            ),
        )?;
        self.pending_ui.remove(&id);
        if self.epoch.settled && self.pending_ui.is_empty() {
            self.epoch = Epoch::default();
        }
        Ok(DecodeOutput::Activity(envelope))
    }

    fn require_bound(&self) -> Result<(), String> {
        self.provider_session_id
            .as_ref()
            .map(|_| ())
            .ok_or_else(|| "Pi RPC is not bound".into())
    }
    fn turn(&self) -> Result<TurnIdentity, String> {
        Ok(TurnIdentity {
            key: id_key(
                "pi-prompt",
                self.epoch.id.as_ref().ok_or("Missing Pi prompt ID")?,
            )?,
            provenance: TurnProvenance::ProviderPrompt,
        })
    }
    fn activity(&self, turn: TurnIdentity, activity: CandidateActivity) -> StructuredActivityInput {
        StructuredActivityInput {
            source: SourceIdentity {
                agent_id: "pi".into(),
                integration: SourceIntegration::Rpc,
                provider_session_id: self.provider_session_id.clone().unwrap_or_default(),
                provenance: SourceProvenance::ProviderEvent,
            },
            context: ActivityContext { turn },
            activity,
        }
    }
}

fn required_string<'a>(o: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    o.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing Pi {key}"))
}
fn required_id(o: &Map<String, Value>) -> Result<RpcId, String> {
    parse_id(o.get("id").ok_or("Missing Pi RPC ID")?)
}
fn parse_id(v: &Value) -> Result<RpcId, String> {
    match v {
        Value::String(s) if s.encode_utf16().count() <= MAX_ID => Ok(RpcId::String(s.clone())),
        Value::String(_) => Err("Pi RPC ID is too long".into()),
        Value::Number(n) => n
            .as_i64()
            .map(RpcId::Integer)
            .ok_or_else(|| "Pi RPC ID must be an integer".into()),
        _ => Err("Pi RPC ID must be a string or integer".into()),
    }
}
fn id_key(prefix: &str, id: &RpcId) -> Result<String, String> {
    let key = match id {
        RpcId::Integer(i) => format!("{prefix}:i:{i}"),
        RpcId::String(s) => format!(
            "{prefix}:s:{}",
            serde_json::to_string(s).map_err(|_| "Invalid Pi ID")?
        ),
    };
    validate_activity_key(&key, "Pi activity key")?;
    Ok(key)
}

fn decode_jsonl(input: &[u8]) -> Vec<Result<Value, String>> {
    input
        .split(|b| *b == b'\n')
        .filter(|r| !r.is_empty())
        .map(|raw| {
            let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
            if raw.len() > MAX_RECORD {
                return Err("Pi RPC record is too large".into());
            }
            serde_json::from_slice(raw).map_err(|_| "Malformed Pi RPC record".into())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stream() -> StreamState {
        StreamState {
            agent_id: "pi".into(),
            stream_id: "st".into(),
            sequence: 0,
            transport_kind: BindingTransport::Protocol,
            source: None,
            current_turn: None,
            pending_attention_keys: HashSet::new(),
            terminal_outcome: None,
        }
    }
    fn decoder() -> Decoder {
        Decoder::new(
            "/tmp/pi/session.jsonl".into(),
            "/work".into(),
            SessionHeader {
                version: 3,
                id: "pid".into(),
                timestamp: "now".into(),
                cwd: "/work".into(),
            },
        )
    }
    fn bind(d: &mut Decoder, s: &mut StreamState) {
        d.decode(
            Direction::Outbound,
            json!({"type":"get_state","id":7}),
            "host",
            s,
        )
        .unwrap();
        d.decode(Direction::Inbound,json!({"id":7,"type":"response","command":"get_state","success":true,"data":{"sessionId":"pid","sessionFile":"/tmp/pi/session.jsonl"}}),"host",s).unwrap();
    }
    fn start(d: &mut Decoder, s: &mut StreamState, id: Value) {
        d.decode(
            Direction::Outbound,
            json!({"type":"prompt","id":id,"message":"secret"}),
            "host",
            s,
        )
        .unwrap();
        let id = d.epoch.id.clone().unwrap();
        let v = match id {
            RpcId::Integer(i) => json!(i),
            RpcId::String(x) => json!(x),
        };
        d.decode(
            Direction::Inbound,
            json!({"id":v,"type":"response","command":"prompt","success":true}),
            "host",
            s,
        )
        .unwrap();
        d.decode(Direction::Inbound, json!({"type":"agent_start"}), "host", s)
            .unwrap();
    }

    #[test]
    fn framing_is_strict_bounded_and_unicode_safe() {
        let rs = decode_jsonl("{\"x\":\"a\u{2028}b\u{2029}c\"}\r\nnot-json\n".as_bytes());
        assert_eq!(rs.len(), 2);
        assert_eq!(rs[0].as_ref().unwrap()["x"], "a\u{2028}b\u{2029}c");
        assert!(rs[1].is_err());
        assert!(decode_jsonl(&vec![b'x'; MAX_RECORD + 1])[0].is_err());
    }
    #[test]
    fn exact_bind_and_typed_correlation() {
        let mut d = decoder();
        let mut s = stream();
        d.decode(
            Direction::Outbound,
            json!({"type":"get_state","id":7}),
            "h",
            &mut s,
        )
        .unwrap();
        assert!(d.decode(Direction::Inbound,json!({"id":"7","type":"response","command":"get_state","success":true,"data":{"sessionId":"pid","sessionFile":"/tmp/pi/session.jsonl"}}),"h",&mut s).is_ok());
        assert!(s.source.is_none());
        d.decode(Direction::Inbound,json!({"id":7,"type":"response","command":"get_state","success":true,"data":{"sessionId":"pid","sessionFile":"/tmp/pi/session.jsonl"}}),"h",&mut s).unwrap();
        assert_eq!(s.source.unwrap().provider_session_id, "pid");
    }
    #[test]
    fn bind_rejection_is_atomic() {
        for bad in [
            json!({"id":1,"type":"response","command":"wrong","success":true,"data":{"sessionId":"pid","sessionFile":"/tmp/pi/session.jsonl"}}),
            json!({"id":1,"type":"response","command":"get_state","success":false,"data":{"sessionId":"pid","sessionFile":"/tmp/pi/session.jsonl"}}),
            json!({"id":1,"type":"response","command":"get_state","success":true,"data":{"sessionId":"wrong","sessionFile":"relative"}}),
        ] {
            let mut d = decoder();
            let mut s = stream();
            d.decode(
                Direction::Outbound,
                json!({"type":"get_state","id":1}),
                "h",
                &mut s,
            )
            .unwrap();
            assert!(d.decode(Direction::Inbound, bad, "h", &mut s).is_err());
            assert!(s.source.is_none());
            assert_eq!(s.sequence, 0);
        }
    }
    #[test]
    fn early_start_waits_for_prompt_acceptance_and_ids_differ() {
        let mut d = decoder();
        let mut s = stream();
        bind(&mut d, &mut s);
        d.decode(
            Direction::Outbound,
            json!({"type":"prompt","id":"7","message":"private"}),
            "h",
            &mut s,
        )
        .unwrap();
        d.decode(
            Direction::Inbound,
            json!({"type":"agent_start"}),
            "h",
            &mut s,
        )
        .unwrap();
        assert_eq!(s.sequence, 0);
        let out = d
            .decode(
                Direction::Inbound,
                json!({"id":"7","type":"response","command":"prompt","success":true}),
                "h",
                &mut s,
            )
            .unwrap();
        assert!(matches!(out, DecodeOutput::Activity(_)));
        assert_eq!(s.current_turn.unwrap().key, "pi-prompt:s:\"7\"");
    }
    #[test]
    fn concurrency_and_queueing_are_rejected() {
        let mut d = decoder();
        let mut s = stream();
        bind(&mut d, &mut s);
        d.decode(
            Direction::Outbound,
            json!({"type":"prompt","id":7,"message":"x"}),
            "h",
            &mut s,
        )
        .unwrap();
        for m in [
            json!({"type":"prompt","id":8,"message":"x"}),
            json!({"type":"steer","id":8}),
            json!({"type":"follow_up","id":8}),
        ] {
            assert!(d.decode(Direction::Outbound, m, "h", &mut s).is_err());
        }
    }
    #[test]
    fn settlement_matrix_and_ignored_intermediate_events() {
        for (reason, outcome) in [
            ("stop", Some(TerminalOutcome::Completed)),
            ("length", Some(TerminalOutcome::Completed)),
            ("error", Some(TerminalOutcome::Failed)),
            ("aborted", Some(TerminalOutcome::Interrupted)),
            ("toolUse", None),
        ] {
            let mut d = decoder();
            let mut s = stream();
            bind(&mut d, &mut s);
            start(&mut d, &mut s, json!(1));
            for t in ["agent_end", "auto_retry_start", "compaction_start"] {
                d.decode(Direction::Inbound, json!({"type":t}), "h", &mut s)
                    .unwrap();
            }
            d.decode(Direction::Inbound,json!({"type":"turn_end","message":{"stopReason":reason,"secret":"no"},"toolResults":["no"]}),"h",&mut s).unwrap();
            let before = s.sequence;
            d.decode(
                Direction::Inbound,
                json!({"type":"agent_settled"}),
                "h",
                &mut s,
            )
            .unwrap();
            assert_eq!(s.terminal_outcome, outcome);
            assert_eq!(s.sequence, before + usize::from(outcome.is_some()) as u64);
        }
    }
    #[test]
    fn final_turn_end_controls_settlement_after_retry_or_tool_use() {
        for first_reason in ["error", "toolUse"] {
            let mut d = decoder();
            let mut s = stream();
            bind(&mut d, &mut s);
            start(&mut d, &mut s, json!(1));
            d.decode(
                Direction::Inbound,
                json!({"type":"turn_end","message":{"stopReason":first_reason}}),
                "h",
                &mut s,
            )
            .unwrap();
            d.decode(
                Direction::Inbound,
                json!({"type":"auto_retry_start"}),
                "h",
                &mut s,
            )
            .unwrap();
            d.decode(
                Direction::Inbound,
                json!({"type":"turn_end","message":{"stopReason":"stop"}}),
                "h",
                &mut s,
            )
            .unwrap();
            d.decode(
                Direction::Inbound,
                json!({"type":"agent_settled"}),
                "h",
                &mut s,
            )
            .unwrap();

            assert_eq!(s.terminal_outcome, Some(TerminalOutcome::Completed));
            assert_eq!(s.sequence, 2);
        }
    }
    #[test]
    fn attention_shapes_timeouts_and_fire_and_forget() {
        let mut d = decoder();
        let mut s = stream();
        bind(&mut d, &mut s);
        start(&mut d, &mut s, json!(1));
        for method in [
            "notify",
            "setStatus",
            "setWidget",
            "setTitle",
            "set_editor_text",
        ] {
            d.decode(
                Direction::Inbound,
                json!({"type":"extension_ui_request","id":method,"method":method}),
                "h",
                &mut s,
            )
            .unwrap();
        }
        d.decode(
            Direction::Inbound,
            json!({"type":"extension_ui_request","id":"timed","method":"confirm","timeout":1}),
            "h",
            &mut s,
        )
        .unwrap();
        assert!(d.pending_ui.is_empty());
        d.decode(
            Direction::Inbound,
            json!({"type":"extension_ui_request","id":7,"method":"confirm","message":"secret"}),
            "h",
            &mut s,
        )
        .unwrap();
        assert!(d
            .decode(
                Direction::Outbound,
                json!({"type":"extension_ui_response","id":7,"value":"bad"}),
                "h",
                &mut s
            )
            .is_err());
        d.decode(
            Direction::Outbound,
            json!({"type":"extension_ui_response","id":7,"confirmed":true}),
            "h",
            &mut s,
        )
        .unwrap();
        assert!(d.pending_ui.is_empty());
    }
    #[test]
    fn attention_can_resolve_after_terminal_outcome() {
        let mut d = decoder();
        let mut s = stream();
        bind(&mut d, &mut s);
        start(&mut d, &mut s, json!(1));
        d.decode(
            Direction::Inbound,
            json!({"type":"extension_ui_request","id":"u","method":"input"}),
            "h",
            &mut s,
        )
        .unwrap();
        d.decode(
            Direction::Inbound,
            json!({"type":"turn_end","message":{"stopReason":"stop"}}),
            "h",
            &mut s,
        )
        .unwrap();
        d.decode(
            Direction::Inbound,
            json!({"type":"agent_settled"}),
            "h",
            &mut s,
        )
        .unwrap();
        assert!(d
            .decode(
                Direction::Outbound,
                json!({"type":"prompt","id":2,"message":"x"}),
                "h",
                &mut s
            )
            .is_err());
        d.decode(
            Direction::Outbound,
            json!({"type":"extension_ui_response","id":"u","cancelled":true}),
            "h",
            &mut s,
        )
        .unwrap();
        d.decode(
            Direction::Outbound,
            json!({"type":"prompt","id":2,"message":"x"}),
            "h",
            &mut s,
        )
        .unwrap();
    }
    #[test]
    fn malformed_stale_and_private_payloads_do_not_leak_or_mutate() {
        let mut d = decoder();
        let mut s = stream();
        bind(&mut d, &mut s);
        start(&mut d, &mut s, json!(7));
        let before = s.sequence;
        assert!(d
            .decode(
                Direction::Inbound,
                json!({"type":"agent_start","prompt":"secret"}),
                "h",
                &mut s
            )
            .is_err());
        assert_eq!(s.sequence, before);
        d.decode(
            Direction::Inbound,
            json!({"type":"extension_ui_request","id":"q","method":"editor","options":["secret"]}),
            "h",
            &mut s,
        )
        .unwrap();
        let text = serde_json::to_string(
            &d.decode(
                Direction::Outbound,
                json!({"type":"extension_ui_response","id":"q","value":"secret"}),
                "h",
                &mut s,
            )
            .ok()
            .and_then(|o| {
                if let DecodeOutput::Activity(e) = o {
                    Some(e)
                } else {
                    None
                }
            })
            .unwrap(),
        )
        .unwrap();
        for private in ["secret", "options", "toolResults"] {
            assert!(!text.contains(private));
        }
    }
}
