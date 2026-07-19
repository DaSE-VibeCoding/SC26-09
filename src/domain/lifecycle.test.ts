import { describe, expect, it } from "vitest";
import {
  createLiveTurnLifecycle,
  deriveLiveSessionStatus,
  reduceLiveTurnLifecycle,
  type ActivityEvent,
  type LiveTurnLifecycle,
} from "./lifecycle";

function reduceEvents(events: readonly ActivityEvent[]): LiveTurnLifecycle {
  return events.reduce(
    (state, event) => reduceLiveTurnLifecycle(state, event),
    createLiveTurnLifecycle(),
  );
}

describe("live turn lifecycle", () => {
  it("derives the live status from idle, working, completed, and reviewed phases", () => {
    const initial = createLiveTurnLifecycle();
    expect(deriveLiveSessionStatus(initial)).toBe("idle");

    const working = reduceLiveTurnLifecycle(initial, {
      type: "turn-started",
      evidence: "fallback",
    });
    expect(deriveLiveSessionStatus(working)).toBe("working");

    const completed = reduceLiveTurnLifecycle(working, {
      type: "turn-ended",
      evidence: "fallback",
      outcome: "completed",
    });
    expect(deriveLiveSessionStatus(completed)).toBe("done");

    const reviewed = reduceLiveTurnLifecycle(completed, { type: "result-reviewed" });
    expect(deriveLiveSessionStatus(reviewed)).toBe("idle");
  });

  it.each([
    ["completed", "done"],
    ["failed", "attention"],
    ["interrupted", "idle"],
  ] as const)("maps the %s terminal outcome to %s", (outcome, expected) => {
    const ended = reduceEvents([
      { type: "turn-started", evidence: "structured" },
      { type: "turn-ended", evidence: "structured", outcome },
    ]);

    expect(ended.phase).toBe(outcome);
    expect(deriveLiveSessionStatus(ended)).toBe(expected);
  });

  it("does not review failed attention and clears a prior outcome for a new turn", () => {
    const failed = reduceEvents([
      { type: "turn-started", evidence: "structured" },
      { type: "turn-ended", evidence: "structured", outcome: "failed" },
    ]);
    expect(reduceLiveTurnLifecycle(failed, { type: "result-reviewed" })).toBe(failed);

    const next = reduceLiveTurnLifecycle(failed, { type: "turn-started", evidence: "structured" });
    expect(next.phase).toBe("working");
    expect(deriveLiveSessionStatus(next)).toBe("working");
  });

  it("keeps pending attention ahead of every terminal outcome until resolution", () => {
    for (const outcome of ["completed", "failed", "interrupted"] as const) {
      const ended = reduceEvents([
        { type: "turn-started", evidence: "structured" },
        { type: "attention-requested", evidence: "structured", key: "approval" },
        { type: "turn-ended", evidence: "structured", outcome },
      ]);
      expect(deriveLiveSessionStatus(ended)).toBe("attention");
      const resolved = reduceLiveTurnLifecycle(ended, {
        type: "attention-resolved", evidence: "structured", key: "approval",
      });
      expect(deriveLiveSessionStatus(resolved)).toBe(
        outcome === "completed" ? "done" : outcome === "failed" ? "attention" : "idle",
      );
    }
  });

  it("tracks multiple correlated pending attention keys", () => {
    const withAttention = reduceEvents([
      { type: "turn-started", evidence: "structured" },
      { type: "attention-requested", evidence: "structured", key: "approval" },
      { type: "attention-requested", evidence: "structured", key: "input" },
    ]);

    expect(withAttention.pendingAttentionKeys).toEqual(["approval", "input"]);
    expect(deriveLiveSessionStatus(withAttention)).toBe("attention");

    const approvalResolved = reduceLiveTurnLifecycle(withAttention, {
      type: "attention-resolved",
      evidence: "structured",
      key: "approval",
    });
    expect(approvalResolved.pendingAttentionKeys).toEqual(["input"]);
    expect(deriveLiveSessionStatus(approvalResolved)).toBe("attention");

    const allResolved = reduceLiveTurnLifecycle(approvalResolved, {
      type: "attention-resolved",
      evidence: "structured",
      key: "input",
    });
    expect(allResolved.pendingAttentionKeys).toEqual([]);
    expect(deriveLiveSessionStatus(allResolved)).toBe("working");
  });

  it("keeps completion latent under pending attention until the final matching resolution", () => {
    const latentCompletion = reduceEvents([
      { type: "turn-started", evidence: "structured" },
      { type: "attention-requested", evidence: "structured", key: "approval" },
      { type: "attention-requested", evidence: "structured", key: "input" },
      { type: "turn-ended", evidence: "structured", outcome: "completed" },
    ]);

    expect(latentCompletion.phase).toBe("completed");
    expect(deriveLiveSessionStatus(latentCompletion)).toBe("attention");

    const stillBlocked = reduceLiveTurnLifecycle(latentCompletion, {
      type: "attention-resolved",
      evidence: "structured",
      key: "approval",
    });
    expect(deriveLiveSessionStatus(stillBlocked)).toBe("attention");

    const revealedCompletion = reduceLiveTurnLifecycle(stillBlocked, {
      type: "attention-resolved",
      evidence: "structured",
      key: "input",
    });
    expect(deriveLiveSessionStatus(revealedCompletion)).toBe("done");
  });

  it("does not review a completed result while attention remains unresolved", () => {
    const latentCompletion = reduceEvents([
      { type: "turn-started", evidence: "structured" },
      { type: "attention-requested", evidence: "structured", key: "approval" },
      { type: "turn-ended", evidence: "structured", outcome: "completed" },
    ]);

    const reviewedWhileBlocked = reduceLiveTurnLifecycle(latentCompletion, {
      type: "result-reviewed",
    });
    expect(reviewedWhileBlocked).toBe(latentCompletion);
    expect(deriveLiveSessionStatus(reviewedWhileBlocked)).toBe("attention");

    const revealedCompletion = reduceLiveTurnLifecycle(reviewedWhileBlocked, {
      type: "attention-resolved",
      evidence: "structured",
      key: "approval",
    });
    expect(deriveLiveSessionStatus(revealedCompletion)).toBe("done");

    const reviewedAfterResolution = reduceLiveTurnLifecycle(revealedCompletion, {
      type: "result-reviewed",
    });
    expect(deriveLiveSessionStatus(reviewedAfterResolution)).toBe("idle");
  });

  it("keeps duplicate attention requests idempotent and immutable", () => {
    const started = reduceLiveTurnLifecycle(createLiveTurnLifecycle(), {
      type: "turn-started",
      evidence: "fallback",
    });
    const requested = reduceLiveTurnLifecycle(started, {
      type: "attention-requested",
      evidence: "fallback",
      key: "approval",
    });
    const duplicate = reduceLiveTurnLifecycle(requested, {
      type: "attention-requested",
      evidence: "fallback",
      key: "approval",
    });

    expect(requested).not.toBe(started);
    expect(started.pendingAttentionKeys).toEqual([]);
    expect(duplicate).toBe(requested);
    expect(duplicate.pendingAttentionKeys).toEqual(["approval"]);
  });

  it("keeps unknown and duplicate attention resolutions idempotent", () => {
    const requested = reduceEvents([
      { type: "turn-started", evidence: "structured" },
      { type: "attention-requested", evidence: "structured", key: "approval" },
    ]);

    const unknownResolution = reduceLiveTurnLifecycle(requested, {
      type: "attention-resolved",
      evidence: "structured",
      key: "unknown",
    });
    expect(unknownResolution).toBe(requested);

    const resolved = reduceLiveTurnLifecycle(requested, {
      type: "attention-resolved",
      evidence: "structured",
      key: "approval",
    });
    expect(deriveLiveSessionStatus(resolved)).toBe("working");

    const duplicateResolution = reduceLiveTurnLifecycle(resolved, {
      type: "attention-resolved",
      evidence: "structured",
      key: "approval",
    });
    expect(duplicateResolution).toBe(resolved);
  });

  it("promotes authority without discarding previous fallback attention", () => {
    const fallbackAttention = reduceEvents([
      { type: "turn-started", evidence: "fallback" },
      { type: "attention-requested", evidence: "fallback", key: "terminal-prompt" },
    ]);
    expect(deriveLiveSessionStatus(fallbackAttention)).toBe("attention");

    const structuredCompletion = reduceLiveTurnLifecycle(fallbackAttention, {
      type: "turn-ended",
      evidence: "structured",
      outcome: "completed",
    });
    expect(structuredCompletion.evidenceAuthority).toBe("structured");
    expect(structuredCompletion.pendingAttentionKeys).toEqual(["terminal-prompt"]);
    expect(deriveLiveSessionStatus(structuredCompletion)).toBe("attention");

    const resolved = reduceLiveTurnLifecycle(structuredCompletion, {
      type: "attention-resolved",
      evidence: "structured",
      key: "terminal-prompt",
    });
    expect(deriveLiveSessionStatus(resolved)).toBe("done");
  });

  it("promotes an unknown structured resolution without clearing pending attention", () => {
    const fallbackAttention = reduceEvents([
      { type: "turn-started", evidence: "fallback" },
      { type: "attention-requested", evidence: "fallback", key: "approval" },
      { type: "attention-requested", evidence: "fallback", key: "input" },
    ]);

    const promoted = reduceLiveTurnLifecycle(fallbackAttention, {
      type: "attention-resolved",
      evidence: "structured",
      key: "unknown",
    });
    expect(promoted.evidenceAuthority).toBe("structured");
    expect(promoted.pendingAttentionKeys).toEqual(["approval", "input"]);

    const oneResolved = reduceLiveTurnLifecycle(promoted, {
      type: "attention-resolved",
      evidence: "structured",
      key: "approval",
    });
    expect(oneResolved.pendingAttentionKeys).toEqual(["input"]);

    const fallbackCompletion = reduceLiveTurnLifecycle(oneResolved, {
      type: "turn-ended",
      evidence: "fallback",
      outcome: "completed",
    });
    expect(fallbackCompletion).toBe(oneResolved);
  });

  it("permanently ignores fallback evidence after structured authority is established", () => {
    const structuredWorking = reduceLiveTurnLifecycle(createLiveTurnLifecycle(), {
      type: "turn-started",
      evidence: "structured",
    });

    const fallbackAttention = reduceLiveTurnLifecycle(structuredWorking, {
      type: "attention-requested",
      evidence: "fallback",
      key: "terminal-prompt",
    });
    expect(fallbackAttention).toBe(structuredWorking);
    expect(deriveLiveSessionStatus(fallbackAttention)).toBe("working");

    const structuredAttention = reduceLiveTurnLifecycle(structuredWorking, {
      type: "attention-requested",
      evidence: "structured",
      key: "approval",
    });
    const fallbackResolution = reduceLiveTurnLifecycle(structuredAttention, {
      type: "attention-resolved",
      evidence: "fallback",
      key: "approval",
    });
    expect(fallbackResolution).toBe(structuredAttention);
    expect(deriveLiveSessionStatus(fallbackResolution)).toBe("attention");

    const completed = reduceEvents([
      { type: "turn-started", evidence: "structured" },
      { type: "turn-ended", evidence: "structured", outcome: "completed" },
    ]);
    const fallbackRestart = reduceLiveTurnLifecycle(completed, {
      type: "turn-started",
      evidence: "fallback",
    });
    expect(fallbackRestart).toBe(completed);
    expect(deriveLiveSessionStatus(fallbackRestart)).toBe("done");
  });
});
