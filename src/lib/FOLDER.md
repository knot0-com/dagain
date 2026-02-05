---
title: "choreo/src/lib"
status: active
date: "2026-02-04"
parents: ["choreo/src"]
tags: ["dagain", "runtime", "folder"]
input: "Core libraries used by CLI/supervisor"
output: "Folder responsibility and file index"
position: "`src/lib/` overview"
---

If this folder changes, this document must be updated.

This folder contains the core `dagain` libraries used by the CLI and supervisor.
It owns config/state IO, SQLite DB helpers, and workgraph scheduling.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `args.js` | runtime | CLI argument parsing utilities |
| `config.js` | runtime | Config + path helpers for `.dagain/` (global + current-session view + per-session) |
| `crypto.js` | runtime | File hashing helpers |
| `context-ops.js` | runtime | Allowlisted read-only ctx.* ops for chat prompt enrichment |
| `dashboard.js` | runtime | Snapshot builder for dashboards (counts/nodes/next) |
| `db/` | runtime | SQLite access + schema helpers |
| `fs.js` | runtime | File/dir utilities (atomic writes, etc.) |
| `lock.js` | runtime | Supervisor lock acquisition/heartbeat |
| `ownership-locks.js` | runtime | Resource ownership lock management |
| `runner.js` | runtime | Runner resolution + invocation helpers |
| `sessions.js` | runtime | Session-scoped state layout + migration + current-session pointer |
| `select.js` | runtime | Node selection logic |
| `template.js` | runtime | Template rendering helpers |
| `ui.js` | runtime | Plain terminal UI helpers |
| `workgraph.js` | runtime | Workgraph model + persistence |
