import type { SessionStatus } from "./models";

export type SessionEvent =
  | { type: "process-started" }
  | { type: "activity" }
  | { type: "attention-requested" }
  | { type: "process-exited"; success: boolean }
  | { type: "reviewed"; running?: boolean }
  | { type: "disconnected" };

export function reduceSessionStatus(
  current: SessionStatus,
  event: SessionEvent,
): SessionStatus {
  switch (event.type) {
    case "process-started":
      return "working";
    case "activity":
      // Output repainting must not hide an unresolved approval or question.
      // Sending the user's response explicitly moves the session back to working.
      return current === "attention" ? "attention" : "working";
    case "attention-requested":
      return "attention";
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

export function outputRequestsAttention(output: string): boolean {
  const normalized = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  return ATTENTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function scanTerminalAttention(previousTail: string, data: string, tailLength = 2_048) {
  const combined = `${previousTail}${data}`;
  return {
    needsAttention: outputRequestsAttention(combined),
    tail: combined.slice(-tailLength),
  };
}
