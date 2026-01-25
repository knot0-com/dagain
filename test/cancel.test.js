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

function spawnCli({ binPath, cwd, args }) {
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
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? 0, signal, stdout, stderr }));
  });
  return { child, done };
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    const ok = await predicate().catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("cancel: SIGTERM unlocks node and clears supervisor lock", { timeout: 10_000 }, async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const sleepAgentPath = fileURLToPath(new URL("../scripts/sleep-agent.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-cancel-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Cancel test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".taskgraph", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          sleepy: { cmd: `node ${sleepAgentPath} 600000` },
        },
        roles: {
          main: "sleepy",
          planner: "sleepy",
          executor: "sleepy",
          verifier: "sleepy",
          integrator: "sleepy",
          finalVerifier: "sleepy",
          researcher: "sleepy",
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

  const lockPath = path.join(tmpDir, ".taskgraph", "lock");
  const graphPath = path.join(tmpDir, ".taskgraph", "workgraph.json");

  const { child, done } = spawnCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--interval-ms", "0", "--no-live", "--no-color"],
  });

  try {
    await waitFor(async () => {
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      if (Number(lock.pid) !== child.pid) return false;
      const graph = JSON.parse(await readFile(graphPath, "utf8"));
      const plan = (graph.nodes || []).find((n) => n.id === "plan-000");
      return Boolean(plan && plan.status === "in_progress" && plan.lock && plan.lock.runId);
    });

    child.kill("SIGTERM");
    const res = await done;
    assert.notEqual(res.code, 0, `expected non-zero exit code, got ${res.code}\n${res.stderr}\n${res.stdout}`);

    const graph = JSON.parse(await readFile(graphPath, "utf8"));
    const plan = (graph.nodes || []).find((n) => n.id === "plan-000");
    assert.ok(plan, "missing plan-000 node");
    assert.equal(plan.status, "open");
    assert.equal(plan.lock, null);

    await assert.rejects(() => stat(lockPath));
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
});

test("stop: choreo stop signals a running supervisor", { timeout: 10_000 }, async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const sleepAgentPath = fileURLToPath(new URL("../scripts/sleep-agent.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-stop-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Stop test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".taskgraph", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          sleepy: { cmd: `node ${sleepAgentPath} 600000` },
        },
        roles: {
          main: "sleepy",
          planner: "sleepy",
          executor: "sleepy",
          verifier: "sleepy",
          integrator: "sleepy",
          finalVerifier: "sleepy",
          researcher: "sleepy",
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

  const lockPath = path.join(tmpDir, ".taskgraph", "lock");
  const graphPath = path.join(tmpDir, ".taskgraph", "workgraph.json");

  const { child, done } = spawnCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--interval-ms", "0", "--no-live", "--no-color"],
  });

  try {
    await waitFor(async () => {
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      return Number(lock.pid) === child.pid;
    });

    const stopRes = await runCli({ binPath, cwd: tmpDir, args: ["stop", "--no-color"] });
    assert.equal(stopRes.code, 0, stopRes.stderr || stopRes.stdout);
    assert.match(stopRes.stderr + stopRes.stdout, /Sent/i);

    const runRes = await done;
    assert.notEqual(runRes.code, 0, runRes.stderr || runRes.stdout);

    const graph = JSON.parse(await readFile(graphPath, "utf8"));
    const plan = (graph.nodes || []).find((n) => n.id === "plan-000");
    assert.ok(plan, "missing plan-000 node");
    assert.equal(plan.status, "open");
    assert.equal(plan.lock, null);

    await assert.rejects(() => stat(lockPath));
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
});

