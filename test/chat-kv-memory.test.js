import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

function runCliInteractive({ binPath, cwd, args, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? 0, signal, stdout, stderr }));
    child.stdin.end(String(input || ""));
  });
}

test("chat: persists KV chat memory and injects it next run", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const routerPath = fileURLToPath(new URL("../scripts/mock-chat-router-memory.js", import.meta.url));
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-chat-kv-memory-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".choreo", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          mock: { cmd: `node ${routerPath} {packet}` },
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
        supervisor: { idleSleepMs: 0, staleLockSeconds: 3600 },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const first = await runCliInteractive({
    binPath,
    cwd: tmpDir,
    args: ["chat", "--runner", "mock", "--no-color"],
    input: "hello\n/exit\n",
  });
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.match(first.stdout, /no-memory/);

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  const rows = await sqliteJson(
    dbPath,
    "SELECT node_id, key, value_text FROM kv_latest WHERE node_id='__run__' AND key IN ('chat.turns','chat.summary','chat.last_ops') ORDER BY key;",
  );
  const keys = rows.map((r) => String(r.key));
  assert.deepEqual(keys, ["chat.last_ops", "chat.summary", "chat.turns"]);
  assert.match(String(rows.find((r) => r.key === "chat.turns")?.value_text || ""), /hello/);

  const second = await runCliInteractive({
    binPath,
    cwd: tmpDir,
    args: ["chat", "--runner", "mock", "--no-color"],
    input: "hi again\n/exit\n",
  });
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.match(second.stdout, /memory-seen/);
});

