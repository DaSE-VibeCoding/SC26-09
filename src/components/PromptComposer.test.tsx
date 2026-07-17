import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PROMPT_READINESS_COPY } from "../domain/sessionPrompt";
import { PromptComposer } from "./PromptComposer";

const noop = () => undefined;

function renderComposer(overrides: Partial<Parameters<typeof PromptComposer>[0]> = {}) {
  return renderToStaticMarkup(
    <PromptComposer
      value="hello"
      agentName="Codex"
      attention={false}
      sending={false}
      blocked={false}
      readinessMessage={PROMPT_READINESS_COPY["pty-fallback-sendable"]}
      onChange={noop}
      onSend={noop}
      {...overrides}
    />,
  );
}

describe("PromptComposer", () => {
  it("keeps the textarea editable and describes readiness with a polite status", () => {
    const markup = renderComposer();

    expect(markup).toContain('aria-label="Prompt for Codex"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain(PROMPT_READINESS_COPY["pty-fallback-sendable"]);
    expect(markup).toContain('aria-describedby="');
    expect(markup).not.toMatch(/<textarea[^>]*disabled/);
    expect(markup).not.toContain("<button type=\"button\" disabled=\"\"");
  });

  it.each([
    { name: "blocked", props: { blocked: true, readinessMessage: PROMPT_READINESS_COPY["awaiting-authoritative"] } },
    { name: "sending", props: { sending: true } },
    { name: "empty", props: { value: "   " } },
  ])("disables Send while $name without disabling text editing", ({ props }) => {
    const markup = renderComposer(props);

    expect(markup).toMatch(/<textarea(?![^>]*disabled)[^>]*>/);
    expect(markup).toContain("<button type=\"button\" disabled=\"\"");
  });

  it("renders existing Sending state and all readiness recovery sentences", () => {
    expect(renderComposer({ sending: true })).toContain("Sending…");

    for (const message of Object.values(PROMPT_READINESS_COPY)) {
      expect(renderComposer({ readinessMessage: message })).toContain(message);
    }
  });
});
