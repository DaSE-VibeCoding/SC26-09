import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../domain/models";
import { filterSessionBrowserSessions, SessionBrowser } from "./SessionBrowser";

const codex: AgentSession = {
  id: "codex-session",
  workspaceId: "workspace-1",
  agentId: "codex",
  title: "Refactor discovery",
  status: "available",
  createdAt: "2026-07-17T00:00:00.000Z",
  lastActivityAt: "2026-07-18T00:00:00.000Z",
  unread: false,
  connected: false,
  running: false,
  resumeHandle: "thread-exact",
  origin: "codex-history",
};
const claude: AgentSession = {
  ...codex,
  id: "claude-session",
  agentId: "claude-code",
  title: "Accessibility review",
};

describe("SessionBrowser", () => {
  it("filters by provider and case-insensitive title or provider name", () => {
    expect(filterSessionBrowserSessions([codex, claude], "REFACTOR", "all")).toEqual([codex]);
    expect(filterSessionBrowserSessions([codex, claude], "claude", "claude-code")).toEqual([claude]);
    expect(filterSessionBrowserSessions([codex, claude], "review", "codex")).toEqual([]);
  });

  it("renders an accessible dialog, controls, provider identity, and missing CLI reason", () => {
    const markup = renderToStaticMarkup(
      <SessionBrowser
        workspaceName="Pelican"
        sessions={[codex, claude]}
        installations={[{ agentId: "codex", installed: true, executable: "/bin/codex" }]}
        loading={false}
        startingSessionIds={new Set([codex.id])}
        onRefresh={() => undefined}
        onResume={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("data-dialog-initial-focus");
    expect(markup).toContain('type="search"');
    expect(markup).toContain('data-agent-logo="claude-code"');
    expect(markup).toContain("Claude CLI is not installed");
    expect(markup).toContain("Resuming…");
    expect(markup).toContain("session-browser-scroll");
  });

  it("distinguishes loading, empty, and filtered-empty copy", () => {
    const render = (sessions: readonly AgentSession[], loading: boolean) => renderToStaticMarkup(
      <SessionBrowser
        workspaceName="Pelican"
        sessions={sessions}
        installations={[]}
        loading={loading}
        startingSessionIds={new Set()}
        onRefresh={() => undefined}
        onResume={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(render([], true)).toContain("Loading saved sessions");
    expect(render([], false)).toContain("No saved sessions are available");
    expect(filterSessionBrowserSessions([codex], "no match", "all")).toEqual([]);
  });
});
