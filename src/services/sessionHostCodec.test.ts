import { describe, expect, it } from "vitest";
import {
  decodeHostedSessionSnapshot,
  decodeSessionEventEnvelope,
  SESSION_HOST_MAX_ACTIVITY_KEY_LENGTH,
  SESSION_HOST_MAX_ID_LENGTH,
  SESSION_HOST_MAX_TERMINAL_OUTPUT_LENGTH,
} from "./sessionHostCodec";

const base = { protocolVersion: 1, sessionId: "session-1", streamId: "stream-1", sequence: 0 };

describe("session host codec", () => {
  it("decodes PTY and protocol snapshots", () => {
    const snapshot = { protocolVersion: 1, sessionId: "session-1", streamId: "stream-1" };
    expect(decodeHostedSessionSnapshot({ ...snapshot, lastSequence: 2, transport: { type: "pty", lifecycleEvidence: "fallback" } }).transport.type).toBe("pty");
    expect(decodeHostedSessionSnapshot({ ...snapshot, lastSequence: 0, transport: { type: "protocol", lifecycleEvidence: "structured" } }).transport.type).toBe("protocol");
  });

  it.each([
    { type: "opened", transport: { type: "pty", lifecycleEvidence: "structured" } },
    { type: "activity", activity: { type: "turn-started", evidence: "structured" } },
    { type: "activity", activity: { type: "attention-requested", evidence: "structured", key: "approval-1" } },
    { type: "activity", activity: { type: "attention-resolved", evidence: "structured", key: "approval-1" } },
    { type: "activity", activity: { type: "turn-completed", evidence: "structured" } },
    { type: "terminal-output", data: "hello" },
    { type: "closed", outcome: { type: "stopped" } },
    { type: "closed", outcome: { type: "exited", success: false } },
  ])("decodes valid event variant $type", (event) => {
    expect(decodeSessionEventEnvelope({ ...base, event }).event).toEqual(event);
  });

  it.each([
    [{ ...base, protocolVersion: 2, event: { type: "terminal-output", data: "" } }, "protocol"],
    [{ ...base, sessionId: "", event: { type: "terminal-output", data: "" } }, "sessionId"],
    [{ ...base, streamId: "", event: { type: "terminal-output", data: "" } }, "streamId"],
    [{ ...base, sequence: -1, event: { type: "terminal-output", data: "" } }, "nonnegative"],
    [{ ...base, sequence: Number.MAX_SAFE_INTEGER + 1, event: { type: "terminal-output", data: "" } }, "safe integer"],
    [{ ...base, event: { type: "mystery" } }, "Unknown"],
    [{ ...base, event: { type: "activity", activity: { type: "result-reviewed" } } }, "local-only"],
    [{ ...base, event: { type: "activity", activity: { type: ["turn-started"], evidence: "structured" } } }, "activity type"],
    [{ ...base, event: { type: "activity", activity: { type: { value: "turn-started" }, evidence: "structured" } } }, "activity type"],
    [{ ...base, event: { type: "activity", activity: { type: "turn-started", evidence: "guess" } } }, "evidence"],
    [{ ...base, event: { type: "activity", activity: { type: "attention-requested", evidence: "structured", key: "" } } }, "activity key"],
    [{ ...base, event: { type: "opened", transport: { type: "protocol", lifecycleEvidence: "fallback" } } }, "transport"],
  ])("rejects malformed input", (value, message) => {
    expect(() => decodeSessionEventEnvelope(value)).toThrow(message);
  });

  it("reconstructs validated activity variants instead of returning raw input objects", () => {
    const rawActivity = { type: "attention-requested", evidence: "structured", key: "approval-1" };
    const decoded = decodeSessionEventEnvelope({ ...base, event: { type: "activity", activity: rawActivity } }).event;

    expect(decoded.type).toBe("activity");
    if (decoded.type === "activity") {
      expect(decoded.activity).toEqual(rawActivity);
      expect(decoded.activity).not.toBe(rawActivity);
    }
  });

  it("enforces explicit string and output bounds", () => {
    expect(() => decodeSessionEventEnvelope({ ...base, sessionId: "x".repeat(SESSION_HOST_MAX_ID_LENGTH + 1), event: { type: "terminal-output", data: "" } })).toThrow("exceeds");
    expect(() => decodeSessionEventEnvelope({ ...base, event: { type: "terminal-output", data: "x".repeat(SESSION_HOST_MAX_TERMINAL_OUTPUT_LENGTH + 1) } })).toThrow("bound");
    expect(() => decodeSessionEventEnvelope({ ...base, event: { type: "activity", activity: { type: "attention-requested", evidence: "structured", key: "x".repeat(SESSION_HOST_MAX_ACTIVITY_KEY_LENGTH + 1) } } })).toThrow("exceeds");
  });

  it("rejects malformed snapshots and unknown fields", () => {
    expect(() => decodeHostedSessionSnapshot({ protocolVersion: 1, sessionId: "s", streamId: "t", lastSequence: -1, transport: { type: "pty", lifecycleEvidence: "fallback" } })).toThrow("nonnegative");
    expect(() => decodeHostedSessionSnapshot({ protocolVersion: 1, sessionId: "s", streamId: "t", lastSequence: 0, extra: true, transport: { type: "pty", lifecycleEvidence: "fallback" } })).toThrow("unknown fields");
  });
});
