# Pelican TODOs — executable dependency ledger

Actionable engineering backlog for further development. Verification criteria live in [`docs/PRODUCT_ACCEPTANCE_CHECKLIST.md`](docs/PRODUCT_ACCEPTANCE_CHECKLIST.md). Milestone sequencing lives in [`docs/ROADMAP.md`](docs/ROADMAP.md). Architecture and provider transports live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/AGENT_INTEGRATIONS.md`](docs/AGENT_INTEGRATIONS.md).

This ledger preserves the previous backlog priorities and intent, but each item now has a stable slice ID, dependencies, scope owner, definition of done, validation requirement, and stop condition so it can be assigned independently.

## How to use

- Work **top-down** (P0 before P5). Do not skip correctness blockers for polish.
- Tag implementation intent from the row: **Fix** (bug / correctness), **Refactor** (structure without behavior change), **Improve** (product gap).
- Before changing session behavior, re-read [`AGENTS.md`](AGENTS.md) invariants.
- Mark a row beyond **Ready** only with reproducible evidence. When closing a TODO here, update the checklist and roadmap if their claims change.
- Self-check every UI change against the **component feedback contract** and, for provider work, the **golden provider workflow** in the acceptance checklist.
- Do not claim **Provider verified** without a native provider smoke run. Do not claim **Product accepted** without checklist/golden-workflow evidence.

## Status labels

| Status | Meaning |
| --- | --- |
| **Ready** | Scope and dependencies are clear enough for implementation, but the slice is not complete. |
| **Oracle gate** | The next code change needs an approved architecture/risk decision before implementation. |
| **Fixture verified** | Code landed with unit/fixture validation, but native provider smoke and product acceptance are not proven. |
| **Provider verified** | The required native provider smoke passed and evidence is cited, but full product acceptance is not claimed. |
| **Product accepted** | Acceptance checklist and golden workflow evidence are complete and cited. |

Current ledger state: no row is **Provider verified** or **Product accepted** yet.

## Evidence ledger

| Evidence | What it proves | What it does **not** prove |
| --- | --- | --- |
| `9c70332` — `feat: define normalized live-turn lifecycle` | **LC-00** fixture-verified lifecycle model exists. | No provider runtime wiring, native smoke, or product acceptance. |
| `a647fec` — `refactor: centralize fallback lifecycle updates` | **LC-01** fixture-verified central fallback lifecycle seam exists. | No structured provider runtime, native smoke, or product acceptance. |
| `3f85c1c` — `fix: mark Done after quiet turn while CLI stays open` | Quiet-output completion fallback exists. | It is fallback only; it is not structured provider completion authority. |
| `30e74dc` — `fix: prevent duplicate new-session launches` | **DI-05** duplicate-create in-flight lock is fixture verified. | No broader resume/attach/stop lock coverage or product acceptance. |
| `79d3384` — `fix: rejoin live PTYs after webview reload` | Webview reload can rejoin an in-process PTY. | Durable Core restart/crash recovery does not exist. |
| `dfdf6c7` — LC-02B SessionHost migration bridge | One in-process SessionHost map, canonical v1 PTY-fallback events, stream-scoped controls, and frontend cutover are fixture verified. | No structured provider transport, daemon/replay, native provider smoke, or product acceptance. |

## Global stop conditions

Stop and leave the row **Ready** or **Oracle gate** if:

- A provider event lacks authoritative session/turn identity or provenance.
- The only available signal is terminal text, process existence, terminal silence, or startup output.
- Correctness would require private/unsupported provider storage or an inferred resume handle.
- Native smoke or product acceptance would be claimed without running the required workflow.
- Preserving existing backlog intent would require guessing an intent not represented here or in the linked product docs.

## Design-goal snapshot

Pelican is a lightweight, keyboard-first macOS desktop app (Tauri) for managing Codex, Claude Code, and Pi across workspaces: left sidebar for workspaces/sessions, center Prompt + Terminal over one PTY, right sidebar for files and Git, native notifications for attention/errors/completion.

| Promise | Status |
| --- | --- |
| Three-panel Orca-style shell | Implemented |
| Multi-agent PTY control (new / resume / attach where supported) | Implemented for Pelican-owned PTYs |
| Real-time idle / working / waiting / completed while CLI stays open | Missing as product behavior — LC-00/LC-01 are fixture-verified foundations only |
| Durable reconnect after UI restart | Missing — `79d3384` covers webview PTY rejoin only, not durable Core restart |
| Rich prompt transcript / approvals / turn interrupt | Missing |
| Discovery honesty (failures, stale rows, identity) | Partial |
| Workspace/session org, keyboard completeness, a11y, packaging | Partial / missing |

---

## P0 — Structured lifecycle correctness blockers

Product status promise is not accepted until the golden workflow “turn finishes with CLI still open → `Working → Done`” passes for Codex, Claude Code, and Pi.

| ID | Status | Depends on | Ownership / bounded scope | Definition of done | Validation, native smoke, and stop condition |
| --- | --- | --- | --- | --- | --- |
| **LC-00** | **Fixture verified** | — | Domain lifecycle model in [`src/domain/lifecycle.ts`](src/domain/lifecycle.ts) and tests. | Normalized live-turn states and transitions encode the session invariants for `Idle`, `Working`, `Needs attention`, and `Done`. No provider wiring is included in this slice. | Evidence: `9c70332`. Fixture tests only. Stop before making any provider-runtime or native-smoke claim. |
| **LC-01** | **Fixture verified** | LC-00 | Central fallback lifecycle seam in [`src/domain/sessionLifecycle.ts`](src/domain/sessionLifecycle.ts), [`src/domain/status.ts`](src/domain/status.ts), and [`src/App.tsx`](src/App.tsx). | Fallback lifecycle updates are centralized so future structured events can outrank PTY text. Quiet-output `Done` while the CLI stays open remains fallback behavior only. | Evidence: `a647fec`; related fallback evidence: `3f85c1c`. Fixture tests only. Stop if a change would make terminal silence or process liveness authoritative. |
| **LC-02** | **Ready** — architecture decision approved, implementation not complete | LC-00, LC-01 | Provider-neutral structured lifecycle authority across [`src/agents/registry.ts`](src/agents/registry.ts) (`structuredLifecycle`), [`src/domain/status.ts`](src/domain/status.ts), [`src/App.tsx`](src/App.tsx), and provider modules under `src-tauri/`. | Structured provider events, not PTY text, drive `Working`, `Needs attention`, `Done`, and `Idle`; fallback remains demoted; stale/untrusted events are ignored fail-closed by provider/session/turn identity. | Add deterministic event-stream fixtures before native work. Native smoke is required through CX-02, CL-02, and PI-02. Stop if event identity/provenance is ambiguous. |
| **CAP-01** | **Ready** | LC-02 | Provider capability and readiness contract in the agent registry and launch/resume flows. Carries the original agent-ready handshake backlog item. | Each provider advertises structured lifecycle support/fallback mode; prompt submission waits for an authoritative ready/auth/setup state instead of startup-output inference; unsupported capability gets explicit fallback copy. | Add capability fixtures and startup-state tests. Native provider smoke is required before **Provider verified**. Stop if readiness is only inferable from TUI text. |
| **CX-01** | **Ready** | LC-02, CAP-01 | Codex structured lifecycle adapter using supported app-server/public interfaces; coordinate identity work with DI-03. | Codex turn start, completion, error, and attention events map into LC-02 with exact thread/session identity and without private database reads or duplicate imported rows. | Fixture app-server payloads first; native Codex smoke later. Stop if only unsupported/private Codex state is available. |
| **CX-02** | **Ready** | CX-01, LC-08 | Codex lifecycle verification slice for new/resume/attach and edge cases. | Codex golden workflow shows `Idle → Working → Done` while CLI remains open, sticky attention resolves only from authoritative events, and disconnected sessions are never rendered interactive. | Requires native Codex smoke. Do not mark **Provider verified** until evidence is recorded. Stop on ambiguous turn IDs. |
| **CL-01** | **Ready** | LC-02, CAP-01 | Claude Code structured lifecycle adapter via supported hooks / inventory. | Claude Code turn start, completion, error, approval/question, resume, and attach signals map into LC-02 while preserving exact session/background-agent handles. | Hook/inventory fixtures first; native Claude Code smoke later. Stop if a foreground PTY cannot be attached through a supported handle. |
| **CL-02** | **Ready** | CL-01, LC-08 | Claude Code lifecycle verification slice for new/resume/attach and attention. | Claude Code golden workflow shows `Idle → Working → Done` while CLI remains open, approval/question attention stays sticky until resolved, and resume/attach use exact provider handles. | Requires native Claude Code smoke. Do not mark **Provider verified** until evidence is recorded. Stop if provider hooks cannot distinguish completion from idle prompt text. |
| **PI-01** | **Ready** | LC-02, CAP-01 | Pi structured lifecycle adapter via supported RPC/session JSONL surfaces; coordinate resume-handle timing with DI-04. | Pi turn start, completion, error, and attention events map into LC-02 with exact JSONL/session identity and no inferred replacement session. | RPC/session fixtures first; native Pi smoke later. Stop if the resume handle is missing or synthesized. |
| **PI-02** | **Ready** | PI-01, LC-08 | Pi lifecycle verification slice for create/stop/resume and attention. | Pi golden workflow shows `Idle → Working → Done` while CLI remains open; intentional stop becomes `Available` when the exact resume handle is present; disconnected sessions are not interactive. | Requires native Pi smoke. Do not mark **Provider verified** until evidence is recorded. Stop if stop/resume semantics would require rediscovery guesses. |
| **LC-08** | **Ready** | LC-02, CX-01, CL-01, PI-01 | Attention authority in [`src/domain/status.ts`](src/domain/status.ts), [`src/App.tsx`](src/App.tsx), and provider adapters. | English PTY attention regex is removed or demoted to fallback; structured approval/question events set sticky attention; only authoritative resolution clears it. | Add fixture streams for attention/resolve/error. Native attention smoke required per provider. Stop if provider events lack a resolvable attention identifier. |
| **NT-01** | **Ready** | LC-02, LC-08, CX-02, CL-02, PI-02 | Native notifications in [`src/services/notifications.ts`](src/services/notifications.ts) and exact workspace/session routing in [`src/App.tsx`](src/App.tsx). | True turn completion, attention, and error notifications fire from structured lifecycle while the CLI remains open; notification click selects the exact workspace/session; failures are surfaced non-disruptively. | Requires macOS native smoke for notification permission, click routing, and all provider completion cases. Stop if the row would depend on fallback quiet-output completion as authority. |

---

## P1 — Discovery, identity, and inspector honesty

| ID | Status | Depends on | Ownership / bounded scope | Definition of done | Validation, native smoke, and stop condition |
| --- | --- | --- | --- | --- | --- |
| **DI-01** | **Ready** | — | Discovery error propagation in [`src-tauri/src/sessions.rs`](src-tauri/src/sessions.rs), [`src/services/sessionDiscovery.ts`](src/services/sessionDiscovery.ts), and left-sidebar copy in [`src/App.tsx`](src/App.tsx). | Per-provider discovery failures are shown as failures, not silent empty inventories; previous known sessions are not erased by a transient discovery error. | Rust/TS fixtures for success, no sessions, and provider failure. Stop if an error cannot be attributed to a provider. |
| **DI-02** | **Ready** | LC-01 | Discovery reconciliation in [`src/services/sessionDiscovery.ts`](src/services/sessionDiscovery.ts). | Sessions missing from a later provider inventory become stale/offline/available as appropriate without overwriting a connected Pelican-owned lifecycle. | Merge fixtures covering disappeared, connected, imported, and errored rows. Stop if reconciliation would disconnect an owned PTY. |
| **DI-03** | **Ready** | DI-05, CX-01 | New-session identity capture in [`src/App.tsx`](src/App.tsx) create flow and discovery merge. | Every newly created session captures provider thread/session ID and deterministic resume handle, especially Codex, without creating a duplicate imported row on rediscovery. | Create/rediscovery fixtures; native Codex smoke after CX-01. Stop if the exact provider handle is unavailable. |
| **DI-04** | **Ready** | PI-01 | Pi create/stop path in [`src/App.tsx`](src/App.tsx) and Pi adapter under [`src/agents/`](src/agents/). | Pi `resumeHandle` is set early enough that intentional stop becomes `Available`, not `Offline`, before rediscovery. | Pi lifecycle fixtures; native Pi stop/resume smoke. Stop if the handle would be inferred instead of observed. |
| **DI-05** | **Fixture verified** | — | Duplicate create protection in [`src/App.tsx`](src/App.tsx) via [`src/services/actionLock.ts`](src/services/actionLock.ts). | New-session launches acquire an immediate in-flight lock so duplicate create actions cannot race before React re-renders. | Evidence: `30e74dc`. Fixture tests only; broader resume/attach/stop locks remain RF-02. Stop before claiming product acceptance. |
| **DI-06** | **Ready** | — | Git inspector copy and result typing in [`src-tauri/src/git.rs`](src-tauri/src/git.rs) and [`src/App.tsx`](src/App.tsx). | Non-Git workspaces are labeled neutrally; Pelican never shows “Working tree clean” for non-repositories. | Rust git fixtures and UI state fixture. Stop if non-repo and clean-repo states share the same representation. |
| **DI-07** | **Ready** | — | Terminal resize error handling in [`src/components/TerminalView.tsx`](src/components/TerminalView.tsx). | Terminal resize failures surface actionable feedback instead of being swallowed. | Component test plus native PTY resize smoke. Stop if the only recovery is silent retry. |
| **DI-08** | **Ready** | CX-01 | Codex discovery in [`src-tauri/src/sessions.rs`](src-tauri/src/sessions.rs). | Codex thread discovery paginates beyond the first 200 roots, preserves subagent hierarchy, and respects custom session/config directories. | Deterministic directory fixtures for pagination, hierarchy, and custom roots. Stop if hierarchy would be guessed from names only. |
| **DI-09** | **Ready** | DI-02 | Imported-history archive policy in discovery merge/storage. | Users can hide/archive imported history without it immediately reappearing on the next discovery poll. | Merge/storage fixtures for archived imported rows and live owned rows. Stop if archive state would hide a connected session. |
| **DI-10** | **Ready** | — | File tree and Git diff loading states in inspector services/UI. | File-scan truncation is visible; diff loading, empty, error, and retry states are distinct and comply with the component feedback contract. | Component/service fixtures for truncation, diff failure, retry, binary/large files. Stop if a failure would be rendered as successful empty content. |

---

## Refactoring and testability ledger

| ID | Priority | Status | Depends on | Ownership / bounded scope | Definition of done | Validation and stop condition |
| --- | --- | --- | --- | --- | --- | --- |
| **RF-01** | P2 | **Ready** | LC-01 | Split monolithic [`src/App.tsx`](src/App.tsx) into focused modules: workspace sidebar, session list, prompt composer, inspector, shortcut registry, and session workflows. | Behavior-preserving refactor only; domain reduction remains pure in [`src/domain/`](src/domain/); provider-specific behavior stays in [`src/agents/`](src/agents/) or Rust transport modules. | Existing focused tests plus smoke of unchanged create/resume/terminal flows. Stop if refactor requires semantic lifecycle changes. |
| **RF-02** | P2 | **Ready** | DI-05 | Centralize mutation locks for new/resume/attach/stop. | All session mutations share a lock service so duplicate actions cannot race before React re-renders; DI-05's create lock remains preserved. | Unit tests for all lock keys and failure release paths. Stop if locks cannot be keyed by exact provider/session handle. |
| **RF-03** | P2 | **Ready** | LC-02 | UI status copy alignment. | User-facing copy uses product vocabulary (`Waiting` ≈ attention, `Running` ≈ working, `Completed` ≈ done) without breaking domain status types or historical records. | Snapshot/component tests for status labels. Stop if copy changes imply unsupported lifecycle guarantees. |
| **RT-01** | P5 | **Ready** | RF-01 | App-level React interaction tests beyond unit and browser smoke. | Critical workflows have deterministic interaction coverage without requiring installed providers, credentials, network, or GUI. | Vitest/browser fixtures. Stop if a test needs real provider credentials. |
| **RT-02** | P5 | **Ready** | LC-02, CAP-01 | Native / fixture-backed provider lifecycle test harness. | Working, waiting/attention, retry, completion, and failure are testable per transport with fixtures first and optional native smoke evidence second. | Fixture harness plus documented native smoke commands. Stop if provider credentials or network are required for unit tests. |

---

## Durable Core ledger

| ID | Priority | Status | Depends on | Ownership / bounded scope | Definition of done | Validation, native smoke, and stop condition |
| --- | --- | --- | --- | --- | --- | --- |
| **CORE-01** | P2 | **Oracle gate** | LC-02, RF-02 | Extract Pelican Core into a background daemon with a versioned local-socket protocol. | Core, not the webview, owns PTYs/processes; Pelican-owned sessions survive UI restart without duplicate PTYs. `79d3384` webview PTY rejoin remains partial evidence only. | Architecture approval, protocol fixtures, and native UI restart smoke. Stop if at-most-one-PTY ownership cannot be proven. |
| **CORE-02** | P2 | **Oracle gate** | CORE-01 | SQLite persistence for workspaces, sessions, layout, unread state, bounded terminal scrollback, and migrations; replace/extend [`src/services/storage.ts`](src/services/storage.ts). | Durable state has versioned migrations, bounded storage, and restart/crash reconnect semantics. | Migration tests, corruption fallback tests, native restart smoke. Stop if prompts/terminal contents would be logged or persisted beyond policy. |
| **CORE-03** | P2 | **Oracle gate** | CORE-01, CORE-02 | Clean shutdown, crash recovery, and orphan PTY/process reconciliation. | Stop/shutdown/crash paths clean up or reconcile child processes and PTYs without silently replacing failed recovery with a fresh session. | Native shutdown/crash smoke and orphan-process fixtures. Stop if recovery cannot preserve exact provider handles. |

---

## Prompt surface and turn-control ledger

| ID | Priority | Status | Depends on | Ownership / bounded scope | Definition of done | Validation, native smoke, and stop condition |
| --- | --- | --- | --- | --- | --- | --- |
| **PT-01** | P3 | **Ready** | LC-02, LC-08 | Center Prompt surface transcript. | Conversation transcript, streamed responses, tool activity, approvals, progress, and usage are rendered from provider events; PTY write success is never treated as provider turn acceptance. | Event fixtures and component tests. Native provider smoke before **Provider verified**. Stop if transcript would be reconstructed from terminal text alone. |
| **PT-02** | P3 | **Ready** | LC-02, CAP-01 | Turn interrupt control. | A turn can be interrupted without killing the whole CLI process, using the provider-supported cancellation path and preserving session resumability. | Provider capability fixtures and native smoke per provider. Stop if only process kill is available. |
| **PT-03** | P3 | **Ready** | CAP-01 | Prompt history, attachments/context selection, and command help. | Prompt history and context affordances are provider-neutral, bounded, and do not leak credentials or terminal contents. | Component/state tests. Stop if attachment support would require unbounded file reads. |
| **PT-04** | P3 | **Ready** | CORE-02 | Terminal search, explicit copy/clear, reconnect affordance, and persistent scrollback UI. | Terminal tools operate on the same PTY/session, do not spawn duplicates, and make disconnected/reconnect states explicit. | Component tests plus native terminal smoke. Stop if switching views would spawn or stop a process. |

CAP-01 carries the original P3 “agent-ready handshake before prompt submission; auth/setup as first-class state” item because it blocks structured lifecycle correctness.

---

## Organization, keyboard, and accessibility ledger

| ID | Priority | Status | Depends on | Ownership / bounded scope | Definition of done | Validation, native smoke, and stop condition |
| --- | --- | --- | --- | --- | --- | --- |
| **OA-01** | P4 | **Ready** | DI-02 | Workspace management. | Workspaces can be renamed, removed, reordered, pinned, archived, and searched; moved/deleted/unreadable paths recover gracefully; symlinks canonicalize before dedup. | State/path fixtures and component tests. Stop if path handling weakens traversal/symlink protections. |
| **OA-02** | P4 | **Ready** | DI-09 | Left sidebar organization. | Sidebar supports independent collapse, agent grouping/filtering, global attention inbox, and session rename/archive/pin. | Component/a11y tests. Stop if archive/pin can hide connected attention. |
| **OA-03** | P4 | **Ready** | DI-10 | Right inspector controls. | Tree expand/collapse, keyboard traversal, open/reveal/copy path, file search, and optional rich hunks/binary state are explicit and bounded. | Component tests and filesystem fixtures. Stop if file operations become write-capable without explicit user action. |
| **OA-04** | P4 | **Ready** | RF-01 | Shortcut coverage. | Next/previous workspace/session, focus-panel, stop/resume, and refresh shortcuts work; globals never corrupt direct terminal input; shortcuts are documented and optionally customizable. | Keyboard interaction tests and native smoke. Stop if terminal input capture is ambiguous. |
| **OA-05** | P4 | **Ready** | RF-03 | Accessibility audit and fixes. | Status, unread, loading, launch, stop, and refresh controls have accessible live regions; VoiceOver, axe, contrast, 200% zoom, and long-name passes are evidenced. | axe/VoiceOver/manual audit evidence required before **Product accepted**. Stop before claiming any accessibility audit without evidence. |
| **OA-06** | P4 | **Ready** | NT-01 | Notification settings and failure surfacing. | Users can disable notifications after enabling them; notification API failures are exposed non-disruptively. | Component tests and native notification permission smoke. Stop if permission failure is silently ignored. |
| **OA-07** | P4 | **Ready** | CAP-01 | CLI version/capability probe. | Provider CLI compatibility and fallback messaging are explicit and do not imply unavailable features. | Probe fixtures for missing, old, and compatible CLIs. Stop if capability is inferred from command presence alone. |

---

## Release evidence ledger

| ID | Priority | Status | Depends on | Ownership / bounded scope | Definition of done | Validation and stop condition |
| --- | --- | --- | --- | --- | --- | --- |
| **REL-01** | P5 | **Ready** | DI-01, CORE-02 | Diagnostics export. | Export includes actionable app/provider diagnostics while excluding prompts, terminal output, credentials, tokens, and provider configuration secrets by default. | Privacy fixtures and manual export review. Stop if redaction cannot be proven. |
| **REL-02** | P5 | **Ready** | RF-01 | Performance budgets. | Startup time, idle CPU, memory, binary size, and large-workspace budgets are defined, measured, and regressions are visible. | Repeatable local benchmark script and budget report. Stop if measurements are not reproducible. |
| **REL-03** | P5 | **Ready** | CORE-03 | Packaged macOS release. | Signed packaged macOS build, notarization, updates, GUI `PATH`, and auth outside a development shell are verified. | Native packaged-app smoke on macOS. Stop if only `npm run tauri dev` is tested. |
| **REL-04** | P5 | **Ready** | CX-02, CL-02, PI-02, NT-01, OA-05 | Golden provider workflow and release-run checklist. | Unified real-time management is called done only after all provider golden workflows, notification routing, accessibility, and release-run evidence are recorded. | Checklist evidence required before **Product accepted**. Stop if any provider lacks native smoke evidence. |

---

## Original backlog mapping

| Original priority | Original item | Ledger ID(s) |
| --- | --- | --- |
| P0 | Wire structured lifecycle as authority for Codex, Claude Code, and Pi; keep PTY text fallback only. | LC-02, CAP-01, CX-01, CX-02, CL-01, CL-02, PI-01, PI-02 |
| P0 | Detect normal turn completion while the interactive CLI remains alive. | LC-01, LC-02, CX-02, CL-02, PI-02 |
| P0 | Replace/demote English PTY attention regex with structured approval/question events; keep sticky attention. | LC-08, CX-02, CL-02, PI-02 |
| P0 | Emit or remove unused `process-started`; stop relying only on fragile engagement refs for idle→working. | LC-01, LC-02 |
| P0 | Fire native notifications on true turn completion and route clicks to exact workspace/session. | NT-01, OA-06 |
| P1 | Surface per-provider discovery failures instead of treating failure as empty inventory. | DI-01 |
| P1 | Reconcile disappeared provider inventory rows as stale/offline without overwriting connected Pelican lifecycle. | DI-02 |
| P1 | Capture provider thread/session ID and resume handle for newly created sessions without duplicate imports. | DI-03 |
| P1 | Set Pi `resumeHandle` early enough that intentional stop becomes `Available`. | DI-04, PI-02 |
| P1 | Guard duplicate new-session launches with an immediate in-flight lock. | DI-05 |
| P1 | Label non-Git workspaces neutrally. | DI-06 |
| P1 | Surface terminal resize failures. | DI-07 |
| P1 | Paginate Codex thread list, preserve subagent hierarchy, respect custom directories. | DI-08 |
| P1 | Allow hide/archive of imported history without immediate rediscovery reappearance. | DI-09 |
| P1 | Show file-scan truncation and distinct diff loading/failure/retry states. | DI-10 |
| P2 | Split monolithic `src/App.tsx` into focused modules while keeping domain pure. | RF-01 |
| P2 | Centralize session mutation locks for new/resume/attach/stop. | RF-02 |
| P2 | Align UI status copy with product vocabulary without breaking domain status types. | RF-03 |
| P2 | Extract Pelican Core background daemon with versioned local-socket protocol. | CORE-01 |
| P2 | Persist workspaces, sessions, layout, unread, scrollback, and reconnect state in SQLite. | CORE-02 |
| P2 | Clean shutdown, crash recovery, and orphan PTY/process reconciliation. | CORE-03 |
| P3 | Conversation transcript, streamed responses, tool activity, approvals, progress, and usage. | PT-01 |
| P3 | Interrupt a turn without killing the whole CLI process. | PT-02 |
| P3 | Agent-ready handshake before prompt submission; auth/setup first-class. | CAP-01 |
| P3 | Prompt history, attachments/context selection, and command help. | PT-03 |
| P3 | Terminal search, explicit copy/clear, reconnect affordance, persistent scrollback UI. | PT-04 |
| P4 | Workspace rename/remove/reorder/pin/archive/search; recover paths; symlink canonicalization. | OA-01 |
| P4 | Left sidebar collapse, grouping/filtering, attention inbox, session rename/archive/pin. | OA-02 |
| P4 | Right inspector tree controls, keyboard traversal, file operations, search, rich hunks/binary state. | OA-03 |
| P4 | Shortcut coverage and terminal-input safety; document/customize shortcuts. | OA-04 |
| P4 | Accessible live regions; VoiceOver, axe, contrast, 200% zoom, long-name passes. | OA-05 |
| P4 | Notification settings disable path and API failure surfacing. | OA-06 |
| P4 | CLI version/capability probe and compatibility/fallback messaging. | OA-07 |
| P5 | App-level React interaction tests beyond unit and browser smoke. | RT-01 |
| P5 | Native / fixture-backed provider lifecycle tests. | RT-02 |
| P5 | Diagnostics export excluding prompts, terminal output, credentials, and tokens. | REL-01 |
| P5 | Startup, idle CPU, memory, binary size, and large-workspace budgets. | REL-02 |
| P5 | Signed packaged macOS build, notarization, updates, GUI `PATH`, and auth outside dev shell. | REL-03 |
| P5 | Complete golden provider workflow and release-run checklist evidence before calling unified real-time management done. | REL-04 |

## Self-check before handoff on any slice

1. **Invariants** — [`AGENTS.md`](AGENTS.md) session correctness rules still hold.
2. **Component feedback** — Loading/busy, success/active, empty/disconnected, error/recovery, disabled/a11y for every touched control.
3. **Workflow** — Exercise the relevant *Implementation checklist by workflow* section in the acceptance checklist.
4. **Golden path** — For lifecycle/notification work, run the three-provider golden workflow; do not accept “completed” while `Working` sticks with CLI open.
5. **Checks** — Prefer `npm run check` or the narrowest relevant subset, plus a native smoke when PTYs, provider lifecycle, paths, notifications, shortcuts, or packaging are involved.
6. **Docs** — Update checklist / roadmap / architecture / this file when claims or priorities change.
