import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec, sqliteJson } from "./helpers/sqlite.js";

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

test("answer: updates sqlite state and reopens node", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-answer-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Answer DB test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  const checkpointsDir = path.join(tmpDir, ".choreo", "checkpoints");
  await mkdir(checkpointsDir, { recursive: true });

  const checkpointPathAbs = path.join(checkpointsDir, "checkpoint-123.json");
  await writeFile(
    checkpointPathAbs,
    JSON.stringify(
      {
        version: 1,
        id: "123",
        question: "Proceed?",
        options: ["yes", "no"],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const checkpointMeta = {
    version: 1,
    runId: "run-123",
    path: path.relative(tmpDir, checkpointPathAbs),
    question: "Proceed?",
  };

  const now = new Date().toISOString().replace(/'/g, "''");
  const checkpointJson = JSON.stringify(checkpointMeta).replace(/'/g, "''");
  await sqliteExec(
    dbPath,
    `INSERT INTO nodes(\n` +
      `  id, title, type, status,\n` +
      `  checkpoint_json,\n` +
      `  lock_run_id, lock_started_at, lock_pid, lock_host,\n` +
      `  created_at, updated_at\n` +
      `)\n` +
      `VALUES(\n` +
      `  'task-ask','Ask','task','needs_human',\n` +
      `  '${checkpointJson}',\n` +
      `  'stale','${now}',123,'host',\n` +
      `  '${now}','${now}'\n` +
      `);\n`,
  );

  const snapshotPath = path.join(tmpDir, ".choreo", "workgraph.json");
  await rm(snapshotPath, { force: true });

  const answerRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["answer", "--node", "task-ask", "--answer", "yes", "--no-prompt", "--no-color"],
  });
  assert.equal(answerRes.code, 0, answerRes.stderr || answerRes.stdout);

  const row = await sqliteJson(
    dbPath,
    "SELECT status, checkpoint_json, lock_run_id, lock_started_at, lock_pid, lock_host FROM nodes WHERE id='task-ask';",
  );
  assert.equal(row[0]?.status, "open");
  assert.equal(row[0]?.lock_run_id, null);
  assert.equal(row[0]?.lock_started_at, null);
  assert.equal(row[0]?.lock_pid, null);
  assert.equal(row[0]?.lock_host, null);

  const checkpoint = JSON.parse(row[0]?.checkpoint_json || "null");
  assert.equal(checkpoint?.answer, "yes");
  assert.ok(typeof checkpoint?.answeredAt === "string" && checkpoint.answeredAt.length > 0);
  assert.ok(typeof checkpoint?.responsePath === "string" && checkpoint.responsePath.length > 0);

  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const answered = (snapshot.nodes || []).find((n) => n.id === "task-ask");
  assert.equal(answered?.status, "open");
});

