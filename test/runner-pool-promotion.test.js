import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("runnerPool: promotes to next runner on missing_result", { timeout: 15_000 }, async () => {
  const dagainRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(dagainRoot, "bin", "dagain.js");
  const noResultPath = fileURLToPath(new URL("../scripts/mock-agent-noresult.js", import.meta.url));
  const markerPath = fileURLToPath(new URL("../scripts/mock-agent-marker.js", import.meta.url));
  const logAgentPath = fileURLToPath(new URL("../scripts/mock-agent-log.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-runner-pool-missing-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Runner pool promotion", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".dagain", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        defaults: { verifyRunner: "verifierR" },
        runners: {
          runnerA: { cmd: `node ${noResultPath} A {packet}` },
          runnerB: { cmd: `node ${markerPath} B {packet}` },
          verifierR: { cmd: `node ${logAgentPath} verifier {packet}` },
          integratorR: { cmd: `node ${logAgentPath} integrator {packet}` },
          finalR: { cmd: `node ${logAgentPath} finalVerifier {packet}` },
        },
        roles: {
          main: "verifierR",
          planner: "verifierR",
          executor: ["runnerA", "runnerB"],
          verifier: "verifierR",
          integrator: "integratorR",
          finalVerifier: "finalR",
          researcher: "verifierR",
        },
        supervisor: {
          idleSleepMs: 0,
          staleLockSeconds: 3600,
          runnerPool: {
            mode: "promotion",
            promoteOn: ["missing_result"],
            promoteAfterAttempts: 99,
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await runCli({
    binPath,
    cwd: tmpDir,
    args: ["node", "set-status", "--id", "plan-000", "--status", "done", "--force"],
  });

  await runCli({
    binPath,
    cwd: tmpDir,
    args: [
      "node",
      "add",
      "--id",
      "task-pool",
      "--title",
      "Runner pool task",
      "--type",
      "task",
      "--status",
      "open",
      "--ownership",
      JSON.stringify(["runner_marker.txt", "invocations.log"]),
      "--retry-policy",
      JSON.stringify({ maxAttempts: 2 }),
    ],
  });

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--max-iterations", "50", "--interval-ms", "0", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);

  const marker = await readFile(path.join(tmpDir, "runner_marker.txt"), "utf8");
  assert.equal(marker, "B\n");

  const activity = await readFile(path.join(tmpDir, ".dagain", "memory", "activity.log"), "utf8");
  assert.match(activity, /spawn role=executor runner=runnerA node=task-pool/);
  assert.match(activity, /spawn role=executor runner=runnerB node=task-pool/);

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
  const runnerHistory = await sqliteJson(
    dbPath,
    "SELECT value_text FROM kv_history WHERE node_id='task-pool' AND key='out.last_runner' ORDER BY id;",
  );
  assert.deepEqual(
    runnerHistory.map((r) => r.value_text),
    ["runnerA", "runnerB"],
  );
});

test("runnerPool: promotes to next runner only after K task failures", { timeout: 15_000 }, async () => {
  const dagainRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(dagainRoot, "bin", "dagain.js");
  const failPath = fileURLToPath(new URL("../scripts/mock-agent-fail-marker.js", import.meta.url));
  const markerPath = fileURLToPath(new URL("../scripts/mock-agent-marker.js", import.meta.url));
  const logAgentPath = fileURLToPath(new URL("../scripts/mock-agent-log.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-runner-pool-k-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Runner pool promotion (K)", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".dagain", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        defaults: { verifyRunner: "verifierR" },
        runners: {
          runnerA: { cmd: `node ${failPath} A {packet}` },
          runnerB: { cmd: `node ${markerPath} B {packet}` },
          verifierR: { cmd: `node ${logAgentPath} verifier {packet}` },
          integratorR: { cmd: `node ${logAgentPath} integrator {packet}` },
          finalR: { cmd: `node ${logAgentPath} finalVerifier {packet}` },
        },
        roles: {
          main: "verifierR",
          planner: "verifierR",
          executor: ["runnerA", "runnerB"],
          verifier: "verifierR",
          integrator: "integratorR",
          finalVerifier: "finalR",
          researcher: "verifierR",
        },
        supervisor: {
          idleSleepMs: 0,
          staleLockSeconds: 3600,
          runnerPool: {
            mode: "promotion",
            promoteOn: [],
            promoteAfterAttempts: 2,
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await runCli({
    binPath,
    cwd: tmpDir,
    args: ["node", "set-status", "--id", "plan-000", "--status", "done", "--force"],
  });

  await runCli({
    binPath,
    cwd: tmpDir,
    args: [
      "node",
      "add",
      "--id",
      "task-pool",
      "--title",
      "Runner pool task (K)",
      "--type",
      "task",
      "--status",
      "open",
      "--ownership",
      JSON.stringify(["runner_marker.txt", "invocations.log"]),
      "--retry-policy",
      JSON.stringify({ maxAttempts: 3 }),
    ],
  });

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--max-iterations", "50", "--interval-ms", "0", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);

  const marker = await readFile(path.join(tmpDir, "runner_marker.txt"), "utf8");
  assert.equal(marker, "B\n");

  const activity = await readFile(path.join(tmpDir, ".dagain", "memory", "activity.log"), "utf8");
  assert.match(activity, /spawn role=executor runner=runnerA node=task-pool/);
  assert.match(activity, /spawn role=executor runner=runnerB node=task-pool/);

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
  const runnerHistory = await sqliteJson(
    dbPath,
    "SELECT value_text FROM kv_history WHERE node_id='task-pool' AND key='out.last_runner' ORDER BY id;",
  );
  assert.deepEqual(
    runnerHistory.map((r) => r.value_text),
    ["runnerA", "runnerA", "runnerB"],
  );
});

