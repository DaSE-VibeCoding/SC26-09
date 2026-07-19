import type { SessionStatus } from "../domain/models";

const labels: Record<SessionStatus, string> = {
  attention: "Needs attention",
  working: "Working",
  done: "Done",
  idle: "Idle",
  available: "Available to resume",
  offline: "Offline",
};

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`status-dot status-${status}`} title={labels[status]} aria-label={labels[status]} />;
}
