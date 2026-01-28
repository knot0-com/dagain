# Dagain setStatus + SQLite Timeout Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `next.setStatus` in `<result>` actually take effect (so escalation/planner nodes can reopen or otherwise update node statuses), and harden SQLite operations for concurrent writes by adding a busy timeout.

**Architecture:** Extend the DB-backed `applyResult` implementation (`src/lib/db/nodes.js`) to process `result.next.setStatus[]` entries in a validated, conservative way (support `{id,...}` and `{nodeId,...}`; ignore invalid ids/statuses; clear locks on changes; reset attempts when reopening). Add a small SQLite busy timeout via `sqlite3` CLI flags so parallel node/microcall KV writes don’t fail with transient `database is locked`.

**Tech Stack:** Node.js, `sqlite3` CLI, existing `node:test` suite.

---

### Task 1: Implement `next.setStatus` in DB applyResult

**Files:**
- Modify: `src/lib/db/nodes.js`
- Test: `test/apply-result-setstatus.test.js`

**Step 1: Write failing test**

Create `test/apply-result-setstatus.test.js`:
- Create a temp SQLite DB initialized with `src/lib/db/schema.sql`.
- Insert two nodes:
  - `a` (any type) in `in_progress` (so we can call `applyResult` on it)
  - `b` in `failed` with `attempts=1` (or any non-zero)
- Call `applyResult({ dbPath, nodeId: "a", runId: "r", result: { status:"success", next:{ addNodes:[], setStatus:[{ id:"b", status:"open" }]}}})`.
- Assert node `b` becomes:
  - `status='open'`
  - `attempts=0`
  - lock fields cleared (`lock_run_id` etc are `NULL`)

Run: `npm test -- test/apply-result-setstatus.test.js`  
Expected: FAIL (no status change applied).

**Step 2: Implement minimal support**

In `src/lib/db/nodes.js` `applyResult`:
- Parse `result?.next?.setStatus` as an array
- Accept id from `entry.id` or `entry.nodeId`
- Accept statuses from the existing internal set:
  - `open`, `done`, `failed`, `needs_human`
- For `open`:
  - reset `attempts=0`
  - clear checkpoint + lock fields
  - set `completed_at=NULL`
- For `done`/`failed`:
  - clear lock fields
  - set `completed_at=now` (only if moving into a terminal state)
- Ignore entries with unknown node ids or invalid statuses.

Run: `npm test -- test/apply-result-setstatus.test.js`  
Expected: PASS.

**Step 3: Commit**

Run:
- `git add src/lib/db/nodes.js test/apply-result-setstatus.test.js`
- `git commit -m "fix(db): apply next.setStatus in applyResult"`

---

### Task 2: Add SQLite busy timeout to reduce write contention failures

**Files:**
- Modify: `src/lib/db/sqlite3.js`

**Step 1: Implement timeout**

In `src/lib/db/sqlite3.js`:
- Add sqlite shell timeout via args:
  - `sqlite3 -cmd ".timeout 5000" ...`

Run: `npm test`  
Expected: PASS.

**Step 2: Commit**

Run:
- `git add src/lib/db/sqlite3.js`
- `git commit -m "chore(db): set sqlite busy timeout"`

---

### Task 3: Document / validate in a real run (smoke)

**Files:**
- (Optional) Modify: `docs/fast-config.md`

**Step 1: Smoke**

In a small target repo, run a goal that triggers an escalation planner that uses `next.setStatus` to reopen a verify node, and confirm it actually reopens without relying on auto-reset.

**Step 2: Doc (optional)**

Add a short note that `next.setStatus` is supported and preferred for reopening failed nodes during escalations.

