import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "./lifecycle";
import type { AgentSession, SessionStatus } from "./models";
import {
  applySessionActivityEvent,
  applySessionActivityEvents,
  createLiveTurnLifecycleFromSessionStatus,
  initializeSessionLifecycleForMode,
  initializeSessionLifecycle,
  PTY_FALLBACK_ATTENTION_KEY,
  reviewSessionLifecycle,
  selectTerminalOutputFallbackAction,
} from "./sessionLifecycle";

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    agentId: "codex",
    title: "Test session",
    status: "idle",
    createdAt: "2026-07-17T00:00:00.000Z",
    lastActivityAt: "2026-07-17T00:00:00.000Z",
    unread: false,
    connected: true,
    running: true,
    origin: "pelican",
    ...overrides,
  };
}

function initializeFromStatus(status: SessionStatus) {
  const target = session({ status });
  return initializeSessionLifecycle(
    target,
    createLiveTurnLifecycleFromSessionStatus(target.status),
  );
}

const fallbackTurnStarted = { type: "turn-started", evidence: "fallback" } satisfies ActivityEvent;
const fallbackAttentionRequested = {
  type: "attention-requested",
  evidence: "fallback",
  key: PTY_FALLBACK_ATTENTION_KEY,
} satisfies ActivityEvent;
const fallbackAttentionResolved = {
  type: "attention-resolved",
  evidence: "fallback",
  key: PTY_FALLBACK_ATTENTION_KEY,
} satisfies ActivityEvent;
const fallbackTurnCompleted = { type: "turn-completed", evidence: "fallback" } satisfies ActivityEvent;

