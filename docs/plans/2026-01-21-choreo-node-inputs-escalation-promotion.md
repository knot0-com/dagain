# Choreo Node Inputs + Escalation Promotion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Make node-to-node context handoff DB-first and lightweight by (1) auto-writing key run artifacts/summary to SQLite KV, (2) rendering `inputs_json` into packets, and (3) promoting terminal failures up the plan hierarchy instead of creating nested `plan-escalate-plan-escalate-*` chains.

**Architecture:** The supervisor writes a small, durable “execution envelope” (`out.summary`, `out.last_stdout_path`, `out.last_result_path`, `err.summary`) into `kv_latest/kv_history` after every runner finishes. Packet rendering resolves `nodes.inputs_json` refs and prints DB pointers (ref + small inline previews) so sub-agents start fresh yet have the minimal context needed. Failure escalation in `applyResult` creates/targets `plan-escalate-*` nodes at the correct parent plan level (and “promotes” to parent plans when an escalation node fails).

**Tech Stack:** Node.js (>=18), SQLite (`sqlite3` CLI), `node:test`

---

## Success Metrics

- Any node run results in KV keys:
  - `out.summary` (always)
  - `out.last_stdout_path` + `out.last_result_path` (always)
  - `err.summary` (only when status != `success`)
- Packets include a **Node Inputs** section rendered from `nodes.inputs_json`:
  - shows `nodeId:key` refs
  - optionally inlines small `value_text` previews (bounded; no packet bloat)
- Escalation is hierarchical:
  - task failure → creates `plan-escalate-<taskId>` under the task’s parent plan
  - escalation failure → creates `plan-escalate-<parentPlanId>` under the parent plan’s parent (promote)
  - does **not** create `plan-escalate-plan-escalate-*`

---

## Task 1: Auto-write required KV outputs after each node run

**Files:**
- Modify: `src/cli.js` (in `executeNode()` apply outcome path)
- Test: `test/auto-kv-envelope.test.js`

**Step 1: Write the failing test**

Create `test/auto-kv-envelope.test.js`:
- Create a tmp choreo project via `choreo init --no-refine`.
- Configure runner `mock` that outputs `<result>` with `status:"fail"` and `summary:"boom"`.
- Run `choreo run --max-iterations 1 --interval-ms 0 --no-live --no-color`.
- Query sqlite `kv_latest` for node `plan-000` and assert keys exist:
  - `out.summary` == `"boom"`
  - `out.last_stdout_path` points at `.choreo/runs/<run>/stdout.log`
  - `out.last_result_path` points at `.choreo/runs/<run>/result.json`
  - `err.summary` == `"boom"`

Run: `npm test -- test/auto-kv-envelope.test.js`  
Expected: FAIL (keys missing)

**Step 2: Implement minimal supervisor KV writes**

In `executeNode()` after `result` is finalized (and before/around `applyOutcome`), call `kvPut` for:
- `out.summary` from `result.summary` (string, possibly empty)
- `out.last_stdout_path` from stdout log path
- `out.last_result_path` from result json path
- `err.summary` when final status != `success` (prefer `result.summary`, else first `result.errors[]`)

Run: `npm test -- test/auto-kv-envelope.test.js`  
Expected: PASS

---

## Task 2: Render `nodes.inputs_json` into runner packets

**Files:**
- Modify: `src/cli.js` (packet rendering)
- Modify: `templates/{planner,executor,verifier,integrator,final-verifier}*.md`
- Test: `test/packet-node-inputs.test.js`

**Step 1: Write the failing test**

Create `test/packet-node-inputs.test.js`:
- Create tmp choreo project via `choreo init --no-refine`.
- Pre-populate DB:
  - `kvPut(__run__:ctx.foo="bar")`
  - `UPDATE nodes SET inputs_json='[{\"nodeId\":\"__run__\",\"key\":\"ctx.foo\",\"as\":\"foo\"}]' WHERE id='plan-000'`
- Configure runner to `scripts/mock-agent-packet-dump.js` so it writes `packet_seen.md`.
- Run `choreo run --max-iterations 1 --interval-ms 0 --no-live --no-color`.
- Assert `packet_seen.md` contains a Node Inputs section with `__run__:ctx.foo` (and includes `bar` preview if inlining is enabled).

Run: `npm test -- test/packet-node-inputs.test.js`  
Expected: FAIL (no Node Inputs in packet)

**Step 2: Implement input rendering**

In `src/cli.js`:
- Add a new template var: `NODE_INPUTS`.
- Implement a small resolver:
  - parse `node.inputs`
  - for `{nodeId,key,as}` entries, `SELECT` `kv_latest` for previews
  - render as markdown bullets; inline preview only up to a small cap (e.g. 2KB) and truncate.

In templates:
- Add a `## Node Inputs` section that prints `{{NODE_INPUTS}}` near `Resume Context`.

Run: `npm test -- test/packet-node-inputs.test.js`  
Expected: PASS

---

## Task 3: Promote failed escalation nodes up the plan hierarchy

**Files:**
- Modify: `src/lib/db/nodes.js` (in `applyResult` failure escalation block)
- Test: `test/failure-escalation-promotion.test.js`

**Step 1: Write the failing test**

Create `test/failure-escalation-promotion.test.js`:
- Build a small hierarchy in sqlite:
  - `plan-root` (parent NULL)
  - `plan-child` (parent `plan-root`)
  - `task-a` (parent `plan-child`, retryPolicy maxAttempts=1)
  - `plan-escalate-task-a` (parent `plan-child`, retryPolicy maxAttempts=1)
- Apply a permanent failure to `plan-escalate-task-a` via `applyResult(... status:"fail")` twice.
- Assert a promoted escalation node exists:
  - `id='plan-escalate-plan-child'` (escalate the parent plan)
  - `parent_id='plan-root'` (promoted one level)
  - dependency on `plan-escalate-task-a` with `required_status='terminal'`
- Assert **no** nested node `plan-escalate-plan-escalate-task-a` exists.

Run: `npm test -- test/failure-escalation-promotion.test.js`  
Expected: FAIL (nested escalation behavior)

**Step 2: Implement promotion logic**

In `applyResult` when `nextStatus === "failed"`:
- If `nodeId` starts with `plan-escalate-` and `node.parent_id` is set:
  - treat the **escalation subject** as `node.parent_id` (the plan that couldn’t resolve)
  - set the promoted escalation node’s parent_id to that plan’s parent (grandparent)
  - depend on the failed escalation node (`nodeId`) with `required_status='terminal'`
- Otherwise keep current behavior for normal nodes.

Run: `npm test -- test/failure-escalation-promotion.test.js`  
Expected: PASS

---

## Task 4: Run full test suite

Run: `npm test`  
Expected: PASS

