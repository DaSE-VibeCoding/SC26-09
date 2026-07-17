import { describe, expect, it } from "vitest";
import type { AgentSession, DiscoveredAgentSession, Workspace } from "../domain/models";
import { mergeDiscoveredSessions } from "./sessionDiscovery";

const workspace: Workspace = {
  id: "workspace-1",
  name: "Pelican",
  path: "/tmp/pelican",
  createdAt: "2026-07-17T00:00:00.000Z",
};

const discovered: DiscoveredAgentSession = {
  agentId: "codex",
  externalSessionId: "thread-1",
  workspacePath: "/tmp/pelican",
  title: "Existing Codex thread",
  createdAtMs: 1_000,
  updatedAtMs: 2_000,
  status: "available",
  running: false,
  resumeHandle: "thread-1",
  attachHandle: null,
  origin: "codex-history",
};

describe("session discovery merge", () => {
  it("adds provider history as an available, disconnected session", () => {
    const merged = mergeDiscoveredSessions([], [discovered], [workspace], () => "local-1");
    expect(merged).toEqual([expect.objectContaining({
      id: "local-1",
      externalSessionId: "thread-1",
      status: "available",
      running: false,
      connected: false,
      resumeHandle: "thread-1",
    })]);
  });

  it("does not overwrite a connected Pelican lifecycle with a polling result", () => {
    const local: AgentSession = {
      id: "local-1",
      workspaceId: workspace.id,
      agentId: "codex",
      title: "Connected thread",
      status: "working",
      createdAt: "2026-07-17T00:00:00.000Z",
      lastActivityAt: "2026-07-17T00:00:00.000Z",
      unread: false,
      connected: true,
      running: true,
      externalSessionId: "thread-1",
      resumeHandle: "thread-1",
      origin: "codex-history",
    };
    const merged = mergeDiscoveredSessions([local], [discovered], [workspace], () => "unused");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(expect.objectContaining({
      title: "Connected thread",
      status: "working",
      connected: true,
      running: true,
    }));
  });
});
