# Pelican agent guide

This file applies to the entire repository. More-specific `AGENTS.md` files may refine these rules for a subtree.

Pelican is a lightweight, local-first Tauri desktop application for supervising Codex, Claude Code, and Pi across workspaces. Preserve truthful session state, keyboard-first operation, local execution, and a small dependency footprint.

Before changing session behavior, read:

- `docs/ARCHITECTURE.md`
- `docs/AGENT_INTEGRATIONS.md`
- `docs/PRODUCT_ACCEPTANCE_CHECKLIST.md`

## Architecture map

- `src/App.tsx` — application orchestration, shortcuts, session workflows, and panel state
- `src/domain/` — provider-neutral models and lifecycle reduction
- `src/agents/` — provider registry, capabilities, and launch/resume arguments
- `src/services/` — Tauri bridge, persistence, discovery merge, notifications, and terminal buffering
- `src/components/` — reusable React UI
- `src-tauri/src/lib.rs` — Tauri commands and plugin registration
- `src-tauri/src/terminal.rs` — in-process PTY ownership and terminal events
- `src-tauri/src/sessions.rs` — provider session discovery
- `src-tauri/src/agents.rs` — CLI executable discovery
- `src-tauri/src/files.rs` and `git.rs` — bounded, read-only workspace inspection
- `src-tauri/src/process.rs` — bounded, timeout-aware subprocess execution

Keep the React client provider-neutral. Put provider-specific behavior in `src/agents/` or the corresponding Rust discovery/transport module.

## Working workflow

1. Inspect `git status --short` and preserve unrelated user changes.
2. Read the nearest tests and relevant architecture documentation before editing behavior.
3. Add a focused regression test for bugs before or alongside the fix.
4. Keep changes within existing boundaries; document deliberate architecture changes.
5. Run the narrowest relevant checks while iterating, then the complete check before handoff.

```sh
npm ci
npm run dev             # frontend preview; native commands are unavailable
npm run tauri dev       # complete native development app
npm run check:frontend  # TypeScript, Vitest, and production frontend build
npm run check:rust      # rustfmt, Rust tests, and strict Clippy
npm run check           # complete repository correctness check
```

Run a native smoke test for changes involving PTYs, Tauri commands, paths, notifications, shortcuts, application lifecycle, or packaging.

## Session correctness invariants

These are product correctness rules, not presentation details:

- `connected` means Pelican owns the session's interactive PTY.
- `running` means the provider reports a live process. It does not imply Pelican can control that process.
- A live PID, terminal output, or welcome screen never proves an agent is `working`.
- A newly connected welcome TUI starts `idle`; user submission or an authoritative lifecycle event may move it to `working`.
- Saved history with a deterministic resume handle is `available`, not live.
- Never render a disconnected session as an interactive terminal. Offer explicit Resume/Attach, or explain that it is running elsewhere.
- Resume and Attach must use the exact provider handle. Never silently replace a failed recovery with a fresh session.
- Discovery polling must not overwrite the lifecycle of a connected, Pelican-owned session.
- Prompt and Terminal views control the same PTY. Switching views must not spawn, stop, or duplicate a process.
- At most one Pelican-owned PTY may exist for a session ID.
- Restored local records are never assumed connected or running after application restart.
- Attention remains sticky until resolved. Structured provider events outrank PTY-text heuristics.
- Do not infer normal turn completion from process existence, terminal silence, or TUI text.

Preserve provider recovery semantics:

- Codex resumes by thread ID through supported public interfaces, never a private database.
- Claude Code resumes by session ID and attaches only to a supported background-agent handle.
- Pi resumes from its exact session JSONL path.
- Unsupported external foreground PTYs cannot be retroactively attached.

## Testing expectations

- Add or update tests for every behavior change.
- Keep TypeScript/Vitest tests beside their module as `*.test.ts` or `*.test.tsx`.
- Keep Rust unit tests in the owning module under `#[cfg(test)]`.
- Prefer deterministic fixtures and temporary directories. Unit tests must not require installed providers, credentials, a network connection, or a GUI.
- Test provider arguments, discovery parsing and merging, lifecycle transitions, restoration, bounds, deadlines, and path validation at their nearest pure seam.
- Do not mark an acceptance-checklist item complete without reproducible evidence.
- Report the checks run and any native or manual behavior that remains unverified.

## Code and repository conventions

- TypeScript is strict. Prefer explicit domain types, `import type`, and small pure functions for lifecycle and merge logic.
- Keep React components functional and preserve keyboard, focus, and accessibility feedback.
- Follow the repository's two-space TypeScript formatting and `rustfmt` for Rust.
- Run blocking filesystem and process work outside Tauri's async runtime thread.
- Return actionable errors; do not silently turn discovery failures into successful empty results.
- Explain new runtime dependencies and update both lockfiles intentionally.
- `src-tauri/gen/schemas/` is generated and ignored. Application icons, `package-lock.json`, and `src-tauri/Cargo.lock` are tracked inputs.
- Update the architecture, integration notes, roadmap, and acceptance checklist when their claims change.

## Safety and privacy

- Spawn programs directly with an executable and argument array. Never concatenate user-controlled values into shell commands.
- Validate workspace roots and preserve path traversal and symlink protections.
- Bound subprocess time, output, protocol messages, terminal buffers, file scans, and Git diffs.
- Clean up child processes and PTYs on failure, stop, and shutdown.
- Do not log prompts, terminal contents, credentials, tokens, or provider configuration by default.
- Agent CLIs retain ownership of their credentials and safety behavior.
- Keep workspace and Git inspection read-only unless an explicit user action authorizes a mutation.
- Never discard unrelated user edits or use destructive Git commands without explicit authorization.
