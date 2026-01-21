import { spawn } from "node:child_process";

import { sqliteQueryJson } from "../src/lib/db/sqlite3.js";

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

function sqlQuote(value) {
  const s = String(value ?? "");
  return `'${s.replace(/'/g, "''")}'`;
}

function trimTail(text, maxChars) {
  const s = String(text ?? "");
  if (s.length <= maxChars) return s;
  return s.slice(s.length - maxChars);
}

function runShellCommand(cmd, { cwd }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("bash", ["-lc", String(cmd || "")], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      resolve({
        cmd: String(cmd || ""),
        code: code ?? 0,
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });
    child.on("error", (err) => {
      resolve({
        cmd: String(cmd || ""),
        code: 1,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: String(err?.message || err || "spawn error"),
      });
    });
  });
}

async function main() {
  const dbPath = String(process.env.CHOREO_DB || "").trim();
  const nodeId = String(process.env.CHOREO_NODE_ID || "").trim();

  if (!dbPath || !nodeId) {
    result({
      version: 1,
      role: "verifier",
      nodeId,
      status: "fail",
      summary: "Missing $CHOREO_DB or $CHOREO_NODE_ID",
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: ["Missing $CHOREO_DB or $CHOREO_NODE_ID"],
      confidence: 0,
    });
    return;
  }

  let verify = [];
  try {
    const rows = await sqliteQueryJson(dbPath, `SELECT verify_json FROM nodes WHERE id=${sqlQuote(nodeId)} LIMIT 1;\n`);
    const raw = rows?.[0]?.verify_json ?? "[]";
    const parsed = JSON.parse(String(raw || "[]"));
    if (Array.isArray(parsed)) verify = parsed;
  } catch (err) {
    const msg = String(err?.message || err || "Failed to load verify_json");
    result({
      version: 1,
      role: "verifier",
      nodeId,
      status: "fail",
      summary: msg,
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: [msg],
      confidence: 0,
    });
    return;
  }

  const commands = verify.map((v) => String(v || "").trim()).filter(Boolean);
  const runs = [];
  for (const cmd of commands) {
    const res = await runShellCommand(cmd, { cwd: process.cwd() });
    runs.push({ cmd: res.cmd, code: res.code, signal: res.signal, durationMs: res.durationMs });
    if (res.code !== 0) {
      const stderrTail = trimTail(res.stderr, 4000).trim();
      const stdoutTail = trimTail(res.stdout, 4000).trim();
      const summary = `Verify command failed: ${cmd} (exit ${res.code})`;
      const errors = [summary];
      if (stderrTail) errors.push(`stderr:\n${stderrTail}`);
      if (stdoutTail) errors.push(`stdout:\n${stdoutTail}`);
      result({
        version: 1,
        role: "verifier",
        nodeId,
        status: "fail",
        summary,
        commandsRun: runs.map((r) => r.cmd),
        next: { addNodes: [], setStatus: [] },
        checkpoint: null,
        errors,
        confidence: 0,
      });
      return;
    }
  }

  result({
    version: 1,
    role: "verifier",
    nodeId,
    status: "success",
    summary: commands.length > 0 ? `All verify commands succeeded (${commands.length})` : "No verify commands",
    commandsRun: runs.map((r) => r.cmd),
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: [],
    confidence: 1,
  });
}

try {
  await main();
} catch (err) {
  const msg = String(err?.message || err || "shell-verifier failed");
  result({
    version: 1,
    role: "verifier",
    nodeId: String(process.env.CHOREO_NODE_ID || "").trim(),
    status: "fail",
    summary: msg,
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: [msg],
    confidence: 0,
  });
}

