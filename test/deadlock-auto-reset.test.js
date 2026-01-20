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

test("run: auto-resets failed deps when graph is blocked", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-deadlock-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Deadlock test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const graphPath = path.join(tmpDir, ".choreo", "workgraph.json");
  const graph = JSON.parse(await readFile(graphPath, "utf8"));

  graph.nodes = [
    { id: "plan-000", title: "plan", type: "plan", status: "done", dependsOn: [] },
    { id: "task-001", title: "failed dep", type: "task", status: "failed", dependsOn: [], attempts: 3, retryPolicy: { maxAttempts: 3 } },
    { id: "task-002", title: "blocked task", type: "task", status: "open", dependsOn: ["task-001"] },
  ];

  await writeFile(graphPath, JSON.stringify(graph, null, 2) + "\n", "utf8");

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--max-iterations", "3", "--interval-ms", "0", "--dry-run", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
  assert.match(runRes.stdout + runRes.stderr, /Reopened failed node/i);

  const updated = JSON.parse(await readFile(graphPath, "utf8"));
  const task001 = updated.nodes.find((n) => n.id === "task-001");
  assert.ok(task001, "task-001 missing");
  assert.equal(task001.status, "open");
  assert.equal(task001.attempts, 0);
  assert.equal(task001.autoResetCount, 1);
});

