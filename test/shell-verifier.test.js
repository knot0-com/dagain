import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec } from "./helpers/sqlite.js";

function sqlQuote(value) {
  const s = String(value ?? "");
  return `'${s.replace(/'/g, "''")}'`;
}

function extractResultJson(output) {
  const m = String(output || "").match(/<result>\s*([\s\S]*?)\s*<\/result>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function runScript({ scriptPath, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      env: { ...process.env, ...env, NO_COLOR: "1" },
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

async function createDbWithNode({ dbPath, nodeId, verify }) {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const schemaPath = path.join(repoRoot, "src", "lib", "db", "schema.sql");
  const schemaSql = await readFile(schemaPath, "utf8");
  await sqliteExec(dbPath, schemaSql);

  const now = new Date().toISOString();
  await sqliteExec(
    dbPath,
    `INSERT INTO nodes(id, title, type, status, verify_json, retry_policy_json, created_at, updated_at)\n` +
      `VALUES(\n` +
      `  ${sqlQuote(nodeId)},\n` +
      `  'Shell verifier test',\n` +
      `  'verify',\n` +
      `  'open',\n` +
      `  ${sqlQuote(JSON.stringify(verify))},\n` +
      `  '${JSON.stringify({ maxAttempts: 1 }).replace(/'/g, "''")}',\n` +
      `  ${sqlQuote(now)},\n` +
      `  ${sqlQuote(now)}\n` +
      `);\n`,
  );
}

test("shell-verifier: success when all commands pass", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const scriptPath = path.join(repoRoot, "scripts", "shell-verifier.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-shell-verifier-ok-"));
  const dbPath = path.join(tmpDir, "state.sqlite");
  const nodeId = "verify-ok";

  await createDbWithNode({
    dbPath,
    nodeId,
    verify: [`node -e "process.exit(0)"`, `node -e "process.exit(0)"`],
  });

  const res = await runScript({
    scriptPath,
    cwd: tmpDir,
    env: {
      DAGAIN_DB: dbPath,
      DAGAIN_NODE_ID: nodeId,
    },
  });

  assert.equal(res.code, 0, res.stderr || res.stdout);
  const parsed = extractResultJson(res.stdout);
  assert.ok(parsed, `expected <result> JSON, got: ${res.stdout}`);
  assert.equal(parsed.status, "success");
});

test("shell-verifier: fail when a command fails", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const scriptPath = path.join(repoRoot, "scripts", "shell-verifier.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-shell-verifier-fail-"));
  const dbPath = path.join(tmpDir, "state.sqlite");
  const nodeId = "verify-fail";

  const failCmd = `node -e "process.exit(1)"`;
  await createDbWithNode({
    dbPath,
    nodeId,
    verify: [`node -e "process.exit(0)"`, failCmd],
  });

  const res = await runScript({
    scriptPath,
    cwd: tmpDir,
    env: {
      DAGAIN_DB: dbPath,
      DAGAIN_NODE_ID: nodeId,
    },
  });

  assert.equal(res.code, 0, res.stderr || res.stdout);
  const parsed = extractResultJson(res.stdout);
  assert.ok(parsed, `expected <result> JSON, got: ${res.stdout}`);
  assert.equal(parsed.status, "fail");
  const errors = Array.isArray(parsed.errors) ? parsed.errors.join("\n") : "";
  assert.match(errors, /process\.exit\(1\)/);
});
