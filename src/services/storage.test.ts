import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessions, loadWorkspaces } from "./storage";

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

describe("storage validation", () => {
  it("recovers from invalid JSON and non-array values", () => {
    values.set("pelican.workspaces.v1", "not json");
    values.set("pelican.sessions.v1", "{}");
    expect(loadWorkspaces()).toEqual([]);
    expect(loadSessions()).toEqual([]);
  });

  it("keeps valid workspaces and drops malformed entries", () => {
    values.set("pelican.workspaces.v1", JSON.stringify([
      { id: "workspace-1", name: "Pelican", path: "/tmp/pelican", createdAt: "2026-07-17" },
      { id: "missing-path", name: "Broken" },
    ]));
    expect(loadWorkspaces()).toEqual([
      { id: "workspace-1", name: "Pelican", path: "/tmp/pelican", createdAt: "2026-07-17" },
    ]);
  });

  it("normalizes restored sessions to offline", () => {
    values.set("pelican.sessions.v1", JSON.stringify([{
      id: "session-1",
      workspaceId: "workspace-1",
      agentId: "codex",
      title: "Existing session",
      status: "working",
      createdAt: "2026-07-17",
      lastActivityAt: "2026-07-17",
      unread: true,
      connected: true,
      running: true,
    }]));
    expect(loadSessions()).toEqual([expect.objectContaining({
      id: "session-1",
      status: "offline",
      running: false,
      connected: false,
      unread: true,
    })]);
  });

  it("restores resumable sessions as available instead of falsely running", () => {
    values.set("pelican.sessions.v1", JSON.stringify([{
      id: "session-2",
      workspaceId: "workspace-1",
      agentId: "pi",
      title: "Persisted Pi session",
      status: "working",
      createdAt: "2026-07-17",
      lastActivityAt: "2026-07-17",
      unread: false,
      connected: true,
      running: true,
      externalSessionId: "pi-id",
      resumeHandle: "/tmp/pi-session.jsonl",
      origin: "pi-history",
    }]));
    expect(loadSessions()).toEqual([expect.objectContaining({
      status: "available",
      connected: false,
      running: false,
      externalSessionId: "pi-id",
      resumeHandle: "/tmp/pi-session.jsonl",
    })]);
  });
});
