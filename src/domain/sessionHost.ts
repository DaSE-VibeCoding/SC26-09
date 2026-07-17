import type { FirstClassAgentId } from "../agents/types";
import type { ActivityEvent } from "./lifecycle";

export const SESSION_HOST_PROTOCOL_VERSION = 1 as const;

export type SessionTransportDescriptor =
  | { type: "pty"; lifecycleEvidence: "fallback" | "structured" }
  | { type: "protocol"; lifecycleEvidence: "structured" };

export function hasInteractiveTerminal(transport: SessionTransportDescriptor): boolean {
  return transport.type === "pty";
}

export type SessionRecovery =
  | { type: "new" }
  | { type: "resume"; handle: string }
  | { type: "attach"; handle: string };

export interface SessionOpenTransport {
  type: "pty-fallback";
  executable: string;
}

export interface SessionTerminalSize {
  rows: number;
  cols: number;
}

export interface SessionOpenRequest {
  protocolVersion: typeof SESSION_HOST_PROTOCOL_VERSION;
  sessionId: string;
  agentId: FirstClassAgentId;
  workspacePath: string;
  title: string;
  transport: SessionOpenTransport;
  terminalSize: SessionTerminalSize;
  recovery: SessionRecovery;
}

export type SessionInput =
  | { type: "prompt"; text: string }
  | { type: "terminal"; data: string };

export interface SessionSendRequest {
  protocolVersion: typeof SESSION_HOST_PROTOCOL_VERSION;
  sessionId: string;
  streamId: string;
  input: SessionInput;
}

export interface SessionResizeRequest {
  protocolVersion: typeof SESSION_HOST_PROTOCOL_VERSION;
  sessionId: string;
  streamId: string;
  rows: number;
  cols: number;
}

export interface SessionStopRequest {
  protocolVersion: typeof SESSION_HOST_PROTOCOL_VERSION;
  sessionId: string;
  streamId: string;
}

export interface HostedSessionSnapshot {
  protocolVersion: typeof SESSION_HOST_PROTOCOL_VERSION;
  sessionId: string;
  streamId: string;
  lastSequence: number;
  transport: SessionTransportDescriptor;
}

export type SessionCloseOutcome =
  | { type: "stopped" }
  | { type: "exited"; success: boolean };

export type TransportActivityEvent = Exclude<ActivityEvent, { type: "result-reviewed" }>;

export type SessionHostEvent =
  | { type: "opened"; transport: SessionTransportDescriptor }
  | { type: "activity"; activity: TransportActivityEvent }
  | { type: "terminal-output"; data: string }
  | { type: "closed"; outcome: SessionCloseOutcome };

export interface SessionEventEnvelope {
  protocolVersion: typeof SESSION_HOST_PROTOCOL_VERSION;
  sessionId: string;
  streamId: string;
  sequence: number;
  event: SessionHostEvent;
}
