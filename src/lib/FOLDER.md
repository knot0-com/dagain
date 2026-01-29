If this folder changes, this document must be updated.

This folder contains the core `dagain` libraries used by the CLI and supervisor.
It owns config/state IO, SQLite DB helpers, and workgraph scheduling.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `args.js` | runtime | CLI argument parsing utilities |
| `config.js` | runtime | Config + path helpers for `.dagain/` |
| `crypto.js` | runtime | File hashing helpers |
| `dashboard.js` | runtime | Snapshot builder for dashboards (counts/nodes/next) |
| `db/` | runtime | SQLite access + schema helpers |
| `fs.js` | runtime | File/dir utilities (atomic writes, etc.) |
| `lock.js` | runtime | Supervisor lock acquisition/heartbeat |
| `ownership-locks.js` | runtime | Resource ownership lock management |
| `runner.js` | runtime | Runner resolution + invocation helpers |
| `select.js` | runtime | Node selection logic |
| `template.js` | runtime | Template rendering helpers |
| `ui.js` | runtime | Plain terminal UI helpers |
| `workgraph.js` | runtime | Workgraph model + persistence |
