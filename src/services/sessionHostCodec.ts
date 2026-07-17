import {
  SESSION_HOST_PROTOCOL_VERSION,
  type HostedSessionSnapshot,
  type SessionEventEnvelope,
  type SessionHostEvent,
  type StructuredActivityContext,
  type StructuredLifecycleIntegration,
  type StructuredLifecycleSource,
  type StructuredSourceProvenance,
  type StructuredTurnProvenance,
  type SessionTransportDescriptor,
  type TransportActivityEvent,
} from "../domain/sessionHost";
import { FIRST_CLASS_AGENT_IDS, type FirstClassAgentId } from "../agents/types";

export const SESSION_HOST_MAX_ID_LENGTH = 256;
export const SESSION_HOST_MAX_ACTIVITY_KEY_LENGTH = 512;
export const SESSION_HOST_MAX_SOURCE_ID_LENGTH = SESSION_HOST_MAX_ID_LENGTH;
export const SESSION_HOST_MAX_TURN_KEY_LENGTH = SESSION_HOST_MAX_ACTIVITY_KEY_LENGTH;
export const SESSION_HOST_MAX_TERMINAL_OUTPUT_LENGTH = 256 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} has unknown fields`);
}

function version(value: unknown): asserts value is typeof SESSION_HOST_PROTOCOL_VERSION {
  if (value !== SESSION_HOST_PROTOCOL_VERSION) throw new Error("Unsupported session host protocol version");
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return value;
}

function literalString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function literalOneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`Malformed ${label}`);
  return value as T;
}

function agentId(value: unknown): FirstClassAgentId {
  return literalOneOf(value, "agent ID", FIRST_CLASS_AGENT_IDS);
}

function sourceIntegration(value: unknown): StructuredLifecycleIntegration {
  return literalOneOf(value, "source integration", ["app-server", "hooks", "rpc"]);
}

function sourceProvenance(value: unknown): StructuredSourceProvenance {
  return literalOneOf(value, "source provenance", ["provider-event", "provider-handshake"]);
}

function turnProvenance(value: unknown): StructuredTurnProvenance {
  return literalOneOf(value, "turn provenance", ["provider-turn", "provider-prompt", "adapter-stream"]);
}

function structuredActivityEvidence(value: unknown): "structured" {
  if (value !== "structured") throw new Error("Host activity evidence must be structured");
  return "structured";
}

function sequence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
  return value;
}

function source(value: unknown): StructuredLifecycleSource {
  const input = record(value, "source");
  exactKeys(input, ["agentId", "integration", "providerSessionId", "provenance"], "source");
  return {
    agentId: agentId(input.agentId),
    integration: sourceIntegration(input.integration),
    providerSessionId: boundedString(input.providerSessionId, "providerSessionId", SESSION_HOST_MAX_SOURCE_ID_LENGTH),
    provenance: sourceProvenance(input.provenance),
  };
}

function turnIdentity(value: unknown) {
  const input = record(value, "turn identity");
  exactKeys(input, ["key", "provenance"], "turn identity");
  return {
    key: boundedString(input.key, "turn key", SESSION_HOST_MAX_TURN_KEY_LENGTH),
    provenance: turnProvenance(input.provenance),
  };
}

function activityContext(value: unknown): StructuredActivityContext {
  const input = record(value, "activity context");
  exactKeys(input, ["turn"], "activity context");
  return { turn: turnIdentity(input.turn) };
}

function transport(value: unknown): SessionTransportDescriptor {
  const input = record(value, "transport");
  exactKeys(input, input.lifecycleEvidence === "structured" ? ["type", "lifecycleEvidence", "source"] : ["type", "lifecycleEvidence"], "transport");
  const type = literalString(input.type, "transport type");
  if (type === "pty" && input.lifecycleEvidence === "fallback") {
    return { type: "pty", lifecycleEvidence: "fallback" };
  }
  if (type === "protocol" && input.lifecycleEvidence === "structured") {
    return { type: "protocol", lifecycleEvidence: "structured", source: source(input.source) };
  }
  if (type === "pty" && input.lifecycleEvidence === "structured") {
    return { type: "pty", lifecycleEvidence: "structured", source: source(input.source) };
  }
  throw new Error("Unknown or malformed transport variant");
}

function activity(value: unknown): TransportActivityEvent {
  const input = record(value, "activity");
  const type = literalString(input.type, "activity type");
  switch (type) {
    case "turn-started":
      exactKeys(input, ["type", "evidence"], "activity");
      return { type: "turn-started", evidence: structuredActivityEvidence(input.evidence) };
    case "attention-requested":
      exactKeys(input, ["type", "evidence", "key"], "activity");
      return {
        type: "attention-requested",
        evidence: structuredActivityEvidence(input.evidence),
        key: boundedString(input.key, "activity key", SESSION_HOST_MAX_ACTIVITY_KEY_LENGTH),
      };
    case "attention-resolved":
      exactKeys(input, ["type", "evidence", "key"], "activity");
      return {
        type: "attention-resolved",
        evidence: structuredActivityEvidence(input.evidence),
        key: boundedString(input.key, "activity key", SESSION_HOST_MAX_ACTIVITY_KEY_LENGTH),
      };
    case "turn-ended":
      exactKeys(input, ["type", "evidence", "outcome"], "activity");
      return {
        type: "turn-ended",
        evidence: structuredActivityEvidence(input.evidence),
        outcome: literalOneOf(input.outcome, "terminal outcome", ["completed", "failed", "interrupted"]),
      };
    case "result-reviewed":
      throw new Error("result-reviewed is local-only activity");
    default:
      throw new Error("Unknown activity variant");
  }
}

function event(value: unknown): SessionHostEvent {
  const input = record(value, "event");
  const type = literalString(input.type, "event type");
  switch (type) {
    case "opened":
      exactKeys(input, ["type", "transport"], "opened event");
      return { type: "opened", transport: transport(input.transport) };
    case "activity":
      exactKeys(input, ["type", "source", "context", "activity"], "activity event");
      return { type: "activity", source: source(input.source), context: activityContext(input.context), activity: activity(input.activity) };
    case "terminal-output":
      exactKeys(input, ["type", "data"], "terminal output event");
      if (typeof input.data !== "string") throw new Error("terminal output must be a string");
      if (input.data.length > SESSION_HOST_MAX_TERMINAL_OUTPUT_LENGTH) throw new Error("terminal output exceeds bound");
      return { type: "terminal-output", data: input.data };
    case "closed": {
      exactKeys(input, ["type", "outcome"], "closed event");
      const outcome = record(input.outcome, "close outcome");
      const outcomeType = literalString(outcome.type, "close outcome type");
      if (outcomeType === "stopped") {
        exactKeys(outcome, ["type"], "stop outcome");
        return { type: "closed", outcome: { type: "stopped" } };
      }
      if (outcomeType === "exited" && typeof outcome.success === "boolean") {
        exactKeys(outcome, ["type", "success"], "exit outcome");
        return { type: "closed", outcome: { type: "exited", success: outcome.success } };
      }
      throw new Error("Unknown close outcome");
    }
    default: throw new Error("Unknown session host event variant");
  }
}

export function decodeHostedSessionSnapshot(value: unknown): HostedSessionSnapshot {
  const input = record(value, "snapshot");
  exactKeys(input, ["protocolVersion", "sessionId", "streamId", "lastSequence", "transport"], "snapshot");
  version(input.protocolVersion);
  return {
    protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
    sessionId: boundedString(input.sessionId, "sessionId", SESSION_HOST_MAX_ID_LENGTH),
    streamId: boundedString(input.streamId, "streamId", SESSION_HOST_MAX_ID_LENGTH),
    lastSequence: sequence(input.lastSequence, "lastSequence"),
    transport: transport(input.transport),
  };
}

export function decodeSessionEventEnvelope(value: unknown): SessionEventEnvelope {
  const input = record(value, "envelope");
  exactKeys(input, ["protocolVersion", "sessionId", "streamId", "sequence", "event"], "envelope");
  version(input.protocolVersion);
  return {
    protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
    sessionId: boundedString(input.sessionId, "sessionId", SESSION_HOST_MAX_ID_LENGTH),
    streamId: boundedString(input.streamId, "streamId", SESSION_HOST_MAX_ID_LENGTH),
    sequence: sequence(input.sequence, "sequence"),
    event: event(input.event),
  };
}
