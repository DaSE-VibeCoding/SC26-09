# First-class agent integrations

Codex, Claude Code, and Pi are equal first-class integrations. Pelican normalizes their different protocols into one session model while preserving each CLI's authentication, configuration, and safety behavior.

## Session binding contract

Pelican's approved transport model is one Core-owned active binding per session. The binding may expose an interactive PTY, but does not have to. PTY fallback provides Prompt, Terminal, and fallback lifecycle evidence. Claude's planned PTY-plus-hooks transport keeps Prompt and Terminal on that same binding while structured hooks own lifecycle. Planned Codex app-server and Pi RPC bindings provide Prompt and structured lifecycle without a Terminal surface; Pelican must not emulate one.

The LC-02A frontend slice defines semantic requests, snapshots/events, bounded runtime validation, stream ordering, and the optional-terminal capability. LC-02B adds the in-process native SessionHost, one-active-stream enforcement, stream-scoped controls, and an atomic React cutover to canonical events. LC-02C introduced the provider-neutral structured identity gate in protocol v2: structured bindings carry normalized source identity (`agentId`, integration, exact provider session, provenance), structured activity carries matching source plus turn context, and fallback PTY bindings remain source-less. CAP-01A fixture-verifies the frontend/domain prompt-readiness policy. CAP-01B advances the host contract to protocol v4: snapshots and ordered events carry host-owned normalized readiness, exact source/stream mismatches reject atomically, and rejoin restores host state instead of preserving an independent client value. CX-01A fixture-verifies a private, narrow Codex app-server v2 decoder for exact handshake/thread identity, turns, and command/file approval correlation through the Rust gate. LC-02D maps exact completed, failed, and interrupted outcomes into the normalized lifecycle while preserving sticky attention and rejection atomicity. None of these slices is registered as a production structured binding: Pelican does not spawn or bind app-server/RPC for live sessions, send protocol prompts, change supported bindings, or claim in-app provider verification. No client action or text/output/process signal can manufacture readiness, and no production provider currently calls the private host readiness channel. Current sessions use the host's PTY-fallback binding; preferred protocol transports and provider readiness producers are not live.

## Codex

Preferred transport: `codex app-server --listen stdio://`, owned by Pelican Core. The adapter uses thread and turn methods for inventory, prompts, interruption, streaming items, diffs, and approval requests. Because app-server is experimental, the adapter must version-probe it and generate schemas from the installed CLI.

PTY compatibility mode launches:

```text
codex -C <workspace> --no-alt-screen
codex resume -C <workspace> <session-id> --no-alt-screen
```

State mapping: outstanding server request → attention; active thread or turn → working; completed turn → done/unread; reviewed idle thread → idle; transport exit → offline.

A sanitized native smoke with Codex 0.144.5 confirmed that app-server omits top-level `jsonrpc`, preserves integer and string request IDs, returns provider identity at `result.thread.id`, and emits lifecycle status at `params.turn.status`. Closing stdin after terminal completion exited cleanly. This validates the private decoder's wire shape only; Pelican does not yet own a production app-server binding.

CX-01B fixture-verifies an always-compiled but unregistered supervisor that directly owns one configured app-server child, bounds stdout JSONL, continuously discards stderr, correlates the canonical new-thread handshake, commits exact source plus `ready` atomically, and reaps gracefully or forcibly. A sanitized native supervisor smoke passed against Codex 0.144.5 without sending a prompt or recording provider data. CX-01C fixture-verifies that accepted protocol transports remain Prompt-only and never initialize or advertise Terminal, while PTY bindings preserve existing behavior. The current private supervisor still combines one route with one process; production work must first introduce process-global request routing for the target one-process-per-`CODEX_HOME` topology.

The cross-agent handoff exporter separately uses bounded `thread/read` with `includeTurns: true` for an exact discovered thread ID. It accepts only text entries from `userMessage` and `agentMessage`, verifies `result.thread.id` and canonical `cwd`, and never registers that short-lived read path as a production session binding.

Primary sources: [app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), and [non-interactive JSONL](https://learn.chatgpt.com/docs/non-interactive-mode).

## Claude Code

Default transport: a Pelican-owned interactive PTY plus a Pelican-owned `--settings` file containing short-timeout loopback hooks. New sessions receive a UUID through `--session-id`; resume always uses the exact ID and never `--continue`.

Claude-managed background agents may be discovered through `claude agents --json --all`. This mode is explicit because `claude --bg` can create isolated worktrees and may perform Git/PR actions.

State mapping: permission, elicitation, or user question → attention; prompt/tool activity → working; `Stop` without background work → done; `SessionEnd` → offline. Background JSON states map directly from `working`, `blocked`, `done`, `failed`, and `stopped`.

Primary sources: [CLI reference](https://code.claude.com/docs/en/cli-reference), [hooks](https://code.claude.com/docs/en/hooks), [sessions](https://code.claude.com/docs/en/sessions), and [agent view](https://code.claude.com/docs/en/agent-view).

For an explicit handoff export, Pelican scans the configured workspace transcript directory for the exact embedded session ID and canonical workspace. Only `user`/`assistant` message text is normalized; tool, thinking, hook, system, and unknown blocks are omitted. Transcript content is never used as lifecycle authority.

## Pi

Preferred transport: `pi --mode rpc --name <title>`, one process per Pelican session. Pelican sends newline-delimited JSON commands and consumes structured events. Resume uses the stored absolute session JSONL path with `--session`.

PI-01A fixture-verifies a private decoder only: correlated `get_state` plus the version-3 session header binds the exact provider session and absolute resume path; an accepted ordinary prompt's typed request ID owns one serialized lifecycle epoch. `agent_start` begins that epoch, each `turn_end` updates the candidate outcome across tool use or retry, and only `agent_settled` emits completed, failed, or interrupted. Untimed extension UI dialogs use exact request/response IDs for sticky attention. Timed dialogs, queued/concurrent/steering prompts, process ownership, prompt writes, readiness, and production RPC support remain excluded.

A sanitized native smoke with Pi 0.80.10 confirmed typed response correlation, `data.sessionId`, absolute `data.sessionFile`, prompt response before `agent_start`, `turn_end.message.stopReason`, non-terminal `agent_end`, terminal `agent_settled`, and clean EOF exit. For a new session, the announced file did not exist until after the first prompt, and the persisted header used a canonicalized macOS temporary `cwd`; a production binding must therefore defer header reads until materialization and compare canonical workspace paths.

State mapping target: unresolved extension UI request → attention; an active serialized prompt epoch, compaction, or retry → working; final `agent_settled` reason → done, attention, or idle; reviewed successful settlement → idle; process exit → offline. `agent_end` is not completion.

PTY compatibility mode remains available for users who want Pi's native TUI, with lower-confidence state detection.

For an explicit handoff export, the exact absolute resume path must canonicalize beneath Pi's configured session directory and its versioned header must match both session ID and workspace. Only documented `message` rows with `user` or `assistant` roles and explicit text are normalized.

Primary sources: [Pi repository](https://github.com/earendil-works/pi), [RPC protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), and [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md).
