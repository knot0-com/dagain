import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec, sqliteJson } from "./helpers/sqlite.js";

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

function spawnCli({ binPath, cwd, args }) {
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
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? 0, signal, stdout, stderr }));
  });
  return { child, done };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    const ok = await predicate().catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function seedDonePlan(dbPath) {
  const now = new Date().toISOString();
  await sqliteExec(
    dbPath,
    `UPDATE nodes\n` +
      `SET status='done',\n` +
      `    attempts=0,\n` +
      `    checkpoint_json=NULL,\n` +
      `    lock_run_id=NULL,\n` +
      `    lock_started_at=NULL,\n` +
      `    lock_pid=NULL,\n` +
      `    lock_host=NULL,\n` +
      `    completed_at='${now.replace(/'/g, "''")}',\n` +
      `    updated_at='${now.replace(/'/g, "''")}'\n` +
      `WHERE id='plan-000';\n`,
  );
}

async function seedTask(dbPath, { id, title, ownership, retryPolicy = { maxAttempts: 1 } }) {
  const now = new Date().toISOString();
  const idSql = `'${String(id).replace(/'/g, "''")}'`;
  const titleSql = `'${String(title || id).replace(/'/g, "''")}'`;
  const ownershipJson = JSON.stringify(Array.isArray(ownership) ? ownership : []);
  const retryPolicyJson = JSON.stringify(retryPolicy);
  await sqliteExec(
    dbPath,
    `INSERT OR REPLACE INTO nodes(\n` +
      `  id, title, type, status,\n` +
      `  runner, inputs_json, ownership_json, acceptance_json, verify_json,\n` +
      `  retry_policy_json, attempts,\n` +
      `  created_at, updated_at\n` +
      `)\n` +
      `VALUES(\n` +
      `  ${idSql}, ${titleSql}, 'task', 'open',\n` +
      `  NULL, '[]', '${ownershipJson.replace(/'/g, "''")}', '[]', '[]',\n` +
      `  '${retryPolicyJson.replace(/'/g, "''")}', 0,\n` +
      `  '${now.replace(/'/g, "''")}', '${now.replace(/'/g, "''")}'\n` +
      `);\n`,
  );
}

function nodeStatus(rows, id) {
  return rows.find((r) => r.id === id)?.status || null;
}

