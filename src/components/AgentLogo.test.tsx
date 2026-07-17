import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentLogo } from "./AgentLogo";

describe("AgentLogo", () => {
  it("renders a distinct mark for every first-class agent", () => {
    const logos = ["codex", "claude-code", "pi"].map((agentId) =>
      renderToStaticMarkup(<AgentLogo agentId={agentId} />),
    );

    expect(logos[0]).toContain('data-agent-logo="codex"');
    expect(logos[1]).toContain('data-agent-logo="claude-code"');
    expect(logos[2]).toContain('data-agent-logo="pi"');
    expect(new Set(logos).size).toBe(3);
  });

  it("uses an accessible generic fallback for an unknown agent", () => {
    const logo = renderToStaticMarkup(
      <AgentLogo agentId="custom-agent" size={42} aria-label="Custom agent" />,
    );

    expect(logo).toContain('data-agent-logo="generic"');
    expect(logo).toContain('aria-label="Custom agent"');
    expect(logo).toContain('role="img"');
    expect(logo).toContain('width="42"');
    expect(logo).toContain('height="42"');
  });

  it("is decorative by default", () => {
    const logo = renderToStaticMarkup(<AgentLogo agentId="codex" />);

    expect(logo).toContain('aria-hidden="true"');
  });
});
