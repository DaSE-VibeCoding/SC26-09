# Pelican product acceptance checklist

Last audited: 2026-07-17

This document converts Pelican's product statement into verifiable behavior. It is both an implementation audit and the repeatable checklist used before a release.

## How to read this checklist

- `[x]` means the behavior exists and has current evidence.
- `[ ] PARTIAL` means a useful slice exists, but the product promise is not yet satisfied.
- `[ ] MISSING` means the behavior does not exist.
- The release-run section starts unchecked every time. Check it only after exercising the packaged build.

Do not mark **unified real-time agent management** complete until the golden workflow passes for Codex, Claude Code, and Pi with the CLI process left alive after a turn.

## Design-goal audit

| Product promise | Status | Current reality |
| --- | --- | --- |
| Lightweight macOS desktop app | Partial | Tauri, React, TypeScript, and a small dependency set form a good prototype. Packaging, signing, notarization, updates, and measured startup/memory budgets are missing. |
| Manage multiple agents across projects | Partial | Multiple workspaces and first-class Codex, Claude Code, and Pi sessions work. Workspace/session rename, archive, removal, search, and durable supervision are incomplete. |
| Unified view of all threads and sessions | Partial | Saved Codex, Claude Code, and Pi sessions can be discovered for added workspaces. Arbitrary foreground TUIs cannot generally be attached, stale results are not reconciled, and Codex listing is not paginated. |
| Real-time idle/running/waiting/completed status | Missing at product level | Current PTY heuristics can show startup, activity, attention text, and process exit. Private Codex and Pi fixture decoders normalize success, failure, interruption, and correlated attention, but no production app-server/RPC binding emits those events; Claude hooks also remain absent, so normal completed turns can remain `Working`. |
| Left sidebar organizes workspaces, agents, sessions | Partial | Workspaces and sessions have agent logos, status text, unread state, and shortcuts. There is no independent collapse, grouping/filtering, global attention inbox, rename, archive, or pinning. |
| Right sidebar shows files and Git context | Substantially implemented | File list, modified files, staged/unstaged/untracked diffs, refresh, empty, and error states exist. Folder interaction, file open/search, non-Git labeling, and richer diff feedback remain. |
| Friendly command interface | Partial | The composer sends text to the connected PTY, preserves drafts, and has fixture-verified readiness gating/copy. It has no conversation transcript, tool progress, approvals, structured streaming, real readiness handshake producer, or turn-level interrupt. |
| Integrated terminal and direct control | Implemented for Pelican-owned PTYs | The in-process SessionHost owns PTY spawn, stream-scoped input/resize/stop, ordered events, and bounded UI buffering. External Codex/Pi foreground terminals cannot be reattached at the OS PTY level. |
| Native notifications | Partial | Permission UI and focus-aware attention/process-exit notifications exist. Normal task completion is not known reliably while an interactive CLI remains open. |
| Keyboard-first operation | Partial | Command palette and core shortcuts exist. Complete panel navigation, lifecycle actions, file-tree navigation, customization, and accessibility validation are missing. |

## Critical correctness gaps

- [ ] MISSING — Use provider lifecycle events as the authority for `Working`, `Needs attention`, `Done`, and `Idle`.
- [ ] MISSING — Detect completion while the interactive CLI remains alive.
- [ ] PARTIAL — Replace the small English terminal-text attention matcher with structured approval/question events.
- [ ] PARTIAL — Report discovery failure per provider instead of silently treating failure as “no sessions.”
- [ ] PARTIAL — Reconcile sessions that disappear from a later provider inventory as stale/offline.
- [ ] PARTIAL — Capture the provider thread ID for every newly created session, especially Codex, without creating a duplicate imported row.
- [ ] MISSING — Keep Pelican-owned sessions alive across UI restart through a daemon/local-socket owner.
- [ ] MISSING — Persist bounded terminal history and reconnect after restart or crash.
- [ ] PARTIAL — Distinguish a non-Git workspace from a clean Git worktree.
- [ ] PARTIAL — Add Codex pagination, subagent hierarchy, and a defined archived-session policy.

## Provider capability matrix

| Capability | Codex | Claude Code | Pi |
| --- | --- | --- | --- |
| Distinct identity and CLI discovery | Implemented | Implemented | Implemented |
| New Pelican-owned PTY | Implemented | Implemented | Implemented |
| Saved-session inventory | App-server thread list, partial | Transcript scan, partial | JSONL scan, partial |
| Resume saved history | `codex resume`, implemented path | `--resume`, implemented path | `--session <absolute path>`, implemented path |
| Attach a live external session | Not for arbitrary TUI | Background `claude attach` only | Not for arbitrary TUI |
| Authoritative live lifecycle | Fixture foundation only (CX-01A/LC-02D; no production binding) | Missing | Fixture foundation only (PI-01A serialized prompt/settlement subset; no production binding) |
| Authoritative prompt readiness producer | Missing | Missing | Missing |
| Target structured transport | Long-lived app-server | Lifecycle hooks/background inventory | RPC or extension events |

