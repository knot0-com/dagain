import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

function runShellCommand(cmd, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", String(cmd || "")], {
      cwd,
      env: process.env,
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

test("worktrees: mode=always runs conflicting executors in parallel and merges serially", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockAgentPath = fileURLToPath(new URL("../scripts/mock-sleep-agent.js", import.meta.url));
  const shellMergePath = fileURLToPath(new URL("../scripts/shell-merge.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-worktrees-"));

  const gitInit = await runShellCommand("git init", { cwd: tmpDir });
  assert.equal(gitInit.code, 0, gitInit.stderr || gitInit.stdout);
  const gitEmail = await runShellCommand('git config user.email "test@example.com"', { cwd: tmpDir });
  assert.equal(gitEmail.code, 0, gitEmail.stderr || gitEmail.stdout);
  const gitName = await runShellCommand('git config user.name "Choreo Test"', { cwd: tmpDir });
  assert.equal(gitName.code, 0, gitName.stderr || gitName.stdout);

  await writeFile(path.join(tmpDir, "shared.txt"), "base-1\nbase-2\nbase-3\nbase-4\nbase-5\n", "utf8");
  const gitAdd = await runShellCommand("git add shared.txt", { cwd: tmpDir });
  assert.equal(gitAdd.code, 0, gitAdd.stderr || gitAdd.stdout);
  const gitCommit = await runShellCommand('git commit -m "init"', { cwd: tmpDir });
  assert.equal(gitCommit.code, 0, gitCommit.stderr || gitCommit.stdout);

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Worktrees test", "--no-refine", "--force", "--no-color"],
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
          mockVerifier: { cmd: `node ${mockAgentPath} verifier` },
          shellMerge: { cmd: `node ${shellMergePath}` },
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
          worktrees: { mode: "always", dir: ".dagain/worktrees" },
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
    args: ["run", "--workers", "2", "--max-iterations", "80", "--interval-ms", "0", "--no-live", "--no-color"],
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
  const spawnB = activity.search(/spawn role=executor .*node=task-b/);
  const exitA = activity.search(/exit code=.*node=task-a/);
  assert.ok(spawnA !== -1, "expected spawn task-a");
  assert.ok(spawnB !== -1, "expected spawn task-b");
  assert.ok(exitA !== -1, "expected exit task-a");
  assert.ok(spawnB < exitA, "expected task-b spawn before task-a exit (parallel via worktrees)");

  const spawnMergeA = activity.search(/spawn role=executor .*node=merge-task-a/);
  const exitMergeA = activity.search(/exit code=.*node=merge-task-a/);
  const spawnMergeB = activity.search(/spawn role=executor .*node=merge-task-b/);
  assert.ok(spawnMergeA !== -1, "expected merge-task-a node");
  assert.ok(exitMergeA !== -1, "expected merge-task-a exit");
  assert.ok(spawnMergeB !== -1, "expected merge-task-b node");
  assert.ok(spawnMergeB > exitMergeA, "expected merge-task-b spawn after merge-task-a exit (serialized merges)");

  const worktreesDir = path.join(tmpDir, ".dagain", "worktrees");
  const worktreeA = path.join(worktreesDir, "task-a");
  const worktreeB = path.join(worktreesDir, "task-b");
  const sharedA = await readFile(path.join(worktreeA, "shared.txt"), "utf8");
  const sharedB = await readFile(path.join(worktreeB, "shared.txt"), "utf8");
  assert.match(sharedA, /base-1-a/);
  assert.match(sharedB, /base-5-b/);

  const rootShared = await readFile(path.join(tmpDir, "shared.txt"), "utf8");
  assert.match(rootShared, /base-1-a/);
  assert.match(rootShared, /base-5-b/);
});
