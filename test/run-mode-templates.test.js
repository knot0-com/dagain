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

async function insertIntegrateNode({ dbPath, nodeId = "integrate-000" } = {}) {
  const now = new Date().toISOString();
  const nowSql = sqlQuote(now);
  await sqliteExec(
    dbPath,
    `INSERT OR IGNORE INTO nodes(\n` +
      `  id, title, type, status,\n` +
      `  created_at, updated_at\n` +
      `)\n` +
      `VALUES(\n` +
      `  ${sqlQuote(nodeId)},\n` +
      `  'Integrate',\n` +
      `  'integrate',\n` +
      `  'open',\n` +
      `  ${nowSql},\n` +
      `  ${nowSql}\n` +
      `);\n`,
  );
}

async function insertFinalVerifyNode({ dbPath, nodeId = "final-verify-000" } = {}) {
  const now = new Date().toISOString();
  const nowSql = sqlQuote(now);
  await sqliteExec(
    dbPath,
    `INSERT OR IGNORE INTO nodes(\n` +
      `  id, title, type, status,\n` +
      `  created_at, updated_at\n` +
      `)\n` +
      `VALUES(\n` +
      `  ${sqlQuote(nodeId)},\n` +
      `  'Final verify',\n` +
      `  'final_verify',\n` +
      `  'open',\n` +
      `  ${nowSql},\n` +
      `  ${nowSql}\n` +
      `);\n`,
  );
}

async function setupProject({ goalText }) {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const dumpAgentPath = fileURLToPath(new URL("../scripts/mock-agent-packet-dump.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-run-mode-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", goalText, "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".choreo", "config.json");
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
          packetMode: "thin",
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  await insertIntegrateNode({ dbPath, nodeId: "integrate-000" });

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--max-iterations", "2", "--interval-ms", "0", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);

  const packetSeenPath = path.join(tmpDir, "packet_seen.md");
  const packetMetaPath = path.join(tmpDir, "packet_meta.json");
  const packet = await readFile(packetSeenPath, "utf8");
  const meta = JSON.parse(await readFile(packetMetaPath, "utf8"));
  return { packet, meta };
}

test("runMode=analysis: selects analysis integrator template and exports RUN_MODE", async () => {
  const { packet, meta } = await setupProject({
    goalText: "Analyze trades data and write a report with plots/metrics using local parquet datasets.",
  });
  assert.match(packet, /Run mode:\s*analysis/i);
  assert.match(packet, /Integrator\s*\(Analysis\)/i);
  assert.equal(meta.runMode, "analysis");
});

test("runMode=analysis: integrator template discourages redundant heavy exec", async () => {
  const { packet } = await setupProject({
    goalText: "Analyze trades data and write a report with plots/metrics using local parquet datasets.",
  });
  assert.match(packet, /Do not re-run expensive commands/i);
  assert.match(packet, /shellVerify/i);
});

test("runMode=analysis: final verifier template discourages redundant heavy exec", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const dumpAgentPath = fileURLToPath(new URL("../scripts/mock-agent-packet-dump.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-run-mode-final-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Analyze trades data and write a report.", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const configPath = path.join(tmpDir, ".choreo", "config.json");
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
          packetMode: "thin",
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  await insertIntegrateNode({ dbPath, nodeId: "integrate-000" });
  await insertFinalVerifyNode({ dbPath, nodeId: "final-verify-000" });

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--max-iterations", "3", "--interval-ms", "0", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);

  const packetSeenPath = path.join(tmpDir, "packet_seen.md");
  const packetMetaPath = path.join(tmpDir, "packet_meta.json");
  const packet = await readFile(packetSeenPath, "utf8");
  const meta = JSON.parse(await readFile(packetMetaPath, "utf8"));

  assert.match(packet, /Final Verifier\s*\(Analysis\)/i);
  assert.match(packet, /Do not re-run expensive commands/i);
  assert.match(packet, /shellVerify/i);
  assert.equal(meta.runMode, "analysis");
});
