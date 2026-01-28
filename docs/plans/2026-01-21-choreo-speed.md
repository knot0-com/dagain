# Dagain Speed Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Dagain runs complete significantly faster by reducing full LLM invocations (especially for verification) and preventing runaway node explosion during escalation.

**Architecture:** (1) Add a non‑LLM “shell verifier” runner that executes `node.verify` commands directly and returns a `<result>` without calling Codex/Claude/Gemini. (2) Update scaffolding + templates so planners don’t create duplicate integrate/final-verify nodes and verifiers don’t spawn endless fix chains. (3) Add a “thin packet” option that reduces repeated context sent to coding agents. Keep everything backwards compatible and configurable.

**Tech Stack:** Node.js (`node:test`), SQLite (`sqlite3` CLI), Dagain CLI (`src/cli.js`)

---

## Success Metrics (what “faster” means)

- A “small” project (≈3–5 tasks) should complete with **≤ 1 LLM call per task** (executor only) plus **≤ 1 LLM call per escalation**, not per verify node.
- Default runs should make **verify nodes non‑LLM** and cut wall clock by ~2–5× for typical repos (depends on model latency).
- Node count should not blow up from repeated integrate/final-verify creation during escalations.

---

### Task 1: Add a non‑LLM shell verifier runner (fast verify)

**Files:**
- Create: `scripts/shell-verifier.js`
- Test: `test/shell-verifier.test.js`
- (Optional doc): `README.md` (brief mention)

**Step 1: Write failing tests**

Create `test/shell-verifier.test.js`:
- Create a temp SQLite DB with `src/lib/db/schema.sql`
- Insert a `nodes` row with `verify_json` containing 2 commands:
  - success case: `["node -e \"process.exit(0)\""]`
  - fail case: `["node -e \"process.exit(1)\""]`
- Spawn `node scripts/shell-verifier.js` with env:
  - `DAGAIN_DB=<dbPath>`
  - `DAGAIN_NODE_ID=<nodeId>`
- Assert it prints `<result>...</result>` and:
  - success → `status:"success"`
  - fail → `status:"fail"` and includes the failing command in `errors`

Run: `npm test -- test/shell-verifier.test.js`
Expected: FAIL (script missing)

**Step 2: Implement minimal runner**

Implement `scripts/shell-verifier.js`:
- Read `DAGAIN_DB`, `DAGAIN_NODE_ID` env
- `sqlite3 -json` (or reuse JS spawn) to fetch `verify_json` for the node
- Execute each command via `bash -lc <cmd>` (sequentially)
- Emit `<result>`:
  - `status:"success"` if all exit 0
  - otherwise `status:"fail"`, `summary` with first failing command + exit code, and `errors` array

Run: `npm test -- test/shell-verifier.test.js`
Expected: PASS

**Step 3: Commit**

Run:
- `git add scripts/shell-verifier.js test/shell-verifier.test.js`
- `git commit -m "feat(verify): add non-LLM shell verifier runner"`

---

### Task 2: Configure verify nodes to use shell verifier by default

**Files:**
- Modify: `src/lib/config.js:24`
- Modify: `src/cli.js:2088` (planner scaffolding)
- Test: `test/scaffold-default-verifier-runner.test.js`

**Step 1: Write failing test**

Create `test/scaffold-default-verifier-runner.test.js`:
- Create a temp dagain project (similar to `test/planner-scaffold.test.js`)
- Write `.dagain/config.json` that defines:
  - `runners.shellVerify: { cmd: "node <abs>/scripts/shell-verifier.js" }`
  - `defaults.verifyRunner: "shellVerify"`
  - planner/executor can be mock agents (existing scripts)
- Use a mock planner that outputs **tasks only** (so scaffolding creates verify nodes).
- Run `dagain run --max-iterations 2 --interval-ms 0 --no-live --no-color` (iteration 1 runs the planner; iteration 2 runs scaffolding and exits before executing tasks).
- Query sqlite `nodes` for created `verify-*` nodes and assert `runner='shellVerify'`.

Run: `npm test -- test/scaffold-default-verifier-runner.test.js`
Expected: FAIL (runner not set)

