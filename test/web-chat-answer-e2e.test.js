// Input — node:test/assert, temp dagain project, dashboard server, mock runner scripts. If this file changes, update this header and the folder Markdown.
// Output — e2e regression coverage: web chat can answer needs_human and unblock the run. If this file changes, update this header and the folder Markdown.
// Position — protects interactive UX where the detached supervisor runs with --no-prompt. If this file changes, update this header and the folder Markdown.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { dagainPaths } from "../src/lib/config.js";
import { serveDashboard } from "../src/ui/server.js";
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

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForStatus({ dbPath, nodeId, want, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sqliteJson(dbPath, `SELECT id, status FROM nodes WHERE id='${nodeId}' LIMIT 1;`);
    const status = rows[0]?.status || "";
    if (status === want) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${nodeId} to become ${want}`);
}

function extractToken(html) {
  const m = String(html || "").match(/token:\s*"([a-f0-9]{10,})"/i);
  return m ? m[1] : "";
}

async function waitForNotStatus({ dbPath, nodeId, notWant, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sqliteJson(dbPath, `SELECT id, status FROM nodes WHERE id='${nodeId}' LIMIT 1;`);
    const status = rows[0]?.status || "";
    if (status && status !== notWant) return status;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${nodeId} to change from ${notWant}`);
}

test("web chat: /answer unblocks needs_human and run completes", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-web-answer-e2e-"));

  let dashboard = null;
  try {
    const initRes = await runCli({
      binPath,
      cwd: tmpDir,
      args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
    });
    assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

    const mockPath = path.join(tmpDir, "mock-checkpoint-once.js");
    await writeFile(
      mockPath,
      [
        'import fs from "node:fs/promises";',
        "",
        "async function readAllStdin() {",
        '  if (process.stdin.isTTY) return \"\";',
        '  process.stdin.setEncoding(\"utf8\");',
        '  let out = \"\";',
        "  for await (const chunk of process.stdin) out += chunk;",
        "  return out;",
        "}",
        "",
        "function result(obj) { process.stdout.write(`<result>${JSON.stringify(obj)}</result>\\n`); }",
        'const role = String(process.argv[2] || \"\").trim();',
        'const packetPath = String(process.argv[3] || \"\").trim();',
        'const packet = packetPath ? await fs.readFile(packetPath, \"utf8\") : await readAllStdin();',
        'const hasAnswer = /-\\s*answer:\\s*.+/i.test(packet);',
        "",
        "if (role !== \"planner\") {",
        "  result({ version: 1, role, status: \"success\", summary: \"ok\", next: { addNodes: [], setStatus: [] }, checkpoint: null, errors: [], confidence: 1 });",
        "} else if (!hasAnswer) {",
        "  result({",
        "    version: 1,",
        "    role: \"planner\",",
        "    status: \"checkpoint\",",
        "    summary: \"Need a decision\",",
        "    next: { addNodes: [], setStatus: [] },",
        "    checkpoint: { question: \"Proceed?\", context: \"E2E checkpoint\", options: [\"yes\", \"no\"], resumeSignal: \"Answer yes/no\" },",
        "    errors: [],",
        "    confidence: 0.5,",
        "  });",
        "} else {",
        "  result({ version: 1, role: \"planner\", status: \"success\", summary: \"Proceeded after human answer\", next: { addNodes: [], setStatus: [] }, checkpoint: null, errors: [], confidence: 1 });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(mockPath, 0o755);

    const configPath = path.join(tmpDir, ".dagain", "config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          version: 1,
          runners: {
            mock: { cmd: `node ${mockPath} planner {packet}` },
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
          supervisor: {
            workers: 1,
            idleSleepMs: 0,
            staleLockSeconds: 3600,
            needsHumanTimeoutMs: 60_000,
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const paths = dagainPaths(tmpDir);
    dashboard = await serveDashboard({ paths, host: "127.0.0.1", port: 0 });
    const htmlRes = await fetch(`${dashboard.url}/`);
    const html = await htmlRes.text();
    const token = extractToken(html);
    assert.ok(token, "expected dashboard HTML to embed token");

    const startRes = await fetch(`${dashboard.url}/api/control/start`, { method: "POST", headers: { "x-dagain-token": token } });
    assert.equal(startRes.status, 200);

    const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
    await waitForStatus({ dbPath, nodeId: "plan-000", want: "needs_human", timeoutMs: 5000 });

    const answerRes = await fetch(`${dashboard.url}/api/chat/send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dagain-token": token },
      body: JSON.stringify({ message: "/answer yes" }),
    });
    assert.equal(answerRes.status, 200);
    const answerJson = await answerRes.json();
    assert.equal(Boolean(answerJson?.ok), true);
    assert.match(String(answerJson?.reply || ""), /Recorded answer/i);

    await waitForNotStatus({ dbPath, nodeId: "plan-000", notWant: "needs_human", timeoutMs: 5000 });
    await waitForStatus({ dbPath, nodeId: "plan-000", want: "done", timeoutMs: 15_000 });
  } finally {
    try {
      await dashboard?.close?.();
    } catch {}
    await runCli({ binPath, cwd: tmpDir, args: ["stop", "--signal", "SIGTERM"] }).catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
