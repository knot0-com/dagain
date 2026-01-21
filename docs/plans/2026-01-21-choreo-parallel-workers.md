# Choreo Parallel Workers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add `choreo run --workers N` to execute multiple runnable nodes concurrently under a single supervisor, while keeping edits safe via `ownership`-based resource locks and supporting conflict-prone executor work via optional git worktrees + serialized merges.

**Architecture:** Keep `.choreo/lock` as the single-supervisor authority. The supervisor owns scheduling + DB state transitions (`claimNode`, `applyResult`) and spawns an in-process worker pool that runs runner subprocesses concurrently. Concurrency safety is enforced by an in-memory resource lock table derived from `node.ownership` (empty ownership defaults to a `__global__` write lock). For conflict-heavy executor tasks, optionally run tasks inside isolated worktrees and introduce a required, serialized `merge-*` node to apply changes back to the root workspace before verification/integration.

**Tech Stack:** Node.js (>=18), SQLite (`sqlite3` CLI), `node:test`, git (optional; required for worktree mode).

---

## Success Metrics

- `choreo run --workers 2+` runs multiple nodes in parallel **without corrupting `.choreo/memory/*`** or DB state.
- Verify/research nodes can run concurrently (read locks), executor nodes run concurrently only when ownership is disjoint (write locks), and empty-ownership nodes serialize via `__global__`.
- With overlapping ownership and worktrees enabled, executor nodes can proceed in parallel, and merges serialize deterministically via merge nodes.
- No behavior change when `--workers` is omitted (defaults to `1`).

---

## Scope / Non-goals

**In scope**
- Parallel worker pool for `run`/`resume` with `--workers` + `supervisor.workers`.
- Ownership-based concurrency guardrails (read/write locks).
- Default-safe behavior: empty ownership => `__global__` (serializes).
- Optional worktree mode for executor tasks with a deterministic merge step.
- Tests proving: concurrency happens when allowed; serialization happens when required.

**Out of scope (for this plan)**
- Distributed workers across machines.
- Intelligent file-level diff/merge beyond `git apply --3way`.
- Full UI redesign for interleaved `--live` output (we’ll keep it usable but minimal).

---

## Design Notes (what to build)

### 1) Worker pool scheduling model

- Add `--workers <n>` to `choreo run` and `choreo resume`. Default: `1`.
- Supervisor loop maintains:
  - `maxWorkers`
  - `inFlight` (map of `nodeId -> { runId, promise, locks }`)
  - an `applyQueue` (a promise chain) so **all DB writes + `.choreo/memory/*` writes remain serialized** even when runners run concurrently.
- Dispatch algorithm:
  1) If capacity available, fetch a candidate batch (e.g. `LIMIT 50`) from DB ordered by current priority (verify > task > plan > integrate > final_verify).
  2) Filter by ownership lock availability.
  3) For each accepted node: `claimNode(...)` (atomic), render packet, spawn runner.
  4) On runner completion: enqueue result application onto `applyQueue` (calls `applyResultDb`, `exportWorkgraphJson`, `syncTaskPlan`, `appendProgress`).
  5) When no runnable nodes are available but `inFlight.size > 0`, wait on the next completion (`Promise.race`).

### 2) Ownership-based locks (A + B)

- Convert `node.ownership` into resources:
  - If `ownership` is empty: treat as `["__global__"]`.
  - Otherwise: normalize non-empty strings as-is.
- Lock mode per node:
  - `verifier` + `researcher` roles => **read**
  - everything else => **write**
- Compatibility:
  - read/read => allowed
  - read/write, write/write => blocked
- Integrate/final verify should naturally serialize because:
  - integrate owns union of tasks
  - final-verify ownership is empty => `__global__`

### 3) Worktrees (C)

Add `supervisor.worktrees`:
- `mode`: `"off" | "on-conflict" | "always"` (default `"off"`)
- `dir`: path (default `.choreo/worktrees`)

