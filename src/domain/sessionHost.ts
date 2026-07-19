import type { FirstClassAgentId } from "../agents/types";
import type { ActivityEvent } from "./lifecycle";

export const SESSION_HOST_PROTOCOL_VERSION = 4 as const;

export const PROMPT_READINESS_STATES = [
  "pty-fallback-sendable",
  "awaiting-authoritative",
  "ready",
  "auth-required",
  "setup-required",
  "unsupported",
] as const;
export type PromptReadinessState = typeof PROMPT_READINESS_STATES[number];

export type StructuredLifecycleIntegration = "app-server" | "hooks" | "rpc";
export type StructuredSourceProvenance = "provider-event" | "provider-handshake";
export type StructuredTurnProvenance = "provider-turn" | "provider-prompt" | "adapter-stream";

export interface StructuredLifecycleSource {
  readonly agentId: FirstClassAgentId;
  readonly integration: StructuredLifecycleIntegration;
  readonly providerSessionId: string;
  readonly provenance: StructuredSourceProvenance;
}

export interface StructuredTurnIdentity {
  readonly key: string;
  readonly provenance: StructuredTurnProvenance;
}

export interface StructuredActivityContext {
  readonly turn: StructuredTurnIdentity;
}

export type SessionTransportDescriptor =
  | { type: "pty"; lifecycleEvidence: "fallback" }
  | { type: "pty"; lifecycleEvidence: "structured"; source: StructuredLifecycleSource }
  | { type: "protocol"; lifecycleEvidence: "structured"; source: StructuredLifecycleSource };

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
  promptReadiness: PromptReadinessState;
}

export type SessionCloseOutcome =
  | { type: "stopped" }
  | { type: "exited"; success: boolean };

export type TransportActivityEvent = Exclude<ActivityEvent, { type: "result-reviewed" }> & {
  evidence: "structured";
};

export type SessionHostEvent =
  | { type: "opened"; transport: SessionTransportDescriptor; promptReadiness: PromptReadinessState }
  | {
    type: "prompt-readiness-changed";
    source: StructuredLifecycleSource;
    promptReadiness: PromptReadinessState;
  }
  | {
    type: "activity";
    source: StructuredLifecycleSource;
    context: StructuredActivityContext;
    activity: TransportActivityEvent;
  }
  | { type: "terminal-output"; data: string }
  | { type: "closed"; outcome: SessionCloseOutcome };

export interface SessionEventEnvelope {
  protocolVersion: typeof SESSION_HOST_PROTOCOL_VERSION;
  sessionId: string;
  streamId: string;
  sequence: number;
  event: SessionHostEvent;
}
