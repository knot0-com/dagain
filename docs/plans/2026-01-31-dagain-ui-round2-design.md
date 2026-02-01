---
title: "Dagain Dashboard UI/UX Round 2"
status: active
date: "2026-01-31"
parents: []
tags: [ui, ux, design, dagain]
input: "src/ui/static/{index.html, styles.css, client.js}, src/ui/server.js"
output: "Enhanced dashboard with improved node details, DAG readability, chat UX, and overall polish"
position: "Design document for the second round of UI/UX improvements"
---

# Dagain Dashboard UI/UX Round 2

## Stage 1: SSE Diffing + Connection Indicator

### SSE Diffing
- Add `lastRenderedNodes` Map tracking `{status, title, lockRunId}` per node
- On SSE message, compare each node against cached state
- Only update DOM for nodes that actually changed
- Skip full `renderGraph()` when only node attributes changed (no structural changes)
- Structural change detection: different node count or different node IDs

### Connection Indicator
- Add `.connDot` element in header next to brand
- Three states: connected (green), reconnecting (amber), disconnected (red)
- Wire to `EventSource` events: `onopen` -> connected, `onerror` -> reconnecting
- Track consecutive errors; after 5 -> disconnected state
- Show "Reconnecting..." text on amber, "Disconnected" on red

### Files modified
- `styles.css`: `.connDot` styles (3 states)
- `index.html`: Add `<span class="connDot" id="connDot"></span>` in header
- `client.js`: SSE diffing logic, connection state management

## Stage 2: Selection Panel Improvements

### Progress Indicator
- Thin 3px colored bar at top of selection card body
- Amber pulse animation for `in_progress`, green for `done`, red for `failed`, purple for `needs_human`
- CSS-only using pseudo-element on a status strip div

### Timing Info
- New fields: "started" and "elapsed" below the existing key-value pairs
- Extract from `node.lock.startedAt` when available
- Elapsed time updates every second via `setInterval`
- Format as relative: "2m 14s", "1h 03m"

### Retry Button
- New button next to "Cancel node" in selection card header
- Only enabled when selected node status is `failed`
- Sends POST to `/api/control/retry` (new endpoint) or uses cancel + status reset

### Log Search
- Small search input above the log div
- Client-side: wraps matches in `<mark>` tags
- `Ctrl+F` shortcut when selection card is focused
- Clear with Escape or X button
- Highlight color: amber with 25% opacity

### Collapsible Sections
- "Info" and "Log" sections with clickable headers
- Collapse/expand with CSS `max-height` transition
- Default: both expanded. State saved to localStorage

### Files modified
- `styles.css`: Status strip, collapsible sections, log search, retry button
- `index.html`: Status strip div, retry button, log search input, section headers
- `client.js`: Timing logic, search highlighting, collapse toggle, retry handler

## Stage 3: Chat Experience

### Markdown Rendering
- ~60 line function: `renderMarkdown(text) -> HTML string`
- Supports: **bold**, *italic*, `inline code`, ```code blocks```, - lists, [links]
- Sanitize output (no raw HTML passthrough)
- Applied to assistant messages only; user messages stay plain text

### Typing Indicator
- Animated "..." bubble appended to chat log during send
- Three dots that pulse sequentially (CSS animation, staggered)
- Removed when response arrives

### Relative Timestamps
- Format `t.at` as "just now", "2m ago", "1h ago"
- Update every 30s via `setInterval`
- Store timestamp data attribute on chat meta elements

### Smart Scroll
- Track if user is "at bottom" (within 40px of scrollHeight)
- If at bottom: auto-scroll on new messages
- If scrolled up: show "New messages" pill at bottom of chat log
- Click pill to scroll to bottom

### Streaming Effect
- Reveal reply text char-by-char, ~30 chars per animation frame
- Uses `requestAnimationFrame` loop
- Respects `prefers-reduced-motion` (instant reveal)
- Cursor blink at end during reveal

### Files modified
- `styles.css`: Typing indicator, new messages pill, cursor blink, markdown styles
- `index.html`: (no changes needed)
- `client.js`: Markdown renderer, typing indicator, scroll management, streaming

## Stage 4: DAG Readability

### Minimap
- 120x80px overlay in bottom-right of `#graphWrap`
- Shows full DAG as tiny colored dots (status-colored)
- White rectangle shows current viewport
- Click/drag to navigate
- Fades to 30% opacity when not hovered, 90% on hover
- Canvas-based for performance

### Node Search
- Search input in DAG card header
- Non-matching nodes fade to 15% opacity
- Matches against id, type, title
- Clear with Escape
- `/` keyboard shortcut to focus

### Status Filter Chips
- Clickable chips below search: open, in_progress, done, failed, needs_human
- Click to activate (dims all other statuses)
- Click again to deactivate
- Multiple active = OR logic
- Color-coded to match status colors

### Collapse Done Nodes
- Toggle button "Hide done" in DAG header
- Collapses all done nodes per layer into single summary node
- Summary node shows count: "12 done"
- Click summary to expand back
- State saved to localStorage

### Zoom Slider
- Replace bare +/- with a range slider between them
- Range: 25% to 400%
- Zoom percentage pill becomes clickable input
- Click to type specific zoom level, Enter to apply

### Files modified
- `styles.css`: Minimap overlay, search input, filter chips, summary nodes, zoom slider
- `index.html`: Minimap canvas, search input, filter chips container, zoom slider
- `client.js`: Minimap rendering, search/filter logic, collapse logic, zoom slider

## Stage 5: Header + Empty States + Micro-interactions

### Header Redesign
- Group controls with subtle 1px separators
- "View" group: Chat, Details, Runs
- "Control" group: Pause, Resume, Replan
- "Workers" group: input + Set
- Separators: `border-left: 1px solid var(--border)` with 8px margin

### Empty States
- Selection: Muted placeholder with instruction text and subtle icon
- Chat: "Ask about your DAG run" with prompt suggestion
- Runs: "No runs yet" with instruction
- Use `.emptyState` class with centered layout

### Micro-interactions
- Node select: brief 1.03x scale then back (150ms)
- Toast progress bar: thin bar at bottom showing dismiss countdown
- Run items: staggered slide-in (30ms per item)
- Node status change: brief flash highlight

### Files modified
- `styles.css`: Separator, empty state, micro-interaction animations
- `index.html`: Separator spans, empty state content
- `client.js`: Micro-interaction triggers, empty state rendering

## Implementation Order

```
Stage 1 (SSE diffing + connection) -> Stage 2 (selection panel) -> Stage 3 (chat) -> Stage 4 (DAG readability) -> Stage 5 (polish)
```

Each stage verified with `node --test` before proceeding.
