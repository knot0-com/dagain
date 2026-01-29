If this folder changes, this document must be updated.

This folder contains the lightweight web UI for `dagain`.
It serves a local HTML dashboard (animated DAG graph + node log tail) plus JSON/SSE endpoints.
It also exposes a small local control API (pause/resume/replan/set-workers/cancel) and node log tail API.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `server.js` | runtime | Local HTTP server for dashboard + SSE + control/log APIs |
