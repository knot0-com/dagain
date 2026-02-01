import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec, sqliteJson } from "./helpers/sqlite.js";
import { applyResult, selectNextRunnableNode } from "../src/lib/db/nodes.js";

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

test("applyResult: permanent failure creates escalation node once", async () => {
  const dagainRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(dagainRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-escalation-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
  const now = new Date().toISOString().replace(/'/g, "''");
  await sqliteExec(
    dbPath,
    `DELETE FROM deps;\n` +
    `DELETE FROM nodes;\n` +
    `INSERT INTO nodes(id, title, type, status, retry_policy_json, created_at, updated_at)\n` +
    `VALUES('a','a','task','open','{\"maxAttempts\":1}','${now}','${now}');\n`,
  );

  await applyResult({
    dbPath,
    nodeId: "a",
    runId: "run-1",
    nowIso: new Date().toISOString(),
    result: { status: "fail", next: { addNodes: [], setStatus: [] } },
  });
  await applyResult({
    dbPath,
    nodeId: "a",
    runId: "run-2",
    nowIso: new Date().toISOString(),
    result: { status: "fail", next: { addNodes: [], setStatus: [] } },
  });

  const a = await sqliteJson(dbPath, "SELECT status FROM nodes WHERE id='a';");
  assert.equal(a[0]?.status, "failed");

  const escalation = await sqliteJson(dbPath, "SELECT id, type, status FROM nodes WHERE id='plan-escalate-a';");
  assert.equal(escalation[0]?.id, "plan-escalate-a");
  assert.equal(escalation[0]?.type, "plan");
  assert.equal(escalation[0]?.status, "open");

  const deps = await sqliteJson(
    dbPath,
    "SELECT node_id, depends_on_id, required_status FROM deps WHERE node_id='plan-escalate-a' AND depends_on_id='a';",
  );
  assert.equal(deps.length, 1);
  assert.equal(deps[0]?.required_status, "terminal");

  const count = await sqliteJson(dbPath, "SELECT COUNT(*) AS n FROM nodes WHERE id='plan-escalate-a';");
  assert.equal(Number(count[0]?.n ?? 0), 1);

  const next = await selectNextRunnableNode({ dbPath, nowIso: new Date().toISOString() });
  assert.ok(next, "expected a runnable node");
  assert.equal(next.id, "plan-escalate-a");
});
