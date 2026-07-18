import type { ActivityEvent, LiveTurnLifecycle, TerminalOutcome } from "./lifecycle";
import type { AgentSession } from "./models";
import type {
  HostedSessionSnapshot,
  PromptReadinessState,
  SessionEventEnvelope,
  SessionTransportDescriptor,
  StructuredLifecycleIntegration,
  StructuredLifecycleSource,
  StructuredTurnIdentity,
} from "./sessionHost";
import {
  applySessionActivityEvents,
  createLiveTurnLifecycleFromSessionStatus,
  initializeSessionLifecycleForMode,
  reviewSessionLifecycle,
  type LiveSessionInitializationMode,
} from "./sessionLifecycle";
import {
  initialPromptReadinessForTransport,
} from "./sessionPrompt";
import { reduceSessionStatus } from "./status";

export interface SessionConnectionSnapshot {
  readonly streamId: string;
  readonly transport: SessionTransportDescriptor;
  readonly open: boolean;
  readonly promptReadiness: PromptReadinessState;
  readonly source?: StructuredLifecycleSource;
  readonly currentTurn?: StructuredTurnIdentity;
  readonly pendingAttentionKeys?: readonly string[];
  readonly terminalOutcome?: TerminalOutcome;
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
      if (!promptReadinessMatchesTransport(snapshot.transport, snapshot.promptReadiness)) return state;
      const acceptedSession = acceptOpenedSession(session, snapshot.transport);
      if (!acceptedSession || !connectionSourceCanRemain(connection, snapshot.streamId, snapshot.transport)) return state;
      const connectedSession = acceptedSession.connected && acceptedSession.running
        ? acceptedSession
        : { ...acceptedSession, connected: true, running: true };
      const connectedState = connectedSession === session ? state : replaceSession(state, connectedSession);
      return {
        ...connectedState,
        connectionBySessionId: {
          ...connectedState.connectionBySessionId,
          [snapshot.sessionId]: {
            streamId: snapshot.streamId,
            transport: snapshot.transport,
            open: true,
            promptReadiness: snapshot.promptReadiness,
            source: transportSource(snapshot.transport),
            currentTurn: connection?.streamId === snapshot.streamId ? connection.currentTurn : undefined,
            pendingAttentionKeys: connection?.streamId === snapshot.streamId ? connection.pendingAttentionKeys : undefined,
            terminalOutcome: connection?.streamId === snapshot.streamId ? connection.terminalOutcome : undefined,
          },
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

  if (envelope.event.type === "opened") {
    if (envelope.event.promptReadiness !== initialPromptReadinessForTransport(envelope.event.transport)) return state;
    const acceptedSession = acceptOpenedSession(session, envelope.event.transport);
    if (!acceptedSession) return state;
    const openedSession = acceptedSession.connected && acceptedSession.running
      ? acceptedSession
      : { ...acceptedSession, connected: true, running: true };
    const sessionState = openedSession === session ? state : replaceSession(state, openedSession);
    return {
      ...sessionState,
      connectionBySessionId: {
        ...sessionState.connectionBySessionId,
        [envelope.sessionId]: {
          streamId: envelope.streamId,
          transport: envelope.event.transport,
          open: true,
          promptReadiness: envelope.event.promptReadiness,
          source: transportSource(envelope.event.transport),
        },
      },
      cursorBySessionId: { ...sessionState.cursorBySessionId, [envelope.sessionId]: envelope.sequence },
    };
  }

  if (!connection) return state;

  let acceptedConnection: SessionConnectionSnapshot = connection;
  if (envelope.event.type === "activity") {
    const nextConnection = acceptHostActivity(connection, envelope.event);
    if (!nextConnection) return state;
    acceptedConnection = nextConnection;
  } else if (envelope.event.type === "prompt-readiness-changed") {
    const nextConnection = acceptPromptReadinessChange(connection, envelope.event);
    if (!nextConnection) return state;
    acceptedConnection = nextConnection;
  }

  let next: SessionRuntimeState = {
    ...state,
    connectionBySessionId: acceptedConnection === connection
      ? state.connectionBySessionId
      : { ...state.connectionBySessionId, [envelope.sessionId]: acceptedConnection },
    cursorBySessionId: { ...state.cursorBySessionId, [envelope.sessionId]: envelope.sequence },
  };
  if (envelope.event.type === "activity") {
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

const EXPECTED_INTEGRATION_BY_AGENT = {
  codex: "app-server",
  "claude-code": "hooks",
  pi: "rpc",
} as const satisfies Record<AgentSession["agentId"], StructuredLifecycleIntegration>;

function acceptOpenedSession(
  session: AgentSession,
  transport: SessionTransportDescriptor,
): AgentSession | undefined {
  const source = transportSource(transport);
  if (!source) return transport.type === "pty" && transport.lifecycleEvidence === "fallback" ? session : undefined;
  if (source.agentId !== session.agentId) return undefined;
  if (source.integration !== EXPECTED_INTEGRATION_BY_AGENT[session.agentId]) return undefined;
  if ((source.agentId === "claude-code") !== (transport.type === "pty")) return undefined;
  if (session.externalSessionId !== undefined && session.externalSessionId !== source.providerSessionId) return undefined;
  return session.externalSessionId === source.providerSessionId
    ? session
    : { ...session, externalSessionId: source.providerSessionId };
}

function transportSource(transport: SessionTransportDescriptor): StructuredLifecycleSource | undefined {
  return transport.lifecycleEvidence === "structured" ? transport.source : undefined;
}

function connectionSourceCanRemain(
  connection: SessionConnectionSnapshot | undefined,
  streamId: string,
  transport: SessionTransportDescriptor,
): boolean {
  if (connection?.streamId !== streamId) return true;
  const source = transportSource(transport);
  if (!connection.source && !source) return true;
  if (!connection.source || !source) return false;
  return sourceIdentityMatches(connection.source, source);
}

function acceptHostActivity(
  connection: SessionConnectionSnapshot,
  event: Extract<SessionEventEnvelope["event"], { type: "activity" }>,
): SessionConnectionSnapshot | undefined {
  if (!connection.source || !sourceIdentityMatches(connection.source, event.source)) return undefined;
  const currentTurn = connection.currentTurn;
  const nextTurn = event.context.turn;
  const pendingAttentionKeys = connection.pendingAttentionKeys ?? [];

  if (event.activity.type === "turn-started") {
    if (currentTurn) {
      if (turnMatches(currentTurn, nextTurn)) return undefined;
      if (!connection.terminalOutcome || pendingAttentionKeys.length > 0) return undefined;
    }
    return {
      ...connection,
      currentTurn: nextTurn,
      pendingAttentionKeys: [],
      terminalOutcome: undefined,
    };
  }

  if (!currentTurn || !turnMatches(currentTurn, nextTurn)) return undefined;

  if (event.activity.type === "attention-requested") {
    if (connection.terminalOutcome || pendingAttentionKeys.includes(event.activity.key)) return undefined;
    return { ...connection, pendingAttentionKeys: [...pendingAttentionKeys, event.activity.key] };
  } else if (event.activity.type === "attention-resolved") {
    const resolvedKey = event.activity.key;
    if (!pendingAttentionKeys.includes(resolvedKey)) return undefined;
    return {
      ...connection,
      pendingAttentionKeys: pendingAttentionKeys.filter((key) => key !== resolvedKey),
    };
  } else if (event.activity.type === "turn-ended") {
    if (connection.terminalOutcome) return undefined;
    return { ...connection, terminalOutcome: event.activity.outcome };
  }

  return undefined;
}

function acceptPromptReadinessChange(
  connection: SessionConnectionSnapshot,
  event: Extract<SessionEventEnvelope["event"], { type: "prompt-readiness-changed" }>,
): SessionConnectionSnapshot | undefined {
  if (!connection.source || !sourceIdentityMatches(connection.source, event.source)) return undefined;
  if (!promptReadinessMatchesTransport(connection.transport, event.promptReadiness)) return undefined;
  if (connection.promptReadiness === event.promptReadiness) return undefined;
  return { ...connection, promptReadiness: event.promptReadiness };
}

function promptReadinessMatchesTransport(
  transport: SessionTransportDescriptor,
  readiness: PromptReadinessState,
): boolean {
  const fallback = transport.type === "pty" && transport.lifecycleEvidence === "fallback";
  return fallback ? readiness === "pty-fallback-sendable" : readiness !== "pty-fallback-sendable";
}

function sourceIdentityMatches(a: StructuredLifecycleSource, b: StructuredLifecycleSource): boolean {
  return a.agentId === b.agentId
    && a.integration === b.integration
    && a.providerSessionId === b.providerSessionId;
}

function turnMatches(a: StructuredTurnIdentity, b: StructuredTurnIdentity): boolean {
  return a.key === b.key && a.provenance === b.provenance;
}

function find(state: SessionRuntimeState, id: string): AgentSession | undefined {
  return state.sessions.find((session) => session.id === id);
}

function replaceSession(state: SessionRuntimeState, session: AgentSession): SessionRuntimeState {
  return { ...state, sessions: state.sessions.map((candidate) => candidate.id === session.id ? session : candidate) };
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
