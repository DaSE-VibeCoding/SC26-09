import { describe, expect, it } from "vitest";
import { outputRequestsAttention, reduceSessionStatus, scanTerminalAttention } from "./status";

describe("session status", () => {
  it("marks successful unseen completion as done", () => {
    expect(
      reduceSessionStatus("working", { type: "process-exited", success: true }),
    ).toBe("done");
  });

  it("marks failures as needing attention", () => {
    expect(
      reduceSessionStatus("working", { type: "process-exited", success: false }),
    ).toBe("attention");
  });

  it("moves reviewed results to idle", () => {
    expect(reduceSessionStatus("done", { type: "reviewed" })).toBe("idle");
  });

  it("moves a reviewed completion with no live process to offline", () => {
    expect(reduceSessionStatus("done", { type: "reviewed", running: false })).toBe("offline");
  });

  it("keeps unresolved attention visible when the session is opened", () => {
    expect(reduceSessionStatus("attention", { type: "reviewed" })).toBe("attention");
  });

  it("keeps attention sticky across ordinary terminal repaint output", () => {
    expect(reduceSessionStatus("attention", { type: "activity" })).toBe("attention");
  });

  it("recognizes common interactive prompts after stripping ANSI", () => {
    expect(outputRequestsAttention("\u001b[33mDo you want to proceed? [y/n]\u001b[0m")).toBe(
      true,
    );
    expect(outputRequestsAttention("Compiling 42 modules...")).toBe(false);
  });

  it("detects attention near the start of a PTY read before retaining its tail", () => {
    const scan = scanTerminalAttention("", `Permission required${".".repeat(16_000)}`);
    expect(scan.needsAttention).toBe(true);
    expect(scan.tail).toHaveLength(2_048);
  });
});