Behavior (only for `task` nodes / executor role):
- If mode is `always`, run all executor nodes in a worktree.
- If mode is `on-conflict`, run executor nodes in a worktree only when they would be blocked by an ownership write lock conflict.
- When a task runs in a worktree, Choreo must create a mandatory `merge-<taskId>` node:
  - `type: "task"` (executor role), runner: `shellMerge`
  - depends on the executor task
  - ownership: `["__global__"]` (serialize merges)
  - verify nodes should depend on `merge-*` (not the worktree executor) so verification runs against root.

`shellMerge` runner responsibilities:
- `git -C <worktree> status --porcelain` to ensure there are changes
- `git -C <worktree> add -A`
- `git -C <worktree> diff --cached --binary > <artifacts>/patches/<taskId>.patch`
- `git -C <root> apply --3way <patch>` (fail if conflicts)

If a merge fails:
- merge node fails -> escalation plan node gets created (existing failure escalation) and can decide to retry with a different approach.

---

## Implementation Plan (TDD + small commits)

### Task 1: Add `--workers` flag + config default

**Files:**
- Modify: `src/cli.js:34` (usage string), `src/cli.js:1216` (run loop)
- Modify: `src/lib/config.js:24` (defaultConfig supervisor.workers)
- Test: `test/parallel-workers-flag.test.js`

**Step 1: Write the failing test**

Create `test/parallel-workers-flag.test.js`:
- Assert `node bin/choreo.js --help` output contains `--workers`.
- Assert config default includes `supervisor.workers: 1` (read `src/lib/config.js` defaultConfig).

Run: `npm test -- test/parallel-workers-flag.test.js`  
Expected: FAIL (flag not present / default missing).

**Step 2: Implement minimal changes**
- Update `usage()` in `src/cli.js` to include `[--workers=<n>]` on `run`/`resume`.
- Add `supervisor.workers: 1` to `defaultConfig()` in `src/lib/config.js`.

Run: `npm test -- test/parallel-workers-flag.test.js`  
Expected: PASS.

**Step 3: Commit**
- `git add src/cli.js src/lib/config.js test/parallel-workers-flag.test.js`
- `git commit -m "feat(supervisor): add workers config + flag"`

---

### Task 2: Add a DB query to return runnable candidate batches

**Files:**
- Modify: `src/lib/db/nodes.js` (add `selectRunnableCandidates`)
- Test: `test/select-runnable-candidates.test.js`

**Step 1: Write the failing test**

Create `test/select-runnable-candidates.test.js`:
- Initialize a temp choreo DB (same setup pattern as `test/select-sql.test.js`).
- Insert multiple open runnable nodes across types.
- Call `selectRunnableCandidates({ dbPath, nowIso, limit: 10 })`.
- Assert:
  - returned list is ordered with verify nodes first (same rules as `selectNextRunnableNode`)
  - no locked nodes returned
  - blocked deps are excluded

Run: `npm test -- test/select-runnable-candidates.test.js`  
Expected: FAIL (function missing).

**Step 2: Implement**
- Implement `selectRunnableCandidates({ dbPath, nowIso, limit })` in `src/lib/db/nodes.js` by reusing the existing SQL from `selectNextRunnableNode` with `LIMIT <n>`.

Run: `npm test -- test/select-runnable-candidates.test.js`  
Expected: PASS.

**Step 3: Commit**
- `git add src/lib/db/nodes.js test/select-runnable-candidates.test.js`
- `git commit -m "feat(db): select runnable candidates batch"`

---

### Task 3: Implement ownership lock manager (read/write + __global)

**Files:**
- Create: `src/lib/ownership-locks.js`
- Modify: `src/cli.js` (use lock manager during dispatch)
- Test: `test/ownership-locks.test.js`

**Step 1: Write the failing test**

Create `test/ownership-locks.test.js`:
- Import lock manager.
- Assert:
  - empty ownership => `__global__`
  - read/read same resource => allowed
  - write/write same resource => blocked
  - read/write same resource => blocked
  - disjoint resources => allowed

Run: `npm test -- test/ownership-locks.test.js`  
Expected: FAIL (module missing).

