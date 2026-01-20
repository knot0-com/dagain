import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function runCli({ binPath, cwd, args, env = {}, stdin = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    if (stdin != null) child.stdin.write(String(stdin));
    child.stdin.end();
    child.on("close", (code, signal) => resolve({ code: code ?? 0, signal, stdout, stderr }));
  });
}

test("run: interactive checkpoint answer resumes and completes", { timeout: 10_000 }, async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockAgentPath = fileURLToPath(new URL("../scripts/mock-agent-checkpoint.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-checkpoint-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Checkpoint test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".choreo", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          mockPlanner: { cmd: `node ${mockAgentPath} planner {packet}` },
          mockExecutor: { cmd: `node ${mockAgentPath} executor {packet}` },
          mockVerifier: { cmd: `node ${mockAgentPath} verifier {packet}` },
          mockIntegrator: { cmd: `node ${mockAgentPath} integrator {packet}` },
          mockFinalVerifier: { cmd: `node ${mockAgentPath} finalVerifier {packet}` },
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
    env: { CHOREO_FORCE_PROMPT: "1" },
    stdin: "yes\n",
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
  assert.match(runRes.stdout + runRes.stderr, /Waiting for human input/i);
  assert.match(runRes.stdout + runRes.stderr, /Your answer/i);
  assert.match(runRes.stdout + runRes.stderr, /All nodes done\./);

  const confirmedPath = path.join(tmpDir, "confirmed.txt");
  const confirmed = await readFile(confirmedPath, "utf8");
  assert.equal(confirmed, "confirmed\n");
});
