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

test("applyResult: next.setStatus can reopen a failed node", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-setstatus-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".taskgraph", "state.sqlite");
  const now = new Date().toISOString().replace(/'/g, "''");
  await sqliteExec(
    dbPath,
    `DELETE FROM deps;\n` +
      `DELETE FROM nodes;\n` +
      `INSERT INTO nodes(id, title, type, status, attempts, retry_policy_json, created_at, updated_at)\n` +
      `VALUES('a','a','task','open',0,'{\"maxAttempts\":1}','${now}','${now}');\n` +
      `INSERT INTO nodes(\n` +
      `  id, title, type, status, attempts, retry_policy_json,\n` +
      `  lock_run_id, lock_started_at, lock_pid, lock_host,\n` +
      `  checkpoint_json, completed_at,\n` +
      `  created_at, updated_at\n` +
      `)\n` +
      `VALUES(\n` +
      `  'b','b','task','failed',1,'{\"maxAttempts\":1}',\n` +
      `  'run-x','${now}',123,'host',\n` +
      `  '{\"question\":\"x\"}','${now}',\n` +
      `  '${now}','${now}'\n` +
      `);\n`,
  );

  await applyResult({
    dbPath,
    nodeId: "a",
    runId: "run-1",
    nowIso: new Date().toISOString(),
    result: {
      status: "success",
      next: {
        addNodes: [],
        setStatus: [{ id: "b", status: "open" }],
      },
    },
  });

  const b = await sqliteJson(
    dbPath,
    "SELECT status, attempts, lock_run_id, lock_pid, checkpoint_json, completed_at FROM nodes WHERE id='b';",
  );
  assert.equal(b[0]?.status, "open");
  assert.equal(b[0]?.attempts, 0);
  assert.equal(b[0]?.lock_run_id, null);
  assert.equal(b[0]?.lock_pid, null);
  assert.equal(b[0]?.checkpoint_json, null);
  assert.equal(b[0]?.completed_at, null);
});

