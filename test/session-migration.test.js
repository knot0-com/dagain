// Input — legacy `.dagain/` layout (state.sqlite/workgraph.json) + project-root GOAL.md.
// Output — asserts ensureSessionLayout() migrates legacy state into `.dagain/sessions/<id>/`.
// Position — regression test for one-time migration from legacy state directory layout.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

test("init: migrates legacy .dagain/* state into a legacy session and removes project-root GOAL.md", async () => {
  const dagainRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(dagainRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-session-migrate-"));

  await mkdir(path.join(tmpDir, ".dagain"), { recursive: true });
  await writeFile(path.join(tmpDir, ".dagain", "state.sqlite"), "", "utf8");
  await writeFile(path.join(tmpDir, ".dagain", "workgraph.json"), "{}", "utf8");
  await writeFile(path.join(tmpDir, "GOAL.md"), "# Goal\n\nLegacy\n", "utf8");

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--no-refine", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const currentSessionRaw = await readFile(path.join(tmpDir, ".dagain", "current-session.json"), "utf8");
  const currentSession = JSON.parse(currentSessionRaw);
  const sessionId = String(currentSession?.id || "").trim();
  assert.ok(sessionId.startsWith("legacy-"), `expected legacy session id, got: ${sessionId}`);

  const sessionDir = path.join(tmpDir, ".dagain", "sessions", sessionId);
  await stat(path.join(sessionDir, "state.sqlite"));
  await stat(path.join(sessionDir, "workgraph.json"));
  await stat(path.join(sessionDir, "GOAL.md"));

  const legacyCompat = await lstat(path.join(tmpDir, ".dagain", "state.sqlite"));
  assert.ok(legacyCompat.isSymbolicLink(), "expected .dagain/state.sqlite to be a symlink to the current session db");
  await assert.rejects(async () => stat(path.join(tmpDir, "GOAL.md")));
});
