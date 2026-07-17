import { describe, expect, it } from "vitest";
import type { AgentSession } from "./models";
import { createSessionRuntimeState, reduceSessionRuntime } from "./sessionRuntime";
import type { SessionEventEnvelope } from "./sessionHost";

const session = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: "s", workspaceId: "w", agentId: "codex", title: "Session", status: "idle",
  createdAt: "created", lastActivityAt: "activity", unread: false, connected: true,
  running: true, origin: "pelican", ...overrides,
});
const envelope = (sequence: number, event: SessionEventEnvelope["event"], streamId = "stream-1"): SessionEventEnvelope => ({
  protocolVersion: 1, sessionId: "s", streamId, sequence, event,
});
const opened = (streamId = "stream-1") => envelope(0, { type: "opened", transport: { type: "pty", lifecycleEvidence: "structured" } }, streamId);
const protocolOpened = (streamId = "stream-1") => envelope(0, { type: "opened", transport: { type: "protocol", lifecycleEvidence: "structured" } }, streamId);

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
    const premature = reduceSessionRuntime(initial, { type: "host-event", envelope: envelope(1, { type: "activity", activity: { type: "turn-started", evidence: "structured" } }) });
    expect(premature).toBe(initial);
    let state = reduceSessionRuntime(initial, { type: "host-event", envelope: opened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: envelope(2, { type: "activity", activity: { type: "turn-started", evidence: "structured" } }) });
    const accepted = state;
    expect(state.sessions[0].status).toBe("working");
    expect(reduceSessionRuntime(state, { type: "host-event", envelope: envelope(2, { type: "activity", activity: { type: "turn-completed", evidence: "structured" } }) })).toBe(state);
    expect(reduceSessionRuntime(state, { type: "host-event", envelope: envelope(1, { type: "activity", activity: { type: "turn-completed", evidence: "structured" } }) })).toBe(accepted);
  });

  it("keeps close final and cannot close a replacement stream with an old event", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: opened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: envelope(3, { type: "closed", outcome: { type: "exited", success: true } }) });
    expect(state.connectionBySessionId.s.open).toBe(false);
    expect(state.sessions[0]).toEqual(expect.objectContaining({ connected: false, running: false }));
    state = reduceSessionRuntime(state, { type: "host-event", envelope: opened("stream-2") });
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
      snapshot: { protocolVersion: 1, sessionId: "s", streamId: "stream-1", lastSequence: 4, transport: { type: "pty", lifecycleEvidence: "fallback" } },
    });
    expect(snapshotState.sessions[0]).toEqual(expect.objectContaining({ connected: true, running: true }));

    const openedState = reduceSessionRuntime(createSessionRuntimeState([
      session({ status: "offline", connected: false, running: false }),
    ]), { type: "host-event", envelope: opened() });
    expect(openedState.sessions[0]).toEqual(expect.objectContaining({ connected: true, running: true }));
  });

  it("rejects protocol terminal output without changing state or advancing the cursor", () => {
    const state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: protocolOpened() });
    const rejected = reduceSessionRuntime(state, { type: "host-event", envelope: envelope(1, { type: "terminal-output", data: "hello" }) });

    expect(rejected).toBe(state);
    expect(rejected.cursorBySessionId.s).toBe(0);
  });

  it("latches structured authority against later local fallback", () => {
    let state = reduceSessionRuntime(createSessionRuntimeState([session()]), { type: "host-event", envelope: opened() });
    state = reduceSessionRuntime(state, { type: "host-event", envelope: envelope(1, { type: "activity", activity: { type: "turn-completed", evidence: "structured" } }) });
    const lifecycle = state.lifecycleBySessionId.s;
    state = reduceSessionRuntime(state, { type: "activity", sessionId: "s", events: [{ type: "turn-started", evidence: "fallback" }] });
    expect(state.sessions[0].status).toBe("done");
    expect(state.lifecycleBySessionId.s).toBe(lifecycle);
  });

  it("applies snapshots and replays deterministically without mutating inputs", () => {
    const initial = createSessionRuntimeState([session()]);
    const actions = [
      { type: "host-snapshot", snapshot: { protocolVersion: 1, sessionId: "s", streamId: "stream-1", lastSequence: 4, transport: { type: "protocol", lifecycleEvidence: "structured" } } },
      { type: "host-event", envelope: envelope(5, { type: "activity", activity: { type: "turn-started", evidence: "structured" } }) },
    ] as const;
    const replay = () => actions.reduce(reduceSessionRuntime, initial);
    expect(replay()).toEqual(replay());
    expect(initial.connectionBySessionId).toEqual({});
  });
});
