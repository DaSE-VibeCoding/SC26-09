import { describe, expect, it } from "vitest";
import type { AgentSession, Workspace } from "./models";
import {
  createSessionHandoffExportRequest,
  selectHandoffSourceSessions,
  selectHandoffTargetAgents,
  validateHandoffSelection,
} from "./sessionHandoff";

const workspace: Workspace = { id: "w", name: "Secret project", path: "/private/project", createdAt: "now" };
const saved = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: "s", workspaceId: "w", agentId: "codex", title: "Saved work", status: "available",
  createdAt: "now", lastActivityAt: "now", unread: false, connected: false, running: false,
  externalSessionId: " external-id ", resumeHandle: "/exact/session.jsonl", origin: "history", ...overrides,
});

describe("session handoff domain", () => {
  it("selects only same-workspace, stopped, disconnected sessions with both exact handles", () => {
    const eligible = saved();
    expect(selectHandoffSourceSessions([
      eligible,
      saved({ id: "connected", connected: true }),
      saved({ id: "running", running: true }),
      saved({ id: "other", workspaceId: "other" }),
      saved({ id: "missing", resumeHandle: undefined }),
    ], "w")).toEqual([eligible]);
  });

  it("preserves handle bytes in the backend request and enforces the limit", () => {
    expect(createSessionHandoffExportRequest(workspace, [saved()])).toEqual({
      workspacePath: "/private/project",
      sources: [{ agentId: "codex", externalSessionId: " external-id ", resumeHandle: "/exact/session.jsonl" }],
    });
    expect(validateHandoffSelection([saved(), saved({ id: "2" }), saved({ id: "3" }), saved({ id: "4" })]))
      .toContain("no more than 3");
  });

  it("offers only installed providers different from every source provider", () => {
    expect(selectHandoffTargetAgents([
      { agentId: "codex", installed: true, executable: "codex" },
      { agentId: "claude-code", installed: true, executable: "claude" },
      { agentId: "pi", installed: true, executable: null },
    ], [saved()])).toEqual(["claude-code"]);
  });
});
