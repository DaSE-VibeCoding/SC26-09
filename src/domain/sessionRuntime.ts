import type { ActivityEvent, LiveTurnLifecycle } from "./lifecycle";
import type { AgentSession } from "./models";
import type { HostedSessionSnapshot, SessionEventEnvelope, SessionTransportDescriptor } from "./sessionHost";
import {
  applySessionActivityEvents,
  createLiveTurnLifecycleFromSessionStatus,
  initializeSessionLifecycleForMode,
  reviewSessionLifecycle,
  type LiveSessionInitializationMode,
} from "./sessionLifecycle";
import { reduceSessionStatus } from "./status";

export interface SessionConnectionSnapshot {
  readonly streamId: string;
  readonly transport: SessionTransportDescriptor;
  readonly open: boolean;
}

export interface SessionRuntimeState {
  readonly sessions: readonly AgentSession[];
  readonly lifecycleBySessionId: Readonly<Record<string, LiveTurnLifecycle>>;
  readonly connectionBySessionId: Readonly<Record<string, SessionConnectionSnapshot>>;
  readonly cursorBySessionId: Readonly<Record<string, number>>;
}

export type SessionRuntimeAction =
  | { type: "replace-sessions"; sessions: readonly AgentSession[] }
  | { type: "initialize"; sessionId: string; mode: LiveSessionInitializationMode }
  | { type: "activity"; sessionId: string; events: readonly ActivityEvent[]; patch?: Partial<AgentSession> }
  | { type: "review"; sessionId: string }
  | { type: "clear-lifecycle"; sessionId: string }
  | { type: "remove"; sessionId: string }
  | { type: "host-snapshot"; snapshot: HostedSessionSnapshot }
  | { type: "host-event"; envelope: SessionEventEnvelope };

export function createSessionRuntimeState(sessions: readonly AgentSession[]): SessionRuntimeState {
  return { sessions: [...sessions], lifecycleBySessionId: {}, connectionBySessionId: {}, cursorBySessionId: {} };
}

export function reduceSessionRuntime(state: SessionRuntimeState, action: SessionRuntimeAction): SessionRuntimeState {
  switch (action.type) {
    case "replace-sessions": {
      const ids = new Set(action.sessions.map((session) => session.id));
      return {
        ...state,
        sessions: [...action.sessions],
        lifecycleBySessionId: retain(state.lifecycleBySessionId, ids),
        connectionBySessionId: retain(state.connectionBySessionId, ids),
        cursorBySessionId: retain(state.cursorBySessionId, ids),
      };
    }
    case "initialize": {
      const session = find(state, action.sessionId);
      if (!session) return state;
      const applied = initializeSessionLifecycleForMode(
        session,
        action.mode,
        state.lifecycleBySessionId[action.sessionId],
      );
      return applySessionAndLifecycle(state, applied.session, applied.lifecycle);
    }
    case "activity": {
      const session = find(state, action.sessionId);
      if (!session) return state;
      const lifecycle = state.lifecycleBySessionId[action.sessionId]
        ?? createLiveTurnLifecycleFromSessionStatus(session.status);
      const applied = applySessionActivityEvents(session, lifecycle, action.events);
      return applySessionAndLifecycle(
        state,
        action.patch ? { ...applied.session, ...action.patch } : applied.session,
        applied.lifecycle,
      );
    }
    case "review": {
      const session = find(state, action.sessionId);
      if (!session) return state;
      const reviewed = reviewSessionLifecycle(session, state.lifecycleBySessionId[action.sessionId]);
      return reviewed.lifecycle
        ? applySessionAndLifecycle(state, reviewed.session, reviewed.lifecycle)
        : removeLifecycle(replaceSession(state, reviewed.session), action.sessionId);
    }
    case "clear-lifecycle":
      return removeLifecycle(state, action.sessionId);
    case "remove":
      return removeSession(state, action.sessionId);
    case "host-snapshot": {
      const { snapshot } = action;
      const session = find(state, snapshot.sessionId);
      if (!session) return state;
      const connection = state.connectionBySessionId[snapshot.sessionId];
      if (connection?.streamId === snapshot.streamId) {
        const cursor = state.cursorBySessionId[snapshot.sessionId] ?? -1;
        if (!connection.open || snapshot.lastSequence < cursor) return state;
      }
      const connectedState = replaceSessionConnection(state, session, true, true);
      return {
        ...connectedState,
        connectionBySessionId: {
          ...connectedState.connectionBySessionId,
          [snapshot.sessionId]: { streamId: snapshot.streamId, transport: snapshot.transport, open: true },
        },
        cursorBySessionId: { ...connectedState.cursorBySessionId, [snapshot.sessionId]: snapshot.lastSequence },
      };
    }
    case "host-event":
      return reduceHostEvent(state, action.envelope);
  }
}

