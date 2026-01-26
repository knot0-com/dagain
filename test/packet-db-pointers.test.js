import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

test("run: injects DB pointer env vars into runner", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockAgentPath = fileURLToPath(new URL("../scripts/mock-agent-env.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-db-pointers-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".dagain", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          mock: { cmd: `node ${mockAgentPath} env {packet}` },
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
    args: ["run", "--max-iterations", "1", "--interval-ms", "0", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);

  const envRecordPath = path.join(tmpDir, "runner_env.json");
  const envRecord = JSON.parse(await readFile(envRecordPath, "utf8"));
  assert.equal(envRecord.CHOREO_DB, path.join(tmpDir, ".dagain", "state.sqlite"));
  assert.equal(envRecord.CHOREO_NODE_ID, "plan-000");
  assert.equal(envRecord.CHOREO_ARTIFACTS_DIR, path.join(tmpDir, ".dagain", "artifacts"));
  assert.equal(envRecord.CHOREO_CHECKPOINTS_DIR, path.join(tmpDir, ".dagain", "checkpoints"));
  assert.equal(envRecord.CHOREO_RUNS_DIR, path.join(tmpDir, ".dagain", "runs"));
  assert.ok(typeof envRecord.CHOREO_RUN_ID === "string" && envRecord.CHOREO_RUN_ID.trim() !== "");
  assert.ok(typeof envRecord.CHOREO_BIN === "string" && envRecord.CHOREO_BIN.endsWith(path.join("bin", "choreo.js")));
  await stat(envRecord.CHOREO_BIN);
});

