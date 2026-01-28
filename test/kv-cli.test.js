import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteJson } from "./helpers/sqlite.js";

function runCli({ binPath, cwd, args, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...env,
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

test("kv: CLI put writes kv_latest using env defaults", async () => {
  const dagainRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(dagainRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-kv-cli-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "KV CLI test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");

  const putRes = await runCli({
    binPath,
    cwd: tmpDir,
    env: {
      DAGAIN_DB: dbPath,
      DAGAIN_NODE_ID: "task-001",
      DAGAIN_RUN_ID: "run-1",
    },
    args: [
      "kv",
      "put",
      "--key",
      "ctx.example",
      "--value",
      "hello",
      "--no-color",
      "--no-refine",
      "--dry-run",
      "--once",
      "--max-iterations",
      "1",
    ],
  });
  assert.equal(putRes.code, 0, putRes.stderr || putRes.stdout);

  const latest = await sqliteJson(dbPath, "SELECT value_text FROM kv_latest WHERE node_id='task-001' AND key='ctx.example';");
  assert.equal(latest[0]?.value_text, "hello");
});
