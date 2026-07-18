import { useMemo, useState } from "react";
import type { FirstClassAgentId } from "../agents/types";
import type { AgentInstallation, AgentSession } from "../domain/models";
import { selectResumableWorkspaceSessions } from "../services/sessionDiscovery";
import { AgentLogo } from "./AgentLogo";

type ProviderFilter = "all" | FirstClassAgentId;

const providers: ReadonlyArray<{ id: ProviderFilter; name: string }> = [
  { id: "all", name: "All" },
  { id: "codex", name: "Codex" },
  { id: "claude-code", name: "Claude" },
  { id: "pi", name: "Pi" },
];

const providerNames: Record<FirstClassAgentId, string> = {
  codex: "Codex",
  "claude-code": "Claude",
  pi: "Pi",
};

export interface SessionBrowserProps {
  workspaceName: string;
  sessions: readonly AgentSession[];
  /** Omit when sessions have already been selected for the workspace. */
  workspaceId?: string;
  installations: readonly AgentInstallation[];
  loading: boolean;
  startingSessionIds: ReadonlySet<string>;
  onRefresh(): void;
  onResume(session: AgentSession): void;
  onClose(): void;
}

export function filterSessionBrowserSessions(
  sessions: readonly AgentSession[],
  query: string,
  provider: ProviderFilter,
): AgentSession[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return sessions.filter((session) => (
    (provider === "all" || session.agentId === provider)
    && (!normalizedQuery || `${session.title} ${providerNames[session.agentId]}`
      .toLocaleLowerCase().includes(normalizedQuery))
  ));
}

function activityLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function SessionBrowser({
  workspaceName,
  sessions,
  workspaceId,
  installations,
  loading,
  startingSessionIds,
  onRefresh,
  onResume,
  onClose,
}: SessionBrowserProps) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const resumable = useMemo(
    () => workspaceId === undefined
      ? [...sessions]
      : selectResumableWorkspaceSessions(sessions, workspaceId),
    [sessions, workspaceId],
  );
  const visible = useMemo(
    () => filterSessionBrowserSessions(resumable, query, provider),
    [provider, query, resumable],
  );
  const installed = new Map(installations.map((item) => [item.agentId, item]));

  return (
    <div className="session-browser-backdrop" onMouseDown={onClose}>
      <section
        className="session-browser-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-browser-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="session-browser-header">
          <div>
            <h2 id="session-browser-title">Saved sessions</h2>
            <p>{workspaceName}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close saved sessions">Close</button>
        </header>

        <div className="session-browser-controls">
          <label>
            <span>Search saved sessions</span>
            <input
              type="search"
              value={query}
              placeholder="Search sessions…"
              data-dialog-initial-focus
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <fieldset>
            <legend>Provider</legend>
            {providers.map((item) => (
              <label key={item.id}>
                <input
                  type="radio"
                  name="session-browser-provider"
                  value={item.id}
                  checked={provider === item.id}
                  onChange={() => setProvider(item.id)}
                />
                {item.name}
              </label>
            ))}
          </fieldset>
          <button type="button" disabled={loading} onClick={onRefresh}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div className="session-browser-results session-browser-scroll" aria-live="polite" aria-busy={loading}>
          {loading && resumable.length === 0 ? (
            <p className="session-browser-state">Loading saved sessions…</p>
          ) : resumable.length === 0 ? (
            <p className="session-browser-state">No saved sessions are available for this workspace.</p>
          ) : visible.length === 0 ? (
            <p className="session-browser-state">No saved sessions match your search and provider filter.</p>
          ) : (
            <ul className="session-browser-list">
              {visible.map((session) => {
                const installation = installed.get(session.agentId);
                const cliAvailable = Boolean(installation?.installed && installation.executable);
                const starting = startingSessionIds.has(session.id);
                return (
                  <li key={session.id} className="session-browser-item">
                    <AgentLogo agentId={session.agentId} size={36} />
                    <div className="session-browser-session-details">
                      <span className="session-browser-provider">{providerNames[session.agentId]}</span>
                      <strong>{session.title || "Untitled session"}</strong>
                      <time dateTime={session.lastActivityAt}>Last active {activityLabel(session.lastActivityAt)}</time>
                      {!cliAvailable && <small role="status">{providerNames[session.agentId]} CLI is not installed; this session cannot be resumed.</small>}
                    </div>
                    <button
                      type="button"
                      disabled={!cliAvailable || starting}
                      aria-describedby={!cliAvailable ? `session-browser-cli-${session.id}` : undefined}
                      onClick={() => onResume(session)}
                    >
                      {starting ? "Resuming…" : "Resume"}
                    </button>
                    {!cliAvailable && <span id={`session-browser-cli-${session.id}`} hidden>Missing {providerNames[session.agentId]} CLI</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
