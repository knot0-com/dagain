If this folder changes, this document must be updated.

This folder contains the CLI implementation and its UI adapters.
It is the main runtime code shipped in the npm package.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `cli.js` | runtime | CLI command routing + implementations |
| `lib/` | runtime | Core logic (DB, workgraph, runners, locks) |
| `tui/` | runtime | Terminal UI (Blessed) |
| `ui/` | runtime | Web UI (local HTTP server) |
