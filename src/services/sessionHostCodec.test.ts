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
import { SESSION_HOST_PROTOCOL_VERSION, type StructuredLifecycleSource, type StructuredTurnIdentity } from "../domain/sessionHost";

const source: StructuredLifecycleSource = {
  agentId: "codex",
  integration: "app-server",
  providerSessionId: "codex-thread-1",
  provenance: "provider-event",
};
const handshakeSource = { ...source, provenance: "provider-handshake" } as const;
const turn: StructuredTurnIdentity = { key: "turn-1", provenance: "provider-turn" };
const context = { turn };
const base = { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "session-1", streamId: "stream-1", sequence: 0 };
const activityEvent = (activity: Record<string, unknown>) => ({ type: "activity", source, context, activity });

describe("session host codec", () => {
  it("decodes source-less fallback PTY and sourced structured snapshots", () => {
    const snapshot = { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "session-1", streamId: "stream-1" };
    expect(decodeHostedSessionSnapshot({ ...snapshot, lastSequence: 2, transport: { type: "pty", lifecycleEvidence: "fallback" }, promptReadiness: "pty-fallback-sendable" }).transport.type).toBe("pty");
    expect(decodeHostedSessionSnapshot({ ...snapshot, lastSequence: 0, transport: { type: "protocol", lifecycleEvidence: "structured", source: handshakeSource }, promptReadiness: "ready" })).toEqual({
      ...snapshot,
      lastSequence: 0,
      transport: {
        type: "protocol",
        lifecycleEvidence: "structured",
        source: handshakeSource,
      },
      promptReadiness: "ready",
    });
    expect(decodeHostedSessionSnapshot({ ...snapshot, lastSequence: 0, transport: { type: "pty", lifecycleEvidence: "structured", source: { ...handshakeSource, agentId: "claude-code", integration: "hooks" } }, promptReadiness: "awaiting-authoritative" }).transport.type).toBe("pty");
  });

  it.each([
    { type: "opened", transport: { type: "pty", lifecycleEvidence: "structured", source: { ...handshakeSource, agentId: "claude-code", integration: "hooks" } }, promptReadiness: "awaiting-authoritative" },
    { type: "prompt-readiness-changed", source, promptReadiness: "ready" },
    { type: "prompt-readiness-changed", source, promptReadiness: "auth-required" },
    activityEvent({ type: "turn-started", evidence: "structured" }),
    activityEvent({ type: "attention-requested", evidence: "structured", key: "approval-1" }),
    activityEvent({ type: "attention-resolved", evidence: "structured", key: "approval-1" }),
    activityEvent({ type: "turn-ended", evidence: "structured", outcome: "completed" }),
    activityEvent({ type: "turn-ended", evidence: "structured", outcome: "failed" }),
    activityEvent({ type: "turn-ended", evidence: "structured", outcome: "interrupted" }),
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
    [{ ...base, event: activityEvent({ type: "turn-ended", evidence: "structured", outcome: "unknown" }) }, "terminal outcome"],
    [{ ...base, event: activityEvent({ type: "turn-ended", evidence: "structured", outcome: "failed", error: "raw" }) }, "unknown fields"],
    [{ ...base, event: activityEvent({ type: "attention-requested", evidence: "structured", key: "" }) }, "activity key"],
    [{ ...base, event: { type: "activity", source, activity: { type: "turn-started", evidence: "structured" } } }, "activity context"],
    [{ ...base, event: { type: "activity", source: { ...source, rawEventName: "thread.started" }, context, activity: { type: "turn-started", evidence: "structured" } } }, "source"],
    [{ ...base, event: { type: "activity", source, context: { ...context, raw: true }, activity: { type: "turn-started", evidence: "structured" } } }, "activity context"],
    [{ ...base, event: { type: "activity", source, context: { turn: { ...turn, rawProviderTurn: "abc" } }, activity: { type: "turn-started", evidence: "structured" } } }, "turn identity"],
    [{ ...base, event: { type: "activity", source: { ...source, providerSessionId: "x".repeat(SESSION_HOST_MAX_SOURCE_ID_LENGTH + 1) }, context, activity: { type: "turn-started", evidence: "structured" } } }, "providerSessionId"],
    [{ ...base, event: { type: "activity", source, context: { turn: { ...turn, key: "x".repeat(SESSION_HOST_MAX_TURN_KEY_LENGTH + 1) } }, activity: { type: "turn-started", evidence: "structured" } } }, "turn key"],
    [{ ...base, event: { type: "opened", transport: { type: "pty", lifecycleEvidence: "fallback", source: handshakeSource }, promptReadiness: "pty-fallback-sendable" } }, "transport"],
    [{ ...base, event: { type: "opened", transport: { type: "protocol", lifecycleEvidence: "structured" }, promptReadiness: "awaiting-authoritative" } }, "source"],
    [{ ...base, event: { type: "opened", transport: { type: "protocol", lifecycleEvidence: "fallback" }, promptReadiness: "pty-fallback-sendable" } }, "transport"],
    [{ ...base, event: { type: "opened", transport: { type: "pty", lifecycleEvidence: "fallback" }, promptReadiness: "ready" } }, "Prompt readiness"],
    [{ ...base, event: { type: "opened", transport: { type: "protocol", lifecycleEvidence: "structured", source: handshakeSource }, promptReadiness: "pty-fallback-sendable" } }, "Prompt readiness"],
    [{ ...base, event: { type: "prompt-readiness-changed", source, promptReadiness: "provider-ready" } }, "prompt readiness"],
    [{ ...base, event: { type: "prompt-readiness-changed", source: { ...source, rawEvent: "ready" }, promptReadiness: "ready" } }, "source"],
    [{ ...base, event: { type: "prompt-readiness-changed", source, promptReadiness: "ready", raw: true } }, "unknown fields"],
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
    expect(() => decodeHostedSessionSnapshot({ protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "s", streamId: "t", lastSequence: -1, transport: { type: "pty", lifecycleEvidence: "fallback" }, promptReadiness: "pty-fallback-sendable" })).toThrow("nonnegative");
    expect(() => decodeHostedSessionSnapshot({ protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "s", streamId: "t", lastSequence: 0, extra: true, transport: { type: "pty", lifecycleEvidence: "fallback" }, promptReadiness: "pty-fallback-sendable" })).toThrow("unknown fields");
    expect(() => decodeHostedSessionSnapshot({ protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "s", streamId: "t", lastSequence: 0, transport: { type: "pty", lifecycleEvidence: "fallback" }, promptReadiness: "ready" })).toThrow("Prompt readiness");
  });
});
