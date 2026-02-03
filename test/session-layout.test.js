// Input — dagain CLI invoked via node child_process in a temp project dir.
// Output — asserts new per-session `.dagain/sessions/<id>/...` layout after init.
// Position — regression test for session-scoped state + removal of project-root GOAL.md.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
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

test("init: creates a session-scoped state directory and no project-root GOAL.md", async () => {
  const dagainRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(dagainRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-session-layout-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const currentSessionRaw = await readFile(path.join(tmpDir, ".dagain", "current-session.json"), "utf8");
  const currentSession = JSON.parse(currentSessionRaw);
  const sessionId = String(currentSession?.id || "").trim();
  assert.ok(sessionId, "expected current-session.json to include a session id");

  const sessionDir = path.join(tmpDir, ".dagain", "sessions", sessionId);
  await stat(path.join(sessionDir, "state.sqlite"));
  await stat(path.join(sessionDir, "workgraph.json"));
  await stat(path.join(sessionDir, "GOAL.md"));

  await assert.rejects(async () => stat(path.join(tmpDir, "GOAL.md")));
});

