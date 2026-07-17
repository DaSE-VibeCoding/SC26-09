import { describe, expect, it } from "vitest";
import {
  SESSION_HOST_PROTOCOL_VERSION,
  hasInteractiveTerminal,
  type SessionOpenRequest,
  type SessionTransportDescriptor,
} from "./sessionHost";

function openRequestFixture(recovery: SessionOpenRequest["recovery"]): SessionOpenRequest {
  return {
    protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
    sessionId: "session-1",
    agentId: "codex",
    workspacePath: "/workspace/project",
    title: "Build session host",
    transport: { type: "pty-fallback", executable: "/usr/local/bin/codex" },
    terminalSize: { rows: 30, cols: 110 },
    recovery,
  };
}

describe("session transport capabilities", () => {
  it.each([
    [{ type: "pty", lifecycleEvidence: "fallback" }, true],
    [{ type: "pty", lifecycleEvidence: "structured" }, true],
    [{ type: "protocol", lifecycleEvidence: "structured" }, false],
  ] satisfies Array<[SessionTransportDescriptor, boolean]>)("maps %j terminal capability", (transport, expected) => {
    expect(hasInteractiveTerminal(transport)).toBe(expected);
  });
});

describe("session open request v1", () => {
  it("includes explicit PTY fallback transport, title, and terminal size for new sessions", () => {
    expect(openRequestFixture({ type: "new" })).toEqual({
      protocolVersion: 1,
      sessionId: "session-1",
      agentId: "codex",
      workspacePath: "/workspace/project",
      title: "Build session host",
      transport: { type: "pty-fallback", executable: "/usr/local/bin/codex" },
      terminalSize: { rows: 30, cols: 110 },
      recovery: { type: "new" },
    });
  });

  it("preserves resume handles exactly", () => {
    const handle = " provider/thread:abc-123?with=query ";
    const request = openRequestFixture({ type: "resume", handle });

    expect(request.recovery).toEqual({ type: "resume", handle });
    expect(request.recovery.type === "resume" ? request.recovery.handle : undefined).toBe(handle);
  });

  it("preserves attach handles exactly", () => {
    const handle = "claude-bg://agent/ABC-123#pane=main ";
    const request = openRequestFixture({ type: "attach", handle });

    expect(request.recovery).toEqual({ type: "attach", handle });
    expect(request.recovery.type === "attach" ? request.recovery.handle : undefined).toBe(handle);
  });
});
