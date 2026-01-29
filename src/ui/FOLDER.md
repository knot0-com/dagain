If this folder changes, this document must be updated.

This folder contains the lightweight web UI for `dagain`.
It serves a local HTML dashboard (interactive DAG graph) plus JSON/SSE endpoints.
It also exposes a small local control API (pause/resume/replan/set-workers/cancel).

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `server.js` | runtime | Local HTTP server for dashboard + SSE + control/log APIs |