function reduceHostEvent(state: SessionRuntimeState, envelope: SessionEventEnvelope): SessionRuntimeState {
  const session = find(state, envelope.sessionId);
  if (!session) return state;
  const connection = state.connectionBySessionId[envelope.sessionId];
  if (!connection) {
    if (envelope.event.type !== "opened") return state;
  } else {
    if (envelope.event.type === "opened") {
      if (connection.open || connection.streamId === envelope.streamId) return state;
    } else {
      if (connection.streamId !== envelope.streamId || !connection.open) return state;
      if (envelope.event.type === "terminal-output" && connection.transport.type === "protocol") return state;
      if (envelope.sequence <= (state.cursorBySessionId[envelope.sessionId] ?? -1)) return state;
    }
  }

  let next: SessionRuntimeState = {
    ...state,
    connectionBySessionId: envelope.event.type === "opened"
      ? { ...state.connectionBySessionId, [envelope.sessionId]: { streamId: envelope.streamId, transport: envelope.event.transport, open: true } }
      : state.connectionBySessionId,
    cursorBySessionId: { ...state.cursorBySessionId, [envelope.sessionId]: envelope.sequence },
  };
  if (envelope.event.type === "opened") {
    next = replaceSessionConnection(next, session, true, true);
  } else if (envelope.event.type === "activity") {
    next = reduceSessionRuntime(next, { type: "activity", sessionId: envelope.sessionId, events: [envelope.event.activity] });
  } else if (envelope.event.type === "closed") {
    const status = envelope.event.outcome.type === "stopped"
      ? session.resumeHandle ? "available" : "offline"
      : reduceSessionStatus(session.status, { type: "process-exited", success: envelope.event.outcome.success });
    next = replaceSession(next, { ...session, connected: false, running: false, status });
    next = removeLifecycle(next, session.id);
    next = { ...next, connectionBySessionId: { ...next.connectionBySessionId, [session.id]: { ...next.connectionBySessionId[session.id], open: false } } };
  }
  return next;
}

function find(state: SessionRuntimeState, id: string): AgentSession | undefined {
  return state.sessions.find((session) => session.id === id);
}

function replaceSession(state: SessionRuntimeState, session: AgentSession): SessionRuntimeState {
  return { ...state, sessions: state.sessions.map((candidate) => candidate.id === session.id ? session : candidate) };
}

function replaceSessionConnection(
  state: SessionRuntimeState,
  session: AgentSession,
  connected: boolean,
  running: boolean,
): SessionRuntimeState {
  if (session.connected === connected && session.running === running) return state;
  return replaceSession(state, { ...session, connected, running });
}

function applySessionAndLifecycle(state: SessionRuntimeState, session: AgentSession, lifecycle: LiveTurnLifecycle): SessionRuntimeState {
  return {
    ...replaceSession(state, session),
    lifecycleBySessionId: { ...state.lifecycleBySessionId, [session.id]: lifecycle },
  };
}

function removeLifecycle(state: SessionRuntimeState, id: string): SessionRuntimeState {
  const lifecycleBySessionId = { ...state.lifecycleBySessionId };
  delete lifecycleBySessionId[id];
  return { ...state, lifecycleBySessionId };
}

function removeSession(state: SessionRuntimeState, id: string): SessionRuntimeState {
  const ids = new Set(state.sessions.filter((session) => session.id !== id).map((session) => session.id));
  return {
    sessions: state.sessions.filter((session) => session.id !== id),
    lifecycleBySessionId: retain(state.lifecycleBySessionId, ids),
    connectionBySessionId: retain(state.connectionBySessionId, ids),
    cursorBySessionId: retain(state.cursorBySessionId, ids),
  };
}

function retain<T>(source: Readonly<Record<string, T>>, ids: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(source).filter(([id]) => ids.has(id)));
}
