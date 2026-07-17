import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentRegistry, getAgentAdapter } from "./agents/registry";
import type { FirstClassAgentId } from "./agents/types";
import { AgentLogo } from "./components/AgentLogo";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { Icon } from "./components/Icon";
import { PelicanLogo } from "./components/PelicanLogo";
import { StatusDot } from "./components/StatusDot";
import { TerminalView } from "./components/TerminalView";
import type {
  AgentInstallation,
  AgentSession,
  FileEntry,
  GitChange,
  SessionMode,
  Workspace,
} from "./domain/models";
import type { ActivityEvent, LiveTurnLifecycle } from "./domain/lifecycle";
import {
  applySessionActivityEvent,
  applySessionActivityEvents,
  createLiveTurnLifecycleFromSessionStatus,
  initializeSessionLifecycleForMode,
  reviewSessionLifecycle,
  selectTerminalOutputFallbackAction,
  type LiveSessionInitializationMode,
  PTY_FALLBACK_ATTENTION_KEY,
} from "./domain/sessionLifecycle";
import { reduceSessionStatus, scanTerminalAttention, TURN_IDLE_MS } from "./domain/status";
import {
  chooseWorkspace,
  discoverAgentSessions,
  discoverAgents,
  getGitChanges,
  getGitDiff,
  isTauri,
  listWorkspaceFiles,
  listTerminalSessions,
  onTerminalExit,
  onTerminalOutput,
  spawnTerminal,
  stopTerminal,
  writeTerminal,
} from "./services/native";
import {
  loadSessions,
  loadWorkspaces,
  saveSessions,
  saveWorkspaces,
} from "./services/storage";
import { mergeDiscoveredSessions } from "./services/sessionDiscovery";
import {
  enableNotifications,
  notificationsAreEnabled,
  notify,
} from "./services/notifications";
import { runIfNotInFlight } from "./services/actionLock";
import {
  appendTerminalBuffer,
  clearTerminalBuffer,
  initializeTerminalBuffer,
} from "./services/terminalBuffer";

function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function createId(): string {
  return crypto.randomUUID();
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function statusLabel(status: AgentSession["status"]): string {
  switch (status) {
    case "attention": return "Needs attention";
    case "working": return "Working";
    case "done": return "Done";
    case "idle": return "Idle";
    case "available": return "Available";
    case "offline": return "Offline";
  }
}

function previewState(): { workspaces: Workspace[]; sessions: AgentSession[] } {
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: "preview-workspace",
    name: "pelican",
    path: "~/Projects/pelican",
    createdAt: now,
  };
  return {
    workspaces: [workspace],
    sessions: [
      { id: "preview-codex", workspaceId: workspace.id, agentId: "codex", title: "Build session host", status: "available", createdAt: now, lastActivityAt: now, unread: false, connected: false, running: false, resumeHandle: "preview-codex-thread", origin: "pelican" },
      { id: "preview-claude", workspaceId: workspace.id, agentId: "claude-code", title: "Review agent protocol", status: "available", createdAt: now, lastActivityAt: now, unread: false, connected: false, running: false, externalSessionId: "preview-claude-provider", resumeHandle: "preview-claude-session", origin: "claude-history" },
      { id: "preview-pi", workspaceId: workspace.id, agentId: "pi", title: "Keyboard flow", status: "available", createdAt: now, lastActivityAt: now, unread: false, connected: false, running: false, externalSessionId: "preview-pi-provider", resumeHandle: "preview-pi-session", origin: "pi-history" },
    ],
  };
}

const DIALOG_FOCUSABLE = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const FALLBACK_TURN_STARTED_EVENT = {
  type: "turn-started",
  evidence: "fallback",
} satisfies ActivityEvent;

const FALLBACK_ATTENTION_REQUESTED_EVENT = {
  type: "attention-requested",
  evidence: "fallback",
  key: PTY_FALLBACK_ATTENTION_KEY,
} satisfies ActivityEvent;

const FALLBACK_SUBMISSION_EVENTS = [
  {
    type: "attention-resolved",
    evidence: "fallback",
    key: PTY_FALLBACK_ATTENTION_KEY,
  },
  FALLBACK_TURN_STARTED_EVENT,
] satisfies readonly ActivityEvent[];

const FALLBACK_TURN_COMPLETED_EVENT = {
  type: "turn-completed",
  evidence: "fallback",
} satisfies ActivityEvent;

