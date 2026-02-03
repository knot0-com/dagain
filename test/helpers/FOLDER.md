---
title: "choreo/test/helpers"
status: active
date: "2026-02-02"
parents: ["choreo/test"]
tags: ["dagain", "tests", "helpers", "folder"]
input: "Test-only helper modules"
output: "Folder responsibility and file index"
position: "Shared utilities for the Node.js test suite"
---

If this folder changes, this document must be updated.

This folder contains shared helper utilities for tests.
It is not used by the runtime package code.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `sqlite.js` | test helper | SQLite helpers for tests |
| `session.js` | test helper | Resolve current session id and session-scoped paths |
