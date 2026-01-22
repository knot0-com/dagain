import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteJson } from "./helpers/sqlite.js";

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

test("control: pause enqueues mailbox command", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-control-pause-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Control test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const pauseRes = await runCli({ binPath, cwd: tmpDir, args: ["control", "pause", "--no-color"] });
  assert.equal(pauseRes.code, 0, pauseRes.stderr || pauseRes.stdout);

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  const rows = await sqliteJson(dbPath, "SELECT command, status FROM mailbox ORDER BY id DESC LIMIT 1;");
  assert.equal(rows[0]?.command, "pause");
  assert.equal(rows[0]?.status, "pending");
});

test("control: set-workers stores args_json", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-control-workers-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Control workers test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const res = await runCli({ binPath, cwd: tmpDir, args: ["control", "set-workers", "--workers", "3", "--no-color"] });
  assert.equal(res.code, 0, res.stderr || res.stdout);

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  const rows = await sqliteJson(dbPath, "SELECT command, args_json FROM mailbox ORDER BY id DESC LIMIT 1;");
  assert.equal(rows[0]?.command, "set_workers");
  assert.equal(JSON.parse(rows[0]?.args_json || "{}").workers, 3);
});
