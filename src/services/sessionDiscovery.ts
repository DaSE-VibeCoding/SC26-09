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

function rebuildProviderIndex(sessions: AgentSession[]): Map<string, number> {
  const indexByProviderId = new Map<string, number>();
  sessions.forEach((session, index) => {
    if (!session.externalSessionId) return;
    const key = sessionKey(session.agentId, session.externalSessionId);
    const previous = indexByProviderId.get(key);
    if (previous === undefined) {
      indexByProviderId.set(key, index);
      return;
    }
    const previousSession = sessions[previous];
    // Prefer a live Pelican-owned row as the canonical holder of a provider id.
    const preferCurrent = session.connected
      && (session.origin === "pelican" || !previousSession.connected);
    if (preferCurrent) indexByProviderId.set(key, index);
  });
  return indexByProviderId;
}

export function mergeDiscoveredSessions(
  current: AgentSession[],
  discovered: DiscoveredAgentSession[],
  workspaces: Workspace[],
  createId: () => string,
  now = new Date().toISOString(),
): AgentSession[] {
  const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]));
  let next = [...current];
  let indexByProviderId = rebuildProviderIndex(next);
  const removeIds = new Set<string>();

  for (const providerSession of discovered) {
    const workspace = workspaceByPath.get(providerSession.workspacePath);
    if (!workspace) continue;
    const key = sessionKey(providerSession.agentId, providerSession.externalSessionId);

    // Live Pelican PTYs are created without a provider id. Claim them before
    // accepting/keeping a separate history row for the same thread.
    const liveUnboundIndex = next.findIndex((session) => (
      !removeIds.has(session.id)
      && session.workspaceId === workspace.id
      && session.agentId === providerSession.agentId
      && session.origin === "pelican"
      && !session.externalSessionId
      && (session.connected || session.running)
    ));

    if (liveUnboundIndex >= 0) {
      const live = next[liveUnboundIndex];
      next[liveUnboundIndex] = {
        ...live,
        title: providerSession.title || live.title,
        externalSessionId: providerSession.externalSessionId,
        resumeHandle: providerSession.resumeHandle ?? live.resumeHandle,
        attachHandle: providerSession.attachHandle ?? live.attachHandle,
      };

      const existingIndex = indexByProviderId.get(key);
      if (existingIndex !== undefined && existingIndex !== liveUnboundIndex) {
        const duplicate = next[existingIndex];
        // Drop the imported history row once the live Pelican PTY owns the
        // provider id. Imported rows should not stay as a second sidebar entry.
        if (duplicate && duplicate.origin !== "pelican") {
          removeIds.add(duplicate.id);
        }
      }

      indexByProviderId = rebuildProviderIndex(next.filter((session) => !removeIds.has(session.id)));
      continue;
    }

    const existingIndex = indexByProviderId.get(key);
    if (existingIndex !== undefined) {
      const existing = next[existingIndex];
      if (removeIds.has(existing.id)) continue;
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

  if (removeIds.size > 0) {
    next = next.filter((session) => !removeIds.has(session.id));
  }

  next = dedupeByProviderIdentity(next, removeIds);

  return next.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
}

export function selectDiscoveryTerminalCleanupIds(
  previous: readonly AgentSession[],
  committed: readonly AgentSession[],
  liveIds: ReadonlySet<string>,
): string[] {
  const committedIds = new Set(committed.map((session) => session.id));
  return previous
    .filter((session) => !committedIds.has(session.id) && session.connected && !liveIds.has(session.id))
    .map((session) => session.id);
}

function preferSession(left: AgentSession, right: AgentSession): AgentSession {
  if (left.connected !== right.connected) return left.connected ? left : right;
  if ((left.origin === "pelican") !== (right.origin === "pelican")) {
    return left.origin === "pelican" ? left : right;
  }
  return left.createdAt <= right.createdAt ? left : right;
}

/** Collapse rows that already share a provider thread id (e.g. after a bad merge). */
function dedupeByProviderIdentity(
  sessions: AgentSession[],
  removeIds: Set<string>,
): AgentSession[] {
  const kept = new Map<string, AgentSession>();
  const unbound: AgentSession[] = [];

  for (const session of sessions) {
    if (!session.externalSessionId) {
      unbound.push(session);
      continue;
    }
    const key = sessionKey(session.agentId, session.externalSessionId);
    const previous = kept.get(key);
    if (!previous) {
      kept.set(key, session);
      continue;
    }
    const winner = preferSession(previous, session);
    const loser = winner.id === previous.id ? session : previous;
    removeIds.add(loser.id);
    kept.set(key, winner);
  }

  return [...unbound, ...kept.values()].filter((session) => !removeIds.has(session.id));
}
