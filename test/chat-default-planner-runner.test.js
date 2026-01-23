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

test("chat: defaults to planner runner for NL routing", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const mockAgentPath = fileURLToPath(new URL("../scripts/mock-agent-marker.js", import.meta.url));
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-chat-default-planner-"));

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
          mockPlanner: { cmd: `node ${mockAgentPath} planner {packet}` },
          mockResearcher: { cmd: `node ${mockAgentPath} researcher {packet}` },
        },
        roles: {
          main: "mockResearcher",
          planner: "mockPlanner",
          researcher: "mockResearcher",
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

  const res = await runCliInteractive({
    binPath,
    cwd: tmpDir,
    args: ["chat", "--no-color"],
    input: "hello\n/exit\n",
  });
  assert.equal(res.code, 0, res.stderr || res.stdout);

  const marker = await readFile(path.join(tmpDir, "runner_marker.txt"), "utf8");
  assert.equal(marker.trim(), "planner");
});

