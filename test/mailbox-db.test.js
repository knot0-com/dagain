import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { mailboxAck, mailboxClaimNext, mailboxEnqueue } from "../src/lib/db/mailbox.js";
import { sqliteJson } from "./helpers/sqlite.js";

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

test("mailbox: enqueue -> claim -> ack", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-mailbox-db-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Mailbox DB test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".taskgraph", "state.sqlite");
  const now = new Date().toISOString();

  const enq = await mailboxEnqueue({ dbPath, command: "pause", args: null, nowIso: now });
  assert.ok(Number.isFinite(enq.id) && enq.id > 0, `expected id, got ${JSON.stringify(enq)}`);

  const claimed = await mailboxClaimNext({ dbPath, pid: 123, host: "test-host", nowIso: now });
  assert.ok(claimed, "expected claim");
  assert.equal(claimed.id, enq.id);
  assert.equal(claimed.command, "pause");
  assert.deepEqual(claimed.args, {});

  await mailboxAck({ dbPath, id: claimed.id, status: "done", result: { paused: true }, errorText: null, nowIso: now });
  const rows = await sqliteJson(
    dbPath,
    `SELECT id, status, command, args_json, result_json, error_text FROM mailbox WHERE id=${claimed.id} LIMIT 1;`,
  );
  assert.equal(rows[0]?.status, "done");
  assert.equal(rows[0]?.command, "pause");
  assert.equal(JSON.parse(rows[0]?.result_json || "{}")?.paused, true);
});

test("mailbox: args_json persists for set-workers", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-mailbox-args-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Mailbox args test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".taskgraph", "state.sqlite");
  const now = new Date().toISOString();

  const enq = await mailboxEnqueue({ dbPath, command: "set_workers", args: { workers: 3 }, nowIso: now });
  const claimed = await mailboxClaimNext({ dbPath, pid: 999, host: "test-host", nowIso: now });
  assert.ok(claimed, "expected claim");
  assert.equal(claimed.id, enq.id);
  assert.equal(claimed.command, "set_workers");
  assert.equal(claimed.args?.workers, 3);
});

