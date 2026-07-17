import {
  SESSION_HOST_PROTOCOL_VERSION,
  type HostedSessionSnapshot,
  type SessionEventEnvelope,
  type SessionHostEvent,
  type SessionTransportDescriptor,
  type TransportActivityEvent,
} from "../domain/sessionHost";

export const SESSION_HOST_MAX_ID_LENGTH = 256;
export const SESSION_HOST_MAX_ACTIVITY_KEY_LENGTH = 512;
export const SESSION_HOST_MAX_TERMINAL_OUTPUT_LENGTH = 256 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} has unknown fields`);
}

function version(value: unknown): asserts value is 1 {
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

function activityEvidence(value: unknown) {
  if (value !== "fallback" && value !== "structured") throw new Error("Malformed activity evidence");
  return value;
}

function sequence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
  return value;
}

function transport(value: unknown): SessionTransportDescriptor {
  const input = record(value, "transport");
  exactKeys(input, ["type", "lifecycleEvidence"], "transport");
  const type = literalString(input.type, "transport type");
  if (type === "pty" && (input.lifecycleEvidence === "fallback" || input.lifecycleEvidence === "structured")) {
    return { type: "pty", lifecycleEvidence: input.lifecycleEvidence };
  }
  if (type === "protocol" && input.lifecycleEvidence === "structured") {
    return { type: "protocol", lifecycleEvidence: "structured" };
  }
  throw new Error("Unknown or malformed transport variant");
}

function activity(value: unknown): TransportActivityEvent {
  const input = record(value, "activity");
  const type = literalString(input.type, "activity type");
  switch (type) {
    case "turn-started":
      exactKeys(input, ["type", "evidence"], "activity");
      return { type: "turn-started", evidence: activityEvidence(input.evidence) };
    case "attention-requested":
      exactKeys(input, ["type", "evidence", "key"], "activity");
      return {
        type: "attention-requested",
        evidence: activityEvidence(input.evidence),
        key: boundedString(input.key, "activity key", SESSION_HOST_MAX_ACTIVITY_KEY_LENGTH),
      };
    case "attention-resolved":
      exactKeys(input, ["type", "evidence", "key"], "activity");
      return {
        type: "attention-resolved",
        evidence: activityEvidence(input.evidence),
        key: boundedString(input.key, "activity key", SESSION_HOST_MAX_ACTIVITY_KEY_LENGTH),
      };
    case "turn-completed":
      exactKeys(input, ["type", "evidence"], "activity");
      return { type: "turn-completed", evidence: activityEvidence(input.evidence) };
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
      exactKeys(input, ["type", "activity"], "activity event");
      return { type: "activity", activity: activity(input.activity) };
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
