import { describe, expect, it } from "vitest";
import type { AgentSession, SessionMode } from "./models";
import { createSessionRuntimeState, reduceSessionRuntime, selectSessionSurfaceState, type SessionConnectionSnapshot, type SessionSurfaceState } from "./sessionRuntime";
import { SESSION_HOST_PROTOCOL_VERSION, type PromptReadinessState, type SessionEventEnvelope, type StructuredLifecycleSource, type StructuredTurnIdentity } from "./sessionHost";

const session = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: "s", workspaceId: "w", agentId: "codex", title: "Session", status: "idle",
  createdAt: "created", lastActivityAt: "activity", unread: false, connected: true,
  running: true, origin: "pelican", ...overrides,
});
const source: StructuredLifecycleSource = {
  agentId: "codex",
  integration: "app-server",
  providerSessionId: "codex-thread-1",
  provenance: "provider-event",
};
const handshakeSource = { ...source, provenance: "provider-handshake" } as const;
const claudeSource: StructuredLifecycleSource = {
  agentId: "claude-code",
  integration: "hooks",
  providerSessionId: "claude-session-1",
  provenance: "provider-handshake",
};
const turn: StructuredTurnIdentity = { key: "turn-1", provenance: "provider-turn" };
const otherTurn: StructuredTurnIdentity = { key: "turn-2", provenance: "provider-turn" };
const envelope = (sequence: number, event: SessionEventEnvelope["event"], streamId = "stream-1"): SessionEventEnvelope => ({
  protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "s", streamId, sequence, event,
});
const fallbackOpened = (streamId = "stream-1") => envelope(0, { type: "opened", transport: { type: "pty", lifecycleEvidence: "fallback" }, promptReadiness: "pty-fallback-sendable" }, streamId);
const structuredOpened = (streamId = "stream-1", openSource: StructuredLifecycleSource = handshakeSource) => envelope(0, { type: "opened", transport: { type: "protocol", lifecycleEvidence: "structured", source: openSource }, promptReadiness: "awaiting-authoritative" }, streamId);
const claudePtyOpened = (streamId = "stream-1") => envelope(0, { type: "opened", transport: { type: "pty", lifecycleEvidence: "structured", source: claudeSource }, promptReadiness: "awaiting-authoritative" }, streamId);
const readinessChanged = (
  sequence: number,
  promptReadiness: PromptReadinessState,
  eventSource: StructuredLifecycleSource = source,
) => envelope(sequence, { type: "prompt-readiness-changed", source: eventSource, promptReadiness });
const activity = (
  sequence: number,
  activity: Extract<SessionEventEnvelope["event"], { type: "activity" }>["activity"],
  activityTurn = turn,
  activitySource = source,
) => envelope(sequence, { type: "activity", source: activitySource, context: { turn: activityTurn }, activity });

const ptyConnection = (open = true): SessionConnectionSnapshot => ({
  streamId: "stream-1",
  transport: { type: "pty", lifecycleEvidence: "fallback" },
  open,
  promptReadiness: "pty-fallback-sendable",
});
const protocolConnection = (open = true): SessionConnectionSnapshot => ({
  streamId: "stream-1",
  transport: { type: "protocol", lifecycleEvidence: "structured", source: handshakeSource },
  open,
  promptReadiness: "awaiting-authoritative",
  source: handshakeSource,
});

