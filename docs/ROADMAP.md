# Roadmap

## Milestone 0 — foundation (in progress)

- [x] Tauri, React, and TypeScript workspace
- [x] Core project and session domain contracts
- [x] First-class Codex, Claude Code, and Pi registry
- [x] PTY spike and terminal rendering
- [x] Native file-tree and Git diff commands
- [x] Initial three-panel interface
- [ ] Validate launch and lifecycle behavior against all three installed CLIs
- [x] Finalize the structured status-integration strategy per agent
- [x] Import saved Codex, Claude Code, and Pi sessions for added workspaces
- [x] Distinguish provider liveness from a Pelican-owned terminal connection
- [x] Resume saved history and attach supported Claude background jobs
- [x] Browse/search same-workspace saved sessions across all first-class providers
- [x] Export bounded visible session context as editable Markdown for a different agent
- [x] Render rich local Git hunks with an on-demand Diffs.com component

## Milestone 1 — durable local sessions

- [ ] Extract Pelican Core into a background daemon
- [ ] Add a versioned local-socket protocol
- [ ] Persist workspace, session, layout, and unread metadata in SQLite
- [ ] Retain bounded terminal scrollback and reconnect after UI restart
- [ ] Add clean shutdown, crash recovery, and orphan reconciliation

## Milestone 2 — MVP

- [ ] Implement Codex app-server transport and version-matched schema generation
- [ ] Implement Claude Code session hooks and optional `agents --json --all` import
- [ ] Implement Pi RPC transport and `agent_settled` lifecycle mapping
- [ ] Add generic CLI configuration
- [ ] Finish project and session create/rename/archive flows
- [x] Add focus-aware notifications
- [ ] Add session and file search
- [ ] Reconcile stale/disappeared discovery results and surface per-provider failures
- [ ] Paginate Codex roots and import persisted subagent hierarchy
- [ ] Complete configurable keyboard shortcuts
- [ ] Harden Git and large-workspace performance

## Milestone 3 — macOS beta

- [ ] Accessibility and VoiceOver pass
- [ ] Performance and memory budgets
- [ ] Crash-safe migrations and diagnostics
- [ ] Signing, notarization, packaging, and updates
- [ ] Beta feedback and compatibility matrix

## Deferred until demand is proven

Mobile clients, cloud synchronization, embedded browsers, GitHub and Linear integrations, account switching, plugin marketplaces, collaboration, SSH orchestration, and automated worktree comparison.
