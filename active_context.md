# Active Context
*Last updated: 2026-01-29T03:15:48Z by codex*

## Current System Status
UI/TUI dashboard work is implemented, tests pass, and changes are pushed to `master`.

## Architecture Overview
- `src/cli.js` routes `chat`, `tui`, `ui` commands.
- `src/lib/dashboard.js` builds a snapshot of DAG state from SQLite + supervisor lock.
- `src/ui/server.js` serves a minimal HTML dashboard + `/api/state` + `/events` (SSE).
- `src/tui/chat.js` renders a Blessed TUI with live DAG status and chat controls.

## Recent Changes
- `src/cli.js:4126` adds `dagain ui`, `dagain tui`, and TTY-default `dagain chat` (with `--plain` fallback).
- `src/ui/server.js:113` adds a lightweight local dashboard server with SSE updates.
- `src/tui/chat.js:119` adds a minimal terminal UI for live DAG viewing + chat.
- `test/helpers/sqlite.js:7` adds a busy-timeout to reduce transient sqlite lock flakes in tests.

## In Progress
(none)

## Next TODOs
- [ ] Watch CI for `master` and npm publish workflow

## Blockers/Open Questions
- Should `dagain tui` be dashboard-only, or keep chat embedded (current behavior)?
