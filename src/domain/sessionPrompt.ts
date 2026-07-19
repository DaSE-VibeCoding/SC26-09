import type { AgentSession } from "./models";
import {
  SESSION_HOST_PROTOCOL_VERSION,
  type SessionSendRequest,
  type StructuredLifecycleSource,
} from "./sessionHost";
import type { SessionConnectionSnapshot } from "./sessionRuntime";

export type PromptReadinessState =
  | "pty-fallback-sendable"
  | "awaiting-authoritative"
  | "ready"
  | "auth-required"
  | "setup-required"
  | "unsupported";

export type PromptAuthority = "pty-fallback" | "provider-ready";

export const PROMPT_READINESS_COPY = {
  "pty-fallback-sendable": "PTY fallback is active. Provider readiness cannot be verified; Send writes directly to the live terminal.",
  ready: "Provider reports ready.",
  "awaiting-authoritative": "Waiting for an authoritative provider readiness signal. Your draft is preserved.",
  "auth-required": "Authentication is required. Complete it in Terminal when available, or authenticate in the provider CLI and reconnect. Your draft is preserved.",
  "setup-required": "Provider setup is required. Complete it in Terminal when available, or finish setup in the provider CLI and reconnect. Your draft is preserved.",
  unsupported: "Prompting is unsupported on this binding. Pelican will not silently start a replacement; reconnect with PTY fallback when an exact recovery handle is available.",
} as const satisfies Record<PromptReadinessState, string>;

const CONNECT_OR_RESUME_COPY = "Connect or resume this session before sending a prompt.";
const READINESS_UNAVAILABLE_COPY = PROMPT_READINESS_COPY["awaiting-authoritative"];
const TRANSPORT_MISMATCH_COPY = "Prompt readiness does not match this session binding. Reconnect using an explicit supported recovery path.";

export type PromptAvailability =
  | {
    readonly canSend: true;
    readonly authority: PromptAuthority;
    readonly providerReady: boolean;
    readonly readiness: PromptReadinessState;
    readonly streamId: string;
    readonly message: string;
  }
  | {
    readonly canSend: false;
    readonly authority: "none";
    readonly providerReady: false;
    readonly readiness?: PromptReadinessState;
    readonly reason: "missing-session" | "closed" | "missing-readiness" | "blocked-readiness" | "mismatched-readiness";
    readonly message: string;
  };

export function initialPromptReadinessForTransport(
  transport: SessionConnectionSnapshot["transport"],
): PromptReadinessState {
  return transport.type === "pty" && transport.lifecycleEvidence === "fallback"
    ? "pty-fallback-sendable"
    : "awaiting-authoritative";
}

export function selectPromptAvailability(
  session: AgentSession | null | undefined,
  connection: SessionConnectionSnapshot | undefined,
): PromptAvailability {
  if (!session) {
    return blocked("missing-session", CONNECT_OR_RESUME_COPY);
  }
  if (!session.connected || !connection || !connection.open) {
    return blocked("closed", CONNECT_OR_RESUME_COPY);
  }

  const readiness = connection.promptReadiness;
  if (!readiness) {
    return blocked("missing-readiness", READINESS_UNAVAILABLE_COPY);
  }

  const fallbackTransport = connection.transport.type === "pty"
    && connection.transport.lifecycleEvidence === "fallback";
  if (fallbackTransport) {
    if (connection.source) {
      return blocked("mismatched-readiness", TRANSPORT_MISMATCH_COPY, readiness);
    }
    if (readiness !== "pty-fallback-sendable") {
      return blocked("mismatched-readiness", TRANSPORT_MISMATCH_COPY, readiness);
    }
    return {
      canSend: true,
      authority: "pty-fallback",
      providerReady: false,
      readiness,
      streamId: connection.streamId,
      message: PROMPT_READINESS_COPY[readiness],
    };
  }

  if (connection.transport.lifecycleEvidence !== "structured") {
    return blocked("mismatched-readiness", TRANSPORT_MISMATCH_COPY, readiness);
  }
  if (!structuredSourceMatchesSession(session, connection)) {
    return blocked("mismatched-readiness", TRANSPORT_MISMATCH_COPY, readiness);
  }

  if (readiness === "ready") {
    return {
      canSend: true,
      authority: "provider-ready",
      providerReady: true,
      readiness,
      streamId: connection.streamId,
      message: PROMPT_READINESS_COPY.ready,
    };
  }

  if (readiness === "pty-fallback-sendable") {
    return blocked("mismatched-readiness", TRANSPORT_MISMATCH_COPY, readiness);
  }

  return blocked("blocked-readiness", PROMPT_READINESS_COPY[readiness], readiness);
}

export function buildPromptSendRequests(
  session: AgentSession,
  connection: SessionConnectionSnapshot | undefined,
  text: string,
): SessionSendRequest[] {
  const promptText = text.trim();
  if (!promptText) return [];

  const availability = selectPromptAvailability(session, connection);
  if (!availability.canSend || !connection) return [];

  if (connection.transport.type === "protocol") {
    return [request(session.id, availability.streamId, { type: "prompt", text: promptText })];
  }

  const multiline = promptText.includes("\n");
  if (session.agentId === "codex" && connection.transport.lifecycleEvidence === "fallback") {
    return [
      request(session.id, availability.streamId, {
        type: "terminal",
        data: multiline ? `\x1b[200~${promptText}\x1b[201~` : promptText,
      }),
      request(session.id, availability.streamId, { type: "terminal", data: "\r" }),
    ];
  }

  return [
    request(session.id, availability.streamId, {
      type: "terminal",
      data: multiline ? `\x1b[200~${promptText}\x1b[201~\r` : `${promptText}\r`,
    }),
  ];
}

function structuredSourceMatchesSession(
  session: AgentSession,
  connection: SessionConnectionSnapshot,
): boolean {
  if (connection.transport.lifecycleEvidence !== "structured") return false;
  const transportSource = connection.transport.source;
  if (!connection.source || !sourceIdentityMatches(connection.source, transportSource)) return false;
  if (transportSource.agentId !== session.agentId) return false;
  if (session.externalSessionId !== undefined && session.externalSessionId !== transportSource.providerSessionId) return false;
  return true;
}

function sourceIdentityMatches(a: StructuredLifecycleSource, b: StructuredLifecycleSource): boolean {
  return a.agentId === b.agentId
    && a.integration === b.integration
    && a.providerSessionId === b.providerSessionId;
}

function blocked(
  reason: Extract<PromptAvailability, { canSend: false }>["reason"],
  message: string,
  readiness?: PromptReadinessState,
): PromptAvailability {
  return { canSend: false, authority: "none", providerReady: false, reason, readiness, message };
}

function request(
  sessionId: string,
  streamId: string,
  input: SessionSendRequest["input"],
): SessionSendRequest {
  return { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId, streamId, input };
}
