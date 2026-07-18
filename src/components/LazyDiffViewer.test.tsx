import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { resolveDiffViewerModule } from "./LazyDiffViewer";

describe("resolveDiffViewerModule", () => {
  it("resolves the imported diff component", async () => {
    const ResolvedViewer = () => <div>resolved viewer</div>;
    const module = await resolveDiffViewerModule(
      async () => ({ DiffViewer: ResolvedViewer }),
      () => undefined,
    );

    expect(renderToStaticMarkup(<module.default state="loading" />)).toContain("resolved viewer");
  });

  it("contains a failed dynamic import behind a retryable local error", async () => {
    const retry = vi.fn();
    const module = await resolveDiffViewerModule(
      async () => { throw new Error("missing chunk"); },
      retry,
    );
    const markup = renderToStaticMarkup(<module.default state="loading" />);

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("diff viewer could not be loaded");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain("missing chunk");
  });
});
