If this folder changes, this document must be updated.

This folder contains the lightweight web UI for `dagain`.
It serves a local HTML dashboard (chat + DAG + node logs + runs browser) plus JSON/SSE endpoints.
It also exposes a small local control API (pause/resume/replan/set-workers/cancel), plus log/chat/runs APIs.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `server.js` | runtime | HTTP routes, SSE, API endpoints, static file serving |
| `static/` | runtime | Frontend assets (HTML shell, CSS, client JS) |
| `FOLDER.md` | docs | This file |
