import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteJson } from "./helpers/sqlite.js";
import { kvPut } from "../src/lib/db/kv.js";

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

test("kv: keeps last 5 history rows per key", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-kv-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "KV test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");

  for (let i = 1; i <= 6; i += 1) {
    await kvPut({
      dbPath,
      nodeId: "task-001",
      key: "ctx.example",
      valueText: String(i),
      runId: "run-1",
      attempt: 0,
      nowIso: new Date(2020, 0, i).toISOString(),
    });
  }

  const latest = await sqliteJson(dbPath, "SELECT value_text FROM kv_latest WHERE node_id='task-001' AND key='ctx.example';");
  assert.equal(latest[0]?.value_text, "6");

  const history = await sqliteJson(
    dbPath,
    "SELECT value_text FROM kv_history WHERE node_id='task-001' AND key='ctx.example' ORDER BY id ASC;",
  );
  assert.equal(history.length, 5);
  assert.equal(history[0]?.value_text, "2");
  assert.equal(history[4]?.value_text, "6");
});

