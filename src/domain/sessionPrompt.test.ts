import { describe, expect, it } from "vitest";
import type { AgentSession } from "./models";
import type { SessionConnectionSnapshot } from "./sessionRuntime";
import type { StructuredLifecycleSource } from "./sessionHost";
import {
  buildPromptSendRequests,
  PROMPT_READINESS_COPY,
  selectPromptAvailability,
  type PromptReadinessState,
} from "./sessionPrompt";

const codexSource: StructuredLifecycleSource = {
  agentId: "codex",
  integration: "app-server",
  providerSessionId: "codex-thread-1",
  provenance: "provider-handshake",
};

const claudeSource: StructuredLifecycleSource = {
  agentId: "claude-code",
  integration: "hooks",
  providerSessionId: "claude-session-1",
  provenance: "provider-handshake",
};

const session = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: "session-1",
  workspaceId: "workspace-1",
  agentId: "codex",
  title: "Session",
  status: "idle",
  createdAt: "created",
  lastActivityAt: "activity",
  unread: false,
  connected: true,
  running: true,
  origin: "pelican",
  ...overrides,
});

const fallbackConnection = (
  readiness: PromptReadinessState = "pty-fallback-sendable",
  open = true,
): SessionConnectionSnapshot => ({
  streamId: "stream-1",
  transport: { type: "pty", lifecycleEvidence: "fallback" },
  open,
  promptReadiness: readiness,
});

const protocolConnection = (
  readiness: PromptReadinessState,
): SessionConnectionSnapshot => ({
  streamId: "stream-1",
  transport: { type: "protocol", lifecycleEvidence: "structured", source: codexSource },
  open: true,
  promptReadiness: readiness,
  source: codexSource,
});

const structuredPtyConnection = (
  readiness: PromptReadinessState,
): SessionConnectionSnapshot => ({
  streamId: "stream-1",
  transport: { type: "pty", lifecycleEvidence: "structured", source: claudeSource },
  open: true,
  promptReadiness: readiness,
  source: claudeSource,
});

describe("prompt availability policy", () => {
  it("allows PTY fallback as sendable terminal authority without provider readiness", () => {
    const availability = selectPromptAvailability(session(), fallbackConnection());

    expect(availability).toEqual({
      canSend: true,
      authority: "pty-fallback",
      providerReady: false,
      readiness: "pty-fallback-sendable",
      streamId: "stream-1",
      message: PROMPT_READINESS_COPY["pty-fallback-sendable"],
    });
  });

  it("allows only authoritative ready structured bindings", () => {
    const protocol = selectPromptAvailability(session(), protocolConnection("ready"));
    expect(protocol.canSend).toBe(true);
    expect(protocol.authority).toBe("provider-ready");
    expect(protocol.providerReady).toBe(true);
    expect(protocol.message).toBe(PROMPT_READINESS_COPY.ready);

    const pty = selectPromptAvailability(session({ agentId: "claude-code" }), structuredPtyConnection("ready"));
    expect(pty.canSend).toBe(true);
    expect(pty.authority).toBe("provider-ready");
  });

  it.each(["awaiting-authoritative", "auth-required", "setup-required", "unsupported"] as const)(
    "blocks structured %s readiness with exact recovery copy",
    (readiness) => {
      const availability = selectPromptAvailability(session(), protocolConnection(readiness));

      expect(availability.canSend).toBe(false);
      expect(availability.providerReady).toBe(false);
      expect(availability.message).toBe(PROMPT_READINESS_COPY[readiness]);
      expect(buildPromptSendRequests(session(), protocolConnection(readiness), "hello")).toEqual([]);
    },
  );

  it("fails closed on missing, closed, and mismatched transport readiness", () => {
    expect(selectPromptAvailability(session(), undefined).canSend).toBe(false);
    expect(selectPromptAvailability(session(), fallbackConnection("pty-fallback-sendable", false)).canSend).toBe(false);
    expect(selectPromptAvailability(session(), fallbackConnection("ready")).canSend).toBe(false);
    expect(selectPromptAvailability(session(), protocolConnection("pty-fallback-sendable")).canSend).toBe(false);
    expect(selectPromptAvailability(session({ agentId: "pi" }), protocolConnection("ready")).canSend).toBe(false);
    expect(buildPromptSendRequests(session(), fallbackConnection("ready"), "hello")).toEqual([]);
    expect(buildPromptSendRequests(session(), protocolConnection("pty-fallback-sendable"), "hello")).toEqual([]);
  });
});

describe("prompt input construction", () => {
  it("constructs one semantic prompt input for protocol bindings", () => {
    expect(buildPromptSendRequests(session(), protocolConnection("ready"), "  hello provider  ")).toEqual([
      {
        protocolVersion: 3,
        sessionId: "session-1",
        streamId: "stream-1",
        input: { type: "prompt", text: "hello provider" },
      },
    ]);
  });

  it("preserves Codex PTY fallback's separate text write and carriage return", () => {
    expect(buildPromptSendRequests(session({ agentId: "codex" }), fallbackConnection(), "hello")).toEqual([
      { protocolVersion: 3, sessionId: "session-1", streamId: "stream-1", input: { type: "terminal", data: "hello" } },
      { protocolVersion: 3, sessionId: "session-1", streamId: "stream-1", input: { type: "terminal", data: "\r" } },
    ]);

    expect(buildPromptSendRequests(session({ agentId: "codex" }), fallbackConnection(), "hello\nworld")).toEqual([
      { protocolVersion: 3, sessionId: "session-1", streamId: "stream-1", input: { type: "terminal", data: "\x1b[200~hello\nworld\x1b[201~" } },
      { protocolVersion: 3, sessionId: "session-1", streamId: "stream-1", input: { type: "terminal", data: "\r" } },
    ]);
  });

  it("preserves existing single terminal writes for non-Codex PTY fallback", () => {
    expect(buildPromptSendRequests(session({ agentId: "claude-code" }), fallbackConnection(), "hello")).toEqual([
      { protocolVersion: 3, sessionId: "session-1", streamId: "stream-1", input: { type: "terminal", data: "hello\r" } },
    ]);

    expect(buildPromptSendRequests(session({ agentId: "pi" }), fallbackConnection(), "hello\nworld")).toEqual([
      { protocolVersion: 3, sessionId: "session-1", streamId: "stream-1", input: { type: "terminal", data: "\x1b[200~hello\nworld\x1b[201~\r" } },
    ]);
  });

  it("uses terminal input for a ready structured Claude PTY binding", () => {
    expect(buildPromptSendRequests(
      session({ agentId: "claude-code", externalSessionId: "claude-session-1" }),
      structuredPtyConnection("ready"),
      "hello",
    )).toEqual([
      { protocolVersion: 3, sessionId: "session-1", streamId: "stream-1", input: { type: "terminal", data: "hello\r" } },
    ]);
  });

  it("constructs no requests for empty or blocked prompts", () => {
    expect(buildPromptSendRequests(session(), fallbackConnection(), "   ")).toEqual([]);
    expect(buildPromptSendRequests(session(), protocolConnection("auth-required"), "hello")).toEqual([]);
  });
});
