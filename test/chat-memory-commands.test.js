import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

test("chat: /memory prints rollup and /forget clears it", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-chat-memory-cmds-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const putRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["kv", "put", "--run", "--key", "chat.rollup", "--value", "S1", "--no-color"],
  });
  assert.equal(putRes.code, 0, putRes.stderr || putRes.stdout);

  const res = await runCliInteractive({
    binPath,
    cwd: tmpDir,
    args: ["chat", "--no-llm", "--no-color"],
    input: "/memory\n/forget\n/memory\n/exit\n",
  });
  assert.equal(res.code, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /rolling_summary:\s*S1/);
  assert.match(res.stdout, /Cleared chat memory/);
  assert.match(res.stdout, /Chat memory: \(empty\)/);
});

