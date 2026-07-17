import type { FirstClassAgentId } from "../agents/types";

export type SessionStatus =
  | "attention"
  | "working"
  | "done"
  | "idle"
  | "available"
  | "offline";

export type SessionMode = "prompt" | "terminal";

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  workspaceId: string;
  agentId: FirstClassAgentId;
  title: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
  unread: boolean;
  /** True when Pelican owns an interactive PTY for this session. */
  connected: boolean;
  /** True when the provider reports a live process, connected or external. */
  running: boolean;
  externalSessionId?: string;
  resumeHandle?: string;
  attachHandle?: string;
  origin: string;
}

export interface AgentInstallation {
  agentId: FirstClassAgentId;
  executable: string | null;
  installed: boolean;
}

export interface DiscoveredAgentSession {
  agentId: FirstClassAgentId;
  externalSessionId: string;
  workspacePath: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  status: SessionStatus;
  running: boolean;
  resumeHandle: string | null;
  attachHandle: string | null;
  origin: string;
}

export interface TerminalOutputEvent {
  sessionId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number;
  success: boolean;
}

export interface FileEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  depth: number;
}

export interface GitChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}
