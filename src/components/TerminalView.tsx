import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  isTauri,
  resizeSession,
  sendSession,
} from "../services/native";
import { SESSION_HOST_PROTOCOL_VERSION } from "../domain/sessionHost";
import { useTerminalBuffer } from "../services/terminalBuffer";

interface TerminalViewProps {
  sessionId: string;
  streamId: string;
  visible: boolean;
  interactive: boolean;
  onInput(sessionId: string, data: string): void;
  onError(message: string): void;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function TerminalView({
  sessionId,
  streamId,
  visible,
  interactive,
  onInput,
  onError,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const output = useTerminalBuffer(sessionId);
  const renderedOffsetRef = useRef(output.start);
  const needsReplayRef = useRef(true);
  const interactiveRef = useRef(interactive);
  const onErrorRef = useRef(onError);
  const onInputRef = useRef(onInput);

  interactiveRef.current = interactive;
  onErrorRef.current = onError;
  onInputRef.current = onInput;

  useEffect(() => {
    if (!hostRef.current) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "bar",
      disableStdin: !interactiveRef.current,
      fontFamily: "'SFMono-Regular', 'SF Mono', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 8_000,
      theme: {
        background: "#ffffff",
        foreground: "#2c2c2c",
        cursor: "#202020",
        selectionBackground: "#cfcfca99",
        black: "#202020",
        brightBlack: "#666666",
        red: "#a93232",
        brightRed: "#d04444",
        green: "#23734f",
        brightGreen: "#2d9164",
        yellow: "#8a6200",
        brightYellow: "#aa7900",
        blue: "#385b8f",
        brightBlue: "#4b72ad",
        magenta: "#76518f",
        brightMagenta: "#9166ac",
        cyan: "#2c6d72",
        brightCyan: "#398890",
        white: "#e9e9e6",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    fitRef.current = fit;
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    renderedOffsetRef.current = output.start;
    needsReplayRef.current = true;

    if (!isTauri()) {
      terminal.writeln("\x1b[1mPelican preview\x1b[0m");
      terminal.writeln("Native agent sessions start inside the Tauri app.");
      terminal.writeln("");
      terminal.write("\x1b[38;5;243m~/pelican\x1b[0m  ");
    }

    const inputDisposable = terminal.onData((data) => {
      if (!interactiveRef.current) return;
      void sendSession({ protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId, streamId, input: { type: "terminal", data } })
        .then(() => onInputRef.current(sessionId, data))
        .catch((reason: unknown) => {
          onErrorRef.current(errorMessage(reason));
        });
    });

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (interactiveRef.current) {
        void resizeSession({ protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId, streamId, rows: terminal.rows, cols: terminal.cols }).catch(() => undefined);
      }
    });
    resizeObserver.observe(hostRef.current);
    queueMicrotask(() => fit.fit());

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, streamId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !isTauri()) return;

    const renderedOffset = renderedOffsetRef.current;
    if (needsReplayRef.current || renderedOffset < output.start || renderedOffset > output.end) {
      terminal.reset();
      if (output.start > 0) {
        terminal.writeln("\x1b[38;5;243m… earlier output omitted …\x1b[0m");
      }
      terminal.write(output.text);
      needsReplayRef.current = false;
    } else {
      terminal.write(output.text.slice(renderedOffset - output.start));
    }
    renderedOffsetRef.current = output.end;
  }, [output]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = !interactive;
    if (!interactive) {
      terminal.blur();
      return;
    }
    queueMicrotask(() => {
      fitRef.current?.fit();
      void resizeSession({ protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId, streamId, rows: terminal.rows, cols: terminal.cols }).catch(() => undefined);
    });
  }, [interactive, sessionId, streamId]);

  useEffect(() => {
    if (visible) {
      queueMicrotask(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        fitRef.current?.fit();
        if (interactiveRef.current) {
          void resizeSession({ protocolVersion: SESSION_HOST_PROTOCOL_VERSION, sessionId, streamId, rows: terminal.rows, cols: terminal.cols }).catch(() => undefined);
        }
        terminal.focus();
      });
    }
  }, [sessionId, streamId, visible]);

  return (
    <div
      ref={hostRef}
      className={`terminal-host ${visible ? "is-visible" : ""}`}
      aria-hidden={!visible}
      inert={visible ? undefined : true}
    />
  );
}
