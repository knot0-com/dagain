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

test("run: .claude ownership routes claude -> fallback runner", { timeout: 10_000 }, async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const markerAgentPath = fileURLToPath(new URL("../scripts/mock-agent-marker.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-sensitive-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Sensitive runner override", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".choreo", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          claude: { cmd: `node ${markerAgentPath} claude {packet}` },
          codex: { cmd: `node ${markerAgentPath} codex {packet}` },
        },
        roles: {
          main: "codex",
          planner: "codex",
          executor: "claude",
          verifier: "codex",
          integrator: "codex",
          finalVerifier: "codex",
          researcher: "codex",
        },
        supervisor: {
          idleSleepMs: 0,
          staleLockSeconds: 3600,
          claudeSensitiveFallbackRunner: "codex",
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const graphPath = path.join(tmpDir, ".choreo", "workgraph.json");
  const graph = JSON.parse(await readFile(graphPath, "utf8"));
  const now = new Date().toISOString();
  graph.nodes = [
    {
      id: "plan-000",
      title: "Skip planning",
      type: "plan",
      status: "done",
      dependsOn: [],
      ownership: [],
      acceptance: [],
      verify: [],
      attempts: 0,
      retryPolicy: { maxAttempts: 1 },
      createdAt: now,
      updatedAt: now,
      lock: null,
      completedAt: now,
    },
    {
      id: "task-sensitive",
      title: "Write marker via fallback runner",
      type: "task",
      status: "open",
      dependsOn: [],
      ownership: [".claude/skills/**", "runner_marker.txt"],
      acceptance: ["Creates runner_marker.txt"],
      verify: ["cat runner_marker.txt"],
      attempts: 0,
      retryPolicy: { maxAttempts: 1 },
      createdAt: now,
      updatedAt: now,
      lock: null,
    },
  ];
  await writeFile(graphPath, JSON.stringify(graph, null, 2) + "\n", "utf8");

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--max-iterations", "10", "--interval-ms", "0", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);

  const marker = await readFile(path.join(tmpDir, "runner_marker.txt"), "utf8");
  assert.equal(marker, "codex\n");
});

