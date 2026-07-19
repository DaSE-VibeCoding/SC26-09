import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmDiscard, exportSessionHandoff, openSession, spawnTerminal, writeTerminal, stopTerminal, isTauri } from "./native";
import { SESSION_HOST_PROTOCOL_VERSION } from "../domain/sessionHost";

const dialogMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => dialogMocks);

describe("native terminal guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reports that Vitest runs outside the Tauri webview", () => {
    expect(isTauri()).toBe(false);
  });

  it("uses browser confirmation in preview and native confirmation in Tauri", async () => {
    const browserConfirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm: browserConfirm });

    await expect(confirmDiscard("Discard preview changes?")).resolves.toBe(true);
    expect(browserConfirm).toHaveBeenCalledWith("Discard preview changes?");
    expect(dialogMocks.confirm).not.toHaveBeenCalled();

    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    dialogMocks.confirm.mockResolvedValueOnce(false);

    await expect(confirmDiscard("Discard native changes?")).resolves.toBe(false);
    expect(dialogMocks.confirm).toHaveBeenCalledWith("Discard native changes?", {
      title: "Pelican",
      kind: "warning",
      okLabel: "Discard",
      cancelLabel: "Keep editing",
    });
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

  it("does not fabricate a cross-agent export outside the desktop app", async () => {
    await expect(exportSessionHandoff({
      workspacePath: "/tmp",
      sources: [{ agentId: "codex", externalSessionId: "thread-1", resumeHandle: "thread-1" }],
    })).rejects.toThrow(/Pelican desktop app/);
  });
});
