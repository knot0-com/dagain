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

test("node: add and set-status", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-node-cli-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const addRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: [
      "node",
      "add",
      "--id",
      "task-001",
      "--title",
      "T",
      "--type",
      "task",
      "--parent",
      "plan-000",
      "--no-refine",
      "--dry-run",
      "--max-iterations",
      "1",
      "--interval-ms",
      "0",
      "--no-color",
    ],
  });
  assert.equal(addRes.code, 0, addRes.stderr || addRes.stdout);

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  const rows = await sqliteJson(dbPath, "SELECT id, title, type, status, parent_id FROM nodes WHERE id='task-001';");
  assert.equal(rows[0]?.id, "task-001");
  assert.equal(rows[0]?.title, "T");
  assert.equal(rows[0]?.type, "task");
  assert.equal(rows[0]?.status, "open");
  assert.equal(rows[0]?.parent_id, "plan-000");

  const statusRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["node", "set-status", "--id", "task-001", "--status", "done", "--no-color"],
  });
  assert.equal(statusRes.code, 0, statusRes.stderr || statusRes.stdout);

  const updated = await sqliteJson(dbPath, "SELECT status FROM nodes WHERE id='task-001';");
  assert.equal(updated[0]?.status, "done");
});

