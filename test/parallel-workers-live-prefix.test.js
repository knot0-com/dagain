import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
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

test("live: workers>1 prefixes runner output with node id", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockAgentPath = fileURLToPath(new URL("../scripts/mock-sleep-agent.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-workers-live-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Live prefix test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".choreo", "config.json");
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
    args: ["run", "--workers", "2", "--live", "--max-iterations", "50", "--interval-ms", "0", "--no-color"],
    env: {
      MOCK_SLEEP_MS: "20",
    },
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
  assert.match(runRes.stdout + runRes.stderr, /All nodes done\./);

  // Runner stdout is teed to process.stdout. Ensure prefixes include node ids.
  assert.match(runRes.stdout, /│task-a│/);
  assert.match(runRes.stdout, /│task-b│/);
});

