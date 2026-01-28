# Dagain Recursive Failure Promotion (Replan to Root) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** When any node exhausts retries and becomes `failed`, create/reopen a single `plan-escalate-<scopeId>` node for the nearest `plan`/`epic` ancestor (scope). If that escalation node fails, promote again to the parent scope, continuing until the root scope (then stop; no `plan-escalate-plan-escalate-*`).

**Architecture:** Implement a small DB helper in `src/lib/db/nodes.js` to find the nearest `plan`/`epic` ancestor via a recursive CTE. In `applyResult()`’s permanent failure block, map leaf failures to the nearest scope escalation node, and map escalation failures to the next higher scope (promotion). If the target escalation node already exists but is terminal (`done`/`failed`), reopen it (`status='open'`, `attempts=0`, `completed_at=NULL`) so new failures always trigger replanning.

**Tech Stack:** Node.js (>=18), SQLite (`sqlite3` CLI), `node:test`

---

## Success Metrics

- Leaf/task failure under a plan hierarchy creates `plan-escalate-<nearestPlanOrEpicId>` (not `plan-escalate-<taskId>`).
- Escalation failure promotes one scope level up, until root.
- Root escalation failure stops (no nested `plan-escalate-plan-escalate-*`).
- If `plan-escalate-<scopeId>` exists and is `done` or `failed`, a new failure in that scope reopens it so it’s runnable again.

---

## Task 1: Leaf failure escalates to nearest plan/epic scope

**Files:**
- Create: `test/failure-escalation-scope.test.js`
- Modify: `src/lib/db/nodes.js`

**Step 1: Write the failing test**

Create `test/failure-escalation-scope.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec, sqliteJson } from "./helpers/sqlite.js";
import { applyResult } from "../src/lib/db/nodes.js";

function runCli({ binPath, cwd, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? 0, signal, stdout, stderr }));
  });
}

test("applyResult: leaf failure escalates to nearest plan scope", async () => {
  const dagainRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(dagainRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-escalation-scope-"));

  const initRes = await runCli({ binPath, cwd: tmpDir, args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"] });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
  const now = new Date().toISOString().replace(/'/g, "''");
  await sqliteExec(
    dbPath,
    `DELETE FROM deps;\n` +
      `DELETE FROM nodes;\n` +
      `INSERT INTO nodes(id, title, type, status, parent_id, retry_policy_json, created_at, updated_at)\n` +
      `VALUES\n` +
      `  ('plan-root','root','plan','open',NULL,'{\"maxAttempts\":1}','${now}','${now}'),\n` +
      `  ('plan-child','child','plan','open','plan-root','{\"maxAttempts\":1}','${now}','${now}'),\n` +
      `  ('task-parent','p','task','open','plan-child','{\"maxAttempts\":1}','${now}','${now}'),\n` +
      `  ('task-sub','s','task','open','task-parent','{\"maxAttempts\":1}','${now}','${now}');\n`,
  );

  await applyResult({
    dbPath,
    nodeId: "task-sub",
    runId: "run-1",
    nowIso: new Date().toISOString(),
    result: { status: "fail", next: { addNodes: [], setStatus: [] } },
  });

  const escalation = await sqliteJson(dbPath, "SELECT id, parent_id, type, status FROM nodes WHERE id='plan-escalate-plan-child';");
  assert.equal(escalation[0]?.id, "plan-escalate-plan-child");
  assert.equal(escalation[0]?.type, "plan");
  assert.equal(escalation[0]?.status, "open");
  assert.equal(escalation[0]?.parent_id, "plan-root");

  const deps = await sqliteJson(
    dbPath,
    "SELECT node_id, depends_on_id, required_status FROM deps WHERE node_id='plan-escalate-plan-child' AND depends_on_id='task-sub';",
  );
  assert.equal(deps.length, 1);
  assert.equal(deps[0]?.required_status, "terminal");

  const noLeafEsc = await sqliteJson(dbPath, "SELECT id FROM nodes WHERE id='plan-escalate-task-sub';");
  assert.equal(noLeafEsc.length, 0);
});
```

Run: `npm test -- test/failure-escalation-scope.test.js`  
Expected: FAIL (currently creates `plan-escalate-task-sub`)

**Step 2: Implement minimal scope targeting**

In `src/lib/db/nodes.js`, inside `applyResult()`’s `nextStatus === "failed"` block:
- Add a helper to find the nearest `plan`/`epic` ancestor for a node.
- For non-escalation failures, set `escalationSubjectId` to that scope id (fallback to `nodeId` when none).
- Ensure the escalation node depends on the failing node id (`dependsOnId = nodeId`) and is parented under the scope’s parent scope.

Run: `npm test -- test/failure-escalation-scope.test.js`  
Expected: PASS

---

## Task 2: Promotion + stop at root (no nested escalation chains)

**Files:**
- Modify: `test/failure-escalation-promotion.test.js`
- Modify: `src/lib/db/nodes.js`

**Step 1: Update the failing test**

Update `test/failure-escalation-promotion.test.js` to:
- Fail `plan-escalate-plan-child` (parent `plan-root`) and assert `plan-escalate-plan-root` is created and depends on `plan-escalate-plan-child`.
- Fail `plan-escalate-plan-root` (parent NULL) and assert no `plan-escalate-plan-escalate-plan-root` exists.

Run: `npm test -- test/failure-escalation-promotion.test.js`  
Expected: FAIL (root currently nests)

**Step 2: Implement root stop**

In `applyResult()` failure escalation logic:
- If `nodeId` starts with `plan-escalate-` and `node.parent_id` is NULL, do nothing (stop).

Run: `npm test -- test/failure-escalation-promotion.test.js`  
Expected: PASS

---

## Task 3: Reopen existing escalation nodes on new failures

**Files:**
- Modify: `src/lib/db/nodes.js`
- Test: `test/failure-escalation-scope.test.js`

**Step 1: Extend the test**

In `test/failure-escalation-scope.test.js`, after asserting the escalation node exists:
- Mark `plan-escalate-plan-child` as `done`.
- Fail another node in the same scope (or re-fail `task-sub` after reopening it).
- Assert `plan-escalate-plan-child` returns to `open` with `attempts=0` and `completed_at IS NULL`.

Run: `npm test -- test/failure-escalation-scope.test.js`  
Expected: FAIL (escalation remains done)

**Step 2: Implement reopen**

After ensuring the escalation node exists, run:
- `UPDATE nodes SET status='open', attempts=0, completed_at=NULL, updated_at=... WHERE id=? AND status IN ('done','failed')`

Run: `npm test -- test/failure-escalation-scope.test.js`  
Expected: PASS

---

## Task 4: Run full test suite

Run: `npm test`  
Expected: PASS
