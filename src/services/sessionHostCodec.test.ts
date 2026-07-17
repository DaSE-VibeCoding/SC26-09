import { describe, expect, it } from "vitest";
import {
  decodeHostedSessionSnapshot,
  decodeSessionEventEnvelope,
  SESSION_HOST_MAX_ACTIVITY_KEY_LENGTH,
  SESSION_HOST_MAX_ID_LENGTH,
  SESSION_HOST_MAX_SOURCE_ID_LENGTH,
  SESSION_HOST_MAX_TERMINAL_OUTPUT_LENGTH,
  SESSION_HOST_MAX_TURN_KEY_LENGTH,
} from "./sessionHostCodec";
import type { StructuredLifecycleSource, StructuredTurnIdentity } from "../domain/sessionHost";

const source: StructuredLifecycleSource = {
  agentId: "codex",
  integration: "app-server",
  providerSessionId: "codex-thread-1",
  provenance: "provider-event",
};
const handshakeSource = { ...source, provenance: "provider-handshake" } as const;
const turn: StructuredTurnIdentity = { key: "turn-1", provenance: "provider-turn" };
const context = { turn };
const base = { protocolVersion: 2, sessionId: "session-1", streamId: "stream-1", sequence: 0 };
const activityEvent = (activity: Record<string, unknown>) => ({ type: "activity", source, context, activity });

