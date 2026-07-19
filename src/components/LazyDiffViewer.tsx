import { lazy, Suspense, useMemo, useState, type ComponentType } from "react";
import type { DiffViewerProps } from "./DiffViewer";

type DiffViewerModule = {
  DiffViewer: ComponentType<DiffViewerProps>;
};

type DiffViewerImporter = () => Promise<DiffViewerModule>;

function DiffViewerModuleError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="diff-viewer-state" role="alert">
      <p>The diff viewer could not be loaded.</p>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

export async function resolveDiffViewerModule(
  importer: DiffViewerImporter,
  onRetry: () => void,
): Promise<{ default: ComponentType<DiffViewerProps> }> {
  try {
    const module = await importer();
    return { default: module.DiffViewer };
  } catch {
    return { default: () => <DiffViewerModuleError onRetry={onRetry} /> };
  }
}

const importDiffViewer: DiffViewerImporter = () => import("./DiffViewer");

export function LazyDiffViewer(props: DiffViewerProps) {
  const [attempt, setAttempt] = useState(0);
  const Viewer = useMemo(() => lazy(() => resolveDiffViewerModule(
    importDiffViewer,
    () => setAttempt((current) => current + 1),
  )), [attempt]);

  return (
    <Suspense fallback={<div className="diff-viewer-state" role="status">Loading diff viewer…</div>}>
      <Viewer {...props} />
    </Suspense>
  );
}