test("mailbox: pause/resume gates scheduling", { timeout: 20_000 }, async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockSleepAgentPath = fileURLToPath(new URL("../scripts/mock-sleep-agent.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-mailbox-pause-"));
  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Mailbox pause test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  await writeFile(
    path.join(tmpDir, ".choreo", "config.json"),
    JSON.stringify(
      {
        version: 1,
        runners: {
          mockPlanner: { cmd: `node ${mockSleepAgentPath} planner` },
          mockExecutor: { cmd: `MOCK_SLEEP_MS=200 node ${mockSleepAgentPath} executor` },
          mockVerifier: { cmd: `node ${mockSleepAgentPath} verifier` },
          mockIntegrator: { cmd: `node ${mockSleepAgentPath} integrator` },
          mockFinalVerifier: { cmd: `node ${mockSleepAgentPath} finalVerifier` },
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
        supervisor: { idleSleepMs: 0, staleLockSeconds: 3600 },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  await seedDonePlan(dbPath);
  await seedTask(dbPath, { id: "task-a", title: "Write a", ownership: ["a.txt"] });
  await seedTask(dbPath, { id: "task-b", title: "Write b", ownership: ["b.txt"] });

  const { child, done } = spawnCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--interval-ms", "0", "--max-iterations", "200", "--no-live", "--no-color"],
  });

  try {
    await waitFor(async () => {
      const rows = await sqliteJson(dbPath, "SELECT id, status FROM nodes WHERE id IN ('task-a','task-b') ORDER BY id;");
      return nodeStatus(rows, "task-a") === "in_progress";
    });

    const pauseRes = await runCli({ binPath, cwd: tmpDir, args: ["control", "pause", "--no-color"] });
    assert.equal(pauseRes.code, 0, pauseRes.stderr || pauseRes.stdout);

    await waitFor(async () => {
      const rows = await sqliteJson(dbPath, "SELECT id, status FROM nodes WHERE id IN ('task-a','task-b') ORDER BY id;");
      return nodeStatus(rows, "task-a") === "done";
    });

    await new Promise((r) => setTimeout(r, 300));
    const rowsAfter = await sqliteJson(dbPath, "SELECT id, status FROM nodes WHERE id IN ('task-a','task-b') ORDER BY id;");
    assert.equal(nodeStatus(rowsAfter, "task-b"), "open");

    const resumeRes = await runCli({ binPath, cwd: tmpDir, args: ["control", "resume", "--no-color"] });
    assert.equal(resumeRes.code, 0, resumeRes.stderr || resumeRes.stdout);

    const runRes = await done;
    assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
});

test("mailbox: set-workers downscales concurrency", { timeout: 25_000 }, async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockSleepAgentPath = fileURLToPath(new URL("../scripts/mock-sleep-agent.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-mailbox-workers-"));
  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Mailbox workers test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  await writeFile(
    path.join(tmpDir, ".choreo", "config.json"),
    JSON.stringify(
      {
        version: 1,
        runners: {
          mockExecutor: { cmd: `MOCK_SLEEP_MS=350 node ${mockSleepAgentPath} executor` },
          mockVerifier: { cmd: `node ${mockSleepAgentPath} verifier` },
          mockIntegrator: { cmd: `node ${mockSleepAgentPath} integrator` },
          mockFinalVerifier: { cmd: `node ${mockSleepAgentPath} finalVerifier` },
        },
        roles: {
          main: "mockExecutor",
          planner: "mockExecutor",
          executor: "mockExecutor",
          verifier: "mockVerifier",
          integrator: "mockIntegrator",
          finalVerifier: "mockFinalVerifier",
          researcher: "mockExecutor",
        },
        supervisor: { idleSleepMs: 0, staleLockSeconds: 3600 },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  await seedDonePlan(dbPath);
  await seedTask(dbPath, { id: "task-1", title: "t1", ownership: ["t1.txt"] });
  await seedTask(dbPath, { id: "task-2", title: "t2", ownership: ["t2.txt"] });
  await seedTask(dbPath, { id: "task-3", title: "t3", ownership: ["t3.txt"] });

  const { child, done } = spawnCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--workers", "2", "--interval-ms", "0", "--max-iterations", "500", "--no-live", "--no-color"],
  });

  try {
    await waitFor(async () => {
      const rows = await sqliteJson(dbPath, "SELECT id, status FROM nodes WHERE id LIKE 'task-%' ORDER BY id;");
      const inProgress = rows.filter((r) => r.status === "in_progress").map((r) => r.id);
      return inProgress.length === 2;
    });

    const setRes = await runCli({
      binPath,
      cwd: tmpDir,
      args: ["control", "set-workers", "--workers", "1", "--no-color"],
    });
    assert.equal(setRes.code, 0, setRes.stderr || setRes.stdout);

    await waitFor(async () => {
      const rows = await sqliteJson(dbPath, "SELECT id, status FROM nodes WHERE id LIKE 'task-%' ORDER BY id;");
      const inProgress = rows.filter((r) => r.status === "in_progress").map((r) => r.id);
      const done = rows.filter((r) => r.status === "done").map((r) => r.id);
      return done.length >= 1 && inProgress.length === 1;
    });

    await new Promise((r) => setTimeout(r, 200));
    const rowsAfter = await sqliteJson(dbPath, "SELECT id, status FROM nodes WHERE id='task-3' LIMIT 1;");
    assert.equal(rowsAfter[0]?.status, "open");

    const runRes = await done;
    assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
});

test("mailbox: cancel aborts a running node", { timeout: 25_000 }, async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockSleepAgentPath = fileURLToPath(new URL("../scripts/mock-sleep-agent.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-mailbox-cancel-"));
  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Mailbox cancel test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  await writeFile(
    path.join(tmpDir, ".choreo", "config.json"),
    JSON.stringify(
      {
        version: 1,
        runners: {
          mockExecutor: { cmd: `MOCK_SLEEP_MS=5000 node ${mockSleepAgentPath} executor` },
          mockVerifier: { cmd: `node ${mockSleepAgentPath} verifier` },
          mockIntegrator: { cmd: `node ${mockSleepAgentPath} integrator` },
          mockFinalVerifier: { cmd: `node ${mockSleepAgentPath} finalVerifier` },
        },
        roles: {
          main: "mockExecutor",
          planner: "mockExecutor",
          executor: "mockExecutor",
          verifier: "mockVerifier",
          integrator: "mockIntegrator",
          finalVerifier: "mockFinalVerifier",
          researcher: "mockExecutor",
        },
        supervisor: { idleSleepMs: 0, staleLockSeconds: 3600 },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  await seedDonePlan(dbPath);
  await seedTask(dbPath, { id: "task-long", title: "long task", ownership: ["long.txt"] });

  const { child, done } = spawnCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--interval-ms", "0", "--max-iterations", "500", "--no-live", "--no-color"],
  });

  try {
    await waitFor(async () => {
      const rows = await sqliteJson(dbPath, "SELECT status FROM nodes WHERE id='task-long' LIMIT 1;");
      return rows[0]?.status === "in_progress";
    });

    const pauseRes = await runCli({ binPath, cwd: tmpDir, args: ["control", "pause", "--no-color"] });
    assert.equal(pauseRes.code, 0, pauseRes.stderr || pauseRes.stdout);

    const cancelRes = await runCli({
      binPath,
      cwd: tmpDir,
      args: ["control", "cancel", "--node", "task-long", "--no-color"],
    });
    assert.equal(cancelRes.code, 0, cancelRes.stderr || cancelRes.stdout);

    await waitFor(async () => {
      const rows = await sqliteJson(dbPath, "SELECT status, lock_run_id FROM nodes WHERE id='task-long' LIMIT 1;");
      return rows[0]?.status === "open" && rows[0]?.lock_run_id == null;
    });

    const markDoneRes = await runCli({
      binPath,
      cwd: tmpDir,
      args: ["node", "set-status", "--id", "task-long", "--status", "done", "--no-color"],
    });
    assert.equal(markDoneRes.code, 0, markDoneRes.stderr || markDoneRes.stdout);

    const resumeRes = await runCli({ binPath, cwd: tmpDir, args: ["control", "resume", "--no-color"] });
    assert.equal(resumeRes.code, 0, resumeRes.stderr || resumeRes.stdout);

    const runRes = await done;
    assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);

    const lockPath = path.join(tmpDir, ".choreo", "lock");
    await assert.rejects(() => readFile(lockPath, "utf8"));
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
});

test("mailbox: replan pauses non-planner until plan completes", { timeout: 25_000 }, async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockSleepAgentPath = fileURLToPath(new URL("../scripts/mock-sleep-agent.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-mailbox-replan-"));
  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Mailbox replan test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const plannerPath = path.join(tmpDir, "planner.js");
  await writeFile(
    plannerPath,
    [
      `async function readAllStdin() {`,
      `  if (process.stdin.isTTY) return "";`,
      `  process.stdin.setEncoding("utf8");`,
      `  let out = "";`,
      `  for await (const chunk of process.stdin) out += chunk;`,
      `  return out;`,
      `}`,
      `function result(obj) { process.stdout.write(\`<result>\${JSON.stringify(obj)}</result>\\n\`); }`,
      `await readAllStdin();`,
      `result({ version: 1, role: "planner", status: "success", summary: "Replanned (test)", next: { addNodes: [], setStatus: [] }, checkpoint: null, errors: [], confidence: 1 });`,
      ``,
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(tmpDir, ".choreo", "config.json"),
    JSON.stringify(
      {
        version: 1,
        runners: {
          testPlanner: { cmd: `node ${plannerPath}` },
          mockExecutor: { cmd: `MOCK_SLEEP_MS=200 node ${mockSleepAgentPath} executor` },
          mockVerifier: { cmd: `node ${mockSleepAgentPath} verifier` },
          mockIntegrator: { cmd: `node ${mockSleepAgentPath} integrator` },
          mockFinalVerifier: { cmd: `node ${mockSleepAgentPath} finalVerifier` },
        },
        roles: {
          main: "testPlanner",
          planner: "testPlanner",
          executor: "mockExecutor",
          verifier: "mockVerifier",
          integrator: "mockIntegrator",
          finalVerifier: "mockFinalVerifier",
          researcher: "testPlanner",
        },
        supervisor: { idleSleepMs: 0, staleLockSeconds: 3600 },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  await seedDonePlan(dbPath);
  await seedTask(dbPath, { id: "task-a", title: "Write a", ownership: ["a.txt"] });
  await seedTask(dbPath, { id: "task-b", title: "Write b", ownership: ["b.txt"] });

  const { child, done } = spawnCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--interval-ms", "0", "--max-iterations", "500", "--no-live", "--no-color"],
  });

  try {
    await waitFor(async () => {
      const rows = await sqliteJson(dbPath, "SELECT status FROM nodes WHERE id='task-a' LIMIT 1;");
      return rows[0]?.status === "in_progress";
    });

    const replanRes = await runCli({ binPath, cwd: tmpDir, args: ["control", "replan", "--no-color"] });
    assert.equal(replanRes.code, 0, replanRes.stderr || replanRes.stdout);

    await waitFor(async () => {
      const rows = await sqliteJson(dbPath, "SELECT status FROM nodes WHERE id='task-a' LIMIT 1;");
      return rows[0]?.status === "done";
    });

    await waitFor(async () => {
      const rows = await sqliteJson(dbPath, "SELECT status FROM nodes WHERE id='plan-000' LIMIT 1;");
      return rows[0]?.status === "in_progress";
    });

    await waitFor(async () => {
      const rows = await sqliteJson(dbPath, "SELECT status FROM nodes WHERE id='plan-000' LIMIT 1;");
      return rows[0]?.status === "done";
    });

    const runRes = await done;
    assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
});