**Step 2: Implement minimal lock manager**
- Expose methods like:
  - `normalizeResources(ownershipArray) -> string[]`
  - `modeForRole(role) -> "read"|"write"`
  - `canAcquire({ role, ownership }, inFlightLocks) -> { ok, resources, mode }`
  - `acquire(nodeId, { resources, mode })`
  - `release(nodeId)`

Run: `npm test -- test/ownership-locks.test.js`  
Expected: PASS.

**Step 3: Commit**
- `git add src/lib/ownership-locks.js test/ownership-locks.test.js`
- `git commit -m "feat(supervisor): add ownership lock manager"`

---

### Task 4: Add worker pool to supervisor loop (no worktrees yet)

**Files:**
- Modify: `src/cli.js` (runCommand loop)
- Modify: `src/lib/db/nodes.js` export list (use new select candidates)
- Create: `scripts/mock-sleep-agent.js`
- Test: `test/parallel-workers-scheduling.test.js`

**Step 1: Write failing end-to-end concurrency test**

Create `scripts/mock-sleep-agent.js`:
- Behave like `scripts/mock-agent.js` but:
  - planner emits two independent tasks: `task-a` owns `a.txt`, `task-b` owns `b.txt` (no deps)
  - executor sleeps (e.g. 400ms) before writing its file and returning `<result status=success>`
  - integrator/finalVerifier immediately succeed

Create `test/parallel-workers-scheduling.test.js`:
- `choreo init ...`
- Write `.choreo/config.json` using the mock sleep agent for planner/executor/integrator/finalVerifier and `shellVerify` for verifier (or disable verify nodes by having no verify specs).
- Run `choreo run --workers 2 --max-iterations 50 --interval-ms 0 --no-live --no-color`.
- Read `.choreo/memory/activity.log` and assert:
  - there are `spawn role=executor` entries for both `task-a` and `task-b`
  - `spawn task-b` appears **before** the first `exit ... node=task-a` (proves parallel dispatch)

Run: `npm test -- test/parallel-workers-scheduling.test.js`  
Expected: FAIL (workers not supported; tasks run serially).

**Step 2: Implement worker pool (minimal, safe)**
- In `runCommand`, compute `maxWorkers`:
  - `Number(flags.workers ?? config.supervisor?.workers ?? 1)` (clamp to `>=1`)
- Replace the “select one node then await executeNode” with:
  - dispatch loop that fills capacity from `selectRunnableCandidates`
  - uses ownership locks to decide which to spawn
  - uses `claimNode` before spawning
  - uses a serialized `applyQueue` to apply DB + memory updates (avoid `.choreo/memory/*` races)
  - when nothing runnable and `inFlight.size > 0`, `await Promise.race([...inFlightPromises])`

Run: `npm test -- test/parallel-workers-scheduling.test.js`  
Expected: PASS.

**Step 3: Commit**
- `git add src/cli.js src/lib/db/nodes.js scripts/mock-sleep-agent.js test/parallel-workers-scheduling.test.js`
- `git commit -m "feat(supervisor): run nodes with worker pool"`

---

### Task 5: Enforce serialization on ownership conflicts (write/write) + allow read/read

**Files:**
- Modify: `scripts/mock-sleep-agent.js` (add modes for tests)
- Test: `test/parallel-workers-locking.test.js`

**Step 1: Write failing tests**

Create `test/parallel-workers-locking.test.js` with two subtests:

1) **Write/write conflict serializes**
- Planner emits `task-a` and `task-b` both owning `shared.txt`.
- Run with `--workers 2`.
- Assert in `activity.log` that `spawn task-b` occurs **after** `exit ... node=task-a`.

2) **Read/read allows concurrency**
- Seed DB directly after init with two verify nodes `verify-1`, `verify-2` both owning `shared.txt`, no deps.
- Set verifier runner to the mock sleep agent role `verifier` (sleep + success).
- Run with `--workers 2`.
- Assert `spawn verify-2` occurs **before** first `exit ... node=verify-1`.

Run: `npm test -- test/parallel-workers-locking.test.js`  
Expected: FAIL (no locking or incorrect mode rules).