## Implementation checklist by workflow

### Application startup and agent availability

- [x] Tauri window and three-panel shell render.
- [x] Codex, Claude Code, and Pi executable discovery uses absolute executables and no shell-concatenated user input.
- [x] Agent picker shows detecting, available, and missing states.
- [ ] PARTIAL — Probe CLI versions and capabilities, with an explicit compatibility/fallback message.
- [ ] PARTIAL — Handle authentication/setup screens as a first-class state instead of inferring work from startup output. CAP-01A defines blocked auth/setup readiness fixture states and copy, but no runtime producer detects them.
- [ ] MISSING — Verify the signed packaged app outside a development shell and GUI `PATH` variants.

### Workspace management

- [x] Add a workspace and cancel the native picker safely.
- [x] Avoid an exact-path duplicate and activate the existing workspace.
- [x] Persist and restore valid workspace records.
- [ ] PARTIAL — Canonicalize symlink aliases before deduplication.
- [ ] MISSING — Rename, remove, reorder, pin, archive, and search workspaces.
- [ ] MISSING — Recover when a saved workspace was moved, deleted, or became unreadable.
- [ ] MISSING — Provide next/previous workspace keyboard navigation.

### Session discovery and reconciliation

- [x] Discover on startup, every 15 seconds, and by manual refresh.
- [x] Show a disabled/spinning refresh control while discovery is in flight.
- [x] Merge by provider identity without overwriting a connected Pelican lifecycle.
- [x] Restore resumable records as `Available`, never falsely as live.
- [ ] PARTIAL — Surface a distinct result for “no sessions” versus “provider discovery failed.”
- [ ] PARTIAL — Mark disappeared live inventory rows stale/offline.
- [ ] PARTIAL — Paginate Codex results beyond the first 200 roots.
- [ ] PARTIAL — Discover Codex descendants/subagents and preserve hierarchy.
- [ ] PARTIAL — Respect every provider's custom session/config directory.
- [ ] MISSING — Let users hide/archive imported history without it immediately reappearing.

### New session

- [x] Create an optimistic session row with a launching state.
- [x] Launch the agent directly in the selected workspace.
- [x] Show a connected terminal on success.
- [x] Remove the optimistic row, restore selection, and alert on spawn failure.
- [x] A fresh welcome TUI begins `Idle`, not `Working`.
- [x] Prevent duplicate resume/attach clicks with an immediate in-flight lock.
- [x] Prevent duplicate new-session launches before React rerenders.
- [ ] MISSING — Wait for an agent-ready handshake before enabling prompt submission. CAP-01A adds fixture policy/readiness copy only; fallback PTY remains sendable and no provider readiness producer exists.
- [ ] PARTIAL — Reconcile every new session with its provider ID and saved resume handle.

### Resume and attach

- [x] Saved history presents `Resume here` instead of silently starting a fresh conversation.
- [x] A supported Claude background job presents `Attach`.
- [x] Unsupported foreground attachment says `Running in another terminal`.
- [x] Resume/attach shows a launching state, restores prior state on failure, and opens the real provider TUI on success.
- [ ] PARTIAL — Prove with real-provider fixtures that the resumed conversation contains a unique prior marker.
- [ ] MISSING — Detect/prevent concurrent resume of the same provider history in separate processes.
- [ ] MISSING — Rejoin Pelican-owned live sessions after the UI restarts.

### Prompt surface

- [x] Keep a separate draft per session.
- [x] Block empty or duplicate sends and display `Sending…`.
- [x] Use bracketed paste for multiline input and restore the draft on write failure.
- [x] Refuse sending while disconnected and offer Resume/Attach where supported.
- [ ] PARTIAL — A successful fallback send currently means “bytes reached the PTY,” not “the provider accepted a turn.” CAP-01A blocks structured fixtures until authoritative ready, but no production readiness producer exists.
- [ ] MISSING — Conversation history, streamed responses, tool activity, approvals, progress, and usage.
- [ ] MISSING — Interrupt a turn without killing the whole CLI process.
- [ ] MISSING — Prompt history, attachments/context selection, and command help.

### Terminal surface

