import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

function sqlQuote(value) {
  const s = String(value ?? "");
  return `'${s.replace(/'/g, "''")}'`;
}

async function insertTaskNode({ dbPath, nodeId = "task-001" } = {}) {
  const now = new Date().toISOString();
  const nowSql = sqlQuote(now);
  const verify = JSON.stringify(["echo ok"]).replace(/'/g, "''");
  const retryPolicy = JSON.stringify({ maxAttempts: 1 }).replace(/'/g, "''");
  await sqliteExec(
    dbPath,
    `INSERT OR IGNORE INTO nodes(\n` +
    `  id, title, type, status,\n` +
    `  verify_json, retry_policy_json,\n` +
    `  created_at, updated_at\n` +
    `)\n` +
    `VALUES(\n` +
    `  ${sqlQuote(nodeId)},\n` +
    `  'Task for packet test',\n` +
    `  'task',\n` +
    `  'open',\n` +
    `  '${verify}',\n` +
    `  '${retryPolicy}',\n` +
    `  ${nowSql},\n` +
    `  ${nowSql}\n` +
    `);\n`,
  );
}

async function setupProject({ packetMode }) {
  const dagainRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(dagainRoot, "bin", "dagain.js");
  const dumpAgentPath = fileURLToPath(new URL("../scripts/mock-agent-packet-dump.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-packet-thin-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const taskPlanSentinel = "SENTINEL_TASK_PLAN_abc123";
  const findingsSentinel = "SENTINEL_FINDINGS_def456";
  const progressSentinel = "SENTINEL_PROGRESS_ghi789";

  const memoryDir = path.join(tmpDir, ".dagain", "memory");
  await writeFile(path.join(memoryDir, "task_plan.md"), `${taskPlanSentinel}\n`, "utf8");
  await writeFile(path.join(memoryDir, "findings.md"), `${findingsSentinel}\n`, "utf8");
  await writeFile(path.join(memoryDir, "progress.md"), `${progressSentinel}\n`, "utf8");

  const configPath = path.join(tmpDir, ".dagain", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          dump: { cmd: `node ${dumpAgentPath} dump {packet}` },
        },
        roles: {
          main: "dump",
          planner: "dump",
          executor: "dump",
          verifier: "dump",
          integrator: "dump",
          finalVerifier: "dump",
          researcher: "dump",
        },
        supervisor: {
          idleSleepMs: 0,
          staleLockSeconds: 3600,
          packetMode,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
  await insertTaskNode({ dbPath, nodeId: "task-001" });

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--max-iterations", "2", "--interval-ms", "0", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);

  const packetSeenPath = path.join(tmpDir, "packet_seen.md");
  const packet = await readFile(packetSeenPath, "utf8");
  return { packet, taskPlanSentinel, findingsSentinel, progressSentinel };
}

test("packetMode=thin: executor packet omits planning drafts", async () => {
  const { packet, taskPlanSentinel, findingsSentinel, progressSentinel } = await setupProject({ packetMode: "thin" });
  assert.ok(!packet.includes(taskPlanSentinel), "expected task_plan.md content omitted");
  assert.ok(!packet.includes(findingsSentinel), "expected findings.md content omitted");
  assert.ok(!packet.includes(progressSentinel), "expected progress.md content omitted");
});

test("packetMode=full: executor packet includes planning drafts", async () => {
  const { packet, taskPlanSentinel, findingsSentinel, progressSentinel } = await setupProject({ packetMode: "full" });
  assert.ok(packet.includes(taskPlanSentinel), "expected task_plan.md content present");
  assert.ok(packet.includes(findingsSentinel), "expected findings.md content present");
  assert.ok(packet.includes(progressSentinel), "expected progress.md content present");
});

