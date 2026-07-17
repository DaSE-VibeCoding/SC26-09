import type { SessionStatus } from "./models";

export type ActivityEvidence = "fallback" | "structured";

export type LiveTurnPhase = "idle" | "working" | "completed";

export type AttentionKey = string;

export type LiveSessionStatus = Extract<SessionStatus, "idle" | "working" | "attention" | "done">;

export type ActivityEvent =
  | { type: "turn-started"; evidence: ActivityEvidence }
  | { type: "attention-requested"; evidence: ActivityEvidence; key: AttentionKey }
  | { type: "attention-resolved"; evidence: ActivityEvidence; key: AttentionKey }
  | { type: "turn-completed"; evidence: ActivityEvidence }
  | { type: "result-reviewed" };

export interface LiveTurnLifecycle {
  readonly phase: LiveTurnPhase;
  readonly pendingAttentionKeys: readonly AttentionKey[];
  /**
   * The strongest provider evidence accepted for this live lifecycle. Once
   * structured evidence is accepted, later fallback evidence is ignored.
   */
  readonly evidenceAuthority: ActivityEvidence;
}

const EMPTY_ATTENTION_KEYS: readonly AttentionKey[] = Object.freeze([]);

export const INITIAL_LIVE_TURN_LIFECYCLE: LiveTurnLifecycle = Object.freeze({
  phase: "idle",
  pendingAttentionKeys: EMPTY_ATTENTION_KEYS,
  evidenceAuthority: "fallback",
});

export function createLiveTurnLifecycle(): LiveTurnLifecycle {
  return INITIAL_LIVE_TURN_LIFECYCLE;
}

export function reduceLiveTurnLifecycle(
  state: LiveTurnLifecycle,
  event: ActivityEvent,
): LiveTurnLifecycle {
  if (event.type === "result-reviewed") {
    if (state.pendingAttentionKeys.length > 0 || state.phase !== "completed") return state;
    return updateLifecycle(state, { phase: "idle" });
  }

  if (state.evidenceAuthority === "structured" && event.evidence === "fallback") {
    return state;
  }

  const acceptedState = event.evidence === "structured" && state.evidenceAuthority === "fallback"
    ? updateLifecycle(state, { evidenceAuthority: "structured" })
    : state;

  switch (event.type) {
    case "turn-started":
      return updateLifecycle(acceptedState, { phase: "working" });
    case "attention-requested":
      return reduceAttentionRequested(acceptedState, event.key);
    case "attention-resolved":
      return reduceAttentionResolved(acceptedState, event.key);
    case "turn-completed":
      return updateLifecycle(acceptedState, { phase: "completed" });
  }
}

export function deriveLiveSessionStatus(state: LiveTurnLifecycle): LiveSessionStatus {
  if (state.pendingAttentionKeys.length > 0) return "attention";

  switch (state.phase) {
    case "idle":
      return "idle";
    case "working":
      return "working";
    case "completed":
      return "done";
  }
}

function reduceAttentionRequested(
  state: LiveTurnLifecycle,
  key: AttentionKey,
): LiveTurnLifecycle {
  if (state.pendingAttentionKeys.includes(key)) return state;
  return updateLifecycle(state, {
    phase: state.phase === "idle" ? "working" : state.phase,
    pendingAttentionKeys: [...state.pendingAttentionKeys, key],
  });
}

function reduceAttentionResolved(
  state: LiveTurnLifecycle,
  key: AttentionKey,
): LiveTurnLifecycle {
  if (!state.pendingAttentionKeys.includes(key)) return state;
  return updateLifecycle(state, {
    pendingAttentionKeys: state.pendingAttentionKeys.filter((candidate) => candidate !== key),
  });
}

function updateLifecycle(
  state: LiveTurnLifecycle,
  updates: Partial<LiveTurnLifecycle>,
): LiveTurnLifecycle {
  const phase = updates.phase ?? state.phase;
  const pendingAttentionKeys = updates.pendingAttentionKeys ?? state.pendingAttentionKeys;
  const evidenceAuthority = updates.evidenceAuthority ?? state.evidenceAuthority;

  if (
    phase === state.phase
    && pendingAttentionKeys === state.pendingAttentionKeys
    && evidenceAuthority === state.evidenceAuthority
  ) {
    return state;
  }

  return Object.freeze({
    phase,
    pendingAttentionKeys: Object.freeze([...pendingAttentionKeys]),
    evidenceAuthority,
  });
}
