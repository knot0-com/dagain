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

test("applyResult: failing escalation node promotes to parent plan", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-escalation-promote-"));

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
      `  ('task-a','a','task','open','plan-child','{\"maxAttempts\":1}','${now}','${now}'),\n` +
      `  ('plan-escalate-task-a','Escalate task-a','plan','open','plan-child','{\"maxAttempts\":1}','${now}','${now}');\n` +
      `INSERT OR IGNORE INTO deps(node_id, depends_on_id, required_status)\n` +
      `VALUES('plan-escalate-task-a','task-a','terminal');\n`,
  );

  await applyResult({
    dbPath,
    nodeId: "plan-escalate-task-a",
    runId: "run-1",
    nowIso: new Date().toISOString(),
    result: { status: "fail", summary: "nope", next: { addNodes: [], setStatus: [] } },
  });

  const promoted = await sqliteJson(dbPath, "SELECT id, parent_id, type, status FROM nodes WHERE id='plan-escalate-plan-child';");
  assert.equal(promoted[0]?.id, "plan-escalate-plan-child");
  assert.equal(promoted[0]?.type, "plan");
  assert.equal(promoted[0]?.status, "open");
  assert.equal(promoted[0]?.parent_id, "plan-root");

  const deps = await sqliteJson(
    dbPath,
    "SELECT node_id, depends_on_id, required_status FROM deps WHERE node_id='plan-escalate-plan-child' AND depends_on_id='plan-escalate-task-a';",
  );
  assert.equal(deps.length, 1);
  assert.equal(deps[0]?.required_status, "terminal");

  const nested = await sqliteJson(dbPath, "SELECT id FROM nodes WHERE id='plan-escalate-plan-escalate-task-a';");
  assert.equal(nested.length, 0);
});

