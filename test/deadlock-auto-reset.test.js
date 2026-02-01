import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec, sqliteJson } from "./helpers/sqlite.js";

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

test("run: auto-resets failed deps when graph is blocked", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-deadlock-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Deadlock test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
  const now = new Date().toISOString().replace(/'/g, "''");
  await sqliteExec(
    dbPath,
    `DELETE FROM deps;\n` +
      `DELETE FROM nodes;\n` +
      `INSERT INTO nodes(id, title, type, status, attempts, retry_policy_json, created_at, updated_at)\n` +
      `VALUES('plan-000','plan','plan','done',0,'{\"maxAttempts\":3}','${now}','${now}');\n` +
      `INSERT INTO nodes(id, title, type, status, attempts, retry_policy_json, created_at, updated_at)\n` +
      `VALUES('task-001','failed dep','task','failed',3,'{\"maxAttempts\":3}','${now}','${now}');\n` +
      `INSERT INTO nodes(id, title, type, status, attempts, retry_policy_json, created_at, updated_at)\n` +
      `VALUES('task-002','blocked task','task','open',0,'{\"maxAttempts\":3}','${now}','${now}');\n` +
      `INSERT INTO deps(node_id, depends_on_id) VALUES('task-002','task-001');\n`,
  );

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--max-iterations", "3", "--interval-ms", "0", "--dry-run", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
  assert.match(runRes.stdout + runRes.stderr, /Reopened failed node/i);

  const task001 = await sqliteJson(dbPath, "SELECT status, attempts, auto_reset_count FROM nodes WHERE id='task-001';");
  assert.equal(task001[0]?.status, "open");
  assert.equal(Number(task001[0]?.attempts ?? -1), 0);
  assert.equal(Number(task001[0]?.auto_reset_count ?? -1), 1);
});
