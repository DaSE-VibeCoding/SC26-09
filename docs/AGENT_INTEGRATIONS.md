# First-class agent integrations

Codex, Claude Code, and Pi are equal first-class integrations. Pelican normalizes their different protocols into one session model while preserving each CLI's authentication, configuration, and safety behavior.

## Session binding contract

Pelican's approved transport model is one Core-owned active binding per session. The binding may expose an interactive PTY, but does not have to. PTY fallback provides Prompt, Terminal, and fallback lifecycle evidence. Claude's planned PTY-plus-hooks transport keeps Prompt and Terminal on that same binding while structured hooks own lifecycle. Planned Codex app-server and Pi RPC bindings provide Prompt and structured lifecycle without a Terminal surface; Pelican must not emulate one.

The LC-02A frontend slice defines protocol-version-1 semantic requests, snapshots/events, bounded runtime validation, stream ordering, and the optional-terminal capability. LC-02B adds the in-process native SessionHost, one-active-stream enforcement, stream-scoped controls, and an atomic React cutover to canonical events. Current sessions use that host's PTY-fallback binding; preferred protocol transports and provider payload conversion are not live.

## Codex

Preferred transport: `codex app-server --listen stdio://`, owned by Pelican Core. The adapter uses thread and turn methods for inventory, prompts, interruption, streaming items, diffs, and approval requests. Because app-server is experimental, the adapter must version-probe it and generate schemas from the installed CLI.

PTY compatibility mode launches:

```text
codex -C <workspace> --no-alt-screen
codex resume -C <workspace> <session-id> --no-alt-screen
```

State mapping: outstanding server request → attention; active thread or turn → working; completed turn → done/unread; reviewed idle thread → idle; transport exit → offline.

Primary sources: [app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), and [non-interactive JSONL](https://learn.chatgpt.com/docs/non-interactive-mode).

## Claude Code

Default transport: a Pelican-owned interactive PTY plus a Pelican-owned `--settings` file containing short-timeout loopback hooks. New sessions receive a UUID through `--session-id`; resume always uses the exact ID and never `--continue`.

Claude-managed background agents may be discovered through `claude agents --json --all`. This mode is explicit because `claude --bg` can create isolated worktrees and may perform Git/PR actions.

State mapping: permission, elicitation, or user question → attention; prompt/tool activity → working; `Stop` without background work → done; `SessionEnd` → offline. Background JSON states map directly from `working`, `blocked`, `done`, `failed`, and `stopped`.

Primary sources: [CLI reference](https://code.claude.com/docs/en/cli-reference), [hooks](https://code.claude.com/docs/en/hooks), [sessions](https://code.claude.com/docs/en/sessions), and [agent view](https://code.claude.com/docs/en/agent-view).

## Pi

Preferred transport: `pi --mode rpc --name <title>`, one process per Pelican session. Pelican sends newline-delimited JSON commands and consumes structured events. Resume uses the stored absolute session JSONL path with `--session`.

State mapping: unresolved extension UI request → attention; streaming, compaction, retry, or queued work → working; `agent_settled` → done/unread; reviewed settlement → idle; process exit → offline. `agent_end` is not completion.

PTY compatibility mode remains available for users who want Pi's native TUI, with lower-confidence state detection.

Primary sources: [Pi repository](https://github.com/earendil-works/pi), [RPC protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), and [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md).
