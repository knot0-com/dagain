import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec } from "./helpers/sqlite.js";

function runCli({ binPath, cwd, args, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...(env || {}),
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

test("workers: write/write ownership conflict serializes executors", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockAgentPath = fileURLToPath(new URL("../scripts/mock-sleep-agent.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-workers-lock-write-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Ownership lock test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".dagain", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        defaults: { retryPolicy: { maxAttempts: 1 } },
        runners: {
          mockPlanner: { cmd: `node ${mockAgentPath} planner` },
          mockExecutor: { cmd: `node ${mockAgentPath} executor` },
          mockIntegrator: { cmd: `node ${mockAgentPath} integrator` },
          mockFinalVerifier: { cmd: `node ${mockAgentPath} finalVerifier` },
        },
        roles: {
          main: "mockPlanner",
          planner: "mockPlanner",
          executor: "mockExecutor",
          verifier: "mockExecutor",
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
    args: ["run", "--workers", "2", "--max-iterations", "50", "--interval-ms", "0", "--no-live", "--no-color"],
    env: {
      MOCK_SLEEP_MS: "400",
      MOCK_SLEEP_SCENARIO: "conflict",
    },
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
  assert.match(runRes.stdout + runRes.stderr, /All nodes done\./);

  const activityPath = path.join(tmpDir, ".dagain", "memory", "activity.log");
  const activity = await readFile(activityPath, "utf8");

  const spawnA = activity.search(/spawn role=executor .*node=task-a/);
  const exitA = activity.search(/exit code=.*node=task-a/);
  const spawnB = activity.search(/spawn role=executor .*node=task-b/);
  assert.ok(spawnA !== -1, "expected spawn task-a");
  assert.ok(exitA !== -1, "expected exit task-a");
  assert.ok(spawnB !== -1, "expected spawn task-b");
  assert.ok(spawnB > exitA, "expected task-b spawn after task-a exit (serialized)");
});

test("workers: read/read ownership allows parallel verifiers", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockAgentPath = fileURLToPath(new URL("../scripts/mock-sleep-agent.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-workers-lock-read-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Ownership lock test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".dagain", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        defaults: { retryPolicy: { maxAttempts: 1 } },
        runners: {
          mockVerifier: { cmd: `node ${mockAgentPath} verifier` },
        },
        roles: {
          main: "mockVerifier",
          planner: "mockVerifier",
          executor: "mockVerifier",
          verifier: "mockVerifier",
          integrator: "mockVerifier",
          finalVerifier: "mockVerifier",
          researcher: "mockVerifier",
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

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
  const now = new Date().toISOString().replace(/'/g, "''");
  await sqliteExec(
    dbPath,
    `DELETE FROM deps;\n` +
      `DELETE FROM nodes;\n` +
      `INSERT INTO nodes(id, title, type, status, created_at, updated_at)\n` +
      `VALUES('plan-000','plan','plan','done','${now}','${now}');\n` +
      `INSERT INTO nodes(id, title, type, status, ownership_json, created_at, updated_at)\n` +
      `VALUES('verify-1','v1','verify','open','[\"shared.txt\"]','${now}','${now}');\n` +
      `INSERT INTO nodes(id, title, type, status, ownership_json, created_at, updated_at)\n` +
      `VALUES('verify-2','v2','verify','open','[\"shared.txt\"]','${now}','${now}');\n`,
  );

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--workers", "2", "--max-iterations", "50", "--interval-ms", "0", "--no-live", "--no-color"],
    env: {
      MOCK_SLEEP_MS: "400",
    },
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
  assert.match(runRes.stdout + runRes.stderr, /All nodes done\./);

  const activityPath = path.join(tmpDir, ".dagain", "memory", "activity.log");
  const activity = await readFile(activityPath, "utf8");

  const spawn1 = activity.search(/spawn role=verifier .*node=verify-1/);
  const spawn2 = activity.search(/spawn role=verifier .*node=verify-2/);
  const exit1 = activity.search(/exit code=.*node=verify-1/);
  assert.ok(spawn1 !== -1, "expected spawn verify-1");
  assert.ok(spawn2 !== -1, "expected spawn verify-2");
  assert.ok(exit1 !== -1, "expected exit verify-1");
  assert.ok(spawn2 < exit1, "expected verify-2 spawn before verify-1 exit (parallel)");
});