- [x] Prompt/Terminal switching keeps one PTY and does not spawn a second agent.
- [x] Input, resize, focus, ANSI rendering, UTF-8 split handling, and bounded replay exist.
- [x] A disconnected Terminal tab shows an honest recovery screen instead of a fake welcome TUI.
- [x] A hidden terminal is inert and removed entirely for disconnected sessions.
- [ ] PARTIAL — Resize failures are currently swallowed.
- [ ] PARTIAL — Terminal-mode stopping needs visible feedback rather than only becoming noninteractive.
- [ ] MISSING — Search, explicit copy/clear controls, reconnect, and persistent scrollback.
- [ ] MISSING — VoiceOver/screen-reader mode validation or an accessible fallback.

### Lifecycle and session status

- [x] Startup remains `Idle` until the user submits work.
- [x] Prompt/terminal submission changes the session to `Working`.
- [x] Attention remains sticky through ordinary repaint output.
- [x] Intentional stop becomes `Available` when a resume handle exists, otherwise `Offline`.
- [x] Process success/failure maps to `Done`/`Needs attention`.
- [ ] PARTIAL — Waiting detection is a low-confidence PTY text matcher.
- [ ] MISSING — Provider completion changes `Working → Done` while the CLI remains open.
- [ ] MISSING — Reviewing a completed live turn consistently changes `Done → Idle` from structured state.
- [ ] MISSING — Fixtures cover working, waiting, retry, completion, and failure for each provider transport.

### Files and Git inspector

- [x] File scan is bounded, sorted, and ignores common generated directories.
- [x] Git status handles staged, unstaged, untracked, rename, delete, and recreated paths.
- [x] Diff handling is path-safe, timeout-bounded, UTF-8-safe, and size-bounded.
- [x] Initial loading, background refresh, clean/empty, and independent error feedback exist.
- [ ] PARTIAL — Show file-scan depth/entry truncation instead of silently stopping.
- [ ] PARTIAL — Give diff loading and diff failure their own visual state and retry.
- [ ] PARTIAL — Label a non-Git workspace neutrally rather than “Working tree clean.”
- [ ] MISSING — Expand/collapse, keyboard tree navigation, file open/reveal/copy path, and search.
- [ ] MISSING — Rich hunks, binary-file state, and optional stage/unstage actions.

### Notifications

- [x] Settings shows checking, enabled, denied guidance, and desktop-only states.
- [x] Focused active work suppresses redundant attention notifications.
- [x] Background attention and unexpected process exit can notify.
- [x] Intentional stop does not emit completion/error notifications.
- [ ] MISSING — Notify on normal task completion while the CLI stays alive.
- [ ] MISSING — Route a notification click to the exact workspace/session.
- [ ] MISSING — Disable notifications after enabling them and expose notification failures non-disruptively.

### Keyboard and accessibility

- [x] `⌘K`, palette filtering, arrow selection, Enter, Escape, focus trap, and focus restoration exist.
- [x] `⇧⌘N`, `⇧⌘O`, `⇧⌘G`, `⇧⌘E`, `⌘,`, Control-backtick, `⌘1…9`, and `⌘Enter` exist.
- [x] Focus-visible and reduced-motion styles exist.
- [ ] PARTIAL — Ensure global shortcuts never corrupt direct terminal input.
- [ ] MISSING — Next/previous workspace/session, focus-panel, stop/resume, and refresh shortcuts.
- [ ] MISSING — Shortcut customization and complete shortcut documentation.
- [ ] MISSING — VoiceOver, axe, contrast, 200% zoom, and long-name acceptance passes.
- [ ] MISSING — Announce status, unread, loading, launch, stop, and refresh changes through accessible live regions.

### Persistence, resilience, and privacy

- [x] Corrupt local records are filtered and running state is never blindly restored.
- [x] Commands use argument arrays; Git paths are constrained to the workspace.
- [x] Subprocess time, stdout, stderr, terminal buffer, Git status, and diff size are bounded.
- [ ] MISSING — Background daemon/local socket, crash recovery, orphan reconciliation, and graceful app shutdown.
- [ ] MISSING — SQLite migrations and durable terminal replay.
- [ ] MISSING — Diagnostics export that excludes prompts, terminal output, credentials, and tokens.
- [ ] MISSING — Startup time, idle CPU, memory, binary size, and large-workspace budgets.

## Component feedback contract

Every interactive component must provide all applicable feedback states.

