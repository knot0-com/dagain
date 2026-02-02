// Input — node:test/assert, child_process, temp filesystem; runs `dagain` CLI. If this file changes, update this header and the folder Markdown.
// Output — regression test ensuring `dagain control resume` starts a supervisor when none is running. If this file changes, update this header and the folder Markdown.
// Position — guards against “graph stuck” when users enqueue controls without an active supervisor. If this file changes, update this header and the folder Markdown.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function readSupervisorLock(lockPath) {
  return readFile(lockPath, "utf8")
    .then((t) => JSON.parse(t))
    .catch(() => null);
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("control resume: starts supervisor if none running", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-control-autostart-"));

  try {
    const initRes = await runCli({
      binPath,
      cwd: tmpDir,
      args: ["init", "--goal", "Create hello.txt", "--no-refine", "--force", "--no-color"],
    });
    assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

    // Make execution slow enough that we can reliably observe the lock file.
    const slowAgentPath = path.join(tmpDir, "slow-agent.js");
    await writeFile(
      slowAgentPath,
      [
        'import { setTimeout as sleep } from "node:timers/promises";',
        'import fs from "node:fs/promises";',
        'import path from "node:path";',
        "",
        "async function readAllStdin() {",
        '  if (process.stdin.isTTY) return "";',
        '  process.stdin.setEncoding("utf8");',
        '  let out = "";',
        "  for await (const chunk of process.stdin) out += chunk;",
        "  return out;",
        "}",
        "",
        "function extractNodeId(packet) {",
        '  const m = String(packet || "").match(/^- ID:\\s*(.+)\\s*$/m);',
        '  return m ? m[1].trim() : "";',
        "}",
        "",
        "function result(obj) {",
        '  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\\n`);',
        "}",
        "",
        'const role = String(process.argv[2] || "").trim();',
        'const packetPath = String(process.argv[3] || "").trim();',
        "",
        'const packet = packetPath ? await fs.readFile(packetPath, "utf8") : await readAllStdin();',
        "const nodeId = extractNodeId(packet);",
        "const cwd = process.cwd();",
        "",
        "if (role === \"planner\") {",
        "  await sleep(400);",
        "  result({",
        "    version: 1,",
        "    role: \"planner\",",
        "    status: \"success\",",
        "    summary: \"Seeded a tiny hello.txt task + verifier\",",
        "    next: {",
        "      addNodes: [",
        "        { id: \"task-hello\", title: \"Create hello.txt\", type: \"task\", status: \"open\", dependsOn: [] },",
        "        { id: \"verify-hello\", title: \"Verify hello.txt\", type: \"verify\", status: \"open\", dependsOn: [\"task-hello\"] },",
        "      ],",
        "      setStatus: [],",
        "    },",
        "    checkpoint: null,",
        "    errors: [],",
        "    confidence: 1,",
        "  });",
        "} else if (role === \"executor\") {",
        "  await sleep(200);",
        "  await fs.writeFile(path.join(cwd, \"hello.txt\"), \"hello from dagain\\n\", \"utf8\");",
        "  result({ version: 1, role: \"executor\", nodeId, status: \"success\", summary: \"Wrote hello.txt\", next: { addNodes: [], setStatus: [] }, checkpoint: null, errors: [], confidence: 1 });",
        "} else if (role === \"verifier\") {",
        "  await sleep(200);",
        "  result({ version: 1, role: \"verifier\", nodeId, status: \"success\", summary: \"Verified\", next: { addNodes: [], setStatus: [] }, checkpoint: null, errors: [], confidence: 1 });",
        "} else {",
        "  result({ version: 1, role, nodeId, status: \"success\", summary: \"ok\", next: { addNodes: [], setStatus: [] }, checkpoint: null, errors: [], confidence: 1 });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(slowAgentPath, 0o755);

    const configPath = path.join(tmpDir, ".dagain", "config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          version: 1,
          runners: {
            slowPlanner: { cmd: `node ${slowAgentPath} planner` },
            slowExecutor: { cmd: `node ${slowAgentPath} executor` },
            slowVerifier: { cmd: `node ${slowAgentPath} verifier` },
            slowIntegrator: { cmd: `node ${slowAgentPath} integrator` },
            slowFinalVerifier: { cmd: `node ${slowAgentPath} finalVerifier` },
          },
          roles: {
            main: "slowPlanner",
            planner: "slowPlanner",
            executor: "slowExecutor",
            verifier: "slowVerifier",
            integrator: "slowIntegrator",
            finalVerifier: "slowFinalVerifier",
            researcher: "slowPlanner",
          },
          supervisor: {
            workers: 1,
            idleSleepMs: 0,
            staleLockSeconds: 3600,
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const lockPath = path.join(tmpDir, ".dagain", "lock");
    await rm(lockPath, { force: true });

    const res = await runCli({ binPath, cwd: tmpDir, args: ["control", "resume"] });
    assert.equal(res.code, 0, res.stderr || res.stdout);

    const lock = await waitFor(async () => {
      const value = await readSupervisorLock(lockPath);
      const pid = Number(value?.pid);
      if (!isPidAlive(pid)) return null;
      return value;
    });

    assert.ok(lock, "expected supervisor lock file to appear after control resume");
  } finally {
    // Best-effort cleanup: stop supervisor if still running.
    await runCli({ binPath, cwd: tmpDir, args: ["stop", "--signal", "SIGTERM"] }).catch(() => {});
    // Ensure temp dir is removed even if background logs exist.
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("control resume --no-start: only enqueues (does not start supervisor)", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-control-no-start-"));

  try {
    const initRes = await runCli({
      binPath,
      cwd: tmpDir,
      args: ["init", "--goal", "Create hello.txt", "--no-refine", "--force", "--no-color"],
    });
    assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

    const lockPath = path.join(tmpDir, ".dagain", "lock");
    await rm(lockPath, { force: true });

    const res = await runCli({ binPath, cwd: tmpDir, args: ["control", "resume", "--no-start"] });
    assert.equal(res.code, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Enqueued resume/);
    assert.doesNotMatch(res.stdout, /Started supervisor pid=/);

    const lock = await waitFor(
      async () => {
        const value = await readSupervisorLock(lockPath);
        const pid = Number(value?.pid);
        if (!isPidAlive(pid)) return null;
        return value;
      },
      { timeoutMs: 1000, intervalMs: 50 },
    );
    assert.equal(lock, null, "expected no supervisor lock to appear when using --no-start");
  } finally {
    await runCli({ binPath, cwd: tmpDir, args: ["stop", "--signal", "SIGTERM"] }).catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
