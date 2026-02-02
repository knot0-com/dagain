---
title: "choreo/src/tui"
status: active
date: "2026-02-02"
parents: ["choreo/src"]
tags: ["dagain", "tui", "folder"]
input: "TTY terminal + Blessed + dashboard snapshot APIs"
output: "TUI entrypoints and file index"
position: "Terminal UI surface for dagain"
---

If this folder changes, this document must be updated.

This folder contains the terminal UI (TUI) for `dagain` and can start the web dashboard.
It renders live DAG status (tree + deps + log tail + status colors) and accepts chat/control input.
It avoids Blessed table widgets for `screen-256color` stability.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `chat.js` | runtime | Blessed-based TUI chat (left) + DAG/log panels (right) + dashboard server |
