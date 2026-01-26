import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec, sqliteJson } from "./helpers/sqlite.js";
import { applyResult } from "../src/lib/db/nodes.js";

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

function parseRetryPolicy(row) {
  try {
    return JSON.parse(String(row?.retry_policy_json || ""));
  } catch {
    return null;
  }
}

test("applyResult: defaultRetryPolicy applies to added nodes", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-retry-policy-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
  const now = new Date().toISOString().replace(/'/g, "''");
  await sqliteExec(
    dbPath,
    `DELETE FROM deps;\n` +
      `DELETE FROM nodes;\n` +
      `INSERT INTO nodes(id, title, type, status, retry_policy_json, created_at, updated_at)\n` +
      `VALUES('a','a','plan','open','{\"maxAttempts\":1}','${now}','${now}');\n`,
  );

  await applyResult({
    dbPath,
    nodeId: "a",
    runId: "run-1",
    nowIso: new Date().toISOString(),
    defaultRetryPolicy: { maxAttempts: 1 },
    result: {
      status: "success",
      next: {
        addNodes: [{ id: "b", title: "b", type: "task", status: "open", dependsOn: ["a"] }],
        setStatus: [],
      },
    },
  });

  const bRows = await sqliteJson(dbPath, "SELECT retry_policy_json FROM nodes WHERE id='b';");
  const policy = parseRetryPolicy(bRows[0]);
  assert.equal(policy?.maxAttempts, 1);
});

test("applyResult: defaultRetryPolicy applies to escalation nodes", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-retry-policy-escalate-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
  const now = new Date().toISOString().replace(/'/g, "''");
  await sqliteExec(
    dbPath,
    `DELETE FROM deps;\n` +
      `DELETE FROM nodes;\n` +
      `INSERT INTO nodes(id, title, type, status, attempts, retry_policy_json, created_at, updated_at)\n` +
      `VALUES('a','a','task','open',0,'{\"maxAttempts\":1}','${now}','${now}');\n`,
  );

  await applyResult({
    dbPath,
    nodeId: "a",
    runId: "run-1",
    nowIso: new Date().toISOString(),
    defaultRetryPolicy: { maxAttempts: 1 },
    result: { status: "fail", next: { addNodes: [], setStatus: [] } },
  });

  const escalationRows = await sqliteJson(dbPath, "SELECT retry_policy_json FROM nodes WHERE id='plan-escalate-a';");
  const policy = parseRetryPolicy(escalationRows[0]);
  assert.equal(policy?.maxAttempts, 1);
});

