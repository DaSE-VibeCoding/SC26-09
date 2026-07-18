import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  classifyPatch,
  DiffViewer,
  PELICAN_TRUNCATION_MARKER,
} from "./DiffViewer";

describe("DiffViewer", () => {
  it("renders distinct loading and native error states without exposing the error", () => {
    expect(
      renderToStaticMarkup(<DiffViewer state="loading" />),
    ).toContain("Loading diff");

    const error = renderToStaticMarkup(
      <DiffViewer
        state="error"
        error="secret native command output"
        onRetry={() => undefined}
      />,
    );
    expect(error).toContain("Unable to load this diff");
    expect(error).toContain("Retry");
    expect(error).not.toContain("secret native command output");
  });

  it("classifies empty and binary patches as Pelican-owned fallbacks", () => {
    expect(classifyPatch("  \n")).toEqual({ kind: "empty", truncated: false });
    expect(classifyPatch("New empty file: notes.md\n")).toEqual({
      kind: "empty-file",
      truncated: false,
    });
    expect(classifyPatch("Binary files a/image.png and b/image.png differ\n")).toEqual({
      kind: "binary",
      truncated: false,
    });
    expect(classifyPatch("GIT binary patch\nliteral 0\nHcmV?d00001\n")).toEqual({
      kind: "binary",
      truncated: false,
    });
  });

  it("removes only Pelican's truncation marker from a renderable patch", () => {
    const patch = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new${PELICAN_TRUNCATION_MARKER}`;

    expect(classifyPatch(patch)).toEqual({
      kind: "patch",
      patch: patch.slice(0, -PELICAN_TRUNCATION_MARKER.length),
      truncated: true,
    });
  });

  it("renders the empty, binary, and truncation notices", () => {
    expect(renderToStaticMarkup(<DiffViewer state="ready" patch="" />)).toContain(
      "No text diff available",
    );
    expect(renderToStaticMarkup(
      <DiffViewer state="ready" patch="New empty file: notes.md\n" />,
    )).toContain("New empty file");
    expect(
      renderToStaticMarkup(
        <DiffViewer state="ready" patch="Binary files a/a.png and b/a.png differ" />,
      ),
    ).toContain("Binary file changed");
    expect(
      renderToStaticMarkup(
        <DiffViewer state="ready" patch={PELICAN_TRUNCATION_MARKER} />,
      ),
    ).toContain("truncated by Pelican");
  });
});
