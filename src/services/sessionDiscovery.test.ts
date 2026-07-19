import { describe, expect, it } from "vitest";
import type { AgentSession, DiscoveredAgentSession, Workspace } from "../domain/models";
import {
  mergeDiscoveredSessions,
  selectDiscoveryTerminalCleanupIds,
  selectResumableWorkspaceSessions,
} from "./sessionDiscovery";

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
  it("selects exact resumable handles for one workspace, newest first", () => {
    const eligible: AgentSession = {
      id: "older",
      workspaceId: workspace.id,
      agentId: "codex",
      title: "Older",
      status: "available",
      createdAt: "2026-07-16T00:00:00.000Z",
      lastActivityAt: "2026-07-17T00:00:00.000Z",
      unread: false,
      connected: false,
      running: false,
      externalSessionId: "provider-id-must-not-be-inferred",
      resumeHandle: " exact-handle ",
      origin: "codex-history",
    };
    const newest = {
      ...eligible,
      id: "newest",
      lastActivityAt: "2026-07-18T00:00:00.000Z",
      resumeHandle: "/exact/pi/session.jsonl",
    };
    const excluded = [
      { ...eligible, id: "other-workspace", workspaceId: "workspace-2" },
      { ...eligible, id: "connected", connected: true },
      { ...eligible, id: "running", running: true },
      { ...eligible, id: "missing-handle", resumeHandle: undefined },
      { ...eligible, id: "blank-handle", resumeHandle: "   " },
    ];

    const selected = selectResumableWorkspaceSessions(
      [eligible, ...excluded, newest],
      workspace.id,
    );

    expect(selected).toEqual([newest, eligible]);
    expect(selected[1]).toBe(eligible);
    expect(selected[1].resumeHandle).toBe(" exact-handle ");
  });

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

  it("claims an unbound connected Pelican Codex session instead of duplicating", () => {
    const local: AgentSession = {
      id: "local-new",
      workspaceId: workspace.id,
      agentId: "codex",
      title: "New Codex session",
      status: "working",
      createdAt: "2026-07-17T00:00:00.000Z",
      lastActivityAt: "2026-07-17T00:00:00.000Z",
      unread: false,
      connected: true,
      running: true,
      origin: "pelican",
    };
    const merged = mergeDiscoveredSessions(
      [local],
      [{ ...discovered, title: "what 's in this folder" }],
      [workspace],
      () => "should-not-create",
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(expect.objectContaining({
      id: "local-new",
      title: "what 's in this folder",
      externalSessionId: "thread-1",
      resumeHandle: "thread-1",
      connected: true,
      running: true,
      status: "working",
      origin: "pelican",
    }));
  });

  it("folds a pre-existing disconnected history duplicate into the live Pelican PTY", () => {
    const live: AgentSession = {
      id: "local-new",
      workspaceId: workspace.id,
      agentId: "codex",
      title: "New Codex session",
      status: "working",
      createdAt: "2026-07-17T00:00:00.000Z",
      lastActivityAt: "2026-07-17T00:00:00.000Z",
      unread: false,
      connected: true,
      running: true,
      origin: "pelican",
    };
    const duplicate: AgentSession = {
      id: "history-dup",
      workspaceId: workspace.id,
      agentId: "codex",
      title: "what 's in this folder",
      status: "available",
      createdAt: "2026-07-17T00:00:00.000Z",
      lastActivityAt: "2026-07-17T00:01:00.000Z",
      unread: false,
      connected: false,
      running: false,
      externalSessionId: "thread-1",
      resumeHandle: "thread-1",
      origin: "codex-history",
    };
    const merged = mergeDiscoveredSessions(
      [live, duplicate],
      [{ ...discovered, title: "what 's in this folder" }],
      [workspace],
      () => "should-not-create",
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(expect.objectContaining({
      id: "local-new",
      title: "what 's in this folder",
      externalSessionId: "thread-1",
      resumeHandle: "thread-1",
      connected: true,
      origin: "pelican",
    }));
  });

  it("folds a connected imported duplicate into the live Pelican PTY", () => {
    const live: AgentSession = {
      id: "local-new",
      workspaceId: workspace.id,
      agentId: "codex",
      title: "New Codex session",
      status: "working",
      createdAt: "2026-07-17T00:00:00.000Z",
      lastActivityAt: "2026-07-17T00:00:00.000Z",
      unread: false,
      connected: true,
      running: true,
      origin: "pelican",
    };
    const duplicate: AgentSession = {
      id: "history-dup",
      workspaceId: workspace.id,
      agentId: "codex",
      title: "what 's in this folder",
      status: "working",
      createdAt: "2026-07-17T00:00:00.000Z",
      lastActivityAt: "2026-07-17T00:01:00.000Z",
      unread: false,
      connected: true,
      running: true,
      externalSessionId: "thread-1",
      resumeHandle: "thread-1",
      origin: "codex-history",
    };
    const merged = mergeDiscoveredSessions(
      [live, duplicate],
      [{ ...discovered, title: "what 's in this folder" }],
      [workspace],
      () => "should-not-create",
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("local-new");
    expect(merged[0].externalSessionId).toBe("thread-1");
  });

  it("dedupes two rows that already share the same Codex thread id", () => {
    const first: AgentSession = {
      id: "a",
      workspaceId: workspace.id,
      agentId: "codex",
      title: "what 's in this folder",
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
    const second: AgentSession = {
      ...first,
      id: "b",
      createdAt: "2026-07-17T00:00:01.000Z",
    };
    const merged = mergeDiscoveredSessions(
      [first, second],
      [discovered],
      [workspace],
      () => "unused",
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("a");
  });

  it("selects only removed connected sessions that are absent from live PTYs for cleanup", () => {
    const baseSession: AgentSession = {
      id: "kept",
      workspaceId: workspace.id,
      agentId: "codex",
      title: "Kept",
      status: "working",
      createdAt: "2026-07-17T00:00:00.000Z",
      lastActivityAt: "2026-07-17T00:00:00.000Z",
      unread: false,
      connected: true,
      running: true,
      origin: "pelican",
    };
    const removedConnected = { ...baseSession, id: "removed-connected" };
    const removedButLive = { ...baseSession, id: "removed-but-live" };
    const removedDisconnected = { ...baseSession, id: "removed-disconnected", connected: false };

    expect(selectDiscoveryTerminalCleanupIds(
      [baseSession, removedConnected, removedButLive, removedDisconnected],
      [baseSession],
      new Set(["removed-but-live"]),
    )).toEqual(["removed-connected"]);
  });
});
