// Input — node:test/assert, temp dagain project, mock runner scripts. If this file changes, update this header and the folder Markdown.
// Output — regression coverage for needs_human timeout auto-answer behavior. If this file changes, update this header and the folder Markdown.
// Position — prevents non-interactive supervisors from stalling forever on checkpoints. If this file changes, update this header and the folder Markdown.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

test("run: needs_human auto-answers after timeout and continues", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-needs-human-timeout-"));

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
        '  if (process.stdin.isTTY) return "";',
        '  process.stdin.setEncoding("utf8");',
        '  let out = "";',
        "  for await (const chunk of process.stdin) out += chunk;",
        "  return out;",
        "}",
        "",
        "function result(obj) { process.stdout.write(`<result>${JSON.stringify(obj)}</result>\\n`); }",
        'const role = String(process.argv[2] || "").trim();',
        'const packetPath = String(process.argv[3] || "").trim();',
        'const packet = packetPath ? await fs.readFile(packetPath, "utf8") : await readAllStdin();',
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
        "    checkpoint: { question: \"Proceed?\", context: \"Test checkpoint\", options: [\"yes\", \"no\"], resumeSignal: \"Answer yes/no\" },",
        "    errors: [],",
        "    confidence: 0.5,",
        "  });",
        "} else {",
        "  result({ version: 1, role: \"planner\", status: \"success\", summary: \"Proceeded after auto-answer\", next: { addNodes: [], setStatus: [] }, checkpoint: null, errors: [], confidence: 1 });",
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
            needsHumanTimeoutMs: 50,
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const runRes = await runCli({
      binPath,
      cwd: tmpDir,
      args: ["run", "--workers", "1", "--max-iterations", "200", "--interval-ms", "0", "--no-live", "--no-color", "--no-prompt"],
    });
    assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
    assert.match(runRes.stdout + runRes.stderr, /All nodes done\./);

    const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
    const rows = await sqliteJson(dbPath, "SELECT id, status, checkpoint_json FROM nodes WHERE id='plan-000' LIMIT 1;");
    assert.equal(rows[0]?.status, "done");

    const progressPath = path.join(tmpDir, ".dagain", "memory", "progress.md");
    const progress = await readFile(progressPath, "utf8").catch(() => "");
    assert.match(progress, /Auto-answered checkpoint/i);

    const chatRows = await sqliteJson(
      dbPath,
      "SELECT value_text FROM kv_latest WHERE node_id='__run__' AND key='chat.turns' LIMIT 1;",
    );
    const turns = chatRows[0]?.value_text ? JSON.parse(chatRows[0].value_text) : [];
    assert.ok(Array.isArray(turns) && turns.length > 0);
    const replies = turns.map((t) => String(t?.reply || ""));
    assert.ok(replies.some((t) => t.includes("waiting for human input") || t.includes("waiting for human")), "expected needs_human system notice");
    assert.ok(replies.some((t) => t.includes("auto-answered checkpoint")), "expected auto-answer system notice");

    const checkpointsDir = path.join(tmpDir, ".dagain", "checkpoints");
    const files = (await readdir(checkpointsDir).catch(() => [])).filter(Boolean).sort();
    const resp = files.find((f) => f.startsWith("response-auto-plan-000-") && f.endsWith(".json")) || "";
    assert.ok(resp, `expected an auto response file, got: ${files.join(", ")}`);
    const responseJson = JSON.parse(await readFile(path.join(checkpointsDir, resp), "utf8"));
    assert.match(String(responseJson?.answer || ""), /Decide the safest default/i);
  } finally {
    await runCli({ binPath, cwd: tmpDir, args: ["stop", "--signal", "SIGTERM"] }).catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
