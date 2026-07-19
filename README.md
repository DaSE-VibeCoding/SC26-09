# Pelican

Pelican is a lightweight, local-first desktop workspace for supervising coding agents across projects. Codex, Claude Code, and Pi are first-class integrations; any terminal CLI can be supported through the generic adapter.

The product is organized around three questions:

1. Which agents need attention?
2. What is each agent doing?
3. What changed in the workspace?

## Current foundation

- Tauri 2 native shell with a React and TypeScript UI
- Three-panel project, session, terminal, file, and Git layout
- Typed adapter registry and distinct visual identity for Codex, Claude Code, and Pi
- Native CLI discovery
- Saved-session discovery for Codex, Claude Code, and Pi
- Explicit Resume for provider history and Attach for supported Claude background jobs
- Cross-platform PTY creation, input, resize, and termination
- Workspace file-tree and Git status/diff commands
- Opt-in native notifications for attention, completion, and failure
- Keyboard-first command palette and navigation
- Unit tests for adapter and status behavior

The PTY host currently lives in the Tauri process. Moving it into the dedicated Pelican Core daemon is the next architectural milestone so sessions can survive a full UI restart.
The current adapters use PTYs for interactive control and can rediscover/resume saved provider history. Structured per-turn lifecycle signals and reconnecting a Pelican-owned live PTY after app restart remain roadmap work. See [the product acceptance checklist](docs/PRODUCT_ACCEPTANCE_CHECKLIST.md) for the exact implemented, partial, and missing behavior.

## Development

Prerequisites: Node.js 22, npm, stable Rust, and the platform requirements listed by Tauri.

```sh
npm ci
npm run check
npm run tauri dev
```

Run the frontend alone with `npm run dev`. It opens a non-destructive preview workspace because native PTY and filesystem commands are only available inside Tauri.

GitHub Actions runs the frontend and native Rust checks independently on every pull request and every push to `main`. Coding agents should follow [AGENTS.md](AGENTS.md), which records the architecture boundaries, session-state invariants, safety rules, and handoff requirements.

## Status vocabulary

- **Needs attention** — waiting for input, permission, or error recovery
- **Working** — actively running
- **Done** — finished and not yet reviewed
- **Idle** — available or reviewed
- **Available** — saved provider history that can be resumed
- **Offline** — stopped or disconnected

## Scope

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).
