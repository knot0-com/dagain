---
title: "choreo/src"
status: active
date: "2026-02-04"
parents: ["choreo"]
tags: ["dagain", "source", "folder"]
input: "Runtime source tree"
output: "Folder responsibility and file index"
position: "Top-level `src/` overview"
---

If this folder changes, this document must be updated.

This folder contains the CLI implementation and its UI adapters.
It is the main runtime code shipped in the npm package.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `cli.js` | runtime | CLI command routing + implementations (supervisor scheduling + recovery + control auto-start) |
| `lib/` | runtime | Core logic (DB, workgraph, runners, locks) |
| `tui/` | runtime | Terminal UI (Blessed) |
| `ui/` | runtime | Web UI (local HTTP server) |
