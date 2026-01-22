# Choreo Mailbox Supervisor Controls Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add a DB-backed mailbox so `choreo chat` can control a running supervisor (pause/resume, set workers, replan now, cancel node) without signals.

**Architecture:** Introduce a `mailbox` table in `.choreo/state.sqlite` that acts as a command queue. Chat (and a new `choreo control ...` CLI) enqueue commands. The supervisor runs a background poller that claims and acks commands, updates in-memory control state (paused, maxWorkers), and can cancel in-flight node runs via per-node abort controllers. Replan is implemented by reopening `plan-000` and pausing launches of non-planner nodes until the planner finishes.

**Tech Stack:** Node.js (>=18), SQLite (`sqlite3` CLI), `node:test`, existing Choreo supervisor loop.

---

## Success Metrics

- `choreo control pause|resume|set-workers|replan|cancel` enqueues commands and prints an id.
- A running `choreo run` responds to mailbox commands within ~250ms.
- `pause` stops *launching* new nodes (in-flight nodes complete); `resume` continues.
- `set-workers` changes the maximum in-flight node runs without restart (downscale should prevent new spawns until below limit).
- `cancel` aborts a specific in-flight node run and unlocks it back to `open`.
- `replan` reopens `plan-000` and pauses launching non-planner nodes until `plan-000` leaves `open/in_progress` (done/failed).
- `npm test` passes.

---

## Task 1: Add mailbox table + migration

**Files:**
- Modify: `src/lib/db/schema.sql`
- Modify: `src/lib/db/migrate.js`
- Modify: `src/cli.js`
- Test: `test/mailbox-migration.test.js`

**Step 1: Write failing test**

Create `test/mailbox-migration.test.js`:
- Init a tmp project (`choreo init --no-refine`).
- Simulate an old DB by dropping `mailbox`.
- Run `choreo run --once --dry-run` to force migrations.
- Assert `mailbox` table exists again.

Run: `npm test -- test/mailbox-migration.test.js`  
Expected: FAIL (table missing)

**Step 2: Implement schema + migration**

- Add `CREATE TABLE IF NOT EXISTS mailbox (...)` + indexes to `src/lib/db/schema.sql`.
- Add `ensureMailboxTable({ dbPath })` to `src/lib/db/migrate.js` (idempotent).
- Call `ensureMailboxTable` at the start of `runCommand(...)` and before any CLI command that enqueues mailbox commands.

Run: `npm test -- test/mailbox-migration.test.js`  
Expected: PASS

---

## Task 2: Add mailbox DB helpers

**Files:**
- Create: `src/lib/db/mailbox.js`
- Test: `test/mailbox-db.test.js`

**Step 1: Write failing test**

Create `test/mailbox-db.test.js`:
- Init tmp project DB.
- Enqueue `pause`, claim from a fake supervisor (`pid/host`), mark done.
- Assert status transitions: `pending -> processing -> done` and `set-workers` args persist as JSON.

Run: `npm test -- test/mailbox-db.test.js`  
Expected: FAIL (module/functions missing)

**Step 2: Implement helpers**

Implement in `src/lib/db/mailbox.js`:
- `mailboxEnqueue({ dbPath, command, args, nowIso }) -> { id }`
- `mailboxClaimNext({ dbPath, pid, host, nowIso }) -> { id, command, args } | null`
- `mailboxAck({ dbPath, id, status, result, errorText, nowIso })`

Run: `npm test -- test/mailbox-db.test.js`  
Expected: PASS

---

## Task 3: Add `choreo control` CLI wrapper

**Files:**
- Modify: `src/cli.js`
- Test: `test/control-cli.test.js`

**Step 1: Write failing test**

Create `test/control-cli.test.js`:
- Init tmp project.
- Run `choreo control pause` and assert a mailbox row exists with `command='pause'` and `status='pending'`.
- Run `choreo control set-workers --workers 3` and assert args_json includes `{"workers":3}`.

Run: `npm test -- test/control-cli.test.js`  
Expected: FAIL (command missing)

**Step 2: Implement control command**

In `src/cli.js`:
- Add `control` to `usage()`.
- Dispatch `command === "control"` to `controlCommand(...)`.
- Implement subcommands: `pause`, `resume`, `set-workers`, `replan`, `cancel --node <id>`.

Run: `npm test -- test/control-cli.test.js`  
Expected: PASS

---

## Task 4: Supervisor mailbox poller + enforcement

**Files:**
- Modify: `src/cli.js`
- Test: `test/mailbox-supervisor.test.js`

**Step 1: Write failing integration tests**

Create `test/mailbox-supervisor.test.js` with 3 scenarios (use `scripts/mock-sleep-agent.js`):

1) **pause/resume gates scheduling**
- Seed `plan-000=done`, add `task-a`, `task-b` open (sleep ~200ms).
- Start `choreo run` in background (workers=1).
- Wait for `task-a` in_progress.
- `choreo control pause`.
- Wait `task-a` done, assert `task-b` stays `open` for ~300ms.
- `choreo control resume`, await run exit 0.

2) **set-workers downscales concurrency**
- Seed `plan-000=done`, add 3 tasks open (sleep ~300ms).
- Start `choreo run --workers 2` in background.
- Wait 2 tasks in_progress, then `choreo control set-workers --workers 1`.
- When 1 finishes, assert the 3rd task is still `open` until the 2nd finishes.

3) **cancel aborts a running node**
- Seed `plan-000=done`, add `task-long` open (sleep ~5000ms).
- Start `choreo run` in background.
- Wait `task-long` in_progress.
- `choreo control pause` (prevents immediate restart)
- `choreo control cancel --node task-long`
- Assert node becomes `open` and `lock_run_id` clears quickly.
- Mark node `done` via `choreo node set-status`.
- `choreo control resume`, await run exits.

Run: `npm test -- test/mailbox-supervisor.test.js`  
Expected: FAIL (no mailbox behavior)

**Step 2: Implement supervisor integration**

In `runCommand(...)`:
- Ensure mailbox table exists.
- Track supervisor control state:
  - `manualPaused` boolean
  - `replanPaused` boolean (blocks non-planner launches)
  - `maxWorkers` (dynamic)
  - per-node `AbortController` map for in-flight nodes
- Start a background async poll loop that:
  - claims mailbox commands
  - mutates control state
  - for `cancel`, aborts the per-node controller
  - for `replan`, reopens `plan-000` and sets `replanPaused=true`
  - acks commands done/failed with a small result payload
- Enforce gating:
  - when paused, do not select/spawn new nodes (except allow planner nodes when `replanPaused`)
  - use dynamic `maxWorkers` in worker dispatch
  - clear `replanPaused` when `plan-000` finishes (success/fail)

Run: `npm test -- test/mailbox-supervisor.test.js`  
Expected: PASS

---

## Task 5: Wire chat slash commands to mailbox controls

**Files:**
- Modify: `src/cli.js`
- Test: `test/chat-controls.test.js` (lightweight, no supervisor)

**Step 1: Add REPL commands**

In `chatCommand(...)` add:
- `/pause`, `/resume`
- `/workers <n>`
- `/replan`
- `/cancel <nodeId>`

They should call `controlCommand(...)` internally.

**Step 2: Test**

Create `test/chat-controls.test.js`:
- Init tmp project, run `choreo chat --no-llm` with piped stdin, send `/pause` then `/exit`.
- Assert it prints a confirmation and exits 0.

Run: `npm test -- test/chat-controls.test.js`  
Expected: PASS

---

## Task 6: Full suite

Run: `npm test`  
Expected: PASS