describe("session surface selector", () => {
  it.each([
    {
      name: "connected open PTY preserves requested Prompt and mounts TerminalView hidden",
      selected: session({ connected: true }),
      connection: ptyConnection(true),
      requestedMode: "prompt",
      expected: { effectiveMode: "prompt", terminalAvailability: "interactive", canMountTerminalView: true },
    },
    {
      name: "connected open PTY preserves requested Terminal",
      selected: session({ connected: true }),
      connection: ptyConnection(true),
      requestedMode: "terminal",
      expected: { effectiveMode: "terminal", terminalAvailability: "interactive", canMountTerminalView: true },
    },
    {
      name: "connected open protocol coerces Prompt and blocks TerminalView",
      selected: session({ connected: true }),
      connection: protocolConnection(true),
      requestedMode: "terminal",
      expected: { effectiveMode: "prompt", terminalAvailability: "unavailable", canMountTerminalView: false },
    },
    {
      name: "connected session without accepted connection fails closed",
      selected: session({ connected: true }),
      connection: undefined,
      requestedMode: "terminal",
      expected: { effectiveMode: "prompt", terminalAvailability: "unavailable", canMountTerminalView: false },
    },
    {
      name: "connected session with closed connection fails closed",
      selected: session({ connected: true }),
      connection: ptyConnection(false),
      requestedMode: "terminal",
      expected: { effectiveMode: "prompt", terminalAvailability: "unavailable", canMountTerminalView: false },
    },
    {
      name: "disconnected session without connection preserves Terminal recovery mode",
      selected: session({ connected: false, running: false }),
      connection: undefined,
      requestedMode: "terminal",
      expected: { effectiveMode: "terminal", terminalAvailability: "recovery", canMountTerminalView: false },
    },
    {
      name: "disconnected closed PTY preserves Terminal recovery mode",
      selected: session({ connected: false, running: false }),
      connection: ptyConnection(false),
      requestedMode: "terminal",
      expected: { effectiveMode: "terminal", terminalAvailability: "recovery", canMountTerminalView: false },
    },
    {
      name: "closed known protocol coerces Prompt",
      selected: session({ connected: false, running: false }),
      connection: protocolConnection(false),
      requestedMode: "terminal",
      expected: { effectiveMode: "prompt", terminalAvailability: "unavailable", canMountTerminalView: false },
    },
    {
      name: "missing selection is Prompt-only",
      selected: null,
      connection: undefined,
      requestedMode: "terminal",
      expected: { effectiveMode: "prompt", terminalAvailability: "unavailable", canMountTerminalView: false },
    },
  ] satisfies ReadonlyArray<{
    name: string;
    selected: AgentSession | null;
    connection: SessionConnectionSnapshot | undefined;
    requestedMode: SessionMode;
    expected: SessionSurfaceState;
  }>)("$name", ({ selected, connection, requestedMode, expected }) => {
    expect(selectSessionSurfaceState(selected, connection, requestedMode)).toEqual(expected);
  });
});

