import type { SessionStatus } from "./models";

export type SessionEvent =
  | { type: "activity" }
  | { type: "attention-requested" }
  | { type: "turn-completed" }
  | { type: "process-exited"; success: boolean }
  | { type: "reviewed"; running?: boolean }
  | { type: "disconnected" };

export function reduceSessionStatus(
  current: SessionStatus,
  event: SessionEvent,
): SessionStatus {
  switch (event.type) {
    case "activity":
      // Output repainting must not hide an unresolved approval or question.
      // Sending the user's response explicitly moves the session back to working.
      if (current === "attention") return "attention";
      // Keep Done stable across TUI repaints until the user starts a new turn.
      if (current === "done") return "done";
      return "working";
    case "attention-requested":
      return "attention";
    case "turn-completed":
      // Interactive CLIs stay alive after a turn; only leave attention alone.
      return current === "attention" ? "attention" : "done";
    case "process-exited":
      return event.success ? "done" : "attention";
    case "reviewed":
      // Reviewing a completed result clears it to idle. An attention request,
      // however, remains unresolved until the agent produces new activity or exits.
      return current === "done" ? event.running === false ? "offline" : "idle" : current;
    case "disconnected":
      return "offline";
  }
}

const ATTENTION_PATTERNS = [
  /(?:approve|permission|confirmation) required/i,
  /do you want to (?:continue|proceed)/i,
  /waiting for (?:your )?input/i,
  /press (?:enter|return) to continue/i,
  /\[(?:y\/n|Y\/n|yes\/no)\]/,
];

/**
 * Temporary PTY fallback: after the user engaged and the agent produced
 * output, a quiet window implies the turn settled while the CLI stayed open.
 * Structured provider events should replace this.
 */
export const TURN_IDLE_MS = 2_500;

export function outputRequestsAttention(output: string): boolean {
  const normalized = stripAnsi(output);
  return ATTENTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function scanTerminalAttention(previousTail: string, data: string, tailLength = 2_048) {
  const combined = `${previousTail}${data}`;
  return {
    needsAttention: outputRequestsAttention(combined),
    tail: combined.slice(-tailLength),
  };
}

function stripAnsi(output: string): string {
  return output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
