# Choreo Chat Rich Graph Ops Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Let `choreo chat` route natural language into safe, explicit “graph ops” that can add/update nodes and add/remove dependencies in the SQLite workgraph.

**Architecture:** Keep the LLM as a pure planner/router that emits `ops[]` JSON. Choreo remains the sole authority that mutates SQLite by executing a small, validated op surface area (`node.add`, `node.update`, `dep.add`, `dep.remove`). After any graph mutation, export a graph snapshot and re-sync `workgraph.json` for human readability.

**Tech Stack:** Node.js (>=18), SQLite (`sqlite3` CLI), `node:test`, existing DB helpers in `src/lib/db/*`.

---

## Task 1: Add an end-to-end failing test for “rich graph ops”

**Files:**
- Create: `scripts/mock-chat-router-graph-ops.js`
- Create: `test/chat-graph-ops.test.js`

**Step 1: Write a failing integration test**

Create `test/chat-graph-ops.test.js` that:
- Initializes a temp project via `choreo init --goal X --no-refine`.
- Configures a `mock` runner pointing at `scripts/mock-chat-router-graph-ops.js`.
- Runs `choreo chat --runner mock` with two free-form messages:
  1) returns ops that add two tasks with rich metadata (inputs/ownership/acceptance/verify/retryPolicy) and a dependency between them
  2) returns ops that update metadata on an existing node
- Asserts:
  - `nodes.*_json` columns are set as expected
  - `deps.required_status` is set/updated as expected

Run: `npm test -- test/chat-graph-ops.test.js`  
Expected: FAIL (ops not supported yet)

**Step 2: Add the mock router**

Create `scripts/mock-chat-router-graph-ops.js` that:
- Reads the router packet path from argv.
- Switches on `User: ...` to return different ops per turn.

Re-run: `npm test -- test/chat-graph-ops.test.js`  
Expected: still FAIL

---

## Task 2: Implement CLI primitives for deps and node metadata

**Files:**
- Modify: `src/cli.js`

**Step 1: Add `choreo dep add/remove`**
- `dep add` upserts into `deps(node_id, depends_on_id, required_status)`.
- `dep remove` deletes the row.
- After each op, re-export graph snapshot and call `syncTaskPlan`.

Run: `npm test -- test/chat-graph-ops.test.js`  
Expected: still FAIL

**Step 2: Extend `choreo node add` to accept rich fields**
- Accept optional `inputs`, `ownership`, `acceptance`, `verify`, `retryPolicy`, `dependsOn`.
- Store JSON columns directly into `nodes.*_json` (defaulting to empty arrays / default retry policy).
- Insert dependencies (default required_status=`done`).

Run: `npm test -- test/chat-graph-ops.test.js`  
Expected: still FAIL

**Step 3: Add `choreo node update`**
- Patch node metadata fields (no implicit dep rewrites).
- Refuse to update locked nodes unless `--force`.
- Re-export + sync after mutation.

Run: `npm test -- test/chat-graph-ops.test.js`  
Expected: still FAIL

---

## Task 3: Wire chat ops → CLI primitives

**Files:**
- Modify: `src/cli.js`
- Test: `test/chat-graph-ops.test.js`

**Step 1: Expand router “Allowed ops”**
- Document:
  - `node.add` rich fields
  - `node.update`
  - `dep.add` / `dep.remove`

**Step 2: Execute new ops in the chat loop**
- Handle `node.update`, `dep.add`, `dep.remove`.
- Pass rich `node.add` fields through to `nodeCommand`.

Run: `npm test -- test/chat-graph-ops.test.js`  
Expected: PASS

---

## Task 4: Full suite

Run: `npm test`  
Expected: PASS