describe("session runtime reducer", () => {
  it("atomically initializes, applies local activity, reviews, and removes", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session({ status: "available" })]), { type: "initialize", sessionId: "s", mode: "fresh" });
    state = reduceSessionRuntime(state, { type: "activity", sessionId: "s", events: [{ type: "turn-ended", evidence: "fallback", outcome: "completed" }], patch: { unread: true } });
    expect(state.sessions[0]).toEqual(expect.objectContaining({ status: "done", unread: true }));
    expect(state.lifecycleBySessionId.s.phase).toBe("completed");
    state = reduceSessionRuntime(state, { type: "review", sessionId: "s" });
    expect(state.sessions[0]).toEqual(expect.objectContaining({ status: "idle", unread: false }));
    state = reduceSessionRuntime(state, { type: "remove", sessionId: "s" });
    expect(state).toEqual({ sessions: [], lifecycleBySessionId: {}, connectionBySessionId: {}, cursorBySessionId: {} });
  });

  it("requires opened first and ignores duplicate and out-of-order events", () => {
    const initial = createSessionRuntimeState([session()]);
    const premature = reduceSessionRuntime(initial, { type: "host-event", envelope: activity(1, { type: "turn-started", evidence: "structured" }) });
    expect(premature).toBe(initial);
    let state = reduceSessionRuntime(initial, { type: "host-event", envelope: structuredOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-started", evidence: "structured" }) });
    const accepted = state;
    expect(state.sessions[0].status).toBe("working");
    expect(reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-ended", evidence: "structured", outcome: "completed" }) })).toBe(state);
    expect(reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-ended", evidence: "structured", outcome: "completed" }) })).toBe(accepted);
  });

  it("keeps close final and cannot close a replacement stream with an old event", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: fallbackOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: envelope(3, { type: "closed", outcome: { type: "exited", success: true } }) });
    expect(state.connectionBySessionId.s.open).toBe(false);
    expect(state.sessions[0]).toEqual(expect.objectContaining({ connected: false, running: false }));
    state = reduceSessionRuntime(state, { type: "host-event", envelope: fallbackOpened("stream-2") });
    const replacement = state;
    state = reduceSessionRuntime(state, { type: "host-event", envelope: envelope(4, { type: "closed", outcome: { type: "exited", success: false } }, "stream-1") });
    expect(state).toBe(replacement);
    expect(state.connectionBySessionId.s).toEqual(expect.objectContaining({ streamId: "stream-2", open: true }));
  });

  it("marks disconnected sessions connected and running from accepted snapshots and opened events", () => {
    const snapshotState = reduceSessionRuntime(createSessionRuntimeState([
      session({ status: "available", connected: false, running: false }),
    ]), {
      type: "host-snapshot",
      snapshot: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "s", streamId: "stream-1", lastSequence: 4, transport: { type: "pty", lifecycleEvidence: "fallback" }, promptReadiness: "pty-fallback-sendable" },
    });
    expect(snapshotState.sessions[0]).toEqual(expect.objectContaining({ connected: true, running: true }));
    expect(snapshotState.connectionBySessionId.s.promptReadiness).toBe("pty-fallback-sendable");

    const openedState = reduceSessionRuntime(createSessionRuntimeState([
      session({ status: "offline", connected: false, running: false }),
    ]), { type: "host-event", envelope: fallbackOpened() });
    expect(openedState.sessions[0]).toEqual(expect.objectContaining({ connected: true, running: true }));
    expect(openedState.connectionBySessionId.s.promptReadiness).toBe("pty-fallback-sendable");
  });

  it("initializes structured prompt readiness as awaiting authoritative provider readiness", () => {
    const protocolState = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: structuredOpened() });
    expect(protocolState.connectionBySessionId.s.promptReadiness).toBe("awaiting-authoritative");

    const ptyState = reduceSessionRuntime(createSessionRuntimeState([session({ agentId: "claude-code" })]), { type: "host-event", envelope: claudePtyOpened() });
    expect(ptyState.connectionBySessionId.s.promptReadiness).toBe("awaiting-authoritative");
  });

  it("applies ordered host prompt readiness changes and rejects duplicate or mismatched updates before cursor advancement", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: structuredOpened() });

    state = reduceSessionRuntime(state, { type: "host-event", envelope: readinessChanged(1, "ready") });
    expect(state.connectionBySessionId.s.promptReadiness).toBe("ready");
    expect(state.cursorBySessionId.s).toBe(1);

    const duplicate = reduceSessionRuntime(state, { type: "host-event", envelope: readinessChanged(2, "ready") });
    expect(duplicate).toBe(state);
    expect(duplicate.cursorBySessionId.s).toBe(1);

    const mismatchedSource = reduceSessionRuntime(state, { type: "host-event", envelope: readinessChanged(2, "auth-required", { ...source, providerSessionId: "other-thread" }) });
    expect(mismatchedSource).toBe(state);
    expect(mismatchedSource.cursorBySessionId.s).toBe(1);

    const mismatchedAgent = reduceSessionRuntime(state, { type: "host-event", envelope: readinessChanged(2, "auth-required", { ...source, agentId: "pi", integration: "rpc" }) });
    expect(mismatchedAgent).toBe(state);
    expect(mismatchedAgent.cursorBySessionId.s).toBe(1);

    const mismatchedIntegration = reduceSessionRuntime(state, { type: "host-event", envelope: readinessChanged(2, "auth-required", { ...source, integration: "hooks" }) });
    expect(mismatchedIntegration).toBe(state);
    expect(mismatchedIntegration.cursorBySessionId.s).toBe(1);

    const transportMismatch = reduceSessionRuntime(state, { type: "host-event", envelope: readinessChanged(2, "pty-fallback-sendable") });
    expect(transportMismatch).toBe(state);
    expect(transportMismatch.cursorBySessionId.s).toBe(1);

    const stale = reduceSessionRuntime(state, { type: "host-event", envelope: readinessChanged(1, "auth-required") });
    expect(stale).toBe(state);
    expect(stale.cursorBySessionId.s).toBe(1);

    state = reduceSessionRuntime(state, { type: "host-event", envelope: readinessChanged(2, "auth-required") });
    expect(state.connectionBySessionId.s.promptReadiness).toBe("auth-required");
    expect(state.cursorBySessionId.s).toBe(2);
  });

  it("keeps PTY fallback readiness host-owned, providerReady-false, and unpromotable by structured updates", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: fallbackOpened() });
    const rejected = reduceSessionRuntime(state, { type: "host-event", envelope: readinessChanged(1, "ready") });

    expect(rejected).toBe(state);
    expect(rejected.connectionBySessionId.s.promptReadiness).toBe("pty-fallback-sendable");
    expect(rejected.cursorBySessionId.s).toBe(0);

    state = reduceSessionRuntime(state, { type: "host-event", envelope: envelope(1, { type: "closed", outcome: { type: "exited", success: true } }) });
    const closed = reduceSessionRuntime(state, { type: "host-event", envelope: readinessChanged(2, "ready") });
    expect(closed).toBe(state);
    expect(closed.cursorBySessionId.s).toBe(1);
  });

  it("restores host prompt readiness from snapshots and resets replacement streams", () => {
    const opened = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: structuredOpened() });
    const ready = {
      ...opened,
      connectionBySessionId: {
        ...opened.connectionBySessionId,
        s: { ...opened.connectionBySessionId.s, promptReadiness: "ready" as const },
      },
    };

    const sameStream = reduceSessionRuntime(ready, {
      type: "host-snapshot",
      snapshot: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "s", streamId: "stream-1", lastSequence: 0, transport: { type: "protocol", lifecycleEvidence: "structured", source: handshakeSource }, promptReadiness: "awaiting-authoritative" },
    });
    expect(sameStream.connectionBySessionId.s.promptReadiness).toBe("awaiting-authoritative");

    const replacement = reduceSessionRuntime(sameStream, {
      type: "host-snapshot",
      snapshot: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "s", streamId: "stream-2", lastSequence: 0, transport: { type: "pty", lifecycleEvidence: "fallback" }, promptReadiness: "pty-fallback-sendable" },
    });
    expect(replacement.connectionBySessionId.s).toEqual(expect.objectContaining({
      streamId: "stream-2",
      promptReadiness: "pty-fallback-sendable",
      currentTurn: undefined,
      pendingAttentionKeys: undefined,
      terminalOutcome: undefined,
    }));
    const staleOldStreamReadiness = reduceSessionRuntime(replacement, { type: "host-event", envelope: readinessChanged(1, "ready") });
    expect(staleOldStreamReadiness).toBe(replacement);
    expect(staleOldStreamReadiness.cursorBySessionId.s).toBe(0);
  });

  it("rejects protocol terminal output without changing state or advancing the cursor", () => {
    const state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: structuredOpened() });
    const rejected = reduceSessionRuntime(state, { type: "host-event", envelope: envelope(1, { type: "terminal-output", data: "hello" }) });

    expect(rejected).toBe(state);
    expect(rejected.cursorBySessionId.s).toBe(0);
  });

  it("latches structured authority against later local fallback", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: structuredOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-started", evidence: "structured" }) });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-ended", evidence: "structured", outcome: "completed" }) });
    const lifecycle = state.lifecycleBySessionId.s;
    state = reduceSessionRuntime(state, { type: "activity", sessionId: "s", events: [{ type: "turn-started", evidence: "fallback" }] });
    expect(state.sessions[0].status).toBe("done");
    expect(state.lifecycleBySessionId.s).toBe(lifecycle);
  });

  it("applies snapshots and replays deterministically without mutating inputs", () => {
    const initial = createSessionRuntimeState([session()]);
    const actions = [
      { type: "host-snapshot", snapshot: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "s", streamId: "stream-1", lastSequence: 4, transport: { type: "protocol", lifecycleEvidence: "structured", source: handshakeSource }, promptReadiness: "ready" } },
      { type: "host-event", envelope: activity(5, { type: "turn-started", evidence: "structured" }) },
    ] as const;
    const replay = () => actions.reduce(reduceSessionRuntime, initial);
    expect(replay()).toEqual(replay());
    expect(initial.connectionBySessionId).toEqual({});
  });

  it("does not let stale same-stream snapshots regress or reopen", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: fallbackOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: envelope(4, { type: "terminal-output", data: "new" }) });
    const current = state;
    state = reduceSessionRuntime(state, { type: "host-snapshot", snapshot: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "s", streamId: "stream-1", lastSequence: 2, transport: { type: "pty", lifecycleEvidence: "fallback" }, promptReadiness: "pty-fallback-sendable" } });
    expect(state).toBe(current);
    state = reduceSessionRuntime(state, { type: "host-event", envelope: envelope(5, { type: "closed", outcome: { type: "exited", success: true } }) });
    const closed = state;
    state = reduceSessionRuntime(state, { type: "host-snapshot", snapshot: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "s", streamId: "stream-1", lastSequence: 5, transport: { type: "pty", lifecycleEvidence: "fallback" }, promptReadiness: "pty-fallback-sendable" } });
    expect(state).toBe(closed);
  });

  it("binds structured source identity on accepted provider-observed open", () => {
    const state = reduceSessionRuntime(createSessionRuntimeState([
      session({ externalSessionId: undefined, connected: false, running: false }),
    ]), { type: "host-event", envelope: structuredOpened() });

    expect(state.sessions[0]).toEqual(expect.objectContaining({
      connected: true,
      running: true,
      externalSessionId: "codex-thread-1",
    }));
    expect(state.connectionBySessionId.s.source).toEqual(handshakeSource);
  });

  it("rejects structured opens with mismatched agent, provider session, integration, or transport mode", () => {
    const initial = createSessionRuntimeState([session({ externalSessionId: "codex-thread-1" })]);

    expect(reduceSessionRuntime(initial, { type: "host-event", envelope: structuredOpened("stream-1", { ...handshakeSource, agentId: "pi", integration: "rpc" }) })).toBe(initial);
    expect(reduceSessionRuntime(initial, { type: "host-event", envelope: structuredOpened("stream-1", { ...handshakeSource, providerSessionId: "other-thread" }) })).toBe(initial);
    expect(reduceSessionRuntime(initial, { type: "host-event", envelope: structuredOpened("stream-1", { ...handshakeSource, integration: "hooks" }) })).toBe(initial);
    expect(reduceSessionRuntime(initial, { type: "host-event", envelope: envelope(0, { type: "opened", transport: { type: "pty", lifecycleEvidence: "structured", source: handshakeSource }, promptReadiness: "awaiting-authoritative" }) })).toBe(initial);
    expect(reduceSessionRuntime(initial, { type: "host-event", envelope: envelope(0, { type: "opened", transport: { type: "protocol", lifecycleEvidence: "structured", source: handshakeSource }, promptReadiness: "ready" }) })).toBe(initial);

    const claudeState = reduceSessionRuntime(createSessionRuntimeState([session({ agentId: "claude-code" })]), { type: "host-event", envelope: claudePtyOpened() });
    expect(claudeState.connectionBySessionId.s.transport.type).toBe("pty");
  });

  it("rejects mismatched activity source before cursor advancement", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: structuredOpened() });
    const rejected = reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-started", evidence: "structured" }, turn, { ...source, providerSessionId: "other-thread" }) });

    expect(rejected).toBe(state);
    expect(rejected.cursorBySessionId.s).toBe(0);
    expect(rejected.sessions[0].status).toBe("idle");
  });

  it("rejects wrong-turn activity before cursor advancement", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: structuredOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-started", evidence: "structured" }) });
    const rejected = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-ended", evidence: "structured", outcome: "completed" }, otherTurn) });

    expect(rejected).toBe(state);
    expect(rejected.cursorBySessionId.s).toBe(1);
    expect(rejected.sessions[0].status).toBe("working");
  });

  it("applies accepted structured Idle to Working to Done events", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session({ status: "idle" })]), { type: "host-event", envelope: structuredOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-started", evidence: "structured" }) });
    expect(state.sessions[0].status).toBe("working");
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-ended", evidence: "structured", outcome: "completed" }) });
    expect(state.sessions[0].status).toBe("done");
    expect(state.connectionBySessionId.s.currentTurn).toEqual(turn);
  });

  it.each([
    ["completed", "done"],
    ["failed", "attention"],
    ["interrupted", "idle"],
  ] as const)("accepts exact %s outcome once and rejects duplicate or conflicting outcomes", (outcome, status) => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: structuredOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-started", evidence: "structured" }) });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-ended", evidence: "structured", outcome }) });
    expect(state.sessions[0].status).toBe(status);
    expect(state.connectionBySessionId.s.terminalOutcome).toBe(outcome);
    expect(state.cursorBySessionId.s).toBe(2);

    for (const conflict of [outcome, outcome === "failed" ? "completed" : "failed"] as const) {
      const rejected = reduceSessionRuntime(state, { type: "host-event", envelope: activity(3, { type: "turn-ended", evidence: "structured", outcome: conflict }) });
      expect(rejected).toBe(state);
      expect(rejected.cursorBySessionId.s).toBe(2);
    }
  });

  it("accepts pending resolution after termination, rejects stale requests, then clears outcome for a new turn", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: structuredOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-started", evidence: "structured" }) });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "attention-requested", evidence: "structured", key: "approval" }) });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(3, { type: "turn-ended", evidence: "structured", outcome: "interrupted" }) });
    const stale = reduceSessionRuntime(state, { type: "host-event", envelope: activity(4, { type: "attention-requested", evidence: "structured", key: "late" }) });
    expect(stale).toBe(state);
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(4, { type: "attention-resolved", evidence: "structured", key: "approval" }) });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(5, { type: "turn-started", evidence: "structured" }, otherTurn) });
    expect(state.connectionBySessionId.s.terminalOutcome).toBeUndefined();
    expect(state.sessions[0].status).toBe("working");
  });

  it("accepts the next provider turn after the previous result was reviewed locally", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session({ status: "idle" })]), { type: "host-event", envelope: structuredOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-started", evidence: "structured" }) });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-ended", evidence: "structured", outcome: "completed" }) });
    state = reduceSessionRuntime(state, { type: "review", sessionId: "s" });
    expect(state.sessions[0].status).toBe("idle");

    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(3, { type: "turn-started", evidence: "structured" }, otherTurn) });
    expect(state.sessions[0].status).toBe("working");
    expect(state.connectionBySessionId.s.currentTurn).toEqual(otherTurn);
  });

  it("correlates attention resolution in transport state", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session({ status: "idle" })]), { type: "host-event", envelope: structuredOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-started", evidence: "structured" }) });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "attention-requested", evidence: "structured", key: "approval-1" }) });
    expect(state.connectionBySessionId.s.pendingAttentionKeys).toEqual(["approval-1"]);

    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(3, { type: "attention-resolved", evidence: "structured", key: "approval-1" }) });
    expect(state.connectionBySessionId.s.pendingAttentionKeys).toEqual([]);
    expect(state.cursorBySessionId.s).toBe(3);
  });
});
