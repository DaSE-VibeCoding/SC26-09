import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  isTauri,
  resizeTerminal,
  writeTerminal,
} from "../services/native";
import { useTerminalBuffer } from "../services/terminalBuffer";

interface TerminalViewProps {
  sessionId: string;
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
        background: "#061225",
        foreground: "#dce9f8",
        cursor: "#28d1d7",
        selectionBackground: "#2e6f9366",
        black: "#071326",
        brightBlack: "#617b96",
        red: "#ef817d",
        brightRed: "#ff9c96",
        green: "#62d4b3",
        brightGreen: "#83e7c9",
        yellow: "#e8bd6b",
        brightYellow: "#ffd184",
        blue: "#6f9fe1",
        brightBlue: "#8ab8f2",
        magenta: "#b99ae7",
        brightMagenta: "#cfb1f5",
        cyan: "#31cbd1",
        brightCyan: "#5ce0e3",
        white: "#dce9f8",
        brightWhite: "#f6f9ff",
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
      terminal.writeln("\x1b[1;36mPelican preview\x1b[0m");
      terminal.writeln("Native agent sessions start inside the Tauri app.");
      terminal.writeln("");
      terminal.write("\x1b[38;5;243m~/pelican\x1b[0m  ");
    }

    const inputDisposable = terminal.onData((data) => {
      if (!interactiveRef.current) return;
      void writeTerminal(sessionId, data)
        .then(() => onInputRef.current(sessionId, data))
        .catch((reason: unknown) => {
          onErrorRef.current(errorMessage(reason));
        });
    });

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (interactiveRef.current) {
        void resizeTerminal(sessionId, terminal.rows, terminal.cols).catch(() => undefined);
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
  }, [sessionId]);

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
      void resizeTerminal(sessionId, terminal.rows, terminal.cols).catch(() => undefined);
    });
  }, [interactive, sessionId]);

  useEffect(() => {
    if (visible) {
      queueMicrotask(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        fitRef.current?.fit();
        if (interactiveRef.current) {
          void resizeTerminal(sessionId, terminal.rows, terminal.cols).catch(() => undefined);
        }
        terminal.focus();
      });
    }
  }, [sessionId, visible]);

  return (
    <div
      ref={hostRef}
      className={`terminal-host ${visible ? "is-visible" : ""}`}
      aria-hidden={!visible}
      inert={visible ? undefined : true}
    />
  );
}
