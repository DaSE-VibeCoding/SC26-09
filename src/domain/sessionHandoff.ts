import type { FirstClassAgentId } from "../agents/types";
import type { AgentInstallation, AgentSession, Workspace } from "./models";

export const MAX_HANDOFF_SOURCE_SESSIONS = 3;

/** Wire shape accepted by the native session-handoff export command. */
export interface SessionHandoffExportSource {
  agentId: FirstClassAgentId;
  externalSessionId: string;
  resumeHandle: string;
}

/** Wire shape accepted by the native session-handoff export command. */
export interface SessionHandoffExportRequest {
  workspacePath: string;
  sources: SessionHandoffExportSource[];
}

/** Wire shape returned by the native session-handoff export command. */
export interface SessionHandoffExportResponse {
  schemaVersion: 1;
  markdown: string;
  warnings: string[];
  truncated: boolean;
  sources: Array<{
    agentId: FirstClassAgentId;
    title: string;
    messageCount: number;
    truncated: boolean;
  }>;
}

export function selectHandoffSourceSessions(
  sessions: readonly AgentSession[],
  workspaceId: string,
): AgentSession[] {
  return sessions.filter((session) =>
    session.workspaceId === workspaceId
    && !session.connected
    && !session.running
    && typeof session.externalSessionId === "string"
    && session.externalSessionId.length > 0
    && typeof session.resumeHandle === "string"
    && session.resumeHandle.length > 0
  );
}

export function validateHandoffSelection(sessions: readonly AgentSession[]): string | null {
  if (sessions.length === 0) return "Select at least one saved session.";
  if (sessions.length > MAX_HANDOFF_SOURCE_SESSIONS) {
    return `Select no more than ${MAX_HANDOFF_SOURCE_SESSIONS} saved sessions.`;
  }
  const workspaceId = sessions[0].workspaceId;
  if (sessions.some((session) => session.workspaceId !== workspaceId)) {
    return "Selected sessions must belong to the same workspace.";
  }
  if (selectHandoffSourceSessions(sessions, workspaceId).length !== sessions.length) {
    return "Selected sessions must be disconnected, stopped, and exactly resumable.";
  }
  return null;
}

export function selectHandoffTargetAgents(
  installations: readonly AgentInstallation[],
  sources: readonly AgentSession[],
): FirstClassAgentId[] {
  const sourceAgents = new Set(sources.map((session) => session.agentId));
  return installations
    .filter((installation) => (
      installation.installed
      && Boolean(installation.executable)
      && !sourceAgents.has(installation.agentId)
    ))
    .map((installation) => installation.agentId);
}

export function createSessionHandoffExportRequest(
  workspace: Workspace,
  sources: readonly AgentSession[],
): SessionHandoffExportRequest {
  const error = validateHandoffSelection(sources);
  if (error || sources[0]?.workspaceId !== workspace.id) {
    throw new Error(error ?? "Selected sessions must belong to the export workspace.");
  }
  return {
    workspacePath: workspace.path,
    sources: sources.map((session) => ({
      agentId: session.agentId,
      externalSessionId: session.externalSessionId!,
      resumeHandle: session.resumeHandle!,
    })),
  };
}
