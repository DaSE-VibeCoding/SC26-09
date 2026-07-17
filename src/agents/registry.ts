import type { AgentAdapter, FirstClassAgentId } from "./types";

const codex: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  shortName: "CX",
  executableCandidates: ["codex"],
  description: "OpenAI's terminal coding agent",
  accent: "#7ee2b8",
  capabilities: {
    preferredTransport: "app-server",
    supportedBindings: ["pty-fallback"],
    resumable: true,
  },
  buildLaunchSpec(executable, context) {
    return {
      program: executable,
      args: context.resumeSessionId
        ? ["resume", "-C", context.cwd, context.resumeSessionId, "--no-alt-screen"]
        : ["-C", context.cwd, "--no-alt-screen"],
      env: { PELICAN_AGENT: "codex" },
    };
  },
};

const claudeCode: AgentAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  shortName: "CC",
  executableCandidates: ["claude"],
  description: "Anthropic's agentic coding CLI",
  accent: "#e6a978",
  capabilities: {
    preferredTransport: "hooks",
    supportedBindings: ["pty-fallback"],
    resumable: true,
  },
  buildLaunchSpec(executable, context) {
    return {
      program: executable,
      args: context.attachSessionId
        ? ["attach", context.attachSessionId]
        : context.resumeSessionId
          ? ["--resume", context.resumeSessionId]
          : ["--session-id", context.sessionId, "--name", context.title],
      env: { PELICAN_AGENT: "claude-code" },
    };
  },
};

const pi: AgentAdapter = {
  id: "pi",
  displayName: "Pi",
  shortName: "PI",
  executableCandidates: ["pi"],
  description: "A minimal, extensible terminal coding agent",
  accent: "#c7a6ff",
  capabilities: {
    preferredTransport: "rpc",
    supportedBindings: ["pty-fallback"],
    resumable: true,
  },
  buildLaunchSpec(executable, context) {
    return {
      program: executable,
      args: context.resumeSessionId
        ? ["--session", context.resumeSessionId]
        : ["--session-id", context.sessionId, "--name", context.title],
      env: { PELICAN_AGENT: "pi" },
    };
  },
};

export const agentRegistry: readonly AgentAdapter[] = [codex, claudeCode, pi];

export function getAgentAdapter(id: FirstClassAgentId): AgentAdapter {
  const adapter = agentRegistry.find((candidate) => candidate.id === id);
  if (!adapter) {
    throw new Error(`Unknown first-class agent: ${id}`);
  }
  return adapter;
}
