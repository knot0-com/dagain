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

test("scaffolding: integrate/final nodes include upstream summary inputs", { timeout: 15_000 }, async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const plannerPath = fileURLToPath(new URL("../scripts/mock-planner-tasks-only.js", import.meta.url));
  const logAgentPath = fileURLToPath(new URL("../scripts/mock-agent-log.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-upstream-inputs-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Upstream inputs test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".dagain", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          plannerR: { cmd: `node ${plannerPath} {packet}` },
          executorR: { cmd: `node ${logAgentPath} executor {packet}` },
          verifierR: { cmd: `node ${logAgentPath} verifier {packet}` },
          integratorR: { cmd: `node ${logAgentPath} integrator {packet}` },
          finalR: { cmd: `node ${logAgentPath} finalVerifier {packet}` },
        },
        roles: {
          main: "plannerR",
          planner: "plannerR",
          executor: "executorR",
          verifier: "verifierR",
          integrator: "integratorR",
          finalVerifier: "finalR",
          researcher: "plannerR",
        },
        supervisor: { idleSleepMs: 0, staleLockSeconds: 3600 },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--max-iterations", "50", "--interval-ms", "0", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);
  assert.match(runRes.stdout + runRes.stderr, /All nodes done\./);

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");

  const integrateRows = await sqliteJson(dbPath, "SELECT inputs_json FROM nodes WHERE id='integrate-000' LIMIT 1;");
  assert.equal(integrateRows.length, 1);
  const integrateInputs = JSON.parse(integrateRows[0].inputs_json || "[]");
  const integrateRefs = new Set(integrateInputs.map((s) => `${s.nodeId}:${s.key}`));
  assert.ok(integrateRefs.has("task-hello:out.summary"));
  assert.ok(integrateRefs.has("verify-task-hello:out.summary"));

  const finalRows = await sqliteJson(dbPath, "SELECT inputs_json FROM nodes WHERE id='final-verify-000' LIMIT 1;");
  assert.equal(finalRows.length, 1);
  const finalInputs = JSON.parse(finalRows[0].inputs_json || "[]");
  const finalRefs = new Set(finalInputs.map((s) => `${s.nodeId}:${s.key}`));
  assert.ok(finalRefs.has("integrate-000:out.summary"));
});

