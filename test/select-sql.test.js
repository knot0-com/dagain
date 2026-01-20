import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec } from "./helpers/sqlite.js";
import { selectNextRunnableNode } from "../src/lib/db/nodes.js";

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

test("selectNextRunnableNode: prefers verify nodes", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-select-sql-"));

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
      `INSERT INTO nodes(id, title, type, status, created_at, updated_at) VALUES('a','a','task','done','${now}','${now}');\n` +
      `INSERT INTO nodes(id, title, type, status, created_at, updated_at) VALUES('b','b','task','open','${now}','${now}');\n` +
      `INSERT INTO nodes(id, title, type, status, created_at, updated_at) VALUES('c','c','verify','open','${now}','${now}');\n` +
      `INSERT INTO deps(node_id, depends_on_id) VALUES('b','a');\n`,
  );

  const node = await selectNextRunnableNode({ dbPath, nowIso: new Date().toISOString() });
  assert.ok(node, "expected a runnable node");
  assert.equal(node.id, "c");
});

