# Terminal Dependency Semantics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support dependency edges that are satisfied by terminal states (`done` OR `failed`) so escalation nodes (and future on-failure workflows) can run without being blocked by default `done`-only deps.

**Architecture:** Add a `deps.required_status` column (default `done`). Update the DB scheduler query to treat each dep as satisfied based on `required_status`. Update “graph blocked by failed deps” logic to only consider `done`-required edges. Set escalation edges to `required_status='terminal'`.

**Tech Stack:** Node.js (`node:test`), SQLite (`sqlite3` CLI), Dagain CLI (`src/cli.js`)

---

### Task 1: Add `deps.required_status` + idempotent migration

**Files:**
- Modify: `src/lib/db/schema.sql`
- Create: `src/lib/db/migrate.js`
- Modify: `src/cli.js`
- Test: `test/db-migrate-required-status.test.js`

**Step 1: Write failing migration test**

Create `test/db-migrate-required-status.test.js` that:
- Creates a temp sqlite DB with a minimal `deps(node_id, depends_on_id)` table (no `required_status`)
- Calls `ensureDepsRequiredStatusColumn({ dbPath })`
- Asserts `PRAGMA table_info(deps)` contains `required_status` with default `done`

Run: `npm test -- test/db-migrate-required-status.test.js`
Expected: FAIL (missing export/function)

**Step 2: Implement migration helper**

Create `src/lib/db/migrate.js`:
- Export `ensureDepsRequiredStatusColumn({ dbPath })`
- Query `PRAGMA table_info(deps);` via `sqliteQueryJson`
- If column missing: run `ALTER TABLE deps ADD COLUMN required_status TEXT NOT NULL DEFAULT 'done';`

**Step 3: Wire migration into the CLI**

In `src/cli.js`:
- After `.dagain/state.sqlite` existence checks in `runCommand`, call `ensureDepsRequiredStatusColumn({ dbPath: paths.dbPath })`
- In `initCommand`, call it after schema creation (harmless/no-op for new DBs)

Run: `npm test`
Expected: PASS

---

### Task 2: Update runnable-node selection to respect per-edge requirements

**Files:**
- Modify: `src/lib/db/nodes.js`
- Test: `test/failure-escalation.test.js`

**Step 1: Write failing test for “terminal deps are runnable”**

Update `test/failure-escalation.test.js`:
- After `applyResult` marks node `a` as `failed`, call `selectNextRunnableNode({ dbPath })`
- Assert it returns `plan-escalate-a`

Run: `npm test -- test/failure-escalation.test.js`
Expected: FAIL (escalation still blocked)

**Step 2: Update `selectNextRunnableNode` SQL**

In `src/lib/db/nodes.js`, change the dep gate from “dep.status <> 'done'” to:
- `required_status='done'` → dep must be `done`
- `required_status='terminal'` → dep must be `done` or `failed`

Run: `npm test -- test/failure-escalation.test.js`
Expected: PASS

---

### Task 3: Ensure “blocked by failed deps” only considers `done` deps

**Files:**
- Modify: `src/lib/db/nodes.js`
- Test: `test/deadlock-auto-reset.test.js`

**Step 1: Update failed-deps query**

Update `listFailedDepsBlockingOpenNodes` to only include failed deps where the edge requires `done` (default/missing treated as `done`).

**Step 2: Run existing auto-reset test**

Run: `npm test -- test/deadlock-auto-reset.test.js`
Expected: PASS

---

### Task 4: Set escalation deps to `required_status='terminal'`

**Files:**
- Modify: `src/lib/db/nodes.js`
- Test: `test/failure-escalation.test.js`

**Step 1: Update escalation dep insert**

In `applyResult`, when inserting the dep row for `plan-escalate-${nodeId}`, include `required_status='terminal'`.

**Step 2: Assert in test**

In `test/failure-escalation.test.js`, assert the dep row has `required_status='terminal'`.

Run: `npm test`
Expected: PASS