describe("session host codec", () => {
  it("decodes source-less fallback PTY and sourced structured snapshots", () => {
    const snapshot = { protocolVersion: 2, sessionId: "session-1", streamId: "stream-1" };
    expect(decodeHostedSessionSnapshot({ ...snapshot, lastSequence: 2, transport: { type: "pty", lifecycleEvidence: "fallback" } }).transport.type).toBe("pty");
    expect(decodeHostedSessionSnapshot({ ...snapshot, lastSequence: 0, transport: { type: "protocol", lifecycleEvidence: "structured", source: handshakeSource } }).transport).toEqual({
      type: "protocol",
      lifecycleEvidence: "structured",
      source: handshakeSource,
    });
    expect(decodeHostedSessionSnapshot({ ...snapshot, lastSequence: 0, transport: { type: "pty", lifecycleEvidence: "structured", source: { ...handshakeSource, agentId: "claude-code", integration: "hooks" } } }).transport.type).toBe("pty");
  });

  it.each([
    { type: "opened", transport: { type: "pty", lifecycleEvidence: "structured", source: { ...handshakeSource, agentId: "claude-code", integration: "hooks" } } },
    activityEvent({ type: "turn-started", evidence: "structured" }),
    activityEvent({ type: "attention-requested", evidence: "structured", key: "approval-1" }),
    activityEvent({ type: "attention-resolved", evidence: "structured", key: "approval-1" }),
    activityEvent({ type: "turn-completed", evidence: "structured" }),
    { type: "terminal-output", data: "hello" },
    { type: "closed", outcome: { type: "stopped" } },
    { type: "closed", outcome: { type: "exited", success: false } },
  ])("decodes valid event variant $type", (event) => {
    expect(decodeSessionEventEnvelope({ ...base, event }).event).toEqual(event);
  });

  it.each([
    [{ ...base, protocolVersion: 1, event: { type: "terminal-output", data: "" } }, "protocol"],
    [{ ...base, sessionId: "", event: { type: "terminal-output", data: "" } }, "sessionId"],
    [{ ...base, streamId: "", event: { type: "terminal-output", data: "" } }, "streamId"],
    [{ ...base, sequence: -1, event: { type: "terminal-output", data: "" } }, "nonnegative"],
    [{ ...base, sequence: Number.MAX_SAFE_INTEGER + 1, event: { type: "terminal-output", data: "" } }, "safe integer"],
    [{ ...base, event: { type: "mystery" } }, "Unknown"],
    [{ ...base, event: activityEvent({ type: "result-reviewed" }) }, "local-only"],
    [{ ...base, event: activityEvent({ type: ["turn-started"], evidence: "structured" }) }, "activity type"],
    [{ ...base, event: activityEvent({ type: { value: "turn-started" }, evidence: "structured" }) }, "activity type"],
    [{ ...base, event: activityEvent({ type: "turn-started", evidence: "fallback" }) }, "structured"],
    [{ ...base, event: activityEvent({ type: "attention-requested", evidence: "structured", key: "" }) }, "activity key"],
    [{ ...base, event: { type: "activity", source, activity: { type: "turn-started", evidence: "structured" } } }, "activity context"],
    [{ ...base, event: { type: "activity", source: { ...source, rawEventName: "thread.started" }, context, activity: { type: "turn-started", evidence: "structured" } } }, "source"],
    [{ ...base, event: { type: "activity", source, context: { ...context, raw: true }, activity: { type: "turn-started", evidence: "structured" } } }, "activity context"],
    [{ ...base, event: { type: "activity", source, context: { turn: { ...turn, rawProviderTurn: "abc" } }, activity: { type: "turn-started", evidence: "structured" } } }, "turn identity"],
    [{ ...base, event: { type: "activity", source: { ...source, providerSessionId: "x".repeat(SESSION_HOST_MAX_SOURCE_ID_LENGTH + 1) }, context, activity: { type: "turn-started", evidence: "structured" } } }, "providerSessionId"],
    [{ ...base, event: { type: "activity", source, context: { turn: { ...turn, key: "x".repeat(SESSION_HOST_MAX_TURN_KEY_LENGTH + 1) } }, activity: { type: "turn-started", evidence: "structured" } } }, "turn key"],
    [{ ...base, event: { type: "opened", transport: { type: "pty", lifecycleEvidence: "fallback", source: handshakeSource } } }, "transport"],
    [{ ...base, event: { type: "opened", transport: { type: "protocol", lifecycleEvidence: "structured" } } }, "source"],
    [{ ...base, event: { type: "opened", transport: { type: "protocol", lifecycleEvidence: "fallback" } } }, "transport"],
  ])("rejects malformed input", (value, message) => {
    expect(() => decodeSessionEventEnvelope(value)).toThrow(message);
  });

  it("reconstructs validated activity variants instead of returning raw input objects", () => {
    const rawActivity = { type: "attention-requested", evidence: "structured", key: "approval-1" };
    const decoded = decodeSessionEventEnvelope({ ...base, event: activityEvent(rawActivity) }).event;

    expect(decoded.type).toBe("activity");
    if (decoded.type === "activity") {
      expect(decoded.activity).toEqual(rawActivity);
      expect(decoded.activity).not.toBe(rawActivity);
      expect(decoded.source).toEqual(source);
      expect(decoded.context).toEqual(context);
    }
  });

  it("enforces explicit string and output bounds", () => {
    expect(() => decodeSessionEventEnvelope({ ...base, sessionId: "x".repeat(SESSION_HOST_MAX_ID_LENGTH + 1), event: { type: "terminal-output", data: "" } })).toThrow("exceeds");
    expect(() => decodeSessionEventEnvelope({ ...base, event: { type: "terminal-output", data: "x".repeat(SESSION_HOST_MAX_TERMINAL_OUTPUT_LENGTH + 1) } })).toThrow("bound");
    expect(() => decodeSessionEventEnvelope({ ...base, event: activityEvent({ type: "attention-requested", evidence: "structured", key: "x".repeat(SESSION_HOST_MAX_ACTIVITY_KEY_LENGTH + 1) }) })).toThrow("exceeds");
  });

  it("rejects malformed snapshots and unknown fields", () => {
    expect(() => decodeHostedSessionSnapshot({ protocolVersion: 2, sessionId: "s", streamId: "t", lastSequence: -1, transport: { type: "pty", lifecycleEvidence: "fallback" } })).toThrow("nonnegative");
    expect(() => decodeHostedSessionSnapshot({ protocolVersion: 2, sessionId: "s", streamId: "t", lastSequence: 0, extra: true, transport: { type: "pty", lifecycleEvidence: "fallback" } })).toThrow("unknown fields");
  });
});
