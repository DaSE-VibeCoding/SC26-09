import { PatchDiff, type PatchDiffProps } from "@pierre/diffs/react";

export const PELICAN_TRUNCATION_MARKER =
  "\n\n… Diff truncated by Pelican (2 MiB limit).\n";

export type DiffViewerProps = (
  | { state: "loading" }
  | { state: "ready"; patch: string }
  | { state: "error"; error: string }
) & {
  onRetry?: () => void;
};

export type ClassifiedPatch =
  | { kind: "empty"; truncated: boolean }
  | { kind: "empty-file"; truncated: boolean }
  | { kind: "binary"; truncated: boolean }
  | { kind: "patch"; patch: string; truncated: boolean };

const BINARY_DIFF_MARKER = /^(?:Binary files .+ differ|GIT binary patch)$/m;

export function classifyPatch(patch: string): ClassifiedPatch {
  const truncated = patch.endsWith(PELICAN_TRUNCATION_MARKER);
  const renderablePatch = truncated
    ? patch.slice(0, -PELICAN_TRUNCATION_MARKER.length)
    : patch;

  if (BINARY_DIFF_MARKER.test(renderablePatch)) {
    return { kind: "binary", truncated };
  }
  if (/^New empty file: .+$/m.test(renderablePatch)) {
    return { kind: "empty-file", truncated };
  }
  if (renderablePatch.trim().length === 0) {
    return { kind: "empty", truncated };
  }
  return { kind: "patch", patch: renderablePatch, truncated };
}

const patchOptions: NonNullable<PatchDiffProps<undefined>["options"]> = {
  theme: "github-light",
  themeType: "light",
  diffStyle: "unified",
  overflow: "wrap",
};

function RetryButton({ onRetry }: Pick<DiffViewerProps, "onRetry">) {
  return onRetry ? (
    <button type="button" onClick={onRetry}>
      Retry
    </button>
  ) : null;
}

export function DiffViewer(props: DiffViewerProps) {
  if (props.state === "loading") {
    return (
      <div className="diff-viewer-state" role="status">
        Loading diff…
      </div>
    );
  }

  if (props.state === "error") {
    return (
      <div className="diff-viewer-state" role="alert">
        <p>Unable to load this diff.</p>
        <RetryButton onRetry={props.onRetry} />
      </div>
    );
  }

  const classified = classifyPatch(props.patch);
  return (
    <div className="diff-viewer">
      {classified.truncated ? (
        <div className="diff-viewer-warning" role="status">
          This diff was truncated by Pelican at the 2 MiB limit.
        </div>
      ) : null}
      {classified.kind === "empty" ? (
        <div className="diff-viewer-state">No text diff available.</div>
      ) : classified.kind === "empty-file" ? (
        <div className="diff-viewer-state">New empty file; there are no lines to compare.</div>
      ) : classified.kind === "binary" ? (
        <div className="diff-viewer-state">
          Binary file changed; no text diff is available.
        </div>
      ) : (
        <PatchDiff
          patch={classified.patch}
          options={patchOptions}
          disableWorkerPool
        />
      )}
    </div>
  );
}
