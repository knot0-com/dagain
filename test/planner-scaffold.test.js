import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("planner scaffolding: tasks-only plan still runs verifier/integrator/finalVerifier", { timeout: 15_000 }, async () => {
  const dagainRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(dagainRoot, "bin", "dagain.js");
  const plannerPath = fileURLToPath(new URL("../scripts/mock-planner-tasks-only.js", import.meta.url));
  const logAgentPath = fileURLToPath(new URL("../scripts/mock-agent-log.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-planner-scaffold-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Scaffold test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".dagain", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          plannerR: { cmd: `node ${plannerPath} {packet}` },
          executorR: { cmd: `node ${logAgentPath} executor {packet}` },
          verifierR: { cmd: `node ${logAgentPath} verifier {packet}` },
          integratorR: { cmd: `node ${logAgentPath} integrator {packet}` },
          finalR: { cmd: `node ${logAgentPath} finalVerifier {packet}` },
        },
        roles: {
          main: "plannerR",
          planner: "plannerR",
          executor: "executorR",
          verifier: "verifierR",
          integrator: "integratorR",
          finalVerifier: "finalR",
          researcher: "plannerR",
        },
        supervisor: { idleSleepMs: 0, staleLockSeconds: 3600 },
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

  const invocations = await readFile(path.join(tmpDir, "invocations.log"), "utf8");
  assert.match(invocations, /^executor\t/m);
  assert.match(invocations, /^verifier\t/m);
  assert.match(invocations, /^integrator\t/m);
  assert.match(invocations, /^finalVerifier\t/m);
});

test("multiVerifier=all: scaffolding fans out verify nodes per verifier runner", { timeout: 15_000 }, async () => {
  const dagainRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(dagainRoot, "bin", "dagain.js");
  const plannerPath = fileURLToPath(new URL("../scripts/mock-planner-tasks-only.js", import.meta.url));
  const logAgentPath = fileURLToPath(new URL("../scripts/mock-agent-log.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-multiverifier-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Multi verifier test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".dagain", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          plannerR: { cmd: `node ${plannerPath} {packet}` },
          executorR: { cmd: `node ${logAgentPath} executor {packet}` },
          v1: { cmd: `node ${logAgentPath} verifier-v1 {packet}` },
          v2: { cmd: `node ${logAgentPath} verifier-v2 {packet}` },
          integratorR: { cmd: `node ${logAgentPath} integrator {packet}` },
          finalR: { cmd: `node ${logAgentPath} finalVerifier {packet}` },
        },
        roles: {
          main: "plannerR",
          planner: "plannerR",
          executor: "executorR",
          verifier: ["v1", "v2"],
          integrator: "integratorR",
          finalVerifier: "finalR",
          researcher: "plannerR",
        },
        supervisor: { idleSleepMs: 0, staleLockSeconds: 3600, multiVerifier: "all" },
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

  const invocations = await readFile(path.join(tmpDir, "invocations.log"), "utf8");
  assert.match(invocations, /^verifier-v1\t/m);
  assert.match(invocations, /^verifier-v2\t/m);
});

