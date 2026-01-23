import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
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

function runCliInteractive({ binPath, cwd, args, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? 0, signal, stdout, stderr }));
    child.stdin.end(String(input || ""));
  });
}

test("chat: executes rich graph ops (node.add/update + dep.add)", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const routerPath = fileURLToPath(new URL("../scripts/mock-chat-router-graph-ops.js", import.meta.url));
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-chat-graph-ops-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".choreo", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          mock: { cmd: `node ${routerPath} {packet}` },
        },
        roles: {
          main: "mock",
          planner: "mock",
          executor: "mock",
          verifier: "mock",
          integrator: "mock",
          finalVerifier: "mock",
          researcher: "mock",
        },
        supervisor: { idleSleepMs: 0, staleLockSeconds: 3600 },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const res = await runCliInteractive({
    binPath,
    cwd: tmpDir,
    args: ["chat", "--runner", "mock", "--no-color"],
    input: "graph-ops-1\ngraph-ops-2\n/exit\n",
  });
  assert.equal(res.code, 0, res.stderr || res.stdout);

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  const depRows = await sqliteJson(
    dbPath,
    "SELECT node_id, depends_on_id, required_status FROM deps WHERE node_id='task-002' AND depends_on_id='task-001' LIMIT 1;",
  );
  assert.deepEqual(depRows, [{ node_id: "task-002", depends_on_id: "task-001", required_status: "terminal" }]);

  const nodeRows = await sqliteJson(
    dbPath,
    "SELECT id, title, inputs_json, ownership_json, acceptance_json, verify_json, retry_policy_json FROM nodes WHERE id IN ('task-001','task-002') ORDER BY id;",
  );
  assert.equal(nodeRows.length, 2);

  const n1 = nodeRows.find((r) => r.id === "task-001");
  assert.equal(n1.title, "Task 1 updated");
  assert.deepEqual(JSON.parse(String(n1.inputs_json)), [{ nodeId: "__run__", key: "chat.rollup" }]);
  assert.deepEqual(JSON.parse(String(n1.ownership_json)), [{ resources: ["__global__"], mode: "read" }]);
  assert.deepEqual(JSON.parse(String(n1.acceptance_json)), ["has-spec"]);
  assert.deepEqual(JSON.parse(String(n1.verify_json)), ["unit"]);
  assert.deepEqual(JSON.parse(String(n1.retry_policy_json)), { maxAttempts: 3 });

  const n2 = nodeRows.find((r) => r.id === "task-002");
  assert.equal(n2.title, "Task 2");
  assert.deepEqual(JSON.parse(String(n2.retry_policy_json)), { maxAttempts: 2 });
});