**Step 2: Implement config default + scaffolding runner assignment**

In `src/lib/config.js`, extend `defaultConfig()`:
- Add `defaults.verifyRunner: "shellVerify"` and a default runner entry:
  - `runners.shellVerify.cmd = "node scripts/shell-verifier.js"` (use `{packet}` if needed)

In `ensurePlannerScaffolding` (`src/cli.js`):
- When creating verify nodes, set `runner` to `config.defaults.verifyRunner` when present.
- Keep existing behavior if unset (runner null → role-based runner pick).

Run: `npm test -- test/scaffold-default-verifier-runner.test.js`
Expected: PASS

**Step 3: Commit**

Run:
- `git add src/lib/config.js src/cli.js test/scaffold-default-verifier-runner.test.js`
- `git commit -m "feat(verify): default verify nodes to shell runner"`

---

### Task 3: Stop planner from generating duplicate integrate/final-verify nodes (node count control)

**Files:**
- Modify: `templates/planner.md`
- Modify: `src/cli.js:2088` (if needed)
- (Optional) Test: `test/node-count-does-not-explode.test.js`

**Step 1: Change planner instructions**

In `templates/planner.md`, change “Planning Rules”:
- Remove the requirement that planners must add `integrate-*` and `final-verify-*` nodes.
- Encourage “tasks-only” planning:
  - Add 2–6 `task-*` nodes max
  - (Optional) add `verify-*` nodes, but only if it’s essential; otherwise rely on Dagain scaffolding.
- Add guardrail: “Do not create additional integrate/final-verify nodes; Dagain will scaffold them.”

**Step 2: Manual smoke run**

Run a small goal and confirm the planner produces fewer nodes:
- `dagain init --goal "…" --no-refine --force`
- `dagain run`
Expected: only one integrate and one final-verify (scaffolded), not one per escalation.

**Step 3: Commit**

Run:
- `git add templates/planner.md`
- `git commit -m "docs(planner): avoid integrate/final-verify duplication"`

---

### Task 4: Add “thin packet” mode to reduce LLM context size (optional but high leverage)

**Files:**
- Modify: `src/cli.js:1809` (packet construction)
- Modify: `templates/*.md`
- Test: `test/packet-thin-mode.test.js`

**Step 1: Write failing test**

Create `test/packet-thin-mode.test.js`:
- Run a single node with a mock runner that prints the packet length.
- Add config `supervisor.packetMode: "thin"`
- Assert packet does **not** embed `TASK_PLAN_DRAFT`, `FINDINGS_DRAFT`, `PROGRESS_DRAFT` for executor/verifier roles.

Run: `npm test -- test/packet-thin-mode.test.js`
Expected: FAIL

**Step 2: Implement thin mode**

In `src/cli.js`:
- Add `supervisor.packetMode` config (`"full"` default, `"thin"` optional)
- For `"thin"`:
  - Keep GOAL draft for planner + finalVerifier
  - For executor/verifier/integrator: omit drafts (or truncate heavily, e.g. 1–2KB)

Run: `npm test -- test/packet-thin-mode.test.js`
Expected: PASS

**Step 3: Commit**

Run:
- `git add src/cli.js templates test/packet-thin-mode.test.js`
- `git commit -m "feat(packet): add thin packet mode"`

---

### Task 5: Benchmark and document recommended “fast config”

**Files:**
- Modify: `README.md`
- (Optional) Create: `docs/fast-config.md`

**Step 1: Add a documented “fast profile”**

Document recommended settings:
- `defaults.retryPolicy.maxAttempts = 1`
- `defaults.verifyRunner = "shellVerify"`
- `supervisor.idleSleepMs = 0`
- runner flags like `model_reasoning_effort="low|medium"` for executor/planner

**Step 2: Run benchmark**

Use the JSON-RPC demo style goal and record:
- node count
- number of LLM runner invocations (planner/executor only)
- wall time estimate

**Step 3: Commit**

Run:
- `git add README.md docs/fast-config.md`
- `git commit -m "docs(perf): document fast dagain profile"`

