export const FIRST_CLASS_AGENT_IDS = ["codex", "claude-code", "pi"] as const;

export type FirstClassAgentId = (typeof FIRST_CLASS_AGENT_IDS)[number];

export type AgentStructuredTransport = "app-server" | "hooks" | "rpc";
export type AgentBindingKind = "pty-fallback" | AgentStructuredTransport;

export interface AgentLaunchContext {
  cwd: string;
  sessionId: string;
  title: string;
  resumeSessionId?: string;
  attachSessionId?: string;
}

export interface AgentLaunchSpec {
  program: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentAdapter {
  id: FirstClassAgentId;
  displayName: string;
  shortName: string;
  executableCandidates: readonly string[];
  description: string;
  accent: string;
  capabilities: {
    preferredTransport: AgentStructuredTransport;
    supportedBindings: readonly AgentBindingKind[];
    resumable: boolean;
  };
  /** Compatibility path used until the preferred structured transport is active. */
  buildLaunchSpec(executable: string, context: AgentLaunchContext): AgentLaunchSpec;
}
