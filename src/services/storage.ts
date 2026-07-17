import { FIRST_CLASS_AGENT_IDS, type FirstClassAgentId } from "../agents/types";
import type { AgentSession, SessionStatus, Workspace } from "../domain/models";

const WORKSPACES_KEY = "pelican.workspaces.v1";
const SESSIONS_KEY = "pelican.sessions.v1";
const SESSION_STATUSES: readonly SessionStatus[] = ["attention", "working", "done", "idle", "available", "offline"];

function loadUnknown(key: string): unknown {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAgentId(value: unknown): value is FirstClassAgentId {
  return typeof value === "string" && FIRST_CLASS_AGENT_IDS.some((agentId) => agentId === value);
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && SESSION_STATUSES.some((status) => status === value);
}

function parseWorkspace(value: unknown): Workspace | null {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.name)
    || !isNonEmptyString(value.path)
    || !isNonEmptyString(value.createdAt)) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    path: value.path,
    createdAt: value.createdAt,
  };
}

function parseSession(value: unknown): AgentSession | null {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.workspaceId)
    || !isAgentId(value.agentId)
    || !isNonEmptyString(value.title)
    || !isSessionStatus(value.status)
    || !isNonEmptyString(value.createdAt)
    || !isNonEmptyString(value.lastActivityAt)) {
    return null;
  }
  const resumeHandle = isNonEmptyString(value.resumeHandle) ? value.resumeHandle : undefined;
  const externalSessionId = isNonEmptyString(value.externalSessionId)
    ? value.externalSessionId
    : undefined;
  const attachHandle = isNonEmptyString(value.attachHandle) ? value.attachHandle : undefined;
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    agentId: value.agentId,
    title: value.title,
    status: resumeHandle ? "available" : "offline",
    createdAt: value.createdAt,
    lastActivityAt: value.lastActivityAt,
    unread: typeof value.unread === "boolean" ? value.unread : false,
    // PTYs live in the current Tauri process and cannot survive a restart yet.
    connected: false,
    running: false,
    externalSessionId,
    resumeHandle,
    attachHandle,
    origin: isNonEmptyString(value.origin) ? value.origin : "pelican",
  };
}

export function loadWorkspaces(): Workspace[] {
  const stored = loadUnknown(WORKSPACES_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.map(parseWorkspace).filter((workspace): workspace is Workspace => workspace !== null);
}

export function saveWorkspaces(workspaces: Workspace[]): void {
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces));
}

export function loadSessions(): AgentSession[] {
  const stored = loadUnknown(SESSIONS_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.map(parseSession).filter((session): session is AgentSession => session !== null);
}

export function saveSessions(sessions: AgentSession[]): void {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}
