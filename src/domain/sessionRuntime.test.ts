import { describe, expect, it } from "vitest";
import type { AgentSession } from "./models";
import { createSessionRuntimeState, reduceSessionRuntime } from "./sessionRuntime";
import type { SessionEventEnvelope, StructuredLifecycleSource, StructuredTurnIdentity } from "./sessionHost";

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
  protocolVersion: 2, sessionId: "s", streamId, sequence, event,
});
const fallbackOpened = (streamId = "stream-1") => envelope(0, { type: "opened", transport: { type: "pty", lifecycleEvidence: "fallback" } }, streamId);
const structuredOpened = (streamId = "stream-1", openSource: StructuredLifecycleSource = handshakeSource) => envelope(0, { type: "opened", transport: { type: "protocol", lifecycleEvidence: "structured", source: openSource } }, streamId);
const claudePtyOpened = (streamId = "stream-1") => envelope(0, { type: "opened", transport: { type: "pty", lifecycleEvidence: "structured", source: claudeSource } }, streamId);
const activity = (
  sequence: number,
  activity: Extract<SessionEventEnvelope["event"], { type: "activity" }>["activity"],
  activityTurn = turn,
  activitySource = source,
) => envelope(sequence, { type: "activity", source: activitySource, context: { turn: activityTurn }, activity });

describe("session runtime reducer", () => {
  it("atomically initializes, applies local activity, reviews, and removes", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session({ status: "available" })]), { type: "initialize", sessionId: "s", mode: "fresh" });
    state = reduceSessionRuntime(state, { type: "activity", sessionId: "s", events: [{ type: "turn-completed", evidence: "fallback" }], patch: { unread: true } });
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
    expect(reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-completed", evidence: "structured" }) })).toBe(state);
    expect(reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-completed", evidence: "structured" }) })).toBe(accepted);
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
      snapshot: { protocolVersion: 2, sessionId: "s", streamId: "stream-1", lastSequence: 4, transport: { type: "pty", lifecycleEvidence: "fallback" } },
    });
    expect(snapshotState.sessions[0]).toEqual(expect.objectContaining({ connected: true, running: true }));

    const openedState = reduceSessionRuntime(createSessionRuntimeState([
      session({ status: "offline", connected: false, running: false }),
    ]), { type: "host-event", envelope: fallbackOpened() });
    expect(openedState.sessions[0]).toEqual(expect.objectContaining({ connected: true, running: true }));
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
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-completed", evidence: "structured" }) });
    const lifecycle = state.lifecycleBySessionId.s;
    state = reduceSessionRuntime(state, { type: "activity", sessionId: "s", events: [{ type: "turn-started", evidence: "fallback" }] });
    expect(state.sessions[0].status).toBe("done");
    expect(state.lifecycleBySessionId.s).toBe(lifecycle);
  });

  it("applies snapshots and replays deterministically without mutating inputs", () => {
    const initial = createSessionRuntimeState([session()]);
    const actions = [
      { type: "host-snapshot", snapshot: { protocolVersion: 2, sessionId: "s", streamId: "stream-1", lastSequence: 4, transport: { type: "protocol", lifecycleEvidence: "structured", source: handshakeSource } } },
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
    state = reduceSessionRuntime(state, { type: "host-snapshot", snapshot: { protocolVersion: 2, sessionId: "s", streamId: "stream-1", lastSequence: 2, transport: { type: "pty", lifecycleEvidence: "fallback" } } });
    expect(state).toBe(current);
    state = reduceSessionRuntime(state, { type: "host-event", envelope: envelope(5, { type: "closed", outcome: { type: "exited", success: true } }) });
    const closed = state;
    state = reduceSessionRuntime(state, { type: "host-snapshot", snapshot: { protocolVersion: 2, sessionId: "s", streamId: "stream-1", lastSequence: 5, transport: { type: "pty", lifecycleEvidence: "fallback" } } });
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
    expect(reduceSessionRuntime(initial, { type: "host-event", envelope: envelope(0, { type: "opened", transport: { type: "pty", lifecycleEvidence: "structured", source: handshakeSource } }) })).toBe(initial);

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
    const rejected = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-completed", evidence: "structured" }, otherTurn) });

    expect(rejected).toBe(state);
    expect(rejected.cursorBySessionId.s).toBe(1);
    expect(rejected.sessions[0].status).toBe("working");
  });

  it("applies accepted structured Idle to Working to Done events", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session({ status: "idle" })]), { type: "host-event", envelope: structuredOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-started", evidence: "structured" }) });
    expect(state.sessions[0].status).toBe("working");
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-completed", evidence: "structured" }) });
    expect(state.sessions[0].status).toBe("done");
    expect(state.connectionBySessionId.s.currentTurn).toEqual(turn);
  });

  it("accepts the next provider turn after the previous result was reviewed locally", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session({ status: "idle" })]), { type: "host-event", envelope: structuredOpened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(1, { type: "turn-started", evidence: "structured" }) });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: activity(2, { type: "turn-completed", evidence: "structured" }) });
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
