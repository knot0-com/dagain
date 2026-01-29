// Input — node:test/assert plus `loadDashboardSnapshot()`. If this file changes, update this header and the folder Markdown.
// Output — verifies the dashboard snapshot shape against an initialized repo. If this file changes, update this header and the folder Markdown.
// Position — Test coverage for the shared dashboard snapshot adapter. If this file changes, update this header and the folder Markdown.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { dagainPaths } from "../src/lib/config.js";
import { loadDashboardSnapshot } from "../src/lib/dashboard.js";

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

test("dashboard snapshot: includes nodes + counts", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-dashboard-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const snapshot = await loadDashboardSnapshot({ paths: dagainPaths(tmpDir) });
  assert.ok(snapshot && typeof snapshot === "object");
  assert.ok(snapshot.nowIso);
  assert.ok(snapshot.counts && typeof snapshot.counts === "object");
  assert.ok(Array.isArray(snapshot.nodes));
  assert.ok(snapshot.nodes.some((n) => n.id === "plan-000"));
});