function useDialogFocus<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open || !ref.current) return;
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE))
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    const initial = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? focusables()[0] ?? dialog;
    queueMicrotask(() => initial.focus());

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const available = focusables();
      if (available.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = available[0];
      const last = available[available.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", trapFocus);
    return () => {
      dialog.removeEventListener("keydown", trapFocus);
      queueMicrotask(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, [open]);

  return ref;
}

export default function App() {
  const preview = useMemo(() => (!isTauri() ? previewState() : null), []);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => preview?.workspaces ?? loadWorkspaces());
  const [sessions, setSessions] = useState<AgentSession[]>(() => (
    (preview?.sessions ?? loadSessions()).filter((session) => (
      workspaces.some((workspace) => workspace.id === session.workspaceId)
    ))
  ));
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(() => workspaces[0]?.id ?? null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => (
    sessions.find((session) => session.workspaceId === workspaces[0]?.id)?.id ?? null
  ));
  const [mode, setMode] = useState<SessionMode>("prompt");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [installations, setInstallations] = useState<AgentInstallation[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [inspectorTab, setInspectorTab] = useState<"changes" | "files">("changes");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [sessionsRefreshing, setSessionsRefreshing] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextRefreshing, setContextRefreshing] = useState(false);
  const [contextErrors, setContextErrors] = useState<{ files?: string; changes?: string }>({});
  const [contextRefreshKey, setContextRefreshKey] = useState(0);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationsLoading, setNotificationsLoading] = useState(() => isTauri());
  const [startingSessionIds, setStartingSessionIds] = useState<Set<string>>(() => new Set());
  const [stoppingSessionIds, setStoppingSessionIds] = useState<Set<string>>(() => new Set());
  const [sendingSessionIds, setSendingSessionIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const workspacesRef = useRef(workspaces);
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);
  const activeWorkspaceRef = useRef<Workspace | null>(null);
  const workspaceSessionsRef = useRef<AgentSession[]>([]);
  const attentionScanRef = useRef<Record<string, string>>({});
  const stoppingSessionIdsRef = useRef(new Set<string>());
  const startingSessionIdsRef = useRef(new Set<string>());
  const sendingSessionIdsRef = useRef(new Set<string>());
  const notificationsEnabledRef = useRef(false);
  const notifiedAttentionRef = useRef(new Set<string>());
  const lastSessionSaveAtRef = useRef(0);
  const exitedSessionIdsRef = useRef(new Set<string>());
  const pendingActivityRef = useRef(new Set<string>());
  const pendingAttentionRef = useRef<Record<string, boolean>>({});
  const engagedSessionIdsRef = useRef(new Set<string>());
  const agentOutputSeenRef = useRef(new Set<string>());
  const turnIdleTimersRef = useRef<Record<string, number>>({});
  const liveTurnLifecycleRef = useRef<Record<string, LiveTurnLifecycle>>({});
  const sessionDiscoveryInFlightRef = useRef(false);
  const createSessionInFlightRef = useRef(false);
  const discoveryErrorRef = useRef<string | null>(null);
  const statusFlushTimerRef = useRef<number | null>(null);
  const loadedWorkspaceIdRef = useRef<string | null>(null);
  const loadedDiffKeyRef = useRef<string | null>(null);
  const agentPickerRef = useDialogFocus<HTMLElement>(agentPickerOpen);
  const settingsRef = useDialogFocus<HTMLElement>(settingsOpen);

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const activeSession = sessions.find((session) => (
    session.id === activeSessionId && session.workspaceId === activeWorkspaceId
  )) ?? null;
  const workspaceSessions = sessions.filter((session) => session.workspaceId === activeWorkspaceId);
  const workspaceHasRunningSessions = workspaceSessions.some((session) => session.running);
  const activeSessionStarting = activeSession ? startingSessionIds.has(activeSession.id) : false;
  const activeSessionStopping = activeSession ? stoppingSessionIds.has(activeSession.id) : false;
  const activeSessionSending = activeSession ? sendingSessionIds.has(activeSession.id) : false;
  const activeSessionCanAttach = Boolean(
    activeSession && !activeSession.connected && activeSession.running && activeSession.attachHandle,
  );
  const activeSessionCanResume = Boolean(
    activeSession && !activeSession.connected && !activeSession.running && activeSession.resumeHandle,
  );
  const overlayOpen = paletteOpen || agentPickerOpen || settingsOpen;
  const prompt = activeSessionId ? drafts[activeSessionId] ?? "" : "";
  workspacesRef.current = workspaces;
  sessionsRef.current = sessions;
  activeWorkspaceRef.current = activeWorkspace;
  workspaceSessionsRef.current = workspaceSessions;
  notificationsEnabledRef.current = notificationsEnabled;
  const setPrompt = useCallback((value: string) => {
    if (!activeSessionId) return;
    setDrafts((current) => ({ ...current, [activeSessionId]: value }));
  }, [activeSessionId]);

  const initializeLiveSession = (
    session: AgentSession,
    mode: LiveSessionInitializationMode,
  ): AgentSession => {
    const applied = initializeSessionLifecycleForMode(
      session,
      mode,
      liveTurnLifecycleRef.current[session.id],
    );
    liveTurnLifecycleRef.current[session.id] = applied.lifecycle;
    return applied.session;
  };

  const applyLiveActivityEvents = (
    session: AgentSession,
    events: readonly ActivityEvent[],
  ): AgentSession => {
    const lifecycle = liveTurnLifecycleRef.current[session.id]
      ?? createLiveTurnLifecycleFromSessionStatus(session.status);
    const applied = applySessionActivityEvents(session, lifecycle, events);
    liveTurnLifecycleRef.current[session.id] = applied.lifecycle;
    return applied.session;
  };

  const applyLiveActivityEvent = (
    session: AgentSession,
    event: ActivityEvent,
  ): AgentSession => {
    const lifecycle = liveTurnLifecycleRef.current[session.id]
      ?? createLiveTurnLifecycleFromSessionStatus(session.status);
    const applied = applySessionActivityEvent(session, lifecycle, event);
    liveTurnLifecycleRef.current[session.id] = applied.lifecycle;
    return applied.session;
  };

  const reviewVisibleSession = (session: AgentSession): AgentSession => {
    const reviewed = reviewSessionLifecycle(session, liveTurnLifecycleRef.current[session.id]);
    if (reviewed.lifecycle) {
      liveTurnLifecycleRef.current[session.id] = reviewed.lifecycle;
    } else {
      delete liveTurnLifecycleRef.current[session.id];
    }
    return reviewed.session;
  };

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (mode === "prompt" && activeSessionId) {
      queueMicrotask(() => promptRef.current?.focus());
    }
  }, [activeSessionId, mode]);

  useEffect(() => {
    if (!isTauri()) return;
    try {
      saveWorkspaces(workspaces);
    } catch (reason) {
      setError(`Could not save workspaces: ${errorMessage(reason)}`);
    }
  }, [workspaces]);

  useEffect(() => {
    if (!isTauri()) return;
    const elapsed = Date.now() - lastSessionSaveAtRef.current;
    const delay = elapsed >= 2_000 ? 0 : Math.min(400, 2_000 - elapsed);
    const timer = window.setTimeout(() => {
      try {
        saveSessions(sessions);
        lastSessionSaveAtRef.current = Date.now();
      } catch (reason) {
        setError(`Could not save sessions: ${errorMessage(reason)}`);
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [sessions]);

  useEffect(() => {
    if (!isTauri()) return;
    const flushSessions = () => {
      try {
        saveSessions(sessionsRef.current);
        lastSessionSaveAtRef.current = Date.now();
      } catch {
        // The normal persistence effect surfaces storage errors while mounted.
      }
    };
    window.addEventListener("pagehide", flushSessions);
    return () => {
      window.removeEventListener("pagehide", flushSessions);
      flushSessions();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void discoverAgents()
      .then((nextInstallations) => {
        if (!cancelled) setInstallations(nextInstallations);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false);
      });
    // Rejoin Pelican-owned PTYs that survived a webview reload (Rust host still live).
    void listTerminalSessions()
      .then((liveIds) => {
        if (cancelled || liveIds.length === 0) return;
        const live = new Set(liveIds);
        liveIds.forEach((sessionId) => initializeTerminalBuffer(sessionId));
        setSessions((current) => current.map((session) => (
          live.has(session.id)
            ? initializeLiveSession(
                {
                  ...session,
                  connected: true,
                  running: true,
                },
                liveTurnLifecycleRef.current[session.id] ? "reuse-existing" : "seed-from-status",
              )
            : session
        )));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const refreshDiscoveredSessions = useCallback(async (surfaceError = true) => {
    if (!isTauri() || workspaces.length === 0 || sessionDiscoveryInFlightRef.current) return;
    sessionDiscoveryInFlightRef.current = true;
    setSessionsRefreshing(true);
    try {
      const [discovered, liveIds] = await Promise.all([
        discoverAgentSessions(workspaces.map((workspace) => workspace.path)),
        listTerminalSessions().catch(() => [] as string[]),
      ]);
      setSessions((current) => {
        const live = new Set(liveIds);
        if (live.size > 0) {
          liveIds.forEach((sessionId) => initializeTerminalBuffer(sessionId));
        }
        const reconnected = live.size === 0
          ? current
          : current.map((session) => (
            live.has(session.id)
              ? initializeLiveSession(
                  {
                    ...session,
                    connected: true,
                    running: true,
                  },
                  liveTurnLifecycleRef.current[session.id] ? "reuse-existing" : "seed-from-status",
                )
              : session
          ));
        const merged = mergeDiscoveredSessions(
          reconnected,
          discovered,
          workspaces,
          createId,
        );
        const mergedIds = new Set(merged.map((session) => session.id));
        for (const session of current) {
          if (!mergedIds.has(session.id)) {
            delete liveTurnLifecycleRef.current[session.id];
            if (session.connected && !live.has(session.id)) {
              void stopTerminal(session.id).catch(() => undefined);
              clearTerminalBuffer(session.id);
            }
          }
        }
        return merged;
      });
      discoveryErrorRef.current = null;
    } catch (reason) {
      const message = errorMessage(reason);
      if (surfaceError && discoveryErrorRef.current !== message) {
        setError(`Could not refresh agent sessions: ${message}`);
      }
      discoveryErrorRef.current = message;
    } finally {
      sessionDiscoveryInFlightRef.current = false;
      setSessionsRefreshing(false);
    }
  }, [workspaces]);

  useEffect(() => {
    if (!isTauri() || workspaces.length === 0) return;
    void refreshDiscoveredSessions(true);
    const timer = window.setInterval(() => {
      void refreshDiscoveredSessions(false);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshDiscoveredSessions, workspaces.length]);

  useEffect(() => {
    if (!activeWorkspaceId || activeSessionId) return;
    const firstSession = sessions.find((session) => session.workspaceId === activeWorkspaceId);
    if (firstSession) setActiveSessionId(firstSession.id);
  }, [activeSessionId, activeWorkspaceId, sessions]);

  useEffect(() => {
    let cancelled = false;
    void notificationsAreEnabled()
      .then((enabled) => {
        if (!cancelled) setNotificationsEnabled(enabled);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setNotificationsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!activeWorkspace) {
      loadedWorkspaceIdRef.current = null;
      setFiles([]);
      setChanges([]);
      setSelectedChange(null);
      setContextLoading(false);
      setContextRefreshing(false);
      setContextErrors({});
      return () => { cancelled = true; };
    }
    const workspaceChanged = loadedWorkspaceIdRef.current !== activeWorkspace.id;
    loadedWorkspaceIdRef.current = activeWorkspace.id;
    if (workspaceChanged) {
      setContextLoading(true);
      setFiles([]);
      setChanges([]);
      setSelectedChange(null);
    }
    setContextErrors({});
    setContextRefreshing(true);
    void Promise.allSettled([
      listWorkspaceFiles(activeWorkspace.path),
      getGitChanges(activeWorkspace.path),
    ]).then(([filesResult, changesResult]) => {
      if (cancelled) return;
      const nextErrors: { files?: string; changes?: string } = {};
      if (filesResult.status === "fulfilled") {
        setFiles(filesResult.value);
      } else {
        nextErrors.files = errorMessage(filesResult.reason);
      }
      if (changesResult.status === "fulfilled") {
        setChanges(changesResult.value);
        setSelectedChange((current) => (
          current && changesResult.value.some((change) => change.path === current)
            ? current
            : changesResult.value[0]?.path ?? null
        ));
      } else {
        nextErrors.changes = errorMessage(changesResult.reason);
      }
      setContextErrors(nextErrors);
      const failures = Object.values(nextErrors);
      if (failures.length > 0) {
        setError(`Could not refresh workspace context: ${failures.join(" · ")}`);
      }
    }).finally(() => {
      if (!cancelled) {
        setContextLoading(false);
        setContextRefreshing(false);
      }
    });
    return () => { cancelled = true; };
  }, [activeWorkspace, contextRefreshKey]);

  useEffect(() => {
    if (!activeWorkspace || !workspaceHasRunningSessions || contextRefreshing) return;
    const timer = window.setTimeout(() => {
      setContextRefreshKey((current) => current + 1);
    }, 4_000);
    return () => window.clearTimeout(timer);
  }, [activeWorkspace, contextRefreshing, workspaceHasRunningSessions]);

  useEffect(() => {
    let cancelled = false;
    if (!activeWorkspace || !selectedChange) {
      loadedDiffKeyRef.current = null;
      setDiff("");
      return () => { cancelled = true; };
    }
    const diffKey = `${activeWorkspace.id}:${selectedChange}`;
    if (loadedDiffKeyRef.current !== diffKey) setDiff("");
    loadedDiffKeyRef.current = diffKey;
    void getGitDiff(activeWorkspace.path, selectedChange)
      .then((nextDiff) => {
        if (!cancelled) setDiff(nextDiff);
      })
      .catch(() => {
        if (!cancelled) setDiff("Diff unavailable for this file.");
      });
    return () => { cancelled = true; };
  }, [activeWorkspace, contextRefreshKey, selectedChange]);

  useEffect(() => {
    let cancelled = false;
    const disposers: Array<() => void> = [];
    void Promise.all([
      onTerminalOutput((event) => {
        appendTerminalBuffer(event.sessionId, event.data);
        const attentionScan = scanTerminalAttention(attentionScanRef.current[event.sessionId] ?? "", event.data);
        const needsAttention = attentionScan.needsAttention;
        attentionScanRef.current[event.sessionId] = attentionScan.tail;
        pendingActivityRef.current.add(event.sessionId);
        pendingAttentionRef.current[event.sessionId] = pendingAttentionRef.current[event.sessionId] || needsAttention;

        if (engagedSessionIdsRef.current.has(event.sessionId) && event.data.trim().length > 0) {
          agentOutputSeenRef.current.add(event.sessionId);
          const previousTimer = turnIdleTimersRef.current[event.sessionId];
          if (previousTimer !== undefined) window.clearTimeout(previousTimer);
          turnIdleTimersRef.current[event.sessionId] = window.setTimeout(() => {
            delete turnIdleTimersRef.current[event.sessionId];
            if (!engagedSessionIdsRef.current.has(event.sessionId)) return;
            if (!agentOutputSeenRef.current.has(event.sessionId)) return;
            if (exitedSessionIdsRef.current.has(event.sessionId)) return;
            engagedSessionIdsRef.current.delete(event.sessionId);
            agentOutputSeenRef.current.delete(event.sessionId);
            setSessions((current) => current.map((session) => session.id === event.sessionId
              ? {
                  ...applyLiveActivityEvent(session, FALLBACK_TURN_COMPLETED_EVENT),
                  unread: session.id !== activeSessionIdRef.current,
                  lastActivityAt: new Date().toISOString(),
                }
              : session));
          }, TURN_IDLE_MS);
        }

        const shouldNotify = activeSessionIdRef.current !== event.sessionId
          || document.visibilityState !== "visible"
          || !document.hasFocus();
        if (
          needsAttention
          && shouldNotify
          && notificationsEnabledRef.current
          && !notifiedAttentionRef.current.has(event.sessionId)
        ) {
          const session = sessionsRef.current.find((candidate) => candidate.id === event.sessionId);
          if (session) {
            notifiedAttentionRef.current.add(event.sessionId);
            const agentName = getAgentAdapter(session.agentId).displayName;
            void notify(`${agentName} needs your attention`, session.title).catch(() => undefined);
          }
        }

        if (statusFlushTimerRef.current === null) {
          statusFlushTimerRef.current = window.setTimeout(() => {
            const pendingActivity = pendingActivityRef.current;
            const pendingAttention = pendingAttentionRef.current;
            pendingActivityRef.current = new Set();
            pendingAttentionRef.current = {};
            statusFlushTimerRef.current = null;
            setSessions((current) => current.map((session) => {
              if (!pendingActivity.has(session.id) || exitedSessionIdsRef.current.has(session.id)) return session;
              const requestedAttention = pendingAttention[session.id] ?? false;
              const lifecycle = liveTurnLifecycleRef.current[session.id]
                ?? createLiveTurnLifecycleFromSessionStatus(session.status);
              const fallbackAction = selectTerminalOutputFallbackAction(lifecycle, {
                currentStatus: session.status,
                requestedAttention,
                hasStartedWork: engagedSessionIdsRef.current.has(session.id),
              });
              const lifecycleSession = fallbackAction === "request-attention"
                ? applyLiveActivityEvent(session, FALLBACK_ATTENTION_REQUESTED_EVENT)
                : fallbackAction === "start-turn"
                  ? applyLiveActivityEvent(session, FALLBACK_TURN_STARTED_EVENT)
                  : session;
              return {
                ...lifecycleSession,
                lastActivityAt: new Date().toISOString(),
                unread: fallbackAction === "request-attention"
                  ? true
                  : fallbackAction === "start-turn"
                    ? session.id !== activeSessionIdRef.current
                    : session.unread,
              };
            }));
          }, 160);
        }
      }),
      onTerminalExit((event) => {
        exitedSessionIdsRef.current.add(event.sessionId);
        engagedSessionIdsRef.current.delete(event.sessionId);
        agentOutputSeenRef.current.delete(event.sessionId);
        const idleTimer = turnIdleTimersRef.current[event.sessionId];
        if (idleTimer !== undefined) {
          window.clearTimeout(idleTimer);
          delete turnIdleTimersRef.current[event.sessionId];
        }
        const intentionallyStopped = stoppingSessionIdsRef.current.delete(event.sessionId);
        const endedSession = sessionsRef.current.find((session) => session.id === event.sessionId);
        notifiedAttentionRef.current.delete(event.sessionId);
        delete liveTurnLifecycleRef.current[event.sessionId];
        setStoppingSessionIds((current) => {
          if (!current.has(event.sessionId)) return current;
          const next = new Set(current);
          next.delete(event.sessionId);
          return next;
        });
        setSessions((current) => current.map((session) => session.id === event.sessionId
          ? {
              ...session,
              status: intentionallyStopped
                ? session.resumeHandle ? "available" : reduceSessionStatus(session.status, { type: "disconnected" })
                : reduceSessionStatus(session.status, { type: "process-exited", success: event.success }),
              connected: false,
              running: false,
              unread: intentionallyStopped
                ? false
                : session.id !== activeSessionIdRef.current
                  || document.visibilityState !== "visible"
                  || !document.hasFocus(),
              lastActivityAt: new Date().toISOString(),
            }
          : session));
        if (
          !intentionallyStopped
          && endedSession
          && notificationsEnabledRef.current
          && (activeSessionIdRef.current !== event.sessionId || !document.hasFocus())
        ) {
          const agentName = getAgentAdapter(endedSession.agentId).displayName;
          const outcome = event.success ? "finished" : "exited with an error";
          void notify(`${agentName} ${outcome}`, endedSession.title).catch(() => undefined);
        }
      }),
    ]).then((nextDisposers) => {
      if (cancelled) {
        nextDisposers.forEach((dispose) => dispose());
      } else {
        disposers.push(...nextDisposers);
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(`Could not monitor terminal sessions: ${errorMessage(reason)}`);
    });
    return () => {
      cancelled = true;
      disposers.forEach((dispose) => dispose());
      if (statusFlushTimerRef.current !== null) {
        window.clearTimeout(statusFlushTimerRef.current);
        statusFlushTimerRef.current = null;
      }
    };
  }, []);

  const addWorkspace = useCallback(async () => {
    try {
      const path = await chooseWorkspace();
      if (!path) return;
      const existing = workspacesRef.current.find((workspace) => workspace.path === path);
      if (existing) {
        const firstSession = sessionsRef.current.find((session) => session.workspaceId === existing.id);
        setActiveWorkspaceId(existing.id);
        setActiveSessionId(firstSession?.id ?? null);
        if (firstSession) {
          setSessions((current) => current.map((session) => session.id === firstSession.id
            ? reviewVisibleSession(session)
            : session));
        }
        return;
      }
      const workspace: Workspace = {
        id: createId(),
        name: basename(path),
        path,
        createdAt: new Date().toISOString(),
      };
      setWorkspaces((current) => [...current, workspace]);
      setActiveWorkspaceId(workspace.id);
      setActiveSessionId(null);
    } catch (reason) {
      setError(`Could not add workspace: ${errorMessage(reason)}`);
    }
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    setActiveWorkspaceId(session.workspaceId);
    setActiveSessionId(sessionId);
    setSessions((current) => current.map((candidate) => candidate.id === sessionId
      ? reviewVisibleSession(candidate)
      : candidate));
  }, []);

  const createSession = useCallback(async (agentId: FirstClassAgentId) => {
    await runIfNotInFlight(createSessionInFlightRef, async () => {
      if (!activeWorkspace) {
        setAgentPickerOpen(false);
        setError("Add a workspace before starting an agent session.");
        return;
      }
      const adapter = getAgentAdapter(agentId);
      const installation = installations.find((candidate) => candidate.agentId === agentId);
      if (!installation?.installed || !installation.executable) {
        setError(`${adapter.displayName} was not found on PATH.`);
        return;
      }

      const id = createId();
      const previousActiveSessionId = activeSessionId;
      const now = new Date().toISOString();
      const session: AgentSession = {
        id,
        workspaceId: activeWorkspace.id,
        agentId,
        title: `New ${adapter.displayName} session`,
        status: "idle",
        createdAt: now,
        lastActivityAt: now,
        unread: false,
        connected: false,
        running: false,
        externalSessionId: agentId === "claude-code" || agentId === "pi" ? id : undefined,
        resumeHandle: agentId === "claude-code" ? id : undefined,
        origin: "pelican",
      };
      const launch = adapter.buildLaunchSpec(installation.executable, {
        cwd: activeWorkspace.path,
        sessionId: id,
        title: session.title,
      });

      setSessions((current) => [...current, session]);
      initializeTerminalBuffer(id);
      startingSessionIdsRef.current.add(id);
      setStartingSessionIds((current) => new Set(current).add(id));
      setActiveSessionId(id);
      setAgentPickerOpen(false);
      setMode("prompt");

      try {
        await spawnTerminal({
          sessionId: id,
          cwd: activeWorkspace.path,
          program: launch.program,
          args: launch.args,
          env: launch.env,
          rows: 30,
          cols: 110,
        });
        setSessions((current) => current.map((candidate) => candidate.id === id && !exitedSessionIdsRef.current.has(id)
          ? initializeLiveSession({ ...candidate, connected: true, running: true }, "reuse-existing")
          : candidate));
        queueMicrotask(() => promptRef.current?.focus());
      } catch (reason) {
        setSessions((current) => current.filter((candidate) => candidate.id !== id));
        clearTerminalBuffer(id);
        delete liveTurnLifecycleRef.current[id];
        setActiveSessionId((current) => current === id ? previousActiveSessionId : current);
        setError(`Could not start ${adapter.displayName}: ${errorMessage(reason)}`);
      } finally {
        startingSessionIdsRef.current.delete(id);
        setStartingSessionIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    });
  }, [activeSessionId, activeWorkspace, installations]);

  const connectSession = useCallback(async (target: AgentSession) => {
    if (target.connected || startingSessionIdsRef.current.has(target.id)) return;
    const workspace = workspacesRef.current.find((candidate) => candidate.id === target.workspaceId);
    if (!workspace) {
      setError("The workspace for this session is no longer available.");
      return;
    }
    const adapter = getAgentAdapter(target.agentId);
    const installation = installations.find((candidate) => candidate.agentId === target.agentId);
    if (!installation?.installed || !installation.executable) {
      setError(`${adapter.displayName} was not found on PATH.`);
      return;
    }
    const attachSessionId = target.running ? target.attachHandle : undefined;
    const resumeSessionId = !target.running ? target.resumeHandle : undefined;
    if (!attachSessionId && !resumeSessionId) {
      setError(target.running
        ? "This session is running in another terminal and does not support live attachment."
        : "This session does not have a provider resume handle yet.");
      return;
    }

    const launch = adapter.buildLaunchSpec(installation.executable, {
      cwd: workspace.path,
      sessionId: target.id,
      title: target.title,
      resumeSessionId,
      attachSessionId,
    });
    const previous = target;
    exitedSessionIdsRef.current.delete(target.id);
    initializeTerminalBuffer(target.id);
    startingSessionIdsRef.current.add(target.id);
    setStartingSessionIds((current) => new Set(current).add(target.id));
    setActiveWorkspaceId(workspace.id);
    setActiveSessionId(target.id);
    setMode("terminal");

    try {
      await spawnTerminal({
        sessionId: target.id,
        cwd: workspace.path,
        program: launch.program,
        args: launch.args,
        env: launch.env,
        rows: 30,
        cols: 110,
      });
      setSessions((current) => current.map((session) => session.id === target.id
        ? initializeLiveSession(
            {
              ...session,
              connected: true,
              running: true,
              unread: false,
            },
            attachSessionId ? "seed-from-status" : "fresh",
          )
        : session));
    } catch (reason) {
      const message = errorMessage(reason);
      // Webview reload leaves the Rust PTY alive; treat "already exists" as reconnect.
      if (/already exists/i.test(message)) {
        initializeTerminalBuffer(target.id);
        setSessions((current) => current.map((session) => session.id === target.id
          ? initializeLiveSession(
              {
                ...session,
                connected: true,
                running: true,
                unread: false,
              },
              "seed-from-status",
            )
          : session));
      } else {
        delete liveTurnLifecycleRef.current[target.id];
        setSessions((current) => current.map((session) => session.id === target.id
          ? previous
          : session));
        setError(`Could not ${attachSessionId ? "attach to" : "resume"} ${adapter.displayName}: ${message}`);
      }
    } finally {
      startingSessionIdsRef.current.delete(target.id);
      setStartingSessionIds((current) => {
        const next = new Set(current);
        next.delete(target.id);
        return next;
      });
    }
  }, [installations]);

  const sendPrompt = useCallback(async () => {
    if (!activeSession || !prompt.trim()) return;
    const sessionId = activeSession.id;
    if (sendingSessionIdsRef.current.has(sessionId)) return;
    if (stoppingSessionIdsRef.current.has(sessionId)) return;
    if (!activeSession.connected) {
      setError("Connect or resume this session before sending a prompt.");
      return;
    }

    // Trim so a trailing Enter in the composer does not force bracketed-paste
    // mode, which leaves Codex waiting for a manual terminal Enter to submit.
    const submittedPrompt = prompt.trim();
    const multiline = submittedPrompt.includes("\n");
    const data = multiline
      ? `\x1b[200~${submittedPrompt}\x1b[201~\r`
      : `${submittedPrompt}\r`;
    sendingSessionIdsRef.current.add(sessionId);
    setSendingSessionIds((current) => new Set(current).add(sessionId));
    setDrafts((current) => current[sessionId] === prompt
      ? { ...current, [sessionId]: "" }
      : current);
    try {
      if (activeSession.agentId === "codex") {
        // Write the line and the Enter separately. A single bulk `text\r` often
        // lands in Codex's composer without submitting until a later Enter.
        await writeTerminal(
          sessionId,
          multiline ? `\x1b[200~${submittedPrompt}\x1b[201~` : submittedPrompt,
        );
        await writeTerminal(sessionId, "\r");
      } else {
        await writeTerminal(sessionId, data);
      }
      engagedSessionIdsRef.current.add(sessionId);
      agentOutputSeenRef.current.delete(sessionId);
      const idleTimer = turnIdleTimersRef.current[sessionId];
      if (idleTimer !== undefined) {
        window.clearTimeout(idleTimer);
        delete turnIdleTimersRef.current[sessionId];
      }
      attentionScanRef.current[sessionId] = "";
      notifiedAttentionRef.current.delete(sessionId);
      pendingActivityRef.current.delete(sessionId);
      delete pendingAttentionRef.current[sessionId];
      setSessions((current) => current.map((session) => (
        session.id === sessionId
        && !exitedSessionIdsRef.current.has(sessionId)
        && !stoppingSessionIdsRef.current.has(sessionId)
      )
        ? {
            ...applyLiveActivityEvents(session, FALLBACK_SUBMISSION_EVENTS),
            unread: false,
            title: session.title.startsWith("New ") ? submittedPrompt.slice(0, 96) : session.title,
          }
        : session));
    } catch (reason) {
      setDrafts((current) => current[sessionId]
        ? current
        : { ...current, [sessionId]: submittedPrompt });
      setError(`Could not send prompt: ${errorMessage(reason)}`);
    } finally {
      sendingSessionIdsRef.current.delete(sessionId);
      setSendingSessionIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }, [activeSession, mode, prompt]);

  const stopSession = useCallback(async () => {
    if (!activeSession?.connected || stoppingSessionIdsRef.current.has(activeSession.id)) return;
    stoppingSessionIdsRef.current.add(activeSession.id);
    setStoppingSessionIds((current) => new Set(current).add(activeSession.id));
    try {
      await stopTerminal(activeSession.id);
      delete liveTurnLifecycleRef.current[activeSession.id];
      setSessions((current) => current.map((session) => session.id === activeSession.id
        ? {
            ...session,
            connected: false,
            running: false,
            status: session.resumeHandle ? "available" : "offline",
            unread: false,
          }
        : session));
    } catch (reason) {
      stoppingSessionIdsRef.current.delete(activeSession.id);
      setStoppingSessionIds((current) => {
        const next = new Set(current);
        next.delete(activeSession.id);
        return next;
      });
      setError(`Could not stop session: ${errorMessage(reason)}`);
    }
  }, [activeSession]);

  const removeSession = useCallback((sessionId: string) => {
    const target = sessionsRef.current.find((session) => session.id === sessionId);
    if (!target || target.connected) {
      setError("Disconnect the session before removing it from Pelican.");
      return;
    }
    const nextSession = sessionsRef.current.find((session) => (
      session.workspaceId === target.workspaceId && session.id !== sessionId
    ));
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setDrafts((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    clearTerminalBuffer(sessionId);
    notifiedAttentionRef.current.delete(sessionId);
    delete liveTurnLifecycleRef.current[sessionId];
    setActiveSessionId((current) => current === sessionId ? nextSession?.id ?? null : current);
  }, []);

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    if (stoppingSessionIdsRef.current.has(sessionId) || exitedSessionIdsRef.current.has(sessionId)) return;
    const isResponse = data.includes("\r") || data.includes("\n");
    if (!isResponse) return;
    engagedSessionIdsRef.current.add(sessionId);
    agentOutputSeenRef.current.delete(sessionId);
    const idleTimer = turnIdleTimersRef.current[sessionId];
    if (idleTimer !== undefined) {
      window.clearTimeout(idleTimer);
      delete turnIdleTimersRef.current[sessionId];
    }
    attentionScanRef.current[sessionId] = "";
    notifiedAttentionRef.current.delete(sessionId);
    pendingActivityRef.current.delete(sessionId);
    delete pendingAttentionRef.current[sessionId];
    setSessions((current) => current.map((session) => session.id === sessionId
      ? {
          ...applyLiveActivityEvents(session, FALLBACK_SUBMISSION_EVENTS),
          unread: false,
          lastActivityAt: new Date().toISOString(),
        }
      : session));
  }, []);

  const requestNotifications = useCallback(async () => {
    setNotificationsLoading(true);
    try {
      const enabled = await enableNotifications();
      setNotificationsEnabled(enabled);
      if (!enabled) setError("Notifications were not enabled. You can allow Pelican in System Settings.");
    } catch (reason) {
      setError(`Could not enable notifications: ${errorMessage(reason)}`);
    } finally {
      setNotificationsLoading(false);
    }
  }, []);

  const openAgentPicker = useCallback(() => {
    if (!activeWorkspaceRef.current) {
      setError("Add a workspace before starting an agent session.");
      return;
    }
    if (createSessionInFlightRef.current) {
      setError("Wait for the current session to finish launching.");
      return;
    }
    setAgentPickerOpen(true);
  }, []);

  const hasActiveWorkspace = activeWorkspace !== null;
  const hasActiveSession = activeSession !== null;
  const actions = useMemo<PaletteAction[]>(() => [
    { id: "add-workspace", icon: "folder", label: "Add workspace", detail: "Open a local project", shortcut: "⇧⌘O", run: () => { void addWorkspace(); } },
    { id: "new-session", icon: "plus", label: "New agent session", detail: hasActiveWorkspace ? "Codex, Claude Code, or Pi" : "Add a workspace first", shortcut: "⇧⌘N", disabled: !hasActiveWorkspace, run: openAgentPicker },
    { id: "refresh-sessions", icon: "refresh", label: "Refresh agent sessions", detail: "Discover saved and running CLI sessions", disabled: !hasActiveWorkspace || sessionsRefreshing, run: () => { void refreshDiscoveredSessions(true); } },
    { id: "toggle-mode", icon: "terminal", label: `Switch to ${mode === "prompt" ? "terminal" : "prompt"}`, shortcut: "⌃`", disabled: !hasActiveSession, run: () => setMode((current) => current === "prompt" ? "terminal" : "prompt") },
    { id: "show-changes", icon: "git", label: "Show Git changes", shortcut: "⇧⌘G", run: () => setInspectorTab("changes") },
    { id: "show-files", icon: "files", label: "Show workspace files", shortcut: "⇧⌘E", run: () => setInspectorTab("files") },
    { id: "settings", icon: "settings", label: "Open settings", detail: "Agents and keyboard shortcuts", shortcut: "⌘,", run: () => setSettingsOpen(true) },
  ], [addWorkspace, hasActiveSession, hasActiveWorkspace, mode, openAgentPicker, refreshDiscoveredSessions, sessionsRefreshing]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const claimShortcut = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === "Escape" && overlayOpen) {
        claimShortcut();
        setAgentPickerOpen(false);
        setPaletteOpen(false);
        setSettingsOpen(false);
        return;
      }
      if (overlayOpen) return;
      if (event.metaKey && event.key.toLowerCase() === "k") {
        claimShortcut();
        setPaletteOpen(true);
      } else if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "n") {
        claimShortcut();
        openAgentPicker();
      } else if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "o") {
        claimShortcut();
        void addWorkspace();
      } else if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "g") {
        claimShortcut();
        setInspectorTab("changes");
      } else if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "e") {
        claimShortcut();
        setInspectorTab("files");
      } else if (event.metaKey && event.key === ",") {
        claimShortcut();
        setSettingsOpen(true);
      } else if (event.ctrlKey && event.key === "`") {
        claimShortcut();
        setMode((current) => current === "prompt" ? "terminal" : "prompt");
      } else if (event.metaKey && /^[1-9]$/.test(event.key)) {
        const session = workspaceSessionsRef.current[Number(event.key) - 1];
        if (session) {
          claimShortcut();
          selectSession(session.id);
        }
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [addWorkspace, openAgentPicker, overlayOpen, selectSession]);

  return (
    <main className={`app-shell${isTauri() ? "" : " has-preview-banner"}`}>
      {!isTauri() && (
        <div className="preview-banner" role="status">
          Browser preview only — agent terminals require the Pelican window from <code>npm run tauri dev</code>, not http://localhost:1420 in Chrome.
        </div>
      )}
      <aside className="left-sidebar" inert={overlayOpen ? true : undefined} aria-hidden={overlayOpen ? true : undefined}>
        <div className="brand-row">
          <PelicanLogo className="brand-mark" size={32} />
          <span className="brand-name">Pelican</span>
          <button className="icon-button brand-action" type="button" onClick={() => setPaletteOpen(true)} title="Command palette (⌘K)">
            <Icon name="command" size={16} />
          </button>
        </div>

        <div className="sidebar-label-row">
          <span>Workspaces</span>
          <span className="sidebar-label-actions">
            <button className={`icon-button ${sessionsRefreshing ? "is-loading" : ""}`} type="button" disabled={sessionsRefreshing || workspaces.length === 0} onClick={() => void refreshDiscoveredSessions(true)} title="Refresh agent sessions">
              <Icon name="refresh" size={14} />
            </button>
            <button className="icon-button" type="button" onClick={() => void addWorkspace()} title="Add workspace">
              <Icon name="plus" size={15} />
            </button>
          </span>
        </div>

        <nav className="workspace-list" aria-label="Workspaces and sessions">
          {workspaces.map((workspace) => {
            const childSessions = sessions.filter((session) => session.workspaceId === workspace.id);
            const hasAttention = childSessions.some((session) => session.status === "attention");
            const unreadCount = childSessions.filter((session) => session.unread).length;
            return (
              <section className="workspace-group" key={workspace.id}>
                <button
                  type="button"
                  className={`workspace-row ${workspace.id === activeWorkspaceId ? "is-active" : ""}`}
                  onClick={() => {
                    if (childSessions[0]) {
                      selectSession(childSessions[0].id);
                    } else {
                      setActiveWorkspaceId(workspace.id);
                      setActiveSessionId(null);
                    }
                  }}
                >
                  <span className="workspace-icon"><Icon name="folder" size={16} /></span>
                  <span className="workspace-name">{workspace.name}</span>
                  {(hasAttention || unreadCount > 0) && (
                    <span className={`attention-count ${hasAttention ? "" : "is-update"}`}>{hasAttention ? "!" : unreadCount}</span>
                  )}
                  <Icon name="chevron" size={13} className="workspace-chevron" />
                </button>
                {workspace.id === activeWorkspaceId && (
                  <div className="session-list">
                    {childSessions.map((session, index) => {
                      const adapter = getAgentAdapter(session.agentId);
                      return (
                        <button
                          type="button"
                          key={session.id}
                          className={`session-row ${session.id === activeSessionId ? "is-active" : ""}`}
                          onClick={() => selectSession(session.id)}
                        >
                          <AgentLogo agentId={session.agentId} size={29} />
                          <span className="session-copy">
                            <strong>{session.title}</strong>
                            <small><StatusDot status={session.status} /> {adapter.displayName} · {startingSessionIds.has(session.id) ? "Launching" : statusLabel(session.status)}</small>
                          </span>
                          {index < 9 && <kbd className="session-shortcut">⌘{index + 1}</kbd>}
                          {session.unread && <span className="unread-dot" />}
                        </button>
                      );
                    })}
                    <button type="button" className="new-session-row" onClick={openAgentPicker}>
                      <Icon name="plus" size={14} /> New session
                    </button>
                  </div>
                )}
              </section>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button type="button" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={16} /> Settings</button>
          <span className="local-pill">Local</span>
        </div>
      </aside>

      <section className="center-panel" inert={overlayOpen ? true : undefined} aria-hidden={overlayOpen ? true : undefined}>
        <header className="panel-header">
          <div className="breadcrumb">
            <span>{activeWorkspace?.name ?? "No workspace"}</span>
            {activeSession && <><b>/</b><strong>{activeSession.title}</strong></>}
          </div>
          <div className="header-actions">
            {activeSession && (
              <button
                type="button"
                className="stop-button"
                disabled={!activeSession.connected || activeSessionStarting || activeSessionStopping}
                onClick={() => void stopSession()}
                title={activeSessionStarting ? "Agent is launching" : activeSessionStopping ? "Agent is stopping" : "Stop session"}
              >
                <Icon name="stop" size={13} />
              </button>
            )}
            <button type="button" className="command-trigger" onClick={() => setPaletteOpen(true)}>
              <Icon name="search" size={14} /><span>Commands</span><kbd>⌘K</kbd>
            </button>
          </div>
        </header>

        {!activeWorkspace ? (
          <div className="empty-state">
            <PelicanLogo className="empty-mark" size={72} />
            <h1>Bring your agents into view.</h1>
            <p>Add a local workspace, then launch Codex, Claude Code, or Pi without leaving Pelican.</p>
            <button type="button" className="primary-button" onClick={() => void addWorkspace()}>
              <Icon name="folder" size={16} /> Add workspace
            </button>
          </div>
        ) : !activeSession ? (
          <div className="empty-state">
            <span className="eyebrow">{activeWorkspace.name}</span>
            <h1>Start an agent session.</h1>
            <p>Every session gets a real terminal and a shared lifecycle, regardless of agent.</p>
            <button type="button" className="primary-button" onClick={openAgentPicker}>
              <Icon name="plus" size={16} /> New session
            </button>
          </div>
        ) : (
          <div className="session-surface">
            <div className="session-toolbar">
              <div className="mode-switch" role="group" aria-label="Session input mode">
                <button type="button" aria-pressed={mode === "prompt"} className={mode === "prompt" ? "is-active" : ""} onClick={() => setMode("prompt")}>
                  <Icon name="message" size={14} /> Prompt
                </button>
                <button type="button" aria-pressed={mode === "terminal"} className={mode === "terminal" ? "is-active" : ""} onClick={() => setMode("terminal")}>
                  <Icon name="terminal" size={14} /> Terminal
                </button>
              </div>
              <span className="mode-hint">⌃` to switch</span>
            </div>

            <div className="terminal-frame">
              {activeSession.connected && (
                <TerminalView
                  sessionId={activeSession.id}
                  visible={mode === "terminal"}
                  interactive={mode === "terminal" && !activeSessionStarting && !activeSessionStopping}
                  onInput={handleTerminalInput}
                  onError={(message) => setError(`Terminal input failed: ${message}`)}
                />
              )}
              {mode === "terminal" && !activeSession.connected && (
                <div className="terminal-unavailable">
                  {activeSessionStarting ? (
                    <>
                      <span className="launch-spinner" />
                      <strong>{activeSessionCanAttach ? "Attaching to session" : "Resuming session"}</strong>
                      <p>Preparing the existing {getAgentAdapter(activeSession.agentId).displayName} session in {activeWorkspace.name}…</p>
                    </>
                  ) : (
                    <>
                      <AgentLogo agentId={activeSession.agentId} size={50} />
                      <strong>{activeSession.running ? "Running in another terminal" : activeSession.resumeHandle ? "Saved session" : "No terminal is connected"}</strong>
                      <p>{activeSessionCanAttach
                        ? "Claude exposes this background session for live attachment."
                        : activeSessionCanResume
                          ? "Resume the provider session to open its real TUI here. Avoid resuming the same session in two terminals."
                          : activeSession.running
                            ? "This CLI does not expose a safe attachment point for its current foreground terminal."
                            : "Start a new session or refresh after the CLI has persisted one."}</p>
                      <span className="session-recovery-actions">
                        {(activeSessionCanAttach || activeSessionCanResume) && (
                          <button type="button" onClick={() => void connectSession(activeSession)}>
                            <Icon name="terminal" size={15} /> {activeSessionCanAttach ? "Attach" : "Resume here"}
                          </button>
                        )}
                        <button type="button" className="secondary" disabled={sessionsRefreshing} onClick={() => void refreshDiscoveredSessions(true)}>
                          <Icon name="refresh" size={14} /> {sessionsRefreshing ? "Refreshing…" : "Refresh"}
                        </button>
                      </span>
                    </>
                  )}
                </div>
              )}
              {mode === "prompt" && (
                <div className="prompt-view">
                  <div className="session-identity">
                    <AgentLogo agentId={activeSession.agentId} size={44} />
                    <div>
                      <strong>{getAgentAdapter(activeSession.agentId).displayName}</strong>
                      <span><StatusDot status={activeSession.status} /> {activeSessionStarting ? "Launching agent" : activeSessionStopping ? "Stopping agent" : statusLabel(activeSession.status)}</span>
                    </div>
                  </div>
                  <div className="prompt-spacer">
                    <p>{activeSessionStarting
                      ? "Pelican is preparing the agent process and terminal."
                      : activeSessionStopping
                        ? "Pelican is stopping the agent process."
                      : !activeSession.connected && activeSession.running
                        ? "The agent is running outside Pelican; connect to interact when the provider supports it."
                        : !activeSession.connected && activeSession.resumeHandle
                          ? "This provider session is saved and ready to resume."
                          : !activeSession.connected
                            ? "No interactive terminal is connected for this session."
                        : activeSession.status === "attention"
                          ? "The agent is waiting for your response."
                          : "The full terminal stays active behind this focused command surface."}</p>
                  </div>
                  {activeSessionStarting ? (
                    <div className="session-recovery is-launching">
                      <span className="launch-spinner" />
                      <div><strong>Launching {getAgentAdapter(activeSession.agentId).displayName}</strong><small>Preparing a terminal in {activeWorkspace.name}…</small></div>
                    </div>
                  ) : activeSessionStopping ? (
                    <div className="session-recovery is-launching">
                      <span className="launch-spinner" />
                      <div><strong>Stopping {getAgentAdapter(activeSession.agentId).displayName}</strong><small>Closing the terminal process safely…</small></div>
                    </div>
                  ) : !activeSession.connected ? (
                    <div className="session-recovery">
                      <div>
                        <strong>{activeSession.running
                          ? activeSessionCanAttach ? "Background session found" : "Running in another terminal"
                          : activeSessionCanResume ? "Saved session found" : "This session is offline"}</strong>
                        <small>{activeSessionCanAttach
                          ? "Attach to the existing Claude background job without starting a fresh conversation."
                          : activeSessionCanResume
                            ? "Resume the existing provider history in a Pelican-owned terminal. Do not resume it concurrently elsewhere."
                            : activeSession.running
                              ? "Pelican can monitor its presence, but this foreground CLI has no safe terminal attachment API."
                              : "Start a fresh session or remove this local entry."}</small>
                      </div>
                      <span className="session-recovery-actions">
                        {activeSession.origin === "pelican" && !activeSession.running && (
                          <button type="button" className="secondary" onClick={() => removeSession(activeSession.id)}><Icon name="close" size={14} /> Remove</button>
                        )}
                        {(activeSessionCanAttach || activeSessionCanResume) ? (
                          <button type="button" onClick={() => void connectSession(activeSession)}><Icon name="terminal" size={15} /> {activeSessionCanAttach ? "Attach" : "Resume here"}</button>
                        ) : (
                          <button type="button" disabled={sessionsRefreshing} onClick={() => void refreshDiscoveredSessions(true)}><Icon name="refresh" size={15} /> {sessionsRefreshing ? "Refreshing…" : "Refresh"}</button>
                        )}
                      </span>
                    </div>
                  ) : (
                    <div className="composer">
                      <textarea
                        ref={promptRef}
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && event.metaKey) {
                            event.preventDefault();
                            void sendPrompt();
                          }
                        }}
                        placeholder={activeSession.status === "attention"
                          ? `Reply to ${getAgentAdapter(activeSession.agentId).displayName}…`
                          : `Give ${getAgentAdapter(activeSession.agentId).displayName} a task…`}
                      />
                      <div className="composer-footer">
                        <span>⌘Enter to send · Enter for newline</span>
                        <button type="button" onClick={() => void sendPrompt()} disabled={!prompt.trim() || activeSessionSending}>{activeSessionSending ? "Sending…" : "Send"}</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <aside className="right-sidebar" inert={overlayOpen ? true : undefined} aria-hidden={overlayOpen ? true : undefined}>
        <header className="inspector-tabs" role="group" aria-label="Workspace inspector">
          <button type="button" aria-pressed={inspectorTab === "changes"} className={inspectorTab === "changes" ? "is-active" : ""} onClick={() => setInspectorTab("changes")}>
            <Icon name="git" size={15} /> Changes <span>{changes.length}</span>
          </button>
          <button type="button" aria-pressed={inspectorTab === "files"} className={inspectorTab === "files" ? "is-active" : ""} onClick={() => setInspectorTab("files")}>
            <Icon name="files" size={15} /> Files
          </button>
          <button type="button" className={`inspector-refresh ${contextRefreshing ? "is-loading" : ""}`} disabled={contextRefreshing || !activeWorkspace} onClick={() => setContextRefreshKey((current) => current + 1)} title="Refresh workspace context" aria-label="Refresh workspace context">
            <Icon name="refresh" size={14} />
          </button>
        </header>
        {inspectorTab === "files" ? (
          <div className="file-tree">
            <div className="inspector-heading"><span>Workspace</span><small>{files.length} entries</small></div>
            {contextErrors.files && <p className="inspector-error" title={contextErrors.files}>Workspace files unavailable. Refresh to try again.</p>}
            {files.map((entry) => (
              <div className="file-row" key={entry.relativePath} style={{ paddingLeft: 14 + entry.depth * 14 }} title={entry.relativePath}>
                <Icon name={entry.isDirectory ? "folder" : "file"} size={14} />
                <span>{entry.name}</span>
              </div>
            ))}
            {activeWorkspace && files.length === 0 && !contextErrors.files && <p className="inspector-empty">{contextLoading ? "Loading workspace…" : "No files to show."}</p>}
          </div>
        ) : (
          <div className="changes-panel">
            <div className="inspector-heading"><span>Working tree</span><small>{changes.length} changed</small></div>
            <div className="change-list">
              {contextErrors.changes && <p className="inspector-error" title={contextErrors.changes}>Git status unavailable. Refresh to try again.</p>}
              {changes.map((change) => {
                const status = `${change.indexStatus}${change.worktreeStatus}`;
                const colorStatus = change.worktreeStatus !== " " ? change.worktreeStatus : change.indexStatus;
                return (
                  <button type="button" key={change.path} className={selectedChange === change.path ? "is-active" : ""} onClick={() => setSelectedChange(change.path)}>
                    <span className={`change-code change-${colorStatus === "?" ? "new" : colorStatus.toLowerCase()}`} title={`Index: ${change.indexStatus || " "}, worktree: ${change.worktreeStatus || " "}`}>{status}</span>
                    <span>{change.path}</span>
                  </button>
                );
              })}
              {activeWorkspace && changes.length === 0 && !contextErrors.changes && <p className="inspector-empty">{contextLoading ? "Reading Git status…" : "Working tree clean."}</p>}
            </div>
            {selectedChange && (
              <div className="mini-diff">
                <div className="diff-heading" title={selectedChange}>{basename(selectedChange)}</div>
                <pre>{diff || "No text diff available."}</pre>
              </div>
            )}
          </div>
        )}
      </aside>

      {agentPickerOpen && (
        <div className="picker-backdrop" onMouseDown={() => setAgentPickerOpen(false)}>
          <section ref={agentPickerRef} tabIndex={-1} className="agent-picker" role="dialog" aria-modal="true" aria-labelledby="agent-picker-title" onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="icon-button dialog-close" data-dialog-initial-focus onClick={() => setAgentPickerOpen(false)} aria-label="Close agent picker"><Icon name="close" size={16} /></button>
            <span className="eyebrow">New session</span>
            <h2 id="agent-picker-title">Choose an agent</h2>
            <p>Each first-class agent uses the same terminal and session lifecycle.</p>
            <div className="agent-options">
              {agentRegistry.map((adapter) => {
                const installation = installations.find((candidate) => candidate.agentId === adapter.id);
                const available = installation?.installed ?? false;
                return (
                  <button type="button" key={adapter.id} disabled={agentsLoading || !available} onClick={() => void createSession(adapter.id)}>
                    <AgentLogo agentId={adapter.id} size={42} />
                    <span><strong>{adapter.displayName}</strong><small>{agentsLoading ? "Detecting CLI…" : available ? adapter.description : "CLI not found on PATH"}</small></span>
                    <Icon name="chevron" size={15} />
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="picker-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section ref={settingsRef} tabIndex={-1} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="icon-button dialog-close" data-dialog-initial-focus onClick={() => setSettingsOpen(false)} aria-label="Close settings"><Icon name="close" size={16} /></button>
            <span className="eyebrow">Preferences</span>
            <h2 id="settings-title">Pelican settings</h2>
            <p>Agent availability is detected from your local shell. Pelican keeps credentials and execution inside each CLI.</p>

            <div className="settings-section">
              <div className="settings-section-title"><span>Agents</span><small>{installations.filter((agent) => agent.installed).length} of {agentRegistry.length} available</small></div>
              <div className="settings-agent-list">
                {agentRegistry.map((adapter) => {
                  const installation = installations.find((candidate) => candidate.agentId === adapter.id);
                  const installed = installation?.installed ?? false;
                  return (
                    <div className="settings-agent-row" key={adapter.id}>
                      <AgentLogo agentId={adapter.id} size={34} />
                      <span><strong>{adapter.displayName}</strong><small>{agentsLoading ? "Detecting CLI…" : installation?.executable ?? "Not found on PATH"}</small></span>
                      <span className={`availability-pill ${installed ? "is-available" : ""}`}>{installed ? "Ready" : "Missing"}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title"><span>Notifications</span><small>Native macOS alerts</small></div>
              <div className="settings-preference-row">
                <span className="settings-preference-icon"><Icon name="bell" size={17} /></span>
                <span><strong>Agent updates</strong><small>Get notified when a background agent needs input, finishes, or exits with an error.</small></span>
                {notificationsEnabled ? (
                  <span className="availability-pill is-available">Enabled</span>
                ) : (
                  <button type="button" disabled={notificationsLoading || !isTauri()} onClick={() => void requestNotifications()}>
                    {notificationsLoading ? "Checking…" : isTauri() ? "Enable" : "Desktop only"}
                  </button>
                )}
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title"><span>Keyboard</span><small>Built for speed</small></div>
              <div className="shortcut-grid">
                <span>Command palette</span><kbd>⌘K</kbd>
                <span>New agent session</span><kbd>⇧⌘N</kbd>
                <span>Add workspace</span><kbd>⇧⌘O</kbd>
                <span>Prompt / terminal</span><kbd>⌃`</kbd>
                <span>Git changes / files</span><span><kbd>⇧⌘G</kbd> <kbd>⇧⌘E</kbd></span>
              </div>
            </div>
          </section>
        </div>
      )}

      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <CommandPalette open={paletteOpen} actions={actions} onClose={() => setPaletteOpen(false)} />
    </main>
  );
}