| Component | Loading/busy | Success/active | Empty/disconnected | Error/recovery | Disabled/accessibility |
| --- | --- | --- | --- | --- | --- |
| Workspace sidebar | Discovery spinner | Active row, badges | Workspace with New session | Provider-specific discovery warning | `aria-expanded/current`, keyboard navigation |
| Agent picker | Detecting CLI | Installed agent enabled | All agents missing guidance | Start failure with retry | Missing provider disabled with reason |
| Session row | Launching/stopping | Logo, text status, unread | Available/offline | Attention/failure state | Accessible selected/unread/source labels |
| Resume/attach card | Resuming/attaching | Connected PTY | Saved/external/offline copy | Restore state and retry | One in-flight action only |
| Prompt composer | Sending | Draft cleared after allowed fallback write | Disabled while disconnected or readiness-blocked | Exact draft restored | Explicit textarea label plus `role=status` readiness copy; textarea remains editable |
| Terminal | Starting/stopping | Same live PTY | Honest recovery screen | Input/resize/reconnect feedback | Inert when hidden; screen-reader plan |
| File tree | Initial/refresh | Sorted bounded tree | No files | Local error and retry | Tree semantics and keyboard traversal |
| Git changes/diff | Status/diff loading | Selected change and diff | Clean/non-Git/binary | Local error and retry | Accessible selection and status code |
| Settings | Detecting/checking | Paths and permission state | Desktop-only/missing | Denial/troubleshooting | Focus trap and restoration |
| Command palette | N/A | Active option | No matching command | Disabled prerequisite detail | Combobox/listbox validation |
| Error toast | N/A | N/A | Hidden | Specific `role=alert`, dismissible | Does not overwrite unresolved errors |
| Native notification | N/A | Routed alert | Permission state | Non-blocking API failure | No sensitive terminal contents |

## Golden provider workflow

Run every item for **Codex, Claude Code, and Pi**:

- [ ] Add a Git workspace with staged, unstaged, and untracked changes.
- [ ] Create a new provider session and confirm its CWD.
- [ ] Confirm the welcome screen is `Idle`.
- [ ] Send a task that edits a file and confirm `Idle → Working`.
- [ ] Confirm file/Git context refreshes without stealing selection or focus.
- [ ] Trigger an approval or user question and confirm `Working → Needs attention`.
- [ ] With Pelican unfocused, receive exactly one correctly named notification.
- [ ] Reply in Prompt mode, then use Terminal mode, proving both control the same conversation.
- [ ] Confirm `Needs attention → Working` after the response.
- [ ] Let the turn finish while keeping the CLI open; confirm `Working → Done`.
- [ ] Open the result; confirm unread clears and `Done → Idle`.
- [ ] Restart Pelican; confirm exactly one restored session with intact history.
- [ ] Resume/reconnect and verify a unique prior marker remains in the conversation.

The product's real-time-status promise remains **not accepted** while the “turn finishes with CLI still open” step fails.

## Repeatable release-run checklist

### Automated

- [ ] `npm run check`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] Native debug build
- [ ] Packaged macOS build
- [ ] No new console panic, unhandled promise rejection, Rust panic, or leaked child process

### UI workflows

- [ ] Cold start, no-workspace state, add/cancel workspace
- [ ] Duplicate, missing, Unicode, spaced, and symlink workspace paths
- [ ] CLI missing, startup/authentication, successful start, and spawn failure
- [ ] Discovery add/update/deduplicate/stale/failure behavior
- [ ] New, resume, attach, unsupported external, stop, and unexpected exit
- [ ] Prompt draft switching, multiline send, write failure, and duplicate-action guards
- [ ] Prompt/Terminal switching, buffer replay, resize, and hidden focus
- [ ] File/Git initial load, background refresh, clean, non-Git, partial failure, and stale-response prevention
- [ ] Notification permission, focus suppression, attention, completion, error, and click routing
- [ ] Every documented shortcut in composer, terminal, palette, and modal contexts
- [ ] Tab/Shift-Tab, Escape, VoiceOver, 200% zoom, reduced motion, contrast, and long content
- [ ] App restart, crash recovery, process ownership, duplicate reconciliation, and restored scrollback

## Current verification snapshot

- [x] TypeScript typecheck passes.
- [x] Frontend production build passes.
- [x] 136 frontend unit tests pass.
- [x] 28 Rust unit tests pass.
- [x] Rust formatting passes.
- [x] Rust Clippy with warnings denied passes.
- [x] Browser smoke test covers disconnected, available, Resume, and connected-terminal feedback.
- [ ] App-level React interaction tests do not yet exist.
- [ ] Native end-to-end provider lifecycle tests do not yet exist.
- [ ] Restart, notification, keyboard, VoiceOver, and packaged-app tests do not yet exist.

## Priority order

1. Structured lifecycle correctness for Codex, Claude Code, and Pi.
2. Durable session ownership and reconnect after UI restart.
3. Central transcript, progress, approval, and turn-control UI.
4. Provider discovery errors, pagination, staleness, and identity reconciliation.
5. App-level workflow tests and a real three-provider compatibility matrix.
6. Workspace/session management, file interaction, keyboard completeness, and accessibility.
7. Packaging, performance budgets, diagnostics, signing, notarization, and updates.
