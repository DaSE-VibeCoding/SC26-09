import { describe, expect, it } from "vitest";
import { agentRegistry, getAgentAdapter } from "./registry";
import { FIRST_CLASS_AGENT_IDS } from "./types";

describe("agent registry", () => {
  it("keeps Codex, Claude Code, and Pi as first-class adapters", () => {
    expect(agentRegistry.map((agent) => agent.id)).toEqual(FIRST_CLASS_AGENT_IDS);
  });

  it("builds a direct launch without a shell", () => {
    const spec = getAgentAdapter("codex").buildLaunchSpec("/usr/local/bin/codex", {
      cwd: "/tmp/project",
      sessionId: "6b4e1538-e19f-4d19-b76d-3d240dff98c4",
      title: "Test session",
    });

    expect(spec.program).toBe("/usr/local/bin/codex");
    expect(spec.args).toEqual(["-C", "/tmp/project", "--no-alt-screen"]);
    expect(spec.env.PELICAN_AGENT).toBe("codex");
  });

  it("uses adapter-specific resume arguments", () => {
    expect(
      getAgentAdapter("claude-code").buildLaunchSpec("claude", {
        cwd: "/tmp/project",
        sessionId: "6b4e1538-e19f-4d19-b76d-3d240dff98c4",
        title: "Test session",
        resumeSessionId: "session-1",
      }).args,
    ).toEqual(["--resume", "session-1"]);
  });

  it("attaches to a Claude background session", () => {
    expect(
      getAgentAdapter("claude-code").buildLaunchSpec("claude", {
        cwd: "/tmp/project",
        sessionId: "pelican-session",
        title: "Test session",
        attachSessionId: "a1b2c3",
      }).args,
    ).toEqual(["attach", "a1b2c3"]);
  });

  it("gives new Pi sessions a deterministic provider identity", () => {
    expect(
      getAgentAdapter("pi").buildLaunchSpec("pi", {
        cwd: "/tmp/project",
        sessionId: "pelican-session",
        title: "Test session",
      }).args,
    ).toEqual(["--session-id", "pelican-session", "--name", "Test session"]);
  });

  it("gives every first-class adapter a structured preferred transport and PTY fallback", () => {
    expect(agentRegistry.map((agent) => agent.capabilities.preferredTransport)).toEqual([
      "app-server",
      "hooks",
      "rpc",
    ]);
    expect(agentRegistry.every((agent) => agent.capabilities.ptyFallback)).toBe(true);
    expect(agentRegistry.every((agent) => !agent.capabilities.structuredLifecycle)).toBe(true);
    expect(agentRegistry.every((agent) => agent.capabilities.resumable)).toBe(true);
  });
});
