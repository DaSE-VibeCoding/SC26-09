import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentSession, Workspace } from "../domain/models";
import {
  handoffGenerationErrorVisible,
  handoffStartButtonState,
  isBriefingDirty,
  SessionHandoffDialog,
} from "./SessionHandoffDialog";

const workspace: Workspace = { id: "w", name: "Private", path: "/secret/workspace", createdAt: "now" };
const session: AgentSession = {
  id: "s", workspaceId: "w", agentId: "codex", title: "Compiler investigation", status: "available",
  createdAt: "now", lastActivityAt: "now", unread: false, connected: false, running: false,
  externalSessionId: "private-external-id", resumeHandle: "/secret/session.jsonl", origin: "history",
};

describe("SessionHandoffDialog", () => {
  it("renders an accessible first step without exposing paths or handles", () => {
    const markup = renderToStaticMarkup(
      <SessionHandoffDialog workspace={workspace} sessions={[session]}
        installations={[{ agentId: "claude-code", installed: true, executable: "claude" }]}
        generateExport={async () => ({ schemaVersion: 1, markdown: "brief", warnings: [], truncated: false, sources: [] })}
        starting={false} onDirtyChange={() => undefined}
        onStart={async () => undefined} onCancel={() => undefined} />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('data-dialog-initial-focus="true"');
    expect(markup).toContain("Compiler investigation");
    expect(markup).toContain("does not launch an agent or send anything automatically");
    expect(markup).not.toContain("private-external-id");
    expect(markup).not.toContain("/secret/session.jsonl");
    expect(markup).not.toContain("/secret/workspace");
  });

  it("surfaces generation failures in target and review steps", () => {
    expect(handoffGenerationErrorVisible("sources", true)).toBe(false);
    expect(handoffGenerationErrorVisible("target", true)).toBe(true);
    expect(handoffGenerationErrorVisible("review", true)).toBe(true);
    expect(handoffGenerationErrorVisible("review", false)).toBe(false);
  });

  it("marks only an edited generated review as dirty", () => {
    expect(isBriefingDirty("review", "generated", "edited")).toBe(true);
    expect(isBriefingDirty("review", "generated", "generated")).toBe(false);
    expect(isBriefingDirty("target", "generated", "edited")).toBe(false);
    expect(isBriefingDirty("review", null, "edited")).toBe(false);
  });

  it("disables the handoff launch and exposes progress while starting", () => {
    expect(handoffStartButtonState("briefing", true)).toEqual({
      disabled: true,
      label: "Starting…",
    });
    expect(handoffStartButtonState("briefing", false)).toEqual({
      disabled: false,
      label: "Start with briefing",
    });
    expect(handoffStartButtonState("   ", false).disabled).toBe(true);
  });
});
