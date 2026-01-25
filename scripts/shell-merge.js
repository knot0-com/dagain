import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { sqliteQueryJson } from "../src/lib/db/sqlite3.js";

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

function sqlQuote(value) {
  const s = String(value ?? "");
  return `'${s.replace(/'/g, "''")}'`;
}

function sanitizeWorktreeName(value) {
  const s = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "x";
}

function runProcess(cmd, args, { cwd }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, {
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
        code: code ?? 0,
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });
    child.on("error", (err) => {
      resolve({
        code: 1,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: String(err?.message || err || "spawn error"),
      });
    });
  });
}

async function runGit(cwd, args) {
  return runProcess("git", ["-C", cwd, ...args], { cwd });
}

async function gitTopLevel(cwd) {
  const res = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (res.code !== 0) return null;
  const out = String(res.stdout || "").trim();
  return out ? path.resolve(out) : null;
}

async function loadConfig(rootDir) {
  for (const dirName of [".taskgraph", ".choreo"]) {
    const configPath = path.join(rootDir, dirName, "config.json");
    try {
      const text = await fs.readFile(configPath, "utf8");
      return JSON.parse(text);
    } catch {
      // try next
    }
  }
  return null;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function main() {
  const dbPath = String(process.env.CHOREO_DB || "").trim();
  const nodeId = String(process.env.CHOREO_NODE_ID || "").trim();
  const artifactsDir = String(process.env.CHOREO_ARTIFACTS_DIR || "").trim();

  if (!dbPath || !nodeId) {
    result({
      version: 1,
      role: "executor",
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

  const rootDir = await gitTopLevel(process.cwd());
  if (!rootDir) {
    result({
      version: 1,
      role: "executor",
      nodeId,
      status: "fail",
      summary: "Not a git repository (required for shellMerge)",
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: ["Not a git repository (required for shellMerge)"],
      confidence: 0,
    });
    return;
  }

  const deps = await sqliteQueryJson(dbPath, `SELECT depends_on_id FROM deps WHERE node_id=${sqlQuote(nodeId)} ORDER BY depends_on_id;`);
  const taskId = String(deps?.[0]?.depends_on_id || "").trim();
  if (!taskId) {
    result({
      version: 1,
      role: "executor",
      nodeId,
      status: "fail",
      summary: "Merge node missing task dependency",
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: ["Merge node missing task dependency"],
      confidence: 0,
    });
    return;
  }

  const config = await loadConfig(rootDir);
  const worktreesDirRaw =
    String(config?.supervisor?.worktrees?.dir || ".taskgraph/worktrees").trim() || ".taskgraph/worktrees";
  const worktreesDir = path.isAbsolute(worktreesDirRaw) ? worktreesDirRaw : path.join(rootDir, worktreesDirRaw);
  const worktreePath = path.join(worktreesDir, sanitizeWorktreeName(taskId));

  const patchDir = artifactsDir ? path.join(artifactsDir, "patches") : null;
  const patchPath = patchDir ? path.join(patchDir, `${sanitizeWorktreeName(taskId)}.patch`) : null;

  const commands = [];

  const wtTop = await gitTopLevel(worktreePath);
  if (!wtTop) {
    result({
      version: 1,
      role: "executor",
      nodeId,
      status: "fail",
      summary: `Worktree missing or not a git repo: ${worktreePath}`,
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: [`Worktree missing or not a git repo: ${worktreePath}`],
      confidence: 0,
    });
    return;
  }

  const statusRes = await runGit(worktreePath, ["status", "--porcelain"]);
  commands.push(`git -C ${worktreePath} status --porcelain`);
  if (statusRes.code !== 0) {
    const msg = `Failed to read worktree status (exit ${statusRes.code})`;
    result({
      version: 1,
      role: "executor",
      nodeId,
      status: "fail",
      summary: msg,
      commandsRun: commands,
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: [msg, String(statusRes.stderr || "").trim()].filter(Boolean),
      confidence: 0,
    });
    return;
  }

  const hasChanges = Boolean(String(statusRes.stdout || "").trim());
  if (!hasChanges) {
    result({
      version: 1,
      role: "executor",
      nodeId,
      status: "success",
      summary: `No changes to merge for ${taskId}`,
      commandsRun: commands,
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: [],
      confidence: 1,
    });
    return;
  }

  const addArgs = ["add", "-A", "--", ".", ":(exclude)GOAL.md", ":(exclude).taskgraph", ":(exclude).choreo"];
  const addRes = await runGit(worktreePath, addArgs);
  commands.push(
    `git -C ${worktreePath} add -A -- . ':(exclude)GOAL.md' ':(exclude).taskgraph' ':(exclude).choreo'`,
  );
  if (addRes.code !== 0) {
    const msg = `Failed to stage worktree changes (exit ${addRes.code})`;
    result({
      version: 1,
      role: "executor",
      nodeId,
      status: "fail",
      summary: msg,
      commandsRun: commands,
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: [msg, String(addRes.stderr || "").trim()].filter(Boolean),
      confidence: 0,
    });
    return;
  }

  const diffRes = await runGit(worktreePath, ["diff", "--cached", "--binary"]);
  commands.push(`git -C ${worktreePath} diff --cached --binary`);
  if (diffRes.code !== 0) {
    const msg = `Failed to generate patch (exit ${diffRes.code})`;
    result({
      version: 1,
      role: "executor",
      nodeId,
      status: "fail",
      summary: msg,
      commandsRun: commands,
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: [msg, String(diffRes.stderr || "").trim()].filter(Boolean),
      confidence: 0,
    });
    return;
  }

  const patchText = String(diffRes.stdout || "");
  if (!patchText.trim()) {
    result({
      version: 1,
      role: "executor",
      nodeId,
      status: "success",
      summary: `No staged changes to merge for ${taskId}`,
      commandsRun: commands,
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: [],
      confidence: 1,
    });
    return;
  }

  if (patchDir && patchPath) {
    await ensureDir(patchDir);
    await fs.writeFile(patchPath, patchText, "utf8");
  }

  const applyArgs = ["apply", "--3way"];
  if (patchPath) applyArgs.push(patchPath);
  else applyArgs.push("-");

  let applyRes = null;
  if (patchPath) {
    applyRes = await runGit(rootDir, applyArgs);
    commands.push(`git -C ${rootDir} ${applyArgs.join(" ")}`);
  } else {
    applyRes = await runProcess("git", ["-C", rootDir, ...applyArgs], { cwd: rootDir });
    commands.push(`git -C ${rootDir} ${applyArgs.join(" ")}`);
  }

  if (applyRes.code !== 0) {
    const msg = `Failed to apply patch to root (exit ${applyRes.code})`;
    result({
      version: 1,
      role: "executor",
      nodeId,
      status: "fail",
      summary: msg,
      commandsRun: commands,
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: [msg, String(applyRes.stderr || "").trim()].filter(Boolean),
      confidence: 0,
    });
    return;
  }

  result({
    version: 1,
    role: "executor",
    nodeId,
    status: "success",
    summary: `Merged ${taskId} into root`,
    commandsRun: commands,
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: [],
    confidence: 1,
  });
}

try {
  await main();
} catch (err) {
  const msg = String(err?.message || err || "shell-merge failed");
  result({
    version: 1,
    role: "executor",
    nodeId: String(process.env.CHOREO_NODE_ID || "").trim(),
    status: "fail",
    summary: msg,
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: [msg],
    confidence: 0,
  });
}
