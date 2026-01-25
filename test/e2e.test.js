import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
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

test("end-to-end: planner -> executor -> verifier -> done", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockAgentPath = fileURLToPath(new URL("../scripts/mock-agent.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-e2e-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Create hello.txt", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".taskgraph", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          mockPlanner: { cmd: `node ${mockAgentPath} planner` },
          mockExecutor: { cmd: `node ${mockAgentPath} executor` },
          mockVerifier: { cmd: `node ${mockAgentPath} verifier` },
          mockIntegrator: { cmd: `node ${mockAgentPath} integrator` },
          mockFinalVerifier: { cmd: `node ${mockAgentPath} finalVerifier` },
        },
        roles: {
          main: "mockPlanner",
          planner: "mockPlanner",
          executor: "mockExecutor",
          verifier: "mockVerifier",
          integrator: "mockIntegrator",
          finalVerifier: "mockFinalVerifier",
          researcher: "mockPlanner",
        },
        supervisor: {
          idleSleepMs: 0,
          staleLockSeconds: 3600,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--max-iterations", "50", "--interval-ms", "0", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
  assert.match(runRes.stdout + runRes.stderr, /All nodes done\./);

  const helloPath = path.join(tmpDir, "hello.txt");
  const hello = await readFile(helloPath, "utf8");
  assert.equal(hello, "hello from choreo\n");

  const dbPath = path.join(tmpDir, ".taskgraph", "state.sqlite");
  await stat(dbPath);
  const dbNodes = await sqliteJson(dbPath, "SELECT id, status FROM nodes ORDER BY id;");
  const dbStatuses = new Map(dbNodes.map((n) => [n.id, n.status]));
  assert.equal(dbStatuses.get("plan-000"), "done");
  assert.equal(dbStatuses.get("task-hello"), "done");
  assert.equal(dbStatuses.get("verify-hello"), "done");

  const graphPath = path.join(tmpDir, ".taskgraph", "workgraph.json");
  const graph = JSON.parse(await readFile(graphPath, "utf8"));
  const statuses = new Map(graph.nodes.map((n) => [n.id, n.status]));
  assert.equal(statuses.get("plan-000"), "done");
  assert.equal(statuses.get("task-hello"), "done");
  assert.equal(statuses.get("verify-hello"), "done");

  // Persisted memory files
  const memoryDir = path.join(tmpDir, ".taskgraph", "memory");
  const activityPath = path.join(memoryDir, "activity.log");
  const errorsPath = path.join(memoryDir, "errors.log");
  const activity = await readFile(activityPath, "utf8");
  assert.match(activity, /\] init/);
  assert.match(activity, /\] select plan-000/);
  assert.match(activity, /spawn role=planner/);
  assert.match(activity, /spawn role=executor/);
  assert.match(activity, /spawn role=verifier/);
  await stat(errorsPath);

  // Persisted per-run artifacts
  const runsDir = path.join(tmpDir, ".taskgraph", "runs");
  const runIds = (await readdir(runsDir)).filter(Boolean).sort();
  assert.ok(runIds.length >= 3, `expected >=3 runs, got ${runIds.length}`);
  for (const runId of runIds) {
    await stat(path.join(runsDir, runId, "packet.md"));
    await stat(path.join(runsDir, runId, "stdout.log"));
    await stat(path.join(runsDir, runId, "result.json"));
  }
});
