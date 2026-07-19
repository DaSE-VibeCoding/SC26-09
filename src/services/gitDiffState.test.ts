import { describe, expect, it } from "vitest";
import { beginDiffFetch, type DiffState } from "./gitDiffState";

describe("beginDiffFetch", () => {
  it("preserves a rendered patch for a same-file background refresh", () => {
    const current: DiffState = { status: "ready", patch: "current patch" };

    expect(beginDiffFetch(current, "workspace:file", "workspace:file")).toBe(current);
  });

  it("shows loading when the selected diff changes or an error is retried", () => {
    expect(beginDiffFetch(
      { status: "ready", patch: "old patch" },
      "workspace:old",
      "workspace:new",
    )).toEqual({ status: "loading" });
    expect(beginDiffFetch(
      { status: "error", message: "failed" },
      "workspace:file",
      "workspace:file",
    )).toEqual({ status: "loading" });
  });
});
