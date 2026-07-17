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
- `ActivityEvent` is normalized, immutable live-turn evidence. It records provider-neutral turn start, attention request/resolution, turn completion, and Pelican result review events, without raw provider payloads or provider-specific event names.

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

The capability/version probing and authoritative transports in this section are the target architecture. The current runtime imports saved provider sessions, resumes them through the PTY fallback, and only attaches supported Claude background jobs. All three adapters advertise their preferred future transport but currently support exactly the `pty-fallback` binding in production. All three adapters still use heuristic PTY lifecycle state.

Claude-managed `--bg` agents are an optional import mode rather than Pelican's default: current Claude Code may isolate them into `.claude/worktrees/` and perform Git/PR actions. Pelican-owned PTYs preserve the selected checkout and make that behavior predictable.

## Session lifecycle

The UI requests a session through a typed command. Pelican Core opens a PTY, launches the adapter command in the workspace, and publishes output and lifecycle events. UI views subscribe by session ID, so switching panels never changes process ownership.

Each session has at most one Core-owned active binding. A binding describes either a PTY transport (with fallback or structured lifecycle evidence) or a protocol transport (always structured). A PTY is therefore a capability of a binding, not a requirement of a session: PTY fallback and Claude PTY-plus-hooks expose Prompt and Terminal over the same binding, while future Codex app-server and Pi RPC bindings expose Prompt only. A non-PTY binding must never mount a fake terminal, and every control command carries the active `streamId` so stale clients cannot control a replacement stream.

LC-02A defines the first frontend wire contracts, fail-closed decoders, transport capability helper, and pure aggregate session/lifecycle/stream reducer. LC-02B provides the in-process Rust SessionHost migration bridge: one binding map owns PTYs, stream-scoped controls, and canonical ordered events, while legacy commands project compatibility events only for legacy-opened streams. LC-02C introduced the provider-neutral structured lifecycle identity gate in protocol v2 at the codec, runtime, and Rust SessionHost seams: structured PTY/protocol bindings carry bounded source identity, host activity carries matching source plus turn context, and fallback PTY bindings remain source-less. CAP-01A adds a frontend/domain prompt-readiness fixture foundation: fallback PTY streams become `pty-fallback-sendable`, structured streams start `awaiting-authoritative`, and policy fixtures define `ready`, `auth-required`, `setup-required`, and `unsupported`. CX-01A and PI-01A add always-compiled private Rust fixture decoders for Codex app-server v2 and serialized Pi RPC/session epochs; both route only normalized activity through the shared gate. LC-02D advances the SessionHost contract to protocol v3 and fixture-normalizes exact completed, failed, and interrupted turn outcomes while preserving sticky correlated attention and rejection atomicity. These slices have no Tauri registration or production structured binding. A future Pi RPC binding remains terminal-less and must not emulate a Terminal surface. No production runtime producer can set authoritative readiness states yet. React consumes only the normalized event family. Current production sessions still use PTY fallback only; protocol transports, replay, readiness producers, and real structured provider adapters remain future work.

Prompt availability is fail-closed at a pure domain seam. Missing, closed, or transport/readiness-mismatched bindings cannot send or clear drafts. PTY fallback remains immediately sendable through terminal input with `pty-fallback` authority, but is never labeled provider-ready. Only an authoritative `ready` state makes structured PTY/protocol prompt bindings sendable; `awaiting-authoritative`, `auth-required`, `setup-required`, and `unsupported` remain blocked fixture states until a provider adapter supplies real readiness evidence.

The daemon milestone will add a versioned local-socket protocol and replayable terminal buffers. The desktop app will become a disposable client that can detach and reattach without affecting agents.

## Pure live-turn lifecycle contract

`src/domain/lifecycle.ts` owns the provider-neutral live-turn reducer contract. It is a pure model for LC-00, and `src/domain/sessionRuntime.ts` now wires accepted local fallback and normalized host activity into that reducer at a pure seam. Provider adapters and future protocol decoders still own conversion from provider-specific events into normalized `ActivityEvent` values; no production structured provider producer is wired yet.

The reducer only derives live statuses: `idle`, `working`, `attention`, and `done`. Connection and process reachability remain outside the live-turn reducer: saved history with a deterministic resume handle is still modeled as `available`, and a missing transport or stopped process without a resume handle is still modeled as `offline` by the surrounding session layer.

Live-turn precedence is:

1. Any unresolved, correlated attention key is `attention`.
2. A turn in progress with no unresolved attention is `working`.
3. A completed turn with no unresolved attention is `done` until reviewed in Pelican.
4. A reviewed completion is `idle`.

Structured lifecycle evidence is authoritative over fallback evidence. Once accepted, structured evidence permanently suppresses later fallback lifecycle evidence for that live reducer state. Promotion is a one-way authority latch, not a state reset: only the structured event's own transition changes the turn phase or pending attention. Completion received while attention keys remain pending is latent: the visible status stays `attention` and reveals `done` only after the final matching attention resolution. Reviewing during unresolved attention is intentionally a no-op.

Provider-specific lifecycle names stay in adapter code and fixtures. The domain contract only accepts normalized events, and a live PID alone never proves that an agent is working.

## Security and privacy

- All execution is local by default.
- Commands use argument arrays, never concatenated shell strings.
- Workspace access is explicit and user-selected.
- Diagnostic logs record metadata, not terminal contents, by default.
- Agent credentials remain owned by each installed CLI.
- Future remote access must be separately enabled and authenticated.

## Portability

Platform-specific behavior stays behind Rust interfaces. The React UI, domain model, event protocol, and adapter definitions remain TypeScript and portable. macOS is the first release target; Windows and Linux follow after session persistence is stable.
