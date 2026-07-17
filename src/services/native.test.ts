import { describe, expect, it } from "vitest";
import { openSession, spawnTerminal, writeTerminal, stopTerminal, isTauri } from "./native";
import { SESSION_HOST_PROTOCOL_VERSION } from "../domain/sessionHost";

describe("native terminal guards", () => {
  it("reports that Vitest runs outside the Tauri webview", () => {
    expect(isTauri()).toBe(false);
  });

  it("refuses to spawn a terminal outside Tauri instead of silently succeeding", async () => {
    await expect(spawnTerminal({
      sessionId: "test",
      cwd: "/tmp",
      program: "/bin/echo",
      args: ["hi"],
      env: {},
      rows: 24,
      cols: 80,
    })).rejects.toThrow(/Pelican desktop app/);
  });

  it("refuses to write or stop a terminal outside Tauri", async () => {
    await expect(writeTerminal("test", "x")).rejects.toThrow(/Pelican desktop app/);
    await expect(stopTerminal("test")).rejects.toThrow(/Pelican desktop app/);
  });

  it("rejects a prepared launch whose executable differs from the semantic request", async () => {
    await expect(openSession({
      protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId: "s", agentId: "codex", workspacePath: "/tmp", title: "Test",
      transport: { type: "pty-fallback", executable: "/bin/cat" }, terminalSize: { rows: 24, cols: 80 }, recovery: { type: "new" },
    }, { program: "/bin/echo", args: ["secret"], env: { TOKEN: "secret" } })).rejects.toThrow(/does not match/);
  });
});
