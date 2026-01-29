If this folder changes, this document must be updated.

This folder contains the terminal UI (TUI) for `dagain`.
It renders live DAG status and accepts chat/control input.
It avoids Blessed table widgets for `screen-256color` stability.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `chat.js` | runtime | Blessed-based TUI chat + live DAG view (scrollable nodes panel) |
