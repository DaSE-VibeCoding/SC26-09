import { useCallback, useSyncExternalStore } from "react";

const MAX_BUFFER_LENGTH = 500_000;
const NOTIFY_INTERVAL_MS = 32;

export interface TerminalBufferSnapshot {
  text: string;
  /** Absolute stream offset represented by text[0]. */
  start: number;
  /** Absolute stream offset immediately after the final character. */
  end: number;
}

interface TerminalBufferState {
  snapshot: TerminalBufferSnapshot;
  pending: string[];
  pendingLength: number;
  streamEnd: number;
  timer: number | null;
}

type Listener = () => void;

const EMPTY_SNAPSHOT: TerminalBufferSnapshot = { text: "", start: 0, end: 0 };
const buffers = new Map<string, TerminalBufferState>();
const listeners = new Map<string, Set<Listener>>();

function boundedTerminalTail(value: string): string {
  if (value.length <= MAX_BUFFER_LENGTH) return value;
  const desiredStart = value.length - MAX_BUFFER_LENGTH;
  // Replaying from a line boundary avoids feeding xterm the tail half of an
  // ANSI control sequence after a long-running session is compacted.
  const nextLine = value.indexOf("\n", desiredStart);
  return value.slice(nextLine >= 0 ? nextLine + 1 : desiredStart);
}

function stateFor(sessionId: string): TerminalBufferState {
  let state = buffers.get(sessionId);
  if (!state) {
    state = {
      snapshot: EMPTY_SNAPSHOT,
      pending: [],
      pendingLength: 0,
      streamEnd: 0,
      timer: null,
    };
    buffers.set(sessionId, state);
  }
  return state;
}

function flush(sessionId: string): void {
  const state = buffers.get(sessionId);
  if (!state) return;
  state.timer = null;
  if (state.pendingLength === 0) return;

  const combined = `${state.snapshot.text}${state.pending.join("")}`;
  const text = boundedTerminalTail(combined);
  state.pending = [];
  state.pendingLength = 0;
  state.snapshot = {
    text,
    start: state.streamEnd - text.length,
    end: state.streamEnd,
  };
  listeners.get(sessionId)?.forEach((listener) => listener());
}

export function appendTerminalBuffer(sessionId: string, data: string): void {
  if (!data) return;
  const state = stateFor(sessionId);
  state.pending.push(data);
  state.pendingLength += data.length;
  state.streamEnd += data.length;

  // Timers can be throttled while the app is backgrounded. Flush immediately
  // at the cap so queued chunks stay bounded without repeatedly joining a
  // 500k tail on every subsequent PTY read.
  if (state.pendingLength >= MAX_BUFFER_LENGTH) {
    if (state.timer !== null) window.clearTimeout(state.timer);
    flush(sessionId);
    return;
  }

  if (state.timer === null) {
    state.timer = window.setTimeout(() => flush(sessionId), NOTIFY_INTERVAL_MS);
  }
}

export function initializeTerminalBuffer(sessionId: string): void {
  stateFor(sessionId);
}

export function clearTerminalBuffer(sessionId: string): void {
  const state = buffers.get(sessionId);
  if (state?.timer !== null && state?.timer !== undefined) window.clearTimeout(state.timer);
  buffers.delete(sessionId);
  listeners.get(sessionId)?.forEach((listener) => listener());
}

function getTerminalBuffer(sessionId: string): TerminalBufferSnapshot {
  return buffers.get(sessionId)?.snapshot ?? EMPTY_SNAPSHOT;
}

function subscribeTerminalBuffer(sessionId: string, listener: Listener): () => void {
  const sessionListeners = listeners.get(sessionId) ?? new Set<Listener>();
  sessionListeners.add(listener);
  listeners.set(sessionId, sessionListeners);
  return () => {
    sessionListeners.delete(listener);
    if (sessionListeners.size === 0) listeners.delete(sessionId);
  };
}

export function useTerminalBuffer(sessionId: string): TerminalBufferSnapshot {
  const subscribe = useCallback(
    (listener: Listener) => subscribeTerminalBuffer(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(() => getTerminalBuffer(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
