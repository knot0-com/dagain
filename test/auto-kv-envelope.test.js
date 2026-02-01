import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteJson } from "./helpers/sqlite.js";

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

test("run: auto-writes KV envelope keys for each node run", async () => {
  const dagainRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(dagainRoot, "bin", "dagain.js");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-auto-kv-"));
  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const mockFailPath = path.join(tmpDir, "mock-fail.js");
  await writeFile(
    mockFailPath,
    [
      "process.stdout.write(`<result>${JSON.stringify({",
      "  version: 1,",
      "  role: 'planner',",
      "  status: 'fail',",
      "  summary: 'boom',",
      "  next: { addNodes: [], setStatus: [] },",
      "  checkpoint: null,",
      "  errors: ['boom'],",
      "  confidence: 0,",
      "})}</result>\\n`);",
      "",
    ].join("\n"),
    "utf8",
  );

  const configPath = path.join(tmpDir, ".dagain", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          mock: { cmd: `node ${mockFailPath} {packet}` },
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
          idleSleepMs: 0,
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
    args: ["run", "--max-iterations", "1", "--interval-ms", "0", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
  const rows = await sqliteJson(
    dbPath,
    "SELECT key, value_text, run_id FROM kv_latest\n" +
    "WHERE node_id='plan-000'\n" +
    "  AND key IN ('out.summary','out.last_stdout_path','out.last_result_path','err.summary')\n" +
    "ORDER BY key;\n",
  );
  const byKey = new Map(rows.map((row) => [row.key, row]));

  assert.equal(byKey.get("out.summary")?.value_text, "boom");
  assert.equal(byKey.get("err.summary")?.value_text, "boom");

  const stdoutRunId = String(byKey.get("out.last_stdout_path")?.run_id || "").trim();
  assert.ok(stdoutRunId, "expected out.last_stdout_path.run_id to be set");
  assert.equal(byKey.get("out.last_stdout_path")?.value_text, path.join(".dagain", "runs", stdoutRunId, "stdout.log"));
  assert.equal(byKey.get("out.last_result_path")?.value_text, path.join(".dagain", "runs", stdoutRunId, "result.json"));
});

