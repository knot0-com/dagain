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
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
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
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-escalation-scope-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
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

  await sqliteExec(
    dbPath,
    `UPDATE nodes\n` +
      `SET status='done', attempts=0, completed_at='${now}', updated_at='${now}'\n` +
      `WHERE id='plan-escalate-plan-child';\n` +
      `INSERT INTO nodes(id, title, type, status, parent_id, retry_policy_json, created_at, updated_at)\n` +
      `VALUES('task-sub-2','s2','task','open','task-parent','{\"maxAttempts\":1}','${now}','${now}');\n`,
  );

  await applyResult({
    dbPath,
    nodeId: "task-sub-2",
    runId: "run-2",
    nowIso: new Date().toISOString(),
    result: { status: "fail", next: { addNodes: [], setStatus: [] } },
  });

  const reopened = await sqliteJson(
    dbPath,
    "SELECT status, attempts, completed_at FROM nodes WHERE id='plan-escalate-plan-child';",
  );
  assert.equal(reopened[0]?.status, "open");
  assert.equal(reopened[0]?.attempts, 0);
  assert.equal(reopened[0]?.completed_at, null);
});
