import { invoke, isTauri as coreIsTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AgentInstallation,
  DiscoveredAgentSession,
  FileEntry,
  GitChange,
  TerminalExitEvent,
  TerminalOutputEvent,
} from "../domain/models";

/** True only inside the native Pelican webview — never in a plain browser tab. */
export const isTauri = (): boolean => {
  if (typeof window === "undefined") return false;
  return coreIsTauri() || "__TAURI_INTERNALS__" in window;
};

function requireTauri(action: string): void {
  if (!isTauri()) {
    throw new Error(`${action} requires the Pelican desktop app (npm run tauri dev), not a browser tab.`);
  }
}

interface SpawnTerminalRequest {
  sessionId: string;
  cwd: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  rows: number;
  cols: number;
}

export async function chooseWorkspace(): Promise<string | null> {
  if (!isTauri()) return null;
  const result = await open({ directory: true, multiple: false, title: "Add workspace" });
  return typeof result === "string" ? result : null;
}

export async function discoverAgents(): Promise<AgentInstallation[]> {
  if (!isTauri()) {
    return [
      { agentId: "codex", executable: "codex", installed: true },
      { agentId: "claude-code", executable: "claude", installed: true },
      { agentId: "pi", executable: "pi", installed: true },
    ];
  }
  return invoke<AgentInstallation[]>("discover_agents");
}

export async function discoverAgentSessions(
  workspacePaths: string[],
): Promise<DiscoveredAgentSession[]> {
  if (!isTauri() || workspacePaths.length === 0) return [];
  return invoke<DiscoveredAgentSession[]>("discover_agent_sessions", { workspacePaths });
}

export async function spawnTerminal(request: SpawnTerminalRequest): Promise<void> {
  requireTauri("Starting an agent terminal");
  await invoke("terminal_spawn", { request });
}

export async function writeTerminal(sessionId: string, data: string): Promise<void> {
  requireTauri("Writing to an agent terminal");
  await invoke("terminal_write", { sessionId, data });
}

export async function resizeTerminal(
  sessionId: string,
  rows: number,
  cols: number,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_resize", { sessionId, rows, cols });
}

export async function stopTerminal(sessionId: string): Promise<void> {
  requireTauri("Stopping an agent terminal");
  await invoke("terminal_stop", { sessionId });
}

export async function listTerminalSessions(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("terminal_list_sessions");
}

export async function onTerminalOutput(
  callback: (event: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<TerminalOutputEvent>("terminal-output", ({ payload }) => callback(payload));
}

export async function onTerminalExit(
  callback: (event: TerminalExitEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<TerminalExitEvent>("terminal-exit", ({ payload }) => callback(payload));
}

export async function listWorkspaceFiles(path: string): Promise<FileEntry[]> {
  if (!isTauri()) return PREVIEW_FILES;
  return invoke<FileEntry[]>("list_workspace_files", { root: path });
}

export async function getGitChanges(path: string): Promise<GitChange[]> {
  if (!isTauri()) return PREVIEW_CHANGES;
  return invoke<GitChange[]>("git_changes", { root: path });
}

export async function getGitDiff(root: string, path: string): Promise<string> {
  if (!isTauri()) {
    return `@@ -12,6 +12,8 @@\n export function createSession() {\n+  // First-class adapters share one lifecycle contract.\n+  return launchAgent(\"${path}\");\n }`;
  }
  return invoke<string>("git_diff", { root, path });
}

const PREVIEW_FILES: FileEntry[] = [
  { name: "src", relativePath: "src", isDirectory: true, depth: 0 },
  { name: "agents", relativePath: "src/agents", isDirectory: true, depth: 1 },
  { name: "registry.ts", relativePath: "src/agents/registry.ts", isDirectory: false, depth: 2 },
  { name: "App.tsx", relativePath: "src/App.tsx", isDirectory: false, depth: 1 },
  { name: "src-tauri", relativePath: "src-tauri", isDirectory: true, depth: 0 },
  { name: "lib.rs", relativePath: "src-tauri/src/lib.rs", isDirectory: false, depth: 1 },
  { name: "README.md", relativePath: "README.md", isDirectory: false, depth: 0 },
];

const PREVIEW_CHANGES: GitChange[] = [
  { path: "src/agents/registry.ts", indexStatus: " ", worktreeStatus: "M" },
  { path: "src/App.tsx", indexStatus: " ", worktreeStatus: "M" },
  { path: "src-tauri/src/lib.rs", indexStatus: "?", worktreeStatus: "?" },
];
