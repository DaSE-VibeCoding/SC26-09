export type DiffState =
  | { status: "loading" }
  | { status: "ready"; patch: string }
  | { status: "error"; message: string };

export function beginDiffFetch(
  current: DiffState,
  previousKey: string | null,
  nextKey: string,
): DiffState {
  return previousKey === nextKey && current.status === "ready"
    ? current
    : { status: "loading" };
}
