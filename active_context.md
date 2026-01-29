# Active Context
*Last updated: 2026-01-29T07:23:50Z by codex*

## Current System Status
UI/TUI dashboards are shipped (web UI now themed + animated with improved DAG layout).
Shell verifier/merge runner env is back-compat with older `CHOREO_*`/`TASKGRAPH_*` prefixes (prevents Node from executing the packet markdown as JS).

## Architecture Overview
- `src/cli.js` routes `chat`, `tui`, `ui` commands.
- `src/lib/dashboard.js` builds a snapshot of DAG state from SQLite + supervisor lock.
- `src/ui/server.js` serves a minimal HTML dashboard + `/api/state` + `/events` (SSE).
- `src/tui/chat.js` renders a Blessed TUI with live DAG status and chat controls.

## Recent Changes
- `src/ui/server.js:513` improves DAG layout (ordering sweeps + edge slotting) and adds knot0-style dark theme + subtle animations.
- `src/cli.js:332` exports `DAGAIN_*` plus `CHOREO_*`/`TASKGRAPH_*` env aliases for runners.
- `src/lib/config.js:37` makes default `shellVerify`/`shellMerge` commands fall back to `CHOREO_*`/`TASKGRAPH_*`.
- `scripts/shell-verifier.js:61` and `scripts/shell-merge.js:50` accept `CHOREO_*`/`TASKGRAPH_*` env vars directly.
- `test/shell-verifier.test.js:107` adds a regression test for `CHOREO_*` env support.

## In Progress
(none)

## Next TODOs
- [ ] Watch CI for `master` and npm publish workflow (tag + trusted publish)

## Blockers/Open Questions
- Should `dagain tui` be dashboard-only, or keep chat embedded (current behavior)?
