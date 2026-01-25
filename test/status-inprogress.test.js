import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec } from "./helpers/sqlite.js";

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

function sqlQuote(value) {
  const s = String(value ?? "");
  return `'${s.replace(/'/g, "''")}'`;
}

test("status: shows in-progress nodes with log paths", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-status-inprogress-"));
  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Status test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".taskgraph", "state.sqlite");
  const now = new Date().toISOString();
  const runId = "2026-01-21T00-00-00-000Z-deadbe";

  await sqliteExec(
    dbPath,
    `UPDATE nodes\n` +
      `SET status='in_progress',\n` +
      `    lock_run_id=${sqlQuote(runId)},\n` +
      `    lock_started_at=${sqlQuote(now)},\n` +
      `    lock_pid=12345,\n` +
      `    lock_host='test-host',\n` +
      `    updated_at=${sqlQuote(now)}\n` +
      `WHERE id='plan-000';\n`,
  );

  const statusRes = await runCli({ binPath, cwd: tmpDir, args: ["status", "--no-color"] });
  assert.equal(statusRes.code, 0, statusRes.stderr || statusRes.stdout);
  const text = statusRes.stdout + statusRes.stderr;
  assert.match(text, /In progress:/i);
  assert.match(text, /\bplan-000\b/);
  assert.match(text, new RegExp(`\\brun=${runId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`));
  assert.match(text, new RegExp(`\\.taskgraph/runs/${runId}/stdout\\.log`));
});

