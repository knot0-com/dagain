---
title: "Static Assets"
status: active
date: "2026-02-02"
parents: ["src/ui"]
tags: [ui, static, frontend]
input: "Served by server.js via /static/* route"
output: "HTML shell, CSS styles, client-side JS for the dashboard"
position: "Frontend assets for the dagain web dashboard"
---

If this folder changes, this document must be updated.

This folder contains the static frontend assets for the dagain web dashboard.
The HTML template uses a `__DAGAIN_TOKEN__` placeholder that the server replaces with the real auth token at request time.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `index.html` | runtime | HTML shell with token placeholder, links to styles.css and client.js |
| `styles.css` | runtime | All CSS rules for the dashboard (theme, layout, components, responsive) |
| `client.js` | runtime | Client-side JS (DAG rendering, pan/zoom, chat with markdown/streaming, controls, SSE diffing, minimap, node search/filter, sessions drawer) |
| `FOLDER.md` | docs | This file |