**Step 2: Implement / fix lock integration**
- Ensure role->mode mapping uses `resolveNodeRole(node)`:
  - `verifier`/`researcher` => read
  - all others => write
- Ensure empty ownership becomes `__global__`.

Run: `npm test -- test/parallel-workers-locking.test.js`  
Expected: PASS.

**Step 3: Commit**
- `git add src/cli.js scripts/mock-sleep-agent.js test/parallel-workers-locking.test.js`
- `git commit -m "feat(supervisor): gate parallelism by ownership locks"`

---

### Task 6: Make `--live` usable with workers > 1 (minimal UX)

**Files:**
- Modify: `src/cli.js` (runner tee prefixes)
- Test: `test/parallel-workers-live-prefix.test.js`

**Step 1: Write failing test**
- Run a short `--workers 2 --live` run with mock sleep agent.
- Assert stdout contains prefixed lines that include node id (or role+node) for disambiguation.

Run: `npm test -- test/parallel-workers-live-prefix.test.js`  
Expected: FAIL.

**Step 2: Implement**
- When `workers > 1`, set `teePrefix` to include `node.id` (e.g. `│ task-a │ `) so interleaving is readable.
- Consider disabling spinner when `workers > 1` (avoid messy terminal output).

Run: `npm test -- test/parallel-workers-live-prefix.test.js`  
Expected: PASS.

**Step 3: Commit**
- `git add src/cli.js test/parallel-workers-live-prefix.test.js`
- `git commit -m "chore(ui): prefix live output in worker mode"`

---

### Task 7: Add worktree mode config + shell merge runner (C)

**Files:**
- Modify: `src/lib/config.js` (add `supervisor.worktrees`)
- Modify: `src/cli.js` (dispatch: choose workspace cwd per node; insert merge node)
- Create: `scripts/shell-merge.js`
- Modify: `templates/planner.md` (remind about ownership + worktree compatibility)
- Test: `test/worktrees-parallel-executors.test.js`

**Step 1: Write failing test**

Create `test/worktrees-parallel-executors.test.js`:
- Create a temp dir, `git init`, commit a baseline file.
- Configure choreo with:
  - `supervisor.workers=2`
  - `supervisor.worktrees.mode="always"`
  - executor runner = mock sleep agent that edits the same file (so ownership conflicts would exist)
  - shell merge runner enabled as `shellMerge`
- Planner emits two executor tasks that both edit `shared.txt` and set `ownership=["shared.txt"]`.
- Ensure Choreo inserts `merge-task-a` and `merge-task-b` nodes, and verify/integrate depend on merges.
- Run `choreo run ...`
- Assert final `shared.txt` in root includes both expected edits OR merge conflict produces a failed merge node deterministically.

Run: `npm test -- test/worktrees-parallel-executors.test.js`  
Expected: FAIL (worktrees/merge missing).

**Step 2: Implement worktree execution + merge nodes**
- Add config parsing and defaults (mode off).
- Implement helper:
  - `ensureWorktree({ nodeId, attempt }) -> worktreePath`
- During dispatch, pick `cwd`:
  - executor node => worktreePath (if enabled)
  - everything else => root
- When a task is assigned a worktree, insert `merge-<taskId>` node via `applyResultDb` `next.addNodes` or directly in supervisor before execution (choose one; keep deterministic).
- Implement `scripts/shell-merge.js` and add runner in config docs/tests.

Run: `npm test -- test/worktrees-parallel-executors.test.js`  
Expected: PASS (either successful merges or deterministic failure).

**Step 3: Commit**
- `git add src/lib/config.js src/cli.js scripts/shell-merge.js templates/planner.md test/worktrees-parallel-executors.test.js`
- `git commit -m "feat(worktrees): isolate executor edits and merge serially"`

---

## Smoke (manual)

From any repo:
- `choreo init --goal "..." --no-refine --force`
- `choreo run --workers 4 --interval-ms 0`

If you see `database is locked`, increase SQLite timeout (already set to `.timeout 5000`) and ensure the repo is on a local filesystem.

