import {
  createLiveTurnLifecycle,
  deriveLiveSessionStatus,
  reduceLiveTurnLifecycle,
  type ActivityEvent,
  type LiveTurnLifecycle,
} from "./lifecycle";
import type { AgentSession, SessionStatus } from "./models";
import { reduceSessionStatus } from "./status";

export const PTY_FALLBACK_ATTENTION_KEY = "pty-fallback-attention";

export type LiveSessionInitializationMode = "fresh" | "reuse-existing" | "seed-from-status";

export type TerminalOutputFallbackAction = "none" | "request-attention" | "start-turn";

export interface SessionLifecycleApplication {
  readonly session: AgentSession;
  readonly lifecycle: LiveTurnLifecycle;
}

export interface SessionLifecycleReview {
  readonly session: AgentSession;
  readonly lifecycle?: LiveTurnLifecycle;
}

export interface TerminalOutputFallbackContext {
  readonly currentStatus: SessionStatus;
  readonly requestedAttention: boolean;
  readonly hasStartedWork: boolean;
}

export function initializeSessionLifecycle(
  session: AgentSession,
  lifecycle: LiveTurnLifecycle = createLiveTurnLifecycle(),
): SessionLifecycleApplication {
  return materializeSessionLifecycle(session, lifecycle);
}

export function initializeSessionLifecycleForMode(
  session: AgentSession,
  mode: LiveSessionInitializationMode,
  existingLifecycle?: LiveTurnLifecycle,
): SessionLifecycleApplication {
  switch (mode) {
    case "fresh":
      return initializeSessionLifecycle(session);
    case "reuse-existing":
      return initializeSessionLifecycle(session, existingLifecycle);
    case "seed-from-status":
      return initializeSessionLifecycle(
        session,
        createLiveTurnLifecycleFromSessionStatus(session.status),
      );
  }
}

export function reviewSessionLifecycle(
  session: AgentSession,
  lifecycle?: LiveTurnLifecycle,
): SessionLifecycleReview {
  if (session.connected && session.running) {
    const applied = applySessionActivityEvent(
      session,
      lifecycle ?? createLiveTurnLifecycleFromSessionStatus(session.status),
      { type: "result-reviewed" },
    );
    return {
      lifecycle: applied.lifecycle,
      session: applied.session.unread ? { ...applied.session, unread: false } : applied.session,
    };
  }

  const status = reduceSessionStatus(session.status, {
    type: "reviewed",
    running: session.running,
  });
  return {
    session: session.unread || session.status !== status
      ? { ...session, status, unread: false }
      : session,
  };
}

export function selectTerminalOutputFallbackAction(
  lifecycle: LiveTurnLifecycle,
  context: TerminalOutputFallbackContext,
): TerminalOutputFallbackAction {
  if (context.requestedAttention) return "request-attention";
  if (!context.hasStartedWork) return "none";
  if (context.currentStatus === "done" || lifecycle.phase === "completed") return "none";
  return "start-turn";
}

export function createLiveTurnLifecycleFromSessionStatus(
  status: SessionStatus,
): LiveTurnLifecycle {
  const initial = createLiveTurnLifecycle();

  switch (status) {
    case "attention":
      return reduceLiveTurnLifecycle(initial, {
        type: "attention-requested",
        evidence: "fallback",
        key: PTY_FALLBACK_ATTENTION_KEY,
      });
    case "working":
      return reduceLiveTurnLifecycle(initial, { type: "turn-started", evidence: "fallback" });
    case "done":
      return reduceLiveTurnLifecycle(initial, { type: "turn-completed", evidence: "fallback" });
    case "idle":
    case "available":
    case "offline":
      return initial;
  }
}

export function applySessionActivityEvent(
  session: AgentSession,
  lifecycle: LiveTurnLifecycle,
  event: ActivityEvent,
): SessionLifecycleApplication {
  return applySessionActivityEvents(session, lifecycle, [event]);
}

export function applySessionActivityEvents(
  session: AgentSession,
  lifecycle: LiveTurnLifecycle,
  events: readonly ActivityEvent[],
): SessionLifecycleApplication {
  const nextLifecycle = events.reduce(
    (current, event) => reduceLiveTurnLifecycle(current, event),
    lifecycle,
  );
  return materializeSessionLifecycle(session, nextLifecycle);
}

function materializeSessionLifecycle(
  session: AgentSession,
  lifecycle: LiveTurnLifecycle,
): SessionLifecycleApplication {
  const status = deriveLiveSessionStatus(lifecycle);
  return {
    lifecycle,
    session: session.status === status ? session : { ...session, status },
  };
}