describe("session lifecycle application", () => {
  it("initializes a live startup or reconnect boundary as idle without changing transport fields", () => {
    const connectedAvailable = session({ status: "available", connected: true, running: true });
    const { session: initialized, lifecycle } = initializeSessionLifecycle(connectedAvailable);

    expect(initialized).toEqual(expect.objectContaining({
      status: "idle",
      connected: true,
      running: true,
    }));
    expect(lifecycle.phase).toBe("idle");
    expect(lifecycle.pendingAttentionKeys).toEqual([]);
  });

  it("maps fallback submission evidence to Working", () => {
    const initialized = initializeSessionLifecycle(session());

    const submitted = applySessionActivityEvent(
      initialized.session,
      initialized.lifecycle,
      fallbackTurnStarted,
    );

    expect(submitted.session.status).toBe("working");
    expect(submitted.lifecycle.phase).toBe("working");
  });

  it("keeps fallback attention sticky through review until the matching response", () => {
    const initialized = initializeSessionLifecycle(session());
    const attention = applySessionActivityEvents(
      initialized.session,
      initialized.lifecycle,
      [fallbackTurnStarted, fallbackAttentionRequested],
    );

    expect(attention.session.status).toBe("attention");

    const reviewed = applySessionActivityEvent(
      attention.session,
      attention.lifecycle,
      { type: "result-reviewed" },
    );

    expect(reviewed.session.status).toBe("attention");
    expect(reviewed.lifecycle.pendingAttentionKeys).toEqual([PTY_FALLBACK_ATTENTION_KEY]);

    const response = applySessionActivityEvents(
      reviewed.session,
      reviewed.lifecycle,
      [fallbackAttentionResolved, fallbackTurnStarted],
    );

    expect(response.session.status).toBe("working");
    expect(response.lifecycle.pendingAttentionKeys).toEqual([]);
  });

  it("maps quiet-turn fallback completion to Done while preserving unresolved attention", () => {
    const initialized = initializeSessionLifecycle(session());
    const working = applySessionActivityEvent(
      initialized.session,
      initialized.lifecycle,
      fallbackTurnStarted,
    );

    const done = applySessionActivityEvent(working.session, working.lifecycle, fallbackTurnCompleted);
    expect(done.session.status).toBe("done");

    const attention = applySessionActivityEvents(
      working.session,
      working.lifecycle,
      [fallbackAttentionRequested, fallbackTurnCompleted],
    );
    expect(attention.session.status).toBe("attention");
    expect(attention.lifecycle.phase).toBe("completed");
  });

  it("maps reviewed live Done results back to Idle", () => {
    const done = initializeFromStatus("done");

    const reviewed = applySessionActivityEvent(
      done.session,
      done.lifecycle,
      { type: "result-reviewed" },
    );

    expect(reviewed.session.status).toBe("idle");
    expect(reviewed.lifecycle.phase).toBe("idle");
  });

  it("can seed a reattached live session from the current normalized status", () => {
    const attention = initializeFromStatus("attention");
    expect(attention.session.status).toBe("attention");
    expect(attention.lifecycle.pendingAttentionKeys).toEqual([PTY_FALLBACK_ATTENTION_KEY]);

    const working = initializeFromStatus("working");
    expect(working.session.status).toBe("working");
    expect(working.lifecycle.phase).toBe("working");
  });

  it("initializes a resumed session fresh even when a stale lifecycle exists", () => {
    const staleWorking = createLiveTurnLifecycleFromSessionStatus("working");

    const initialized = initializeSessionLifecycleForMode(
      session({ status: "done" }),
      "fresh",
      staleWorking,
    );

    expect(initialized.session.status).toBe("idle");
    expect(initialized.lifecycle.phase).toBe("idle");
  });

  it("can reuse an existing lifecycle populated by early output", () => {
    const earlyOutput = createLiveTurnLifecycleFromSessionStatus("working");

    const initialized = initializeSessionLifecycleForMode(
      session({ status: "idle" }),
      "reuse-existing",
      earlyOutput,
    );

    expect(initialized.session.status).toBe("working");
    expect(initialized.lifecycle).toBe(earlyOutput);
  });

  it("can seed an attached or reconnected session from status while ignoring stale lifecycle", () => {
    const staleWorking = createLiveTurnLifecycleFromSessionStatus("working");

    const initialized = initializeSessionLifecycleForMode(
      session({ status: "done" }),
      "seed-from-status",
      staleWorking,
    );

    expect(initialized.session.status).toBe("done");
    expect(initialized.lifecycle.phase).toBe("completed");
  });

  it("reviews only connected and running sessions through the live lifecycle", () => {
    const liveCompleted = createLiveTurnLifecycleFromSessionStatus("done");

    const reviewed = reviewSessionLifecycle(
      session({ status: "done", connected: true, running: true, unread: true }),
      liveCompleted,
    );

    expect(reviewed.session.status).toBe("idle");
    expect(reviewed.session.unread).toBe(false);
    expect(reviewed.lifecycle?.phase).toBe("idle");
  });

  it.each([
    { connected: true, running: false, expected: "offline" },
    { connected: false, running: true, expected: "idle" },
    { connected: false, running: false, expected: "offline" },
  ] as const)(
    "reviews done sessions with connected=$connected running=$running through legacy status reduction",
    ({ connected, running, expected }) => {
      const staleWorking = createLiveTurnLifecycleFromSessionStatus("working");

      const reviewed = reviewSessionLifecycle(
        session({ status: "done", connected, running, unread: true }),
        staleWorking,
      );

      expect(reviewed.session.status).toBe(expected);
      expect(reviewed.session.unread).toBe(false);
      expect(reviewed.lifecycle).toBeUndefined();
    },
  );

  it("does not create a lifecycle entry when reviewing a disconnected external row", () => {
    const reviewed = reviewSessionLifecycle(session({
      status: "done",
      connected: false,
      running: true,
      unread: true,
      origin: "claude-history",
      externalSessionId: "external-1",
    }));

    expect(reviewed.session.status).toBe("idle");
    expect(reviewed.session.unread).toBe(false);
    expect(reviewed.lifecycle).toBeUndefined();
  });

  it("suppresses ordinary fallback output starts after a visible completion", () => {
    const completed = createLiveTurnLifecycleFromSessionStatus("done");

    expect(selectTerminalOutputFallbackAction(completed, {
      currentStatus: "done",
      requestedAttention: false,
      hasStartedWork: true,
    })).toBe("none");

    const submitted = applySessionActivityEvent(
      session({ status: "done" }),
      completed,
      fallbackTurnStarted,
    );
    expect(submitted.session.status).toBe("working");
    expect(submitted.lifecycle.phase).toBe("working");
  });

  it("suppresses ordinary fallback output starts while completion is latent under attention", () => {
    const initialized = initializeSessionLifecycle(session());
    const latentCompletion = applySessionActivityEvents(
      initialized.session,
      initialized.lifecycle,
      [fallbackTurnStarted, fallbackAttentionRequested, fallbackTurnCompleted],
    );

    expect(latentCompletion.session.status).toBe("attention");
    expect(latentCompletion.lifecycle.phase).toBe("completed");
    expect(selectTerminalOutputFallbackAction(latentCompletion.lifecycle, {
      currentStatus: latentCompletion.session.status,
      requestedAttention: false,
      hasStartedWork: true,
    })).toBe("none");

    const submitted = applySessionActivityEvents(
      latentCompletion.session,
      latentCompletion.lifecycle,
      [fallbackAttentionResolved, fallbackTurnStarted],
    );
    expect(submitted.session.status).toBe("working");
    expect(submitted.lifecycle.phase).toBe("working");
  });

  it("allows engaged fallback output to start work before completion", () => {
    const initialized = initializeSessionLifecycle(session());

    expect(selectTerminalOutputFallbackAction(initialized.lifecycle, {
      currentStatus: initialized.session.status,
      requestedAttention: false,
      hasStartedWork: true,
    })).toBe("start-turn");
  });
});
