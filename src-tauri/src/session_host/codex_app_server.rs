//! Narrow, fixture-only decoder for Codex app-server v2 lifecycle messages.

#![allow(dead_code)]

use super::*;
use serde_json::{Map, Value};
use std::collections::HashMap;

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
    Activity(Envelope),
}

#[derive(Clone)]
struct PendingApproval {
    turn_id: String,
    key: String,
}

#[derive(Default)]
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
            return self.decode_response(direction, object, stream);
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
                let (thread_id, turn_id) = lifecycle_identity(object)?;
                require_bound_thread(self, thread_id)?;
                let params = required_params(object)?;
                if params.get("status").and_then(Value::as_str) != Some("inProgress") {
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
                let (thread_id, turn_id) = lifecycle_identity(object)?;
                require_bound_thread(self, thread_id)?;
                let status = required_params(object)?
                    .get("status")
                    .and_then(Value::as_str)
                    .ok_or("Missing Codex completion status")?;
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
            if stream.agent_id != "codex"
                || stream.transport_kind != BindingTransport::Protocol
                || stream.source.is_some()
            {
                return Err("Codex thread cannot bind this stream".into());
            }
            stream.source = Some(source);
            self.thread_id = Some(thread_id.into());
            return Ok(DecodeOutput::Handshake(HandshakeMarker::ThreadBound));
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
fn lifecycle_identity(object: &Map<String, Value>) -> Result<(&str, &str), String> {
    let params = required_params(object)?;
    let thread_id = required_string(params, "threadId")?;
    let turn = params
        .get("turn")
        .and_then(Value::as_object)
        .ok_or("Missing Codex turn")?;
    Ok((thread_id, required_string(turn, "id")?))
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

    fn stream() -> StreamState {
        StreamState {
            agent_id: "codex".into(),
            stream_id: "stream-1".into(),
            sequence: 0,
            transport_kind: BindingTransport::Protocol,
            source: None,
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
        json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"},"status":"inProgress"}})
    }
    fn approval(method: &str, id: Value) -> Value {
        json!({"method":method,"id":id,"params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1"}})
    }
    fn resolved(id: Value) -> Value {
        json!({"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":id}})
    }
    fn completed(status: &str) -> Value {
        json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1"},"status":status}})
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
        d.decode(
            Direction::Server,
            json!({"id":8,"result":{"thread":{"id":"thread-1","sessionId":"other"}}}),
            "s",
            &mut s,
        )
        .unwrap();
        assert_eq!(s.source.as_ref().unwrap().provider_session_id, "thread-1");

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
        assert_eq!(s.sequence, 2);
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
        assert_eq!((s.sequence, d.pending.len()), (0, 0));
        d.decode(Direction::Server, started(), "s", &mut s).unwrap();
        let before = s.sequence;
        for msg in [
            started(),
            json!({"method":"turn/started","params":{"threadId":"wrong","turn":{"id":"x"},"status":"inProgress"}}),
            json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"stale"},"status":"completed"}}),
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
        assert_eq!((s.sequence, d.pending.len()), (0, 0));
    }
}
