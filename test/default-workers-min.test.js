// Input — node:test/assert plus CLI subprocess. If this file changes, update this header and the folder Markdown.
// Output — regression test that default workers is at least 3 unless explicitly overridden. If this file changes, update this header and the folder Markdown.
// Position — protects UX: parallel execution by default (min 3 workers). If this file changes, update this header and the folder Markdown.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec } from "./helpers/sqlite.js";

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

test("run: uses at least 3 workers by default", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-default-workers-"));

  try {
    const initRes = await runCli({
      binPath,
      cwd: tmpDir,
      args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
    });
    assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

    // Simulate an older config where supervisor.workers=1.
    const configPath = path.join(tmpDir, ".dagain", "config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          version: 1,
          defaults: { retryPolicy: { maxAttempts: 1 }, verifyRunner: "shellVerify", mergeRunner: "shellMerge" },
          runners: {
            shellVerify: { cmd: "true" },
            shellMerge: { cmd: "true" },
          },
          roles: {
            main: "shellVerify",
            planner: "shellVerify",
            executor: "shellVerify",
            verifier: "shellVerify",
            integrator: "shellVerify",
            finalVerifier: "shellVerify",
            researcher: "shellVerify",
          },
          supervisor: { workers: 1, idleSleepMs: 0, staleLockSeconds: 3600 },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    // Prevent any work from executing (avoid runner invocation); we only want to observe header output.
    const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
    await sqliteExec(
      dbPath,
      "UPDATE nodes SET status='done', lock_run_id=NULL, lock_started_at=NULL, lock_pid=NULL, lock_host=NULL;",
    );

    const runRes = await runCli({
      binPath,
      cwd: tmpDir,
      args: ["run", "--max-iterations", "1", "--interval-ms", "0", "--no-live", "--no-color", "--no-prompt"],
    });
    assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
    assert.match(runRes.stdout + runRes.stderr, /workers:\s*3/);
  } finally {
    await runCli({ binPath, cwd: tmpDir, args: ["stop", "--signal", "SIGTERM"] }).catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
