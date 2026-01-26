import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec, sqliteJson } from "./helpers/sqlite.js";
import { applyResult, claimNode } from "../src/lib/db/nodes.js";

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

test("applyResult: success marks node done and inserts new nodes/deps", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-apply-result-"));

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
      `INSERT INTO nodes(id, title, type, status, created_at, updated_at) VALUES('a','a','task','open','${now}','${now}');\n`,
  );

  const claimed = await claimNode({ dbPath, nodeId: "a", runId: "run-1", pid: 1, host: "host", nowIso: new Date().toISOString() });
  assert.equal(claimed, true);

  await applyResult({
    dbPath,
    nodeId: "a",
    runId: "run-1",
    nowIso: new Date().toISOString(),
    result: {
      status: "success",
      next: {
        addNodes: [
          {
            id: "b",
            title: "b",
            type: "verify",
            status: "open",
            dependsOn: ["a"],
            ownership: [],
            acceptance: [],
            verify: [],
          },
        ],
        setStatus: [],
      },
    },
  });

  const aRows = await sqliteJson(dbPath, "SELECT status, lock_run_id, completed_at FROM nodes WHERE id='a';");
  assert.equal(aRows[0]?.status, "done");
  assert.equal(aRows[0]?.lock_run_id, null);
  assert.ok(typeof aRows[0]?.completed_at === "string" && aRows[0].completed_at.trim() !== "");

  const bRows = await sqliteJson(dbPath, "SELECT id, parent_id, type, status FROM nodes WHERE id='b';");
  assert.equal(bRows[0]?.id, "b");
  assert.equal(bRows[0]?.parent_id, "a");
  assert.equal(bRows[0]?.type, "verify");
  assert.equal(bRows[0]?.status, "open");

  const deps = await sqliteJson(dbPath, "SELECT node_id, depends_on_id FROM deps WHERE node_id='b' AND depends_on_id='a';");
  assert.equal(deps.length, 1);
});

