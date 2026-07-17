# Pelican architecture

## Boundaries

Pelican is split into three conceptual layers:

1. **Desktop client** — React and TypeScript. Owns presentation, navigation, shortcuts, unread state, and adapter-neutral workflows.
2. **Pelican Core** — the session host. Owns PTYs, process lifetimes, terminal buffers, and the event stream. The current spike runs this host in-process; the next milestone moves it into a local daemon.
3. **Platform bridge** — Rust commands for PTYs, process discovery, files, Git, notifications, and application lifecycle.

The client must never infer a session's state from component lifecycle. It consumes explicit events from Pelican Core.

## Domain model

- `Workspace` is a local project directory.
- `AgentSession` is a provider conversation associated with a workspace. `running` means the provider reports a live process; `connected` separately means Pelican owns its interactive PTY.
- `AgentAdapter` describes launch, resume, process detection, and status-integration capabilities.
- `SessionStatus` is one of `attention`, `working`, `done`, `idle`, `available`, or `offline`.
- `ActivityEvent` is immutable evidence used to update a session.

## First-class agent adapters

Codex, Claude Code, and Pi have named, tested adapters. Each adapter must eventually provide:

- executable discovery and version probing;
- new-session and resume invocation;
- structured lifecycle integration where the CLI exposes it;
- terminal/process heuristics as a documented fallback;
- fixtures that test attention, working, completion, and failure transitions.

The generic CLI adapter only promises PTY hosting and process-exit state.

### Preferred transports

| Agent | Preferred integration | PTY fallback |
| --- | --- | --- |
| Codex | One `codex app-server` per `CODEX_HOME`; JSON-RPC threads, turns, approvals, and diffs | `codex -C <workspace> --no-alt-screen` |
| Claude Code | Pelican-owned PTY with a per-session settings file and loopback lifecycle hooks | Terminal output and process exit |
| Pi | One `pi --mode rpc` process per Pelican session; newline-delimited JSON commands and events, followed by `set_session_name` | Native Pi TUI in the PTY |

Structured signals are authoritative. PTY text matching is explicitly low-confidence and must never override a structured event. Each adapter is capability- and version-probed at startup so an older CLI degrades to PTY mode instead of failing.

The capability/version probing and authoritative transports in this section are the target architecture. The current runtime imports saved provider sessions, resumes them through the PTY fallback, and only attaches supported Claude background jobs. All three adapters still use heuristic PTY lifecycle state.

Claude-managed `--bg` agents are an optional import mode rather than Pelican's default: current Claude Code may isolate them into `.claude/worktrees/` and perform Git/PR actions. Pelican-owned PTYs preserve the selected checkout and make that behavior predictable.

## Session lifecycle

The UI requests a session through a typed command. Pelican Core opens a PTY, launches the adapter command in the workspace, and publishes output and lifecycle events. UI views subscribe by session ID, so switching panels never changes process ownership.

The daemon milestone will add a versioned local-socket protocol and replayable terminal buffers. The desktop app will become a disposable client that can detach and reattach without affecting agents.

## Normalized lifecycle precedence

1. An unresolved approval, user-input request, or extension UI request is `attention`.
2. Structured turn/agent activity is `working`.
3. A structured completion becomes `done` until reviewed in Pelican.
4. A reviewed completion is `idle`.
5. Saved history with a deterministic resume handle is `available`.
6. A missing transport or stopped process without a resume handle is `offline`.

Codex `turn/completed`, Claude `Stop`, and Pi `agent_settled` are the primary completion signals. Pi `agent_end` is intentionally not treated as completion because retries, compaction, or queued work may follow. A live PID alone never proves that an agent is working.

## Security and privacy

- All execution is local by default.
- Commands use argument arrays, never concatenated shell strings.
- Workspace access is explicit and user-selected.
- Diagnostic logs record metadata, not terminal contents, by default.
- Agent credentials remain owned by each installed CLI.
- Future remote access must be separately enabled and authenticated.

## Portability

Platform-specific behavior stays behind Rust interfaces. The React UI, domain model, event protocol, and adapter definitions remain TypeScript and portable. macOS is the first release target; Windows and Linux follow after session persistence is stable.
