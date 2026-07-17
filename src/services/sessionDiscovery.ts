import type {
  AgentSession,
  DiscoveredAgentSession,
  Workspace,
} from "../domain/models";

function sessionKey(agentId: string, externalSessionId: string): string {
  return `${agentId}\u0000${externalSessionId}`;
}

function timestamp(milliseconds: number, fallback: string): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return fallback;
  return new Date(milliseconds).toISOString();
}

export function mergeDiscoveredSessions(
  current: AgentSession[],
  discovered: DiscoveredAgentSession[],
  workspaces: Workspace[],
  createId: () => string,
  now = new Date().toISOString(),
): AgentSession[] {
  const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]));
  const indexByProviderId = new Map<string, number>();
  const next = [...current];

  next.forEach((session, index) => {
    if (session.externalSessionId) {
      indexByProviderId.set(sessionKey(session.agentId, session.externalSessionId), index);
    }
  });

  for (const providerSession of discovered) {
    const workspace = workspaceByPath.get(providerSession.workspacePath);
    if (!workspace) continue;
    const key = sessionKey(providerSession.agentId, providerSession.externalSessionId);
    const existingIndex = indexByProviderId.get(key);
    if (existingIndex !== undefined) {
      const existing = next[existingIndex];
      next[existingIndex] = existing.connected
        ? {
            ...existing,
            resumeHandle: providerSession.resumeHandle ?? existing.resumeHandle,
            attachHandle: providerSession.attachHandle ?? existing.attachHandle,
          }
        : {
            ...existing,
            title: providerSession.title,
            status: providerSession.status,
            running: providerSession.running,
            connected: false,
            lastActivityAt: timestamp(providerSession.updatedAtMs, existing.lastActivityAt),
            resumeHandle: providerSession.resumeHandle ?? undefined,
            attachHandle: providerSession.attachHandle ?? undefined,
            origin: providerSession.origin,
          };
      continue;
    }

    const id = createId();
    indexByProviderId.set(key, next.length);
    next.push({
      id,
      workspaceId: workspace.id,
      agentId: providerSession.agentId,
      title: providerSession.title,
      status: providerSession.status,
      createdAt: timestamp(providerSession.createdAtMs, now),
      lastActivityAt: timestamp(providerSession.updatedAtMs, now),
      unread: false,
      connected: false,
      running: providerSession.running,
      externalSessionId: providerSession.externalSessionId,
      resumeHandle: providerSession.resumeHandle ?? undefined,
      attachHandle: providerSession.attachHandle ?? undefined,
      origin: providerSession.origin,
    });
  }

  return next.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
}
