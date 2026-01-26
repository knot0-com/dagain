import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { access, chmod, chown, lstat, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.js";
import { sha256File } from "./lib/crypto.js";
import { appendLine, ensureDir, pathExists, readJson, writeJsonAtomic } from "./lib/fs.js";
import { choreoPaths, defaultConfig, loadConfig, saveConfig } from "./lib/config.js";
import { defaultWorkgraph, loadWorkgraph, saveWorkgraph, countByStatus } from "./lib/workgraph.js";
import { selectNextNode } from "./lib/select.js";
import { formatBullets, renderTemplate } from "./lib/template.js";
import { normalizeRunnerList, resolveNodeRole, resolveRoleRunnerPick, runRunnerCommand } from "./lib/runner.js";
import { OwnershipLockManager } from "./lib/ownership-locks.js";
import { acquireSupervisorLock, heartbeatSupervisorLock, readSupervisorLock, releaseSupervisorLock } from "./lib/lock.js";
import { createUi } from "./lib/ui.js";
import { sqliteExec, sqliteQueryJson } from "./lib/db/sqlite3.js";
import { exportWorkgraphJson, loadWorkgraphFromDb } from "./lib/db/export.js";
import { mailboxAck, mailboxClaimNext, mailboxEnqueue } from "./lib/db/mailbox.js";
import { kvGet, kvList, kvPut } from "./lib/db/kv.js";
import { ensureDepsRequiredStatusColumn, ensureMailboxTable } from "./lib/db/migrate.js";
import {
  allDoneDb,
  applyResult as applyResultDb,
	  claimNode,
	  countByStatusDb,
	  getNode,
	  listFailedDepsBlockingOpenNodes,
	  listNodes,
	  selectRunnableCandidates,
	  selectNextRunnableNode,
	  unlockNode as unlockNodeDb,
	} from "./lib/db/nodes.js";

function usage() {
  return `dagain (aliases: taskgraph, choreo)

Usage:
  dagain [<goal...>] [--color] [--no-color]
  dagain chat [--no-color]
  dagain control pause|resume
  dagain control set-workers --workers=<n>
  dagain control replan
  dagain control cancel --node=<id>
  dagain node add --id=<id> --title="..." [--type=<t>] [--status=<s>] [--parent=<id>] [--runner=<name>] [--inputs=<json>] [--ownership=<json>] [--acceptance=<json>] [--verify=<json>] [--retry-policy=<json>] [--depends-on=<json|a,b>]
  dagain node update --id=<id> [--title="..."] [--type=<t>] [--parent=<id>] [--runner=<name>] [--inputs=<json>] [--ownership=<json>] [--acceptance=<json>] [--verify=<json>] [--retry-policy=<json>] [--force]
  dagain node set-status --id=<id> --status=<open|done|failed|needs_human> [--force]
  dagain dep add --node=<id> --depends-on=<id> [--required-status=<done|terminal>]
  dagain dep remove --node=<id> --depends-on=<id>
  dagain start [<goal...>] [--no-refine] [--max-turns=<n>] [--live] [--no-live] [--color] [--no-color] [--main=<runner[,..]>] [--planner=<runner[,..]>] [--executor=<runner[,..]>] [--verifier=<runner[,..]>] [--integrator=<runner[,..]>] [--final-verifier=<runner[,..]>] [--researcher=<runner[,..]>]
  dagain init [--force] [--no-templates] [--goal="..."] [--no-refine] [--max-turns=<n>] [--live] [--no-live] [--color] [--no-color] [--main=<runner[,..]>] [--planner=<runner[,..]>] [--executor=<runner[,..]>] [--verifier=<runner[,..]>] [--integrator=<runner[,..]>] [--final-verifier=<runner[,..]>] [--researcher=<runner[,..]>]
		  dagain goal [--goal="..."] [--max-turns=<n>] [--runner=<name>] [--live] [--no-live] [--color] [--no-color]
		  dagain status
	  dagain run [--once] [--workers=<n>] [--interval-ms=<n>] [--max-iterations=<n>] [--dry-run] [--live] [--no-live] [--color] [--no-color]
	  dagain resume [--once] [--workers=<n>] [--interval-ms=<n>] [--max-iterations=<n>] [--dry-run] [--live] [--no-live] [--color] [--no-color]
	  dagain answer [--node=<id>] [--checkpoint=<file>] [--answer="..."] [--no-prompt]
	  dagain kv get [--run] [--node=<id>] --key=<k> [--json]
	  dagain kv put [--run] [--node=<id>] --key=<k> --value="..." [--allow-cross-node-write]
	  dagain kv ls [--run] [--node=<id>] [--prefix=<p>] [--json]
  dagain microcall --prompt="..." [--runner=<name>] [--role=<role>] [--store-key=<k>] [--run] [--json]
  dagain templates sync [--force]
		  dagain stop [--signal=<sig>]
		  dagain graph validate

State:
  .dagain/config.json
  .dagain/workgraph.json
`;
}

async function maybeMigrateLegacyStateDir(rootDir) {
  const canonicalDir = path.join(rootDir, ".dagain");
  const legacyTaskgraphDir = path.join(rootDir, ".taskgraph");
  const legacyChoreoDir = path.join(rootDir, ".choreo");

  if (await pathExists(canonicalDir)) return;

  const ensureAliasSymlink = async (aliasPath) => {
    try {
      const st = await lstat(aliasPath);
      if (!st.isSymbolicLink?.()) return;
      try {
        await rm(aliasPath, { force: true });
      } catch {
        // ignore
      }
    } catch {
      // missing; fall through
    }
    try {
      await symlink(".dagain", aliasPath);
    } catch {
      // ignore
    }
  };

  const migrateFrom = async (fromDir) => {
    try {
      await rename(fromDir, canonicalDir);
      return true;
    } catch {
      return false;
    }
  };

  if (await pathExists(legacyTaskgraphDir)) {
    if (!(await migrateFrom(legacyTaskgraphDir))) return;
    await ensureAliasSymlink(legacyTaskgraphDir);
    await ensureAliasSymlink(legacyChoreoDir);
    return;
  }

  if (await pathExists(legacyChoreoDir)) {
    if (!(await migrateFrom(legacyChoreoDir))) return;
    await ensureAliasSymlink(legacyTaskgraphDir);
    await ensureAliasSymlink(legacyChoreoDir);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeMaxAttempts(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function stableJsonSig(value, fallback = "[]") {
  try {
    const serialized = JSON.stringify(value ?? null);
    return typeof serialized === "string" ? serialized : fallback;
  } catch {
    return fallback;
  }
}

function safeJsonParseAny(value) {
  if (value == null) return null;
  const text = String(value);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJsonFlag(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const parsed = safeJsonParseAny(trimmed);
    if (parsed == null) throw new Error("Invalid JSON.");
    return parsed;
  }
  return value;
}

function parseJsonArrayFlag(value, fallback, label) {
  const parsed = parseJsonFlag(value, fallback);
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array.`);
  return parsed;
}

function parseRetryPolicyFlag(value, fallback) {
  const parsed = parseJsonFlag(value, fallback);
  if (!parsed || typeof parsed !== "object") throw new Error("retryPolicy must be a JSON object.");
  const maxAttempts = normalizeMaxAttempts(parsed.maxAttempts);
  if (!maxAttempts) throw new Error("retryPolicy.maxAttempts must be a positive integer.");
  return { maxAttempts };
}

function parseDependsOnFlag(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      const parsed = safeJsonParseAny(trimmed);
      if (!Array.isArray(parsed)) throw new Error("dependsOn must be a JSON array.");
      return parsed.map((v) => String(v || "").trim()).filter(Boolean);
    }
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function resolveDefaultRetryPolicy(config) {
  const maxAttempts = normalizeMaxAttempts(config?.defaults?.retryPolicy?.maxAttempts);
  if (!maxAttempts) return null;
  return { maxAttempts };
}

function sqlQuote(value) {
  const s = String(value ?? "");
  return `'${s.replace(/'/g, "''")}'`;
}

function isPromptEnabled() {
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  return String(process.env.CHOREO_FORCE_PROMPT || "").trim() === "1";
}

let passwdByUidCache = null;

async function lookupPasswdUserByUid(uid) {
  const n = Number(uid);
  if (!Number.isFinite(n) || n < 0) return null;
  if (!passwdByUidCache) {
    const map = new Map();
    try {
      const text = await readFile("/etc/passwd", "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const parts = trimmed.split(":");
        if (parts.length < 7) continue;
        const entryUid = Number(parts[2]);
        const entryGid = Number(parts[3]);
        if (!Number.isFinite(entryUid) || entryUid < 0) continue;
        map.set(entryUid, {
          username: parts[0],
          gid: Number.isFinite(entryGid) ? entryGid : null,
          home: parts[5] || null,
        });
      }
    } catch {
      // ignore
    }
    passwdByUidCache = map;
  }
  return passwdByUidCache.get(n) || null;
}

async function resolveSpawnIdentity({ rootDir }) {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!isRoot) return null;

  const sudoUid = Number(process.env.SUDO_UID || "");
  const sudoGid = Number(process.env.SUDO_GID || "");
  const hasSudoIds = Number.isFinite(sudoUid) && sudoUid > 0 && Number.isFinite(sudoGid) && sudoGid > 0;

  if (hasSudoIds) {
    const info = await lookupPasswdUserByUid(sudoUid);
    const username = typeof info?.username === "string" && info.username ? info.username : String(process.env.SUDO_USER || "");
    const home = typeof info?.home === "string" && info.home ? info.home : null;
    return { uid: sudoUid, gid: sudoGid, username, home };
  }

  try {
    const st = await stat(rootDir);
    const uid = Number(st.uid);
    const gid = Number(st.gid);
    if (!Number.isFinite(uid) || uid <= 0) return null;
    if (!Number.isFinite(gid) || gid <= 0) return null;
    const info = await lookupPasswdUserByUid(uid);
    const username = typeof info?.username === "string" && info.username ? info.username : "";
    const home = typeof info?.home === "string" && info.home ? info.home : null;
    return { uid, gid, username, home };
  } catch {
    return null;
  }
}

function mergeEnv(a, b) {
  if (!a && !b) return null;
  const out = {};
  if (a && typeof a === "object") Object.assign(out, a);
  if (b && typeof b === "object") Object.assign(out, b);
  return Object.keys(out).length > 0 ? out : null;
}

function choreoRunnerEnv(paths, { nodeId, runId, parentNodeId = "", runMode = "" }) {
  const choreoBin = fileURLToPath(new URL("../bin/choreo.js", import.meta.url));
  const shellVerifier = fileURLToPath(new URL("../scripts/shell-verifier.js", import.meta.url));
  const shellMerge = fileURLToPath(new URL("../scripts/shell-merge.js", import.meta.url));
  const mode = String(runMode || "").trim();
  return {
    CHOREO_DB: paths.dbPath,
    CHOREO_NODE_ID: nodeId,
    CHOREO_RUN_ID: runId,
    CHOREO_PARENT_NODE_ID: parentNodeId,
    CHOREO_ARTIFACTS_DIR: paths.artifactsDir,
    CHOREO_CHECKPOINTS_DIR: paths.checkpointsDir,
    CHOREO_RUNS_DIR: paths.runsDir,
    CHOREO_BIN: choreoBin,
    CHOREO_SHELL_VERIFIER: shellVerifier,
    CHOREO_SHELL_MERGE: shellMerge,
    CHOREO_RUN_MODE: mode,
  };
}

function envForIdentity(identity) {
  if (!identity) return null;
  const env = {};
  if (identity.home) env.HOME = identity.home;
  if (identity.username) {
    env.USER = identity.username;
    env.LOGNAME = identity.username;
  }
  return Object.keys(env).length > 0 ? env : null;
}

async function chownTree(rootPath, uid, gid, { maxEntries = 25_000 } = {}) {
  const uidNum = Number(uid);
  const gidNum = Number(gid);
  if (!Number.isFinite(uidNum) || uidNum <= 0) return;
  if (!Number.isFinite(gidNum) || gidNum <= 0) return;

  let seen = 0;
  async function visit(targetPath) {
    seen += 1;
    if (seen > maxEntries) throw new Error(`Refusing to chown >${maxEntries} entries under ${rootPath}`);

    try {
      await chown(targetPath, uidNum, gidNum);
    } catch {
      // ignore
    }

    let st = null;
    try {
      st = await lstat(targetPath);
    } catch {
      return;
    }

    if (!st.isDirectory()) return;
    if (st.isSymbolicLink?.()) return;

    let entries = [];
    try {
      entries = await readdir(targetPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent?.name) continue;
      await visit(path.join(targetPath, ent.name));
    }
  }

  await visit(rootPath);
}

async function repairChoreoStateOwnership({ paths, ui }) {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!isRoot) return;
  if (!(await pathExists(paths.choreoDir))) return;

  const identity = await resolveSpawnIdentity({ rootDir: paths.rootDir });
  if (!identity) return;

  try {
    await chownTree(paths.choreoDir, identity.uid, identity.gid);
    try {
      await chmod(paths.choreoDir, 0o755);
    } catch {
      // ignore
    }
  } catch (error) {
    ui?.event?.("warn", `Failed to repair .dagain ownership: ${error?.message || String(error)}`);
  }
}

function resolveRunnerEnv({ runnerName, runner, cwd, paths }) {
  const raw = runner?.env && typeof runner.env === "object" ? runner.env : null;
  const out = raw ? { ...raw } : {};

  // Claude Code uses os.tmpdir() for its scratchpad. If prior runs created a root-owned
  // /tmp/claude directory, non-root runs can hit EACCES. Default TMPDIR into .dagain/tmp.
  if (runnerName === "claude") {
    // Claude also treats sudo-context env vars as a privileged context. Clear them so
    // `--dangerously-skip-permissions` can work when the actual uid is not root.
    for (const key of ["SUDO_USER", "SUDO_UID", "SUDO_GID", "SUDO_COMMAND", "SUDO_ASKPASS"]) {
      if (!(key in out)) out[key] = null;
    }

    const hasTmp = Boolean(out.TMPDIR || out.TMP || out.TEMP);
    if (!hasTmp && paths?.tmpDir) out.TMPDIR = paths.tmpDir;
  }

  for (const [key, value] of Object.entries(out)) {
    if (value == null) out[key] = null;
    else out[key] = String(value);
  }

  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    const v = out[key];
    if (!v) continue;
    if (!path.isAbsolute(v)) out[key] = path.resolve(cwd, v);
  }

  return Object.keys(out).length > 0 ? out : null;
}

async function ensureRunnerTmpDir(env) {
  if (!env || typeof env !== "object") return;
  const dir = env.TMPDIR || env.TMP || env.TEMP;
  if (!dir) return;
  try {
    await ensureDir(dir);
  } catch {
    // ignore
  }
}

function claudeProjectTmpKey(cwd) {
  // Claude Code uses: /tmp/claude/<sanitized cwd>/<uuid>/scratchpad
  // Example: /home/mojians/projects -> -home-mojians-projects
  const abs = path.resolve(String(cwd || process.cwd()));
  return abs.split(path.sep).join("-");
}

async function ensureClaudeProjectTmpWritable({ cwd, ui, uid = null, gid = null }) {
  const baseDir = "/tmp/claude";
  const projectDir = path.join(baseDir, claudeProjectTmpKey(cwd));

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const uidNum = Number(uid);
  const gidNum = Number(gid);
  const hasTargetUser = Number.isFinite(uidNum) && uidNum > 0 && Number.isFinite(gidNum) && gidNum > 0;

  const sudoUid = Number(process.env.SUDO_UID || "");
  const sudoGid = Number(process.env.SUDO_GID || "");
  const hasSudoUser = Number.isFinite(sudoUid) && sudoUid > 0 && Number.isFinite(sudoGid) && sudoGid > 0;
  const targetUid = hasTargetUser ? uidNum : sudoUid;
  const targetGid = hasTargetUser ? gidNum : sudoGid;
  const canChown = isRoot && ((hasTargetUser && targetUid > 0) || hasSudoUser);

  // Ensure base exists so we can repair permissions deterministically.
  try {
    await ensureDir(baseDir);
    if (canChown) {
      try {
        await chown(baseDir, targetUid, targetGid);
      } catch {
        // ignore
      }
    }
  } catch {
    return;
  }

  let projectExists = false;
  try {
    const st = await stat(projectDir);
    projectExists = st.isDirectory();
  } catch {
    projectExists = false;
  }

  if (!projectExists) {
    // Precreate under correct ownership when running via sudo/root.
    try {
      await ensureDir(projectDir);
      if (canChown) await chown(projectDir, targetUid, targetGid);
    } catch {
      // ignore
    }
    return;
  }

  try {
    await access(projectDir, fsConstants.W_OK | fsConstants.X_OK);
    if (canChown) {
      try {
        const entries = await readdir(projectDir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isDirectory()) continue;
          const childPath = path.join(projectDir, ent.name);
          try {
            const st = await stat(childPath);
            if (Number(st.uid) === 0) await chown(childPath, targetUid, targetGid);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }
    return;
  } catch {
    // continue
  }

  if (canChown) {
    try {
      await chown(projectDir, targetUid, targetGid);
      try {
        const entries = await readdir(projectDir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isDirectory()) continue;
          const childPath = path.join(projectDir, ent.name);
          try {
            const st = await stat(childPath);
            if (Number(st.uid) === 0) await chown(childPath, targetUid, targetGid);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
      return;
    } catch {
      // continue
    }
  }

  // Non-root fallback: move aside the unwritable dir if possible.
  const suffix = `stale-${nowIso().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
  const moved = `${projectDir}.${suffix}`;
  try {
    await rename(projectDir, moved);
    await ensureDir(projectDir);
    ui?.event?.("warn", `Claude tmp dir was not writable; moved aside: ${moved}`);
  } catch {
    // ignore; will fail downstream with a clearer error from Claude
  }
}

function resolveLiveFlag(flags) {
  const noLive = Boolean(flags["no-live"]) || Boolean(flags.noLive);
  if (noLive) return false;
  if (Boolean(flags.live)) return true;
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

function resolveNoColorFlag(flags) {
  if (Boolean(flags.color) || Boolean(flags["force-color"]) || Boolean(flags.forceColor)) return false;
  return Boolean(flags["no-color"]) || Boolean(flags.noColor) || Boolean(flags.nocolor);
}

function resolveForceColorFlag(flags) {
  return Boolean(flags.color) || Boolean(flags["force-color"]) || Boolean(flags.forceColor);
}

async function readStdinText() {
  try {
    if (process.stdin.isTTY) return "";
    process.stdin.setEncoding("utf8");
    let out = "";
    for await (const chunk of process.stdin) out += chunk;
    return out;
  } catch {
    return "";
  }
}

function runId() {
  const stamp = nowIso().replace(/[:.]/g, "-");
  const rand = Math.random().toString(16).slice(2, 8);
  return `${stamp}-${rand}`;
}

function normalizeRunMode(value) {
  const mode = String(value || "").toLowerCase().trim();
  if (mode === "analysis") return "analysis";
  if (mode === "coding" || mode === "code") return "coding";
  return "auto";
}

function inferRunMode(goalText, config) {
  const raw = String(goalText || "");

  // 1) Explicit directive inside GOAL.md.
  const explicit = raw.match(/^\s*(?:run\s*mode|mode)\s*:\s*(analysis|coding)\s*$/im);
  if (explicit) return String(explicit[1] || "").toLowerCase();

  // 2) Config override.
  const override = normalizeRunMode(config?.supervisor?.runMode);
  if (override === "analysis" || override === "coding") return override;

  // 3) Heuristic keyword scoring on the goal text.
  const text = raw.toLowerCase();
  const analysisHints = [
    "analysis",
    "analyz",
    "research",
    "hypothesis",
    "report",
    "dataset",
    "parquet",
    "csv",
    "plot",
    "metrics",
    "alpha",
    "trades",
    "orderbook",
    "microstructure",
  ];
  const codingHints = ["refactor", "implement", "bug", "fix", "feature", "build", "compile", "test", "ci", "merge", "pr", "release"];

  let scoreAnalysis = 0;
  for (const h of analysisHints) if (text.includes(h)) scoreAnalysis += 1;
  let scoreCoding = 0;
  for (const h of codingHints) if (text.includes(h)) scoreCoding += 1;

  if (/\.(parquet|csv|jsonl|feather)\b/i.test(raw)) scoreAnalysis += 2;
  if (/[\\/](data|datasets|raw|artifacts)[\\/]/i.test(raw)) scoreAnalysis += 2;

  if (scoreAnalysis === 0 && scoreCoding === 0) return "coding";
  return scoreAnalysis >= scoreCoding ? "analysis" : "coding";
}

function normalizeWorktreeMode(value) {
  const mode = String(value || "").toLowerCase().trim();
  if (mode === "always") return "always";
  if (mode === "on-conflict" || mode === "onconflict") return "on-conflict";
  return "off";
}

function resolveWorktreesDir({ paths, config }) {
  const raw = String(config?.supervisor?.worktrees?.dir || ".dagain/worktrees").trim() || ".dagain/worktrees";
  return path.isAbsolute(raw) ? raw : path.join(paths.rootDir, raw);
}

function runProcessCapture(cmd, args, { cwd, stdinText = null } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(cmd, Array.isArray(args) ? args : [], {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) =>
      resolve({
        code: code ?? 0,
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      }),
    );
    child.on("error", (err) =>
      resolve({
        code: 1,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: String(err?.message || err || "spawn error"),
      }),
    );
    try {
      if (stdinText != null) child.stdin.end(String(stdinText));
      else child.stdin.end();
    } catch {
      // ignore
    }
  });
}

async function ensureGitWorktree({ rootDir, worktreePath }) {
  const gitDir = await runProcessCapture("git", ["-C", rootDir, "rev-parse", "--git-dir"], { cwd: rootDir });
  if (gitDir.code !== 0) throw new Error("Not a git repository");

  await ensureDir(path.dirname(worktreePath));
  const exists = await pathExists(worktreePath);
  if (exists) {
    const ok = await runProcessCapture("git", ["-C", worktreePath, "rev-parse", "--is-inside-work-tree"], { cwd: worktreePath });
    if (ok.code !== 0) {
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  if (!(await pathExists(worktreePath))) {
    const add = await runProcessCapture("git", ["-C", rootDir, "worktree", "add", "--detach", "--force", worktreePath, "HEAD"], { cwd: rootDir });
    if (add.code !== 0) {
      const msg = String(add.stderr || add.stdout || "").trim();
      throw new Error(`git worktree add failed: ${msg || `exit ${add.code}`}`);
    }
  }

  await runProcessCapture("git", ["-C", worktreePath, "reset", "--hard", "HEAD"], { cwd: worktreePath });
  await runProcessCapture("git", ["-C", worktreePath, "clean", "-fd"], { cwd: worktreePath });
}

async function readBuiltInTemplate(role) {
  const templatePath = new URL(`../templates/${role}.md`, import.meta.url);
  return readFile(templatePath, "utf8");
}

async function resolveTemplate(rootDir, role) {
  const { templatesDir } = choreoPaths(rootDir);
  const localPath = path.join(templatesDir, `${role}.md`);
  if (await pathExists(localPath)) return readFile(localPath, "utf8");
  return readBuiltInTemplate(role);
}

async function copyTemplates(rootDir, { force = false } = {}) {
  const { templatesDir } = choreoPaths(rootDir);
  await ensureDir(templatesDir);
  const roles = [
    "planner",
    "executor",
    "verifier",
    "integrator",
    "integrator-analysis",
    "final-verifier",
    "final-verifier-analysis",
    "goal-refiner",
  ];
  await Promise.all(
    roles.map(async (role) => {
      const src = await readBuiltInTemplate(role);
      const dst = path.join(templatesDir, `${role}.md`);
      if (force || !(await pathExists(dst))) await writeFile(dst, src, "utf8");
    }),
  );
}

async function initCommand(rootDir, flags) {
  const paths = choreoPaths(rootDir);
  const force = Boolean(flags.force);
  const noTemplates = Boolean(flags["no-templates"]);
  const noRefine = Boolean(flags["no-refine"]) || Boolean(flags.noRefine);
  const goalFlag = typeof flags.goal === "string" ? flags.goal : "";
  const maxTurnsRaw = flags["max-turns"] ?? 12;
  const maxTurnsNum = Number(maxTurnsRaw);
  const maxTurns = Number.isFinite(maxTurnsNum) && maxTurnsNum > 0 ? Math.floor(maxTurnsNum) : 12;
  const live = resolveLiveFlag(flags);
  const noColor = resolveNoColorFlag(flags);
  const forceColor = resolveForceColorFlag(flags);

  await ensureDir(paths.choreoDir);
  await ensureDir(paths.checkpointsDir);
  await ensureDir(paths.runsDir);
  await ensureDir(paths.memoryDir);
  await ensureDir(paths.templatesDir);
  await ensureDir(paths.tmpDir);
  await ensureDir(paths.artifactsDir);

  const goalExists = await pathExists(paths.goalPath);
  if (goalFlag) {
    await writeFile(
      paths.goalPath,
      `# Goal\n\n${goalFlag.trim()}\n\n## Done means\n- (refine into measurable success criteria)\n`,
      "utf8",
    );
  }

  if (!(await pathExists(paths.goalPath))) {
    await writeFile(
      paths.goalPath,
      `# Goal\n\nDescribe the unified human goal here.\n\n## Done means\n- (define measurable success criteria)\n`,
      "utf8",
    );
  }

  const goalHash = await sha256File(paths.goalPath);

  let config = await loadConfig(paths.configPath);
  if (!config || force) config = defaultConfig();
  const roleFlagMap = {
    main: "main",
    planner: "planner",
    executor: "executor",
    verifier: "verifier",
    integrator: "integrator",
    researcher: "researcher",
    "final-verifier": "finalVerifier",
    finalVerifier: "finalVerifier",
  };
  let touchedConfig = force || !config;
  for (const [flagKey, roleKey] of Object.entries(roleFlagMap)) {
    const value = flags[flagKey];
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      config.roles[roleKey] = parsed.length <= 1 ? parsed[0] : parsed;
      touchedConfig = true;
    }
  }
  if (touchedConfig || !(await pathExists(paths.configPath))) {
    await saveConfig(paths.configPath, config);
  }

  if (force) {
    await rm(paths.dbPath, { force: true });
  }

  const schemaUrl = new URL("./lib/db/schema.sql", import.meta.url);
  const schemaSql = await readFile(schemaUrl, "utf8");
  await sqliteExec(paths.dbPath, schemaSql);
  await ensureDepsRequiredStatusColumn({ dbPath: paths.dbPath });
  await ensureMailboxTable({ dbPath: paths.dbPath });
  const defaultRetryPolicy = resolveDefaultRetryPolicy(config);
  const defaultRetryPolicyJson = defaultRetryPolicy ? sqlQuote(JSON.stringify(defaultRetryPolicy)) : null;
  const now = nowIso();
  const nowSql = `'${now.replace(/'/g, "''")}'`;
  await sqliteExec(
    paths.dbPath,
    `INSERT OR IGNORE INTO nodes(id, title, type, status, created_at, updated_at)\n` +
      `VALUES('plan-000','Plan','plan','open',${nowSql},${nowSql});\n` +
      (defaultRetryPolicyJson
        ? `UPDATE nodes SET retry_policy_json=${defaultRetryPolicyJson} WHERE id='plan-000';\n`
        : ""),
  );

  if (force || !(await pathExists(paths.graphPath))) {
    const graph = defaultWorkgraph("GOAL.md", goalHash);
    graph.createdAt = nowIso();
    await saveWorkgraph(paths.graphPath, graph);
  } else {
    const graph = await loadWorkgraph(paths.graphPath);
    if (graph?.goal?.hash !== goalHash) {
      graph.goal = { path: "GOAL.md", hash: goalHash };
    }
    if (Array.isArray(graph?.nodes) && graph.nodes.length === 0) {
      graph.nodes.push(...defaultWorkgraph("GOAL.md", goalHash).nodes);
    }
    await saveWorkgraph(paths.graphPath, graph);
  }

  if (!noTemplates) await copyTemplates(rootDir, { force });

  const activityPath = path.join(paths.memoryDir, "activity.log");
  const errorsPath = path.join(paths.memoryDir, "errors.log");
  const progressPath = path.join(paths.memoryDir, "progress.md");
  const guardrailsPath = path.join(paths.memoryDir, "guardrails.md");
  const patternsPath = path.join(paths.memoryDir, "patterns.md");
  const goalDialogPath = path.join(paths.memoryDir, "goal-dialog.md");
  const taskPlanPath = path.join(paths.memoryDir, "task_plan.md");
  const findingsPath = path.join(paths.memoryDir, "findings.md");

  if (!(await pathExists(progressPath))) await writeFile(progressPath, "# Choreo Progress\n", "utf8");
  if (!(await pathExists(guardrailsPath))) await writeFile(guardrailsPath, "# Choreo Guardrails\n", "utf8");
  if (!(await pathExists(patternsPath))) await writeFile(patternsPath, "# Choreo Patterns\n", "utf8");
  if (!(await pathExists(activityPath))) await writeFile(activityPath, "", "utf8");
  if (!(await pathExists(errorsPath))) await writeFile(errorsPath, "", "utf8");
  if (!(await pathExists(goalDialogPath))) await writeFile(goalDialogPath, "# Goal Dialog\n", "utf8");
  if (!(await pathExists(findingsPath))) await writeFile(findingsPath, defaultFindingsMarkdown(), "utf8");
  if (!(await pathExists(taskPlanPath))) await writeFile(taskPlanPath, defaultTaskPlanMarkdown(), "utf8");

  await appendLine(activityPath, `[${nowIso()}] init`);
  try {
    const graphAfterInit = await loadWorkgraph(paths.graphPath);
    if (graphAfterInit) await syncTaskPlan({ paths, graph: graphAfterInit });
  } catch {
    // ignore
  }

  await repairChoreoStateOwnership({ paths });
  process.stdout.write(`Initialized dagain state in ${paths.choreoDir}\n`);

  if (goalFlag && !noRefine) {
    if (!config) throw new Error("Missing .dagain/config.json after init");
    await refineGoalInteractive({
      rootDir,
      paths,
      config,
      seedGoal: goalFlag,
      maxTurns,
      live,
      noColor,
      forceColor,
    });
  }
}

async function goalCommand(rootDir, flags) {
  const paths = choreoPaths(rootDir);
  const config = await loadConfig(paths.configPath);
  if (!config) throw new Error("Missing .dagain/config.json. Run `dagain init` first.");

  const goalFlag = typeof flags.goal === "string" ? flags.goal : "";
  const maxTurnsRaw = flags["max-turns"] ?? 12;
  const maxTurnsNum = Number(maxTurnsRaw);
  const maxTurns = Number.isFinite(maxTurnsNum) && maxTurnsNum > 0 ? Math.floor(maxTurnsNum) : 12;
  const runnerOverride = typeof flags.runner === "string" ? flags.runner.trim() : "";
  const live = resolveLiveFlag(flags);
  const noColor = resolveNoColorFlag(flags);
  const forceColor = resolveForceColorFlag(flags);

  if (goalFlag) {
    await writeFile(
      paths.goalPath,
      `# Goal\n\n${goalFlag.trim()}\n\n## Done means\n- (refine into measurable success criteria)\n`,
      "utf8",
    );
  } else if (!(await pathExists(paths.goalPath))) {
    throw new Error("Missing GOAL.md. Provide `--goal \"...\"` or run `dagain init`.");
  }

  await refineGoalInteractive({
    rootDir,
    paths,
    config,
    seedGoal: goalFlag,
    maxTurns,
    runnerOverride: runnerOverride || null,
    live,
    noColor,
    forceColor,
  });
}

async function startCommand(rootDir, flags, positionalGoalTokens) {
  const paths = choreoPaths(rootDir);
  const live = resolveLiveFlag(flags);
  const noRefine = Boolean(flags["no-refine"]) || Boolean(flags.noRefine);

  const goalFlag = typeof flags.goal === "string" ? flags.goal.trim() : "";
  const positionalGoal = Array.isArray(positionalGoalTokens) ? positionalGoalTokens.join(" ").trim() : "";

  const hadConfig = await pathExists(paths.configPath);
  const hadGoal = await pathExists(paths.goalPath);

  let seedGoal = goalFlag || positionalGoal;
  let seedGoalProvided = Boolean(seedGoal);

  const canPrompt = isPromptEnabled();
  if (!seedGoal && !process.stdin.isTTY) {
    seedGoal = (await readStdinText()).trim();
    seedGoalProvided = Boolean(seedGoal);
  }

  if (!seedGoal && canPrompt) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const prompt = hadGoal ? "Goal (blank to keep existing): " : "Goal: ";
      seedGoal = (await rl.question(prompt)).trim();
      seedGoalProvided = Boolean(seedGoal);
    } finally {
      rl.close();
    }
  }

  if (!seedGoal && !hadGoal) {
    throw new Error('Missing goal. Provide a goal (interactive), pipe stdin, or use `--goal "..."`.');
  }

  // Initialize state if needed; keep goal refinement under explicit control here.
  await initCommand(rootDir, {
    ...flags,
    goal: seedGoal || "",
    "no-refine": true,
    noRefine: true,
  });

  // Optional first-run config prompt.
  let config = await loadConfig(paths.configPath);
  if (!config) throw new Error("Missing .dagain/config.json after init");
  if (!hadConfig && canPrompt) {
    const runnerNames = Object.keys(config.runners || {}).sort();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const defaultMain = String(config.roles?.main || "claude");
      const mainPrompt = `Main runner${runnerNames.length ? ` (${runnerNames.join(", ")})` : ""} [${defaultMain}]: `;
      const main = (await rl.question(mainPrompt)).trim() || defaultMain;

      const defaultExecutor = String(config.roles?.executor || "codex");
      const execPrompt = `Executor runner [${defaultExecutor}]: `;
      const executor = (await rl.question(execPrompt)).trim() || defaultExecutor;

      const sharePrompt = "Use main runner for planner/verifier/integrator/finalVerifier? [Y/n]: ";
      const share = ((await rl.question(sharePrompt)).trim() || "y").toLowerCase();
      const shareMain = share !== "n" && share !== "no";

      config.roles = config.roles || {};
      config.roles.main = main;
      config.roles.executor = executor;
      if (shareMain) {
        config.roles.planner = main;
        config.roles.verifier = main;
        config.roles.integrator = main;
        config.roles.finalVerifier = main;
      }
      if (!config.roles.researcher) config.roles.researcher = "gemini";

      await saveConfig(paths.configPath, config);
    } finally {
      rl.close();
    }
    config = await loadConfig(paths.configPath);
    if (!config) throw new Error("Missing .dagain/config.json after saving");
  }

  // Refine goal only when a new seed goal was provided for this invocation.
  if (seedGoalProvided && !noRefine) {
    await goalCommand(rootDir, { ...flags, goal: seedGoal, live });
  }

  // Ensure graph has at least one planning node (older graphs may be empty).
  const graph = await loadWorkgraph(paths.graphPath);
  if (!graph) throw new Error("Missing .dagain/workgraph.json after init");
  if (!Array.isArray(graph.nodes)) graph.nodes = [];
  if (graph.nodes.length === 0) {
    graph.nodes.push({
      id: "plan-000",
      title: "Expand GOAL.md into an executable workgraph",
      type: "plan",
      status: "open",
      dependsOn: [],
      ownership: [],
      acceptance: [
        "Adds 3–10 small, verifiable task/verify nodes",
        "Each node includes ownership, acceptance, and verify steps",
      ],
      verify: [],
      attempts: 0,
      retryPolicy: { maxAttempts: 3 },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await saveWorkgraph(paths.graphPath, graph);
  }

  await runCommand(rootDir, { ...flags, live });
}

async function refineGoalInteractive({
  rootDir,
  paths,
  config,
  seedGoal,
  maxTurns,
  runnerOverride = null,
  live = false,
  noColor = false,
  forceColor = false,
}) {
  const ui = createUi({ noColor, forceColor });
  const cancel = installCancellation({ ui, label: "goal-refine" });
  const abortSignal = cancel.signal;
  const activityPath = path.join(paths.memoryDir, "activity.log");
  const errorsPath = path.join(paths.memoryDir, "errors.log");
  const goalDialogPath = path.join(paths.memoryDir, "goal-dialog.md");

  await ensureDir(paths.memoryDir);
  if (!(await pathExists(goalDialogPath))) await writeFile(goalDialogPath, "# Goal Dialog\n", "utf8");
  if (!(await pathExists(activityPath))) await writeFile(activityPath, "", "utf8");
  if (!(await pathExists(errorsPath))) await writeFile(errorsPath, "", "utf8");

  if (seedGoal) {
    await appendLine(goalDialogPath, `\n## [${nowIso()}] Seed Goal\n${seedGoal.trim()}\n`);
  }

  const canPrompt = isPromptEnabled();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const spawnIdentity = await resolveSpawnIdentity({ rootDir: paths.rootDir });
  const identityEnv = envForIdentity(spawnIdentity);
  try {
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      if (abortSignal.aborted) return;
      const run = `goal-${runId()}`;
      const runDir = path.join(paths.runsDir, run);
      await ensureDir(runDir);

      const packetPath = path.join(runDir, "packet.md");
      const resultPath = path.join(runDir, "result.json");
      const stdoutPath = path.join(runDir, "stdout.log");
      const checkpointOutPath = path.join(paths.checkpointsDir, `checkpoint-${run}.json`);

      const goalDraft = await readTextTruncated(paths.goalPath, 20_000);
      const dialog = await readTextTruncated(goalDialogPath, 20_000);

      const template = await resolveTemplate(rootDir, "goal-refiner");
      const packet = renderTemplate(template, {
        REPO_ROOT: paths.rootDir,
        GOAL_PATH: paths.goalPath,
        RUN_ID: run,
        RESULT_PATH: resultPath,
        CHECKPOINT_OUT_PATH: checkpointOutPath,
        USER_GOAL: seedGoal || "",
        GOAL_DRAFT: goalDraft,
        GOAL_DIALOG: dialog,
      });
      await writeFile(packetPath, packet, "utf8");

      const runnerName =
        (runnerOverride && runnerOverride.length > 0 ? runnerOverride : null) ??
        resolveRoleRunnerPick("main", config, { seed: run, attempt: Math.max(0, turn - 1) });
      const runner = config.runners?.[runnerName];
      if (!runner?.cmd) {
        throw new Error(`Runner not configured: ${runnerName}. Check .dagain/config.json`);
      }

      await appendLine(activityPath, `[${nowIso()}] goal-refine turn=${turn} runner=${runnerName} run=${run}`);
      ui.event("spawn", `goal-refine ${turn}/${maxTurns} runner=${runnerName} run=${run}`);
      ui.detail(`log: ${stdoutPath}`);
      if (live) ui.writeLine(ui.hr(`runner ${runnerName}`));
      const spinner = !live ? ui.spinnerStart(`goal-refine ${turn}/${maxTurns} (${runnerName})`) : null;
      const runnerEnv = mergeEnv(
        mergeEnv(resolveRunnerEnv({ runnerName, runner, cwd: paths.rootDir, paths }), identityEnv),
        choreoRunnerEnv(paths, { nodeId: "goal-refine", runId: run }),
      );
      await ensureRunnerTmpDir(runnerEnv);
      if (runnerName === "claude")
        await ensureClaudeProjectTmpWritable({ cwd: paths.rootDir, ui, uid: spawnIdentity?.uid, gid: spawnIdentity?.gid });
      const execRes = await runRunnerCommand({
        cmd: runner.cmd,
        packetPath,
        cwd: paths.rootDir,
        logPath: stdoutPath,
        timeoutMs: Number(runner.timeoutMs ?? config?.supervisor?.goalRefineTimeoutMs ?? 120_000),
        tee: Boolean(live),
        teePrefix: live ? { stdout: ui.c.gray("│") + " ", stderr: ui.c.gray("│") + " " } : null,
        abortSignal,
        env: runnerEnv,
        uid: spawnIdentity?.uid ?? null,
        gid: spawnIdentity?.gid ?? null,
      });
      spinner?.stop?.();
      if (live) ui.writeLine(ui.hr());
      if (execRes.aborted || abortSignal.aborted) {
        await appendLine(activityPath, `[${nowIso()}] goal-refine cancelled run=${run}`);
        return;
      }

      let result = await safeReadResult(resultPath);
      if (!result) {
        const stdoutText = await readTextTruncated(stdoutPath, 200_000);
        const extracted = extractResultJson(stdoutText);
        if (extracted) {
          result = normalizeGoalRefineResult(extracted, run);
          await writeJsonAtomic(resultPath, result);
        }
      }
      if (!result) {
        const tail = await readTextTruncated(stdoutPath, 2_000);
        await appendLine(errorsPath, `[${nowIso()}] goal-refine missing result.json run=${run} code=${execRes.code}`);
        throw new Error(
          `Goal refinement failed (missing result.json).\n` +
            `Runner exit: code=${execRes.code}${execRes.signal ? ` signal=${execRes.signal}` : ""}\n` +
            `Log: ${stdoutPath}\n` +
            `Log tail:\n${tail}`,
        );
      }

      const goalMarkdown = typeof result.goalMarkdown === "string" ? result.goalMarkdown.trim() : "";
      if (goalMarkdown) await writeFile(paths.goalPath, goalMarkdown.endsWith("\n") ? goalMarkdown : goalMarkdown + "\n", "utf8");

      const status = String(result.status || "").toLowerCase();
      if (status === "success") {
        await appendLine(activityPath, `[${nowIso()}] goal-refine complete run=${run}`);
        process.stdout.write(`GOAL.md updated.\n`);
        return;
      }

      if (status !== "checkpoint") {
        await appendLine(errorsPath, `[${nowIso()}] goal-refine failed run=${run} status=${status}`);
        throw new Error(`Goal refinement failed (status=${status}). See: ${stdoutPath}`);
      }

      let checkpoint = await safeReadJson(checkpointOutPath);
      if (!checkpoint) {
        checkpoint = buildCheckpointFromResult(result, run);
        if (checkpoint) await writeJsonAtomic(checkpointOutPath, checkpoint);
      }
      if (!checkpoint) throw new Error(`Checkpoint missing/invalid. Expected: ${checkpointOutPath}`);

      const question = String(checkpoint.question || checkpoint.prompt || "").trim();
      const context = String(checkpoint.context || "").trim();
      const options = Array.isArray(checkpoint.options) ? checkpoint.options.map((o) => String(o)) : [];

      if (!question) throw new Error(`Checkpoint missing question text. File: ${checkpointOutPath}`);

      process.stdout.write("\n---\n");
      process.stdout.write(`Goal refinement question (${turn}/${maxTurns}):\n${question}\n`);
      if (context) process.stdout.write(`\nContext:\n${context}\n`);
      if (options.length > 0) {
        process.stdout.write("\nOptions:\n");
        for (const opt of options) process.stdout.write(`- ${opt}\n`);
      }

      if (!canPrompt) {
        process.stdout.write(
          `\n(stdin is not interactive; cannot collect an answer)\n` +
            `Checkpoint: ${checkpointOutPath}\n` +
            `Rerun with a TTY (or use an interactive terminal) to continue.\n`,
        );
        return;
      }

      let answer = "";
      try {
        answer = (await rl.question("\nYour answer (or 'quit'): ", { signal: abortSignal })).trim();
      } catch (error) {
        if (abortSignal.aborted) return;
        process.stdout.write(
          `\nFailed to read answer from stdin.\n` +
            `Checkpoint: ${checkpointOutPath}\n` +
            `Error: ${error?.message || String(error)}\n`,
        );
        return;
      }
      if (!answer) {
        process.stdout.write("Answer was empty. Aborting refinement.\n");
        return;
      }
      if (answer.toLowerCase() === "quit" || answer.toLowerCase() === "exit") {
        process.stdout.write("Aborted.\n");
        return;
      }

      const responsePath = path.join(paths.checkpointsDir, `response-${run}.json`);
      await writeJsonAtomic(responsePath, {
        version: 1,
        id: run,
        answeredAt: nowIso(),
        answer,
      });

      await appendLine(goalDialogPath, `\n## [${nowIso()}] Question\n${question}\n`);
      await appendLine(goalDialogPath, `\n## [${nowIso()}] Answer\n${answer}\n`);
      await appendLine(activityPath, `[${nowIso()}] goal-refine answered run=${run}`);
    }

    process.stdout.write(`Reached max turns (${maxTurns}).\n`);
  } finally {
    rl.close();
    cancel.cleanup();
    await repairChoreoStateOwnership({ paths, ui });
  }
}

function normalizeGoalRefineResult(result, runIdStr) {
  const out = typeof result === "object" && result ? { ...result } : {};
  out.version = Number(out.version || 1);
  if (!out.runId) out.runId = runIdStr;
  if (!out.role) out.role = "goalRefiner";
  return out;
}

function buildCheckpointFromResult(result, runIdStr) {
  const checkpoint = result?.checkpoint && typeof result.checkpoint === "object" ? result.checkpoint : null;
  const question = String(checkpoint?.question || result?.question || result?.prompt || "").trim();
  if (!question) return null;
  const context = String(checkpoint?.context || result?.context || "").trim();
  const optionsRaw = checkpoint?.options ?? result?.options ?? [];
  const options = Array.isArray(optionsRaw) ? optionsRaw.map((o) => String(o)) : [];
  const resumeSignal = String(checkpoint?.resumeSignal || result?.resumeSignal || "Answer in plain text").trim();
  return {
    version: 1,
    id: runIdStr,
    type: String(checkpoint?.type || "goal-question"),
    question,
    context,
    options,
    resumeSignal,
  };
}

function extractResultJson(text) {
  const t = String(text || "");

  // Preferred: <result>{...}</result>
  const tagRe = /<result>\s*([\s\S]*?)\s*<\/result>/gi;
  for (let m = tagRe.exec(t); m; m = tagRe.exec(t)) {
    const candidate = String(m[1] || "").trim();
    const parsed = safeJsonParse(candidate);
    if (parsed) return parsed;
  }

  // Common: ```json ... ```
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  for (let m = fenceRe.exec(t); m; m = fenceRe.exec(t)) {
    const candidate = String(m[1] || "").trim();
    const parsed = safeJsonParse(candidate);
    if (parsed) return parsed;
  }

  // Fallback: whole output is JSON
  const trimmed = t.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const parsed = safeJsonParse(trimmed);
    if (parsed) return parsed;
  }

  return null;
}

function safeJsonParse(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readTextTruncated(filePath, maxChars) {
  try {
    const text = await readFile(filePath, "utf8");
    if (text.length <= maxChars) return text;
    return text.slice(text.length - maxChars);
  } catch {
    return "";
  }
}

async function safeReadJson(jsonPath) {
  try {
    return await readJson(jsonPath);
  } catch {
    return null;
  }
}

function formatNodeLine(node) {
  const id = node?.id || "(missing-id)";
  const title = node?.title || "(untitled)";
  const type = node?.type || "(type?)";
  const status = node?.status || "(status?)";
  return `${id} [${type}] (${status}) — ${title}`;
}

async function statusCommand(rootDir) {
  const paths = choreoPaths(rootDir);
  const hasDb = Boolean(paths.dbPath && (await pathExists(paths.dbPath)));
  const graph = hasDb ? await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath }) : await loadWorkgraph(paths.graphPath);
  if (!graph) throw new Error("Missing .dagain state. Run `dagain init`.");

  const counts = countByStatus(graph.nodes);
  process.stdout.write("Workgraph status\n");
  for (const key of Object.keys(counts).sort()) {
    process.stdout.write(`- ${key}: ${counts[key]}\n`);
  }

  const inProgress = (graph.nodes || []).filter((n) => String(n?.status || "").toLowerCase() === "in_progress");
  if (inProgress.length > 0) {
    process.stdout.write("\nIn progress:\n");
    const ordered = inProgress
      .slice()
      .sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || "")));
    for (const node of ordered) {
      const runId = typeof node?.lock?.runId === "string" ? node.lock.runId.trim() : "";
      process.stdout.write(`- ${node.id}${runId ? ` (run=${runId})` : ""}\n`);
      if (runId) {
        const logAbs = path.join(paths.runsDir, runId, "stdout.log");
        const logRel = path.relative(paths.rootDir, logAbs) || logAbs;
        process.stdout.write(`  log: ${logRel}\n`);
      }
    }
  }

  const next = selectNextNode(graph);
  if (next) {
    process.stdout.write("\nNext runnable:\n");
    process.stdout.write(`- ${formatNodeLine(next)}\n`);
  } else {
    process.stdout.write("\nNext runnable:\n- (none)\n");
  }

  const needsHuman = (graph.nodes || []).filter((n) => String(n?.status || "").toLowerCase() === "needs_human");
  if (needsHuman.length > 0) {
    process.stdout.write("\nNeeds human:\n");
    for (const node of needsHuman) {
      let cpPath = node?.checkpoint?.path ? String(node.checkpoint.path) : "";
      let cpQuestion = node?.checkpoint?.question ? String(node.checkpoint.question) : "";
      if (!cpPath || !cpQuestion) {
        try {
          const resolved = await resolveCheckpointForAnswer({ paths, graph, nodeId: node.id, checkpointFile: "" });
          cpPath = path.relative(paths.rootDir, resolved.checkpointPathAbs);
          cpQuestion = String(resolved?.checkpoint?.question || "").trim() || cpQuestion;
        } catch {
          // ignore
        }
      }
      process.stdout.write(`- ${node.id}${cpQuestion ? ` — ${cpQuestion}` : ""}\n`);
      if (cpPath) process.stdout.write(`  checkpoint: ${cpPath}\n`);
    }
    process.stdout.write("\nTip: `dagain answer` to respond and resume.\n");
  }

  const checkpointFiles = await listCheckpoints(paths.checkpointsDir);
  if (checkpointFiles.length > 0) {
    process.stdout.write("\nCheckpoints:\n");
    for (const file of checkpointFiles) process.stdout.write(`- ${file}\n`);
  }
}

async function listCheckpoints(checkpointsDir) {
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(checkpointsDir);
    return files.filter((f) => f.startsWith("checkpoint-") && f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

function validateGraph(graph) {
  if (!graph || typeof graph !== "object") throw new Error("workgraph.json must be an object");
  if (!Array.isArray(graph.nodes)) throw new Error("workgraph.json nodes must be an array");

  const ids = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node !== "object") throw new Error("node must be an object");
    if (!node.id || typeof node.id !== "string") throw new Error("node.id must be a string");
    if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    ids.add(node.id);
  }

  // Cycle detection (DFS)
  const index = new Map(graph.nodes.map((n) => [n.id, n]));
  const visiting = new Set();
  const visited = new Set();

  function dfs(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`cycle detected at node: ${id}`);
    visiting.add(id);
    const node = index.get(id);
    const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
    for (const dep of deps) {
      if (index.has(dep)) dfs(dep);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of ids) dfs(id);
}

async function graphValidateCommand(rootDir) {
  const paths = choreoPaths(rootDir);
  const graph = await loadWorkgraph(paths.graphPath);
  if (!graph) throw new Error("Missing .dagain/workgraph.json. Run `dagain init`.");
  validateGraph(graph);
  process.stdout.write("workgraph.json OK\n");
}

function allDone(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  if (nodes.length === 0) return false;
  return nodes.every((n) => String(n?.status || "").toLowerCase() === "done");
}

function normalizeStatus(status) {
  return String(status || "").toLowerCase();
}

function diagnoseNoRunnableNodes(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const statusById = new Map();
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (!n.id || typeof n.id !== "string") continue;
    statusById.set(n.id, normalizeStatus(n.status));
  }

  const failed = nodes.filter((n) => normalizeStatus(n?.status) === "failed").map((n) => n.id);
  const openNodes = nodes.filter((n) => normalizeStatus(n?.status) === "open");

  const blockedByFailed = [];
  const blockedByMissing = [];
  const failedDeps = new Set();
  const missingDeps = new Set();

  for (const node of openNodes) {
    const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
    const nodeFailedDeps = [];
    const nodeMissingDeps = [];
    for (const dep of deps) {
      const depId = String(dep || "").trim();
      if (!depId) continue;
      const depStatus = statusById.get(depId);
      if (!depStatus) {
        nodeMissingDeps.push(depId);
        missingDeps.add(depId);
        continue;
      }
      if (depStatus === "failed") {
        nodeFailedDeps.push(depId);
        failedDeps.add(depId);
      }
    }
    if (nodeFailedDeps.length > 0) blockedByFailed.push({ nodeId: node.id, failedDeps: nodeFailedDeps });
    if (nodeMissingDeps.length > 0) blockedByMissing.push({ nodeId: node.id, missingDeps: nodeMissingDeps });
  }

  return {
    failed,
    open: openNodes.map((n) => n.id),
    blockedByFailed,
    blockedByMissing,
    failedDeps: [...failedDeps].sort(),
    missingDeps: [...missingDeps].sort(),
  };
}

async function runCommand(rootDir, flags) {
  const paths = choreoPaths(rootDir);
  const config = await loadConfig(paths.configPath);
  if (!config) throw new Error("Missing .dagain/config.json. Run `dagain init`.");
  if (!(await pathExists(paths.dbPath))) throw new Error("Missing .dagain/state.sqlite. Run `dagain init`.");
  await ensureDepsRequiredStatusColumn({ dbPath: paths.dbPath });
  await ensureMailboxTable({ dbPath: paths.dbPath });
  const initGraph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
  if (!Array.isArray(initGraph.nodes) || initGraph.nodes.length === 0) {
    process.stderr.write(
      "No nodes in .dagain/state.sqlite. Run `dagain start` (or `dagain init --force`) to seed a plan node.\n",
    );
    return;
  }
  await syncTaskPlan({ paths, graph: initGraph });

  const once = Boolean(flags.once);
  const dryRun = Boolean(flags["dry-run"]);
  const live = resolveLiveFlag(flags);
  const ui = createUi({ noColor: resolveNoColorFlag(flags), forceColor: resolveForceColorFlag(flags) });
  const cancel = installCancellation({ ui, label: "run" });
  const abortSignal = cancel.signal;
  const canPrompt = isPromptEnabled();
  const noPrompt = Boolean(flags["no-prompt"]) || Boolean(flags.noPrompt);
  const intervalMsRaw = flags["interval-ms"] ?? config.supervisor?.idleSleepMs ?? 2000;
  const intervalMsNum = Number(intervalMsRaw);
  const intervalMs = Number.isFinite(intervalMsNum) && intervalMsNum >= 0 ? intervalMsNum : 2000;

  const maxIterationsRaw = flags["max-iterations"] ?? 0;
  const maxIterationsNum = Number(maxIterationsRaw);
  const maxIterations = Number.isFinite(maxIterationsNum) && maxIterationsNum >= 0 ? maxIterationsNum : 0;
  const staleLockSeconds = Number(config.supervisor?.staleLockSeconds ?? 3600);
  const autoResetFailedMaxRaw = config.supervisor?.autoResetFailedMax ?? 1;
  const autoResetFailedMaxNum = Number(autoResetFailedMaxRaw);
  const autoResetFailedMax = Number.isFinite(autoResetFailedMaxNum) && autoResetFailedMaxNum >= 0 ? autoResetFailedMaxNum : 1;

  const workersRaw = flags.workers ?? config.supervisor?.workers ?? 1;
  const workersNum = Number(workersRaw);
  const requestedWorkers = Number.isFinite(workersNum) && workersNum > 0 ? Math.floor(workersNum) : 1;
  const workers = dryRun || once ? 1 : requestedWorkers;
  const worktreeMode = normalizeWorktreeMode(config?.supervisor?.worktrees?.mode);
  const worktreesDir = worktreeMode === "off" ? null : resolveWorktreesDir({ paths, config });

  const activityPath = path.join(paths.memoryDir, "activity.log");
  const errorsPath = path.join(paths.memoryDir, "errors.log");

  ui.writeLine(ui.hr("dagain run"));
  ui.detail(`root: ${paths.rootDir}`);
  ui.detail(`goal: ${path.relative(paths.rootDir, paths.goalPath) || "GOAL.md"}`);
  ui.detail(`state: ${path.relative(paths.rootDir, paths.choreoDir) || ".dagain"}`);
  if (workers > 1) ui.detail(`workers: ${workers}`);
  if (worktreeMode !== "off" && worktreesDir) ui.detail(`worktrees: ${worktreeMode} (${path.relative(paths.rootDir, worktreesDir) || worktreesDir})`);
  ui.writeLine(ui.hr());

  let acquired = false;
  await repairChoreoStateOwnership({ paths, ui });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const acquireRes = await acquireSupervisorLock(paths.lockPath, { staleSeconds: staleLockSeconds });
    if (acquireRes.ok) {
      acquired = true;
      break;
    }

    const lock = acquireRes.lock || {};
    const pid = Number(lock.pid);
    ui.event(
      "warn",
      `Supervisor already running pid=${lock.pid || "?"} host=${lock.host || "?"}.` +
        (canPrompt && !noPrompt ? " Stop it and take over?" : " Use `dagain stop` or wait."),
    );

    if (!canPrompt || noPrompt) {
      process.exitCode = 2;
      cancel.cleanup();
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let choice = "";
    try {
      choice = (await rl.question("Stop the running supervisor? [y/N]: ", { signal: abortSignal })).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (!choice || (choice !== "y" && choice !== "yes")) {
      cancel.cleanup();
      return;
    }

    if (!Number.isFinite(pid) || pid <= 0) {
      ui.event("warn", "Invalid supervisor PID in lock file.");
      process.exitCode = 2;
      cancel.cleanup();
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      ui.event("warn", `Failed to stop supervisor pid=${pid}: ${error?.message || String(error)}`);
      process.exitCode = 2;
      cancel.cleanup();
      return;
    }

    const spinner = ui.spinnerStart(`waiting for pid ${pid} to exit`);
    const deadlineMs = Date.now() + 10_000;
    while (!abortSignal.aborted && Date.now() < deadlineMs) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code !== "EPERM") break;
      }
      await sleep(200, abortSignal);
    }
    spinner.stop();
  }

  if (!acquired) {
    process.exitCode = 2;
    cancel.cleanup();
    return;
  }

  await appendLine(activityPath, `[${nowIso()}] supervisor-start pid=${process.pid}`);

  const serial = createSerialQueue();
  const abortControllersByNodeId = new Map();
  const control = {
    manualPaused: false,
    replanPaused: false,
    maxWorkers: workers,
  };

  const mailboxController = new AbortController();
  const mailboxStopSignal = AbortSignal.any([abortSignal, mailboxController.signal]);
  const mailboxHost = os.hostname();
  const mailboxPollMsRaw = config.supervisor?.mailboxPollMs ?? 100;
  const mailboxPollMsNum = Number(mailboxPollMsRaw);
  const mailboxPollMs = Number.isFinite(mailboxPollMsNum) && mailboxPollMsNum >= 0 ? Math.floor(mailboxPollMsNum) : 100;

  async function reopenPlanForReplan() {
    const now = nowIso();
    await sqliteExec(
      paths.dbPath,
      `UPDATE nodes\n` +
        `SET status='open',\n` +
        `    attempts=0,\n` +
        `    checkpoint_json=NULL,\n` +
        `    lock_run_id=NULL,\n` +
        `    lock_started_at=NULL,\n` +
        `    lock_pid=NULL,\n` +
        `    lock_host=NULL,\n` +
        `    completed_at=NULL,\n` +
        `    updated_at=${sqlQuote(now)}\n` +
        `WHERE id='plan-000';\n`,
    );
    const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
    await syncTaskPlan({ paths, graph });
  }

  async function maybeClearReplanPause() {
    if (!control.replanPaused) return;
    const rows = await sqliteQueryJson(paths.dbPath, "SELECT status FROM nodes WHERE id='plan-000' LIMIT 1;");
    const status = String(rows?.[0]?.status || "").toLowerCase();
    if (status === "done" || status === "failed") control.replanPaused = false;
  }

  async function selectRunnablePlannerCandidatesDb({ dbPath, nowIso, limit = 50 }) {
    const now = typeof nowIso === "string" && nowIso.trim() ? nowIso : new Date().toISOString();
    const limitNum = Number(limit);
    const limitInt = Number.isFinite(limitNum) && limitNum > 0 ? Math.floor(limitNum) : 50;
    return sqliteQueryJson(
      dbPath,
      `SELECT n.*\n` +
        `FROM nodes n\n` +
        `WHERE n.status='open'\n` +
        `  AND (n.blocked_until IS NULL OR n.blocked_until <= ${sqlQuote(now)})\n` +
        `  AND n.lock_run_id IS NULL\n` +
        `  AND lower(n.type) IN ('plan','epic')\n` +
        `  AND NOT EXISTS (\n` +
        `    SELECT 1\n` +
        `    FROM deps d\n` +
        `    JOIN nodes dep ON dep.id = d.depends_on_id\n` +
        `    WHERE d.node_id = n.id AND (\n` +
        `      CASE COALESCE(NULLIF(lower(d.required_status), ''), 'done')\n` +
        `        WHEN 'terminal' THEN dep.status NOT IN ('done', 'failed')\n` +
        `        ELSE dep.status <> 'done'\n` +
        `      END\n` +
        `    )\n` +
        `  )\n` +
        `ORDER BY n.id\n` +
        `LIMIT ${String(limitInt)};\n`,
    );
  }

  const mailboxTask = Promise.resolve().then(async () => {
    while (!mailboxStopSignal.aborted) {
      let claimed = null;
      try {
        claimed = await mailboxClaimNext({
          dbPath: paths.dbPath,
          pid: process.pid,
          host: mailboxHost,
          nowIso: nowIso(),
        });
      } catch (error) {
        await appendLine(errorsPath, `[${nowIso()}] mailbox-claim error: ${error?.message || String(error)}`);
      }

      if (!claimed) {
        await sleep(mailboxPollMs, mailboxStopSignal);
        continue;
      }

      const { id, command, args } = claimed;
      try {
        const cmd = String(command || "").trim();
        const payload = args && typeof args === "object" ? args : {};

        let result = {};
        if (cmd === "pause") {
          control.manualPaused = true;
          result = { paused: true };
        } else if (cmd === "resume") {
          control.manualPaused = false;
          result = { paused: Boolean(control.replanPaused) };
        } else if (cmd === "set_workers") {
          const nRaw = payload.workers;
          const nNum = Number(nRaw);
          const next = Number.isFinite(nNum) && nNum > 0 ? Math.floor(nNum) : null;
          if (next == null) throw new Error("set_workers: invalid workers");
          if (dryRun || once) {
            result = { ignored: true, workers: next };
          } else {
            control.maxWorkers = next;
            result = { workers: next };
          }
        } else if (cmd === "cancel") {
          const nodeId = String(payload.nodeId || "").trim();
          if (!nodeId) throw new Error("cancel: missing nodeId");
          const controller = abortControllersByNodeId.get(nodeId);
          if (!controller) throw new Error(`cancel: node not in flight: ${nodeId}`);
          controller.abort("cancel");
          result = { cancelled: nodeId };
        } else if (cmd === "replan_now") {
          if (dryRun || once) {
            result = { ignored: true };
          } else {
            control.replanPaused = true;
            await serial.enqueue(reopenPlanForReplan);
            result = { replanPaused: true };
          }
        } else {
          throw new Error(`Unknown mailbox command: ${cmd}`);
        }

        await mailboxAck({ dbPath: paths.dbPath, id, status: "done", result, errorText: null, nowIso: nowIso() });
        await appendLine(activityPath, `[${nowIso()}] mailbox done id=${id} cmd=${cmd}`);
      } catch (error) {
        const message = error?.message || String(error);
        try {
          await mailboxAck({ dbPath: paths.dbPath, id, status: "failed", result: null, errorText: message, nowIso: nowIso() });
        } catch {
          // ignore
        }
        await appendLine(errorsPath, `[${nowIso()}] mailbox fail id=${id} ${message}`);
      }
    }
  });

  let iter = 0;
  let lastIdleReason = "";
  let lastHeartbeatMs = 0;
  let lastCountsSig = "";
  // eslint-disable-next-line no-constant-condition
  try {
    async function runParallelSupervisor() {
      const locks = new OwnershipLockManager();
      const inFlight = new Map();
      const worktreeMode = normalizeWorktreeMode(config?.supervisor?.worktrees?.mode);
      const worktreesDir = worktreeMode === "off" ? null : resolveWorktreesDir({ paths, config });
      const worktreeSerial = createSerialQueue();

      const spawnWorker = async (node, { nodeCwd = null, worktreePath = null } = {}) => {
        const run = runId();
        const nodeAbort = new AbortController();
        abortControllersByNodeId.set(node.id, nodeAbort);
        const nodeAbortSignal = AbortSignal.any([abortSignal, nodeAbort.signal]);
        const promise = Promise.resolve()
          .then(async () => {
            if (worktreePath) {
              await worktreeSerial.enqueue(async () => {
                await ensureGitWorktree({ rootDir: paths.rootDir, worktreePath });
              });
            }
            return executeNode({
              rootDir,
              paths,
              config,
              node,
              nodeCwd,
              run,
              activityPath,
              errorsPath,
              live,
              ui,
              abortSignal: nodeAbortSignal,
              serial,
              multiWorker: true,
            });
          })
          .catch(async (error) => {
            const message = error?.message || String(error);
            await appendLine(errorsPath, `[${nowIso()}] worker error node=${node.id} run=${run} ${message}`);
            try {
              const unlock = async () => {
                await unlockNodeDb({ dbPath: paths.dbPath, nodeId: node.id, status: "open", nowIso: nowIso() });
                const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
                await syncTaskPlan({ paths, graph });
              };
              await serial.enqueue(unlock);
            } catch {
              // ignore
            }
          })
          .finally(async () => {
            inFlight.delete(node.id);
            locks.release(node.id);
            abortControllersByNodeId.delete(node.id);
            await serial.enqueue(async () => repairChoreoStateOwnership({ paths, ui }));
          });

        inFlight.set(node.id, promise);
        return promise;
      };

      while (true) {
        iter += 1;
        if (abortSignal.aborted) {
          await appendLine(activityPath, `[${nowIso()}] supervisor-cancel pid=${process.pid}`);
          await Promise.allSettled([...inFlight.values()]);
          return;
        }
        if (maxIterations > 0 && iter > maxIterations) {
          process.stdout.write(`Reached max iterations (${maxIterations}).\n`);
          await Promise.allSettled([...inFlight.values()]);
          return;
        }

        const nowMs = Date.now();
        if (nowMs - lastHeartbeatMs > 1000) {
          lastHeartbeatMs = nowMs;
          try {
            await heartbeatSupervisorLock(paths.lockPath);
          } catch {
            // ignore
          }
        }

        const staleUnlocked = await clearStaleLocksDb({ paths, staleLockSeconds });
        if (staleUnlocked) {
          await serial.enqueue(async () => {
            const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
            await syncTaskPlan({ paths, graph });
          });
          continue;
        }

        const scaffold = await ensurePlannerScaffoldingDb({ paths, config });
        if (scaffold.updated) {
          await serial.enqueue(async () => {
            const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
            await syncTaskPlan({ paths, graph });
          });
          ui.event(
            "info",
            `Planner scaffolding ${
              scaffold.addedIds.length > 0
                ? `added ${scaffold.addedIds.length} node${scaffold.addedIds.length === 1 ? "" : "s"}`
                : "updated deps"
            }.`,
          );
          continue;
        }

        await maybeClearReplanPause();
        const pausedManual = Boolean(control.manualPaused);
        const pausedReplan = !pausedManual && Boolean(control.replanPaused);
        const maxWorkerCountNum = Number(dryRun || once ? 1 : control.maxWorkers);
        const maxWorkerCount = Number.isFinite(maxWorkerCountNum) && maxWorkerCountNum > 0 ? Math.floor(maxWorkerCountNum) : 1;
        const candidateLimit = Math.max(50, maxWorkerCount * 10);

        let spawned = 0;
        if (!dryRun && !pausedManual && inFlight.size < maxWorkerCount) {
          const candidates = pausedReplan
            ? await selectRunnablePlannerCandidatesDb({ dbPath: paths.dbPath, nowIso: nowIso(), limit: candidateLimit })
            : await selectRunnableCandidates({ dbPath: paths.dbPath, nowIso: nowIso(), limit: candidateLimit });
          for (const row of candidates) {
            if (inFlight.size >= maxWorkerCount) break;
            const nodeId = String(row?.id || "").trim();
            if (!nodeId) continue;
            if (inFlight.has(nodeId)) continue;

            const node = await getNode({ dbPath: paths.dbPath, nodeId });
            if (!node) continue;

            const role = resolveNodeRole(node);
            if (pausedReplan && role !== "planner") continue;
            const nodeType = normalizeNodeType(node?.type);
            let lockAcquired = false;
            let nodeCwd = null;
            let worktreePath = null;

            const canUseWorktrees = worktreeMode !== "off" && Boolean(worktreesDir);
            const isExecutorTask = role === "executor" && nodeType === "task";

            if (canUseWorktrees && isExecutorTask && worktreeMode === "always") {
              worktreePath = path.join(worktreesDir, sanitizeNodeIdPart(node.id));
              nodeCwd = worktreePath;
            } else if (canUseWorktrees && isExecutorTask && worktreeMode === "on-conflict") {
              const resources = locks.normalizeResources(node.ownership);
              const mode = locks.modeForRole(role);
              if (locks.acquire(node.id, { resources, mode })) {
                lockAcquired = true;
              } else {
                await serial.enqueue(async () => {
                  await ensureMergeNodeForTaskDb({ paths, config, taskId: node.id });
                });
                worktreePath = path.join(worktreesDir, sanitizeNodeIdPart(node.id));
                nodeCwd = worktreePath;
              }
            }

            if (!nodeCwd && !lockAcquired) {
              const resources = locks.normalizeResources(node.ownership);
              const mode = locks.modeForRole(role);
              if (!locks.acquire(node.id, { resources, mode })) continue;
              lockAcquired = true;
            }

            ui.event("select", ui.formatNode(node));
            await appendLine(activityPath, `[${nowIso()}] select ${node.id}`);
            spawnWorker(node, { nodeCwd, worktreePath });
            spawned += 1;
          }
        }

        if (inFlight.size > 0) {
          await Promise.race([...inFlight.values()]);
          continue;
        }

        if (!pausedManual && !pausedReplan) {
          const nodeRow = await selectNextRunnableNode({ dbPath: paths.dbPath, nowIso: nowIso() });
          if (nodeRow) continue;
        }

        if (await allDoneDb({ dbPath: paths.dbPath })) {
          ui.event("done", "All nodes done.");
          return;
        }
        if (once) return;

        const counts = await countByStatusDb({ dbPath: paths.dbPath });
        const countsSig = stableCountsSig(counts);
        if (countsSig !== lastCountsSig) {
          lastCountsSig = countsSig;
          ui.event("info", `queue: ${ui.formatCounts(counts)}`);
        }

        const needsHuman = Number(counts.needs_human || 0);
        const openCount = Number(counts.open || 0);
        const failedCount = Number(counts.failed || 0);
        const terminalOnly = needsHuman === 0 && openCount === 0 && Number(counts.in_progress || 0) === 0;
        if (terminalOnly && failedCount > 0) {
          const failedIds = (await sqliteQueryJson(paths.dbPath, "SELECT id FROM nodes WHERE status='failed' ORDER BY id;"))
            .map((r) => r.id)
            .filter(Boolean);
          ui.event("fail", `No runnable nodes. ${failedCount} node${failedCount === 1 ? "" : "s"} failed.`);
          if (failedIds.length > 0) ui.detail(`failed: ${failedIds.join(", ")}`);
          process.exitCode = 1;
          return;
        }

        const failedDeps = await listFailedDepsBlockingOpenNodes({ dbPath: paths.dbPath });
        const isBlockedByFailed = failedDeps.length > 0 && openCount > 0;
        const idleReason = needsHuman > 0 ? "needs_human" : isBlockedByFailed ? "blocked_failed" : "idle";

        if (idleReason !== lastIdleReason) {
          lastIdleReason = idleReason;
          if (idleReason === "needs_human") {
            ui.event(
              "checkpoint",
              canPrompt && !noPrompt
                ? `Waiting for human input (${needsHuman} node${needsHuman === 1 ? "" : "s"}). Answer below to continue.`
                : `Waiting for human input (${needsHuman} node${needsHuman === 1 ? "" : "s"}). Run \`dagain answer\` or \`dagain status\`.`,
            );
          } else if (idleReason === "blocked_failed") {
            ui.event(
              "fail",
              `No runnable nodes. ${openCount} open node${openCount === 1 ? "" : "s"} blocked by failed deps: ${failedDeps.join(", ")}`,
            );
          }
        }

        if (idleReason === "needs_human" && !noPrompt && canPrompt) {
          let answered = false;
          try {
            answered = await answerNeedsHumanInteractiveDb({ paths, ui, abortSignal });
          } catch (error) {
            ui.event("warn", `Failed to collect checkpoint answer: ${error?.message || String(error)}`);
          }
          if (answered) continue;
          return;
        }

        if (idleReason === "blocked_failed") {
          const toReset = [];
          for (const depId of failedDeps) {
            const failedNode = await getNode({ dbPath: paths.dbPath, nodeId: depId });
            if (!failedNode) continue;
            const resetCount = Number(failedNode.autoResetCount || 0);
            if (resetCount >= autoResetFailedMax) continue;
            toReset.push(depId);
          }

          if (toReset.length > 0) {
            const now = nowIso();
            for (const depId of toReset) {
              await sqliteExec(
                paths.dbPath,
                `UPDATE nodes\n` +
                  `SET status='open',\n` +
                  `    attempts=0,\n` +
                  `    checkpoint_json=NULL,\n` +
                  `    lock_run_id=NULL,\n` +
                  `    lock_started_at=NULL,\n` +
                  `    lock_pid=NULL,\n` +
                  `    lock_host=NULL,\n` +
                  `    auto_reset_count=auto_reset_count+1,\n` +
                  `    last_auto_reset_at='${now.replace(/'/g, "''")}',\n` +
                  `    updated_at='${now.replace(/'/g, "''")}'\n` +
                  `WHERE id='${String(depId).replace(/'/g, "''")}';\n`,
              );
            }
            await serial.enqueue(async () => {
              const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
              await syncTaskPlan({ paths, graph });
            });
            await appendLine(activityPath, `[${now}] auto-reset failed nodes: ${toReset.join(", ")}`);

            const progressPath = path.join(paths.memoryDir, "progress.md");
            const lines = [];
            lines.push("");
            lines.push(`## [${now}] Auto-reset failed nodes`);
            lines.push(`- nodes: ${toReset.join(", ")}`);
            lines.push(`- reason: open nodes blocked by failed deps`);
            await writeFile(progressPath, lines.join("\n") + "\n", { encoding: "utf8", flag: "a" });

            ui.event("warn", `Reopened failed node${toReset.length === 1 ? "" : "s"}: ${toReset.join(", ")}. Continuing...`);
            continue;
          }

          if (canPrompt && !noPrompt) {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            let choice = "";
            try {
              const prompt = `Retry failed deps again? (${failedDeps.join(", ")}) [y/N]: `;
              choice = (await rl.question(prompt, { signal: abortSignal })).trim().toLowerCase();
            } finally {
              rl.close();
            }
            if (choice === "y" || choice === "yes") {
              const now = nowIso();
              for (const depId of failedDeps) {
                await sqliteExec(
                  paths.dbPath,
                  `UPDATE nodes\n` +
                    `SET status='open',\n` +
                    `    attempts=0,\n` +
                    `    checkpoint_json=NULL,\n` +
                    `    lock_run_id=NULL,\n` +
                    `    lock_started_at=NULL,\n` +
                    `    lock_pid=NULL,\n` +
                    `    lock_host=NULL,\n` +
                    `    manual_reset_count=manual_reset_count+1,\n` +
                    `    last_manual_reset_at='${now.replace(/'/g, "''")}',\n` +
                    `    updated_at='${now.replace(/'/g, "''")}'\n` +
                    `WHERE id='${String(depId).replace(/'/g, "''")}';\n`,
                );
              }
              await serial.enqueue(async () => {
                const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
                await syncTaskPlan({ paths, graph });
              });
              await appendLine(activityPath, `[${now}] manual-reset failed nodes: ${failedDeps.join(", ")}`);
              ui.event("warn", `Reopened failed deps. Continuing...`);
              continue;
            }
            return;
          }

          process.exitCode = 1;
          return;
        }

        await appendLine(activityPath, `[${nowIso()}] idle`);
        await sleep(intervalMs, abortSignal);
        continue;
      }
    }

    if (workers > 1) {
      await runParallelSupervisor();
      return;
    }

    while (true) {
      iter += 1;
      if (abortSignal.aborted) {
        await appendLine(activityPath, `[${nowIso()}] supervisor-cancel pid=${process.pid}`);
        return;
      }
      if (maxIterations > 0 && iter > maxIterations) {
        process.stdout.write(`Reached max iterations (${maxIterations}).\n`);
        return;
      }

      const nowMs = Date.now();
      if (nowMs - lastHeartbeatMs > 1000) {
        lastHeartbeatMs = nowMs;
        try {
          await heartbeatSupervisorLock(paths.lockPath);
        } catch {
          // ignore
        }
      }

      const staleUnlocked = await clearStaleLocksDb({ paths, staleLockSeconds });
      if (staleUnlocked) {
        const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
        await syncTaskPlan({ paths, graph });
        continue;
      }

      const scaffold = await ensurePlannerScaffoldingDb({ paths, config });
      if (scaffold.updated) {
        const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
        await syncTaskPlan({ paths, graph });
        ui.event(
          "info",
          `Planner scaffolding ${
            scaffold.addedIds.length > 0
              ? `added ${scaffold.addedIds.length} node${scaffold.addedIds.length === 1 ? "" : "s"}`
              : "updated deps"
          }.`,
        );
        continue;
      }

      await maybeClearReplanPause();
      const wantsParallelWorkers = !dryRun && !once && Number(control.maxWorkers) > 1;
      if (wantsParallelWorkers) {
        await runParallelSupervisor();
        return;
      }

      let nodeRow = null;
      if (!control.manualPaused) {
        if (control.replanPaused) {
          const planners = await selectRunnablePlannerCandidatesDb({ dbPath: paths.dbPath, nowIso: nowIso(), limit: 1 });
          nodeRow = planners[0] || null;
        } else {
          nodeRow = await selectNextRunnableNode({ dbPath: paths.dbPath, nowIso: nowIso() });
        }
      }
      if (!nodeRow) {
        if (await allDoneDb({ dbPath: paths.dbPath })) {
          ui.event("done", "All nodes done.");
          return;
        }
        if (once) return;

        const counts = await countByStatusDb({ dbPath: paths.dbPath });
        const countsSig = stableCountsSig(counts);
        if (countsSig !== lastCountsSig) {
          lastCountsSig = countsSig;
          ui.event("info", `queue: ${ui.formatCounts(counts)}`);
        }

        const needsHuman = Number(counts.needs_human || 0);
        const openCount = Number(counts.open || 0);
        const failedCount = Number(counts.failed || 0);
        const terminalOnly = needsHuman === 0 && openCount === 0 && Number(counts.in_progress || 0) === 0;
        if (terminalOnly && failedCount > 0) {
          const failedIds = (
            await sqliteQueryJson(paths.dbPath, "SELECT id FROM nodes WHERE status='failed' ORDER BY id;")
          )
            .map((r) => r.id)
            .filter(Boolean);
          ui.event("fail", `No runnable nodes. ${failedCount} node${failedCount === 1 ? "" : "s"} failed.`);
          if (failedIds.length > 0) ui.detail(`failed: ${failedIds.join(", ")}`);
          process.exitCode = 1;
          return;
        }

        const failedDeps = await listFailedDepsBlockingOpenNodes({ dbPath: paths.dbPath });
        const isBlockedByFailed = failedDeps.length > 0 && openCount > 0;
        const idleReason = needsHuman > 0 ? "needs_human" : isBlockedByFailed ? "blocked_failed" : "idle";

        if (idleReason !== lastIdleReason) {
          lastIdleReason = idleReason;
          if (idleReason === "needs_human") {
            ui.event(
              "checkpoint",
              canPrompt && !noPrompt
                ? `Waiting for human input (${needsHuman} node${needsHuman === 1 ? "" : "s"}). Answer below to continue.`
                : `Waiting for human input (${needsHuman} node${needsHuman === 1 ? "" : "s"}). Run \`dagain answer\` or \`dagain status\`.`,
            );
          } else if (idleReason === "blocked_failed") {
            ui.event(
              "fail",
              `No runnable nodes. ${openCount} open node${openCount === 1 ? "" : "s"} blocked by failed deps: ${failedDeps.join(", ")}`,
            );
          }
        }

        if (idleReason === "needs_human" && !noPrompt && canPrompt) {
          let answered = false;
          try {
            answered = await answerNeedsHumanInteractiveDb({ paths, ui, abortSignal });
          } catch (error) {
            ui.event("warn", `Failed to collect checkpoint answer: ${error?.message || String(error)}`);
          }
          if (answered) continue;
          return;
        }

        if (idleReason === "blocked_failed") {
          const toReset = [];
          for (const depId of failedDeps) {
            const failedNode = await getNode({ dbPath: paths.dbPath, nodeId: depId });
            if (!failedNode) continue;
            const resetCount = Number(failedNode.autoResetCount || 0);
            if (resetCount >= autoResetFailedMax) continue;
            toReset.push(depId);
          }

          if (toReset.length > 0) {
            const now = nowIso();
            for (const depId of toReset) {
              await sqliteExec(
                paths.dbPath,
                `UPDATE nodes\n` +
                  `SET status='open',\n` +
                  `    attempts=0,\n` +
                  `    checkpoint_json=NULL,\n` +
                  `    lock_run_id=NULL,\n` +
                  `    lock_started_at=NULL,\n` +
                  `    lock_pid=NULL,\n` +
                  `    lock_host=NULL,\n` +
                  `    auto_reset_count=auto_reset_count+1,\n` +
                  `    last_auto_reset_at='${now.replace(/'/g, "''")}',\n` +
                  `    updated_at='${now.replace(/'/g, "''")}'\n` +
                  `WHERE id='${String(depId).replace(/'/g, "''")}';\n`,
              );
            }
            const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
            await syncTaskPlan({ paths, graph });
            await appendLine(activityPath, `[${now}] auto-reset failed nodes: ${toReset.join(", ")}`);

            const progressPath = path.join(paths.memoryDir, "progress.md");
            const lines = [];
            lines.push("");
            lines.push(`## [${now}] Auto-reset failed nodes`);
            lines.push(`- nodes: ${toReset.join(", ")}`);
            lines.push(`- reason: open nodes blocked by failed deps`);
            await writeFile(progressPath, lines.join("\n") + "\n", { encoding: "utf8", flag: "a" });

            ui.event("warn", `Reopened failed node${toReset.length === 1 ? "" : "s"}: ${toReset.join(", ")}. Continuing...`);
            continue;
          }

          if (canPrompt && !noPrompt) {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            let choice = "";
            try {
              const prompt = `Retry failed deps again? (${failedDeps.join(", ")}) [y/N]: `;
              choice = (await rl.question(prompt, { signal: abortSignal })).trim().toLowerCase();
            } finally {
              rl.close();
            }
            if (choice === "y" || choice === "yes") {
              const now = nowIso();
              for (const depId of failedDeps) {
                await sqliteExec(
                  paths.dbPath,
                  `UPDATE nodes\n` +
                    `SET status='open',\n` +
                    `    attempts=0,\n` +
                    `    checkpoint_json=NULL,\n` +
                    `    lock_run_id=NULL,\n` +
                    `    lock_started_at=NULL,\n` +
                    `    lock_pid=NULL,\n` +
                    `    lock_host=NULL,\n` +
                    `    manual_reset_count=manual_reset_count+1,\n` +
                    `    last_manual_reset_at='${now.replace(/'/g, "''")}',\n` +
                    `    updated_at='${now.replace(/'/g, "''")}'\n` +
                    `WHERE id='${String(depId).replace(/'/g, "''")}';\n`,
                );
              }
              const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
              await syncTaskPlan({ paths, graph });
              await appendLine(activityPath, `[${now}] manual-reset failed nodes: ${failedDeps.join(", ")}`);
              ui.event("warn", `Reopened failed deps. Continuing...`);
              continue;
            }
            return;
          }

          process.exitCode = 1;
          return;
        }

        await appendLine(activityPath, `[${nowIso()}] idle`);
        await sleep(intervalMs, abortSignal);
        continue;
      }

      lastIdleReason = "";
      const counts = await countByStatusDb({ dbPath: paths.dbPath });
      const countsSig = stableCountsSig(counts);
      if (countsSig !== lastCountsSig) {
        lastCountsSig = countsSig;
        ui.event("info", `queue: ${ui.formatCounts(counts)}`);
      }
      const node = await getNode({ dbPath: paths.dbPath, nodeId: nodeRow.id });
      if (!node) continue;
      ui.event("select", ui.formatNode(node));
      await appendLine(activityPath, `[${nowIso()}] select ${node.id}`);

      if (dryRun) {
        if (once) return;
        await sleep(0, abortSignal);
        continue;
      }

      const run = runId();
      let nodeCwd = null;
      if (worktreeMode === "always" && worktreesDir) {
        const role = resolveNodeRole(node);
        const nodeType = normalizeNodeType(node?.type);
        if (role === "executor" && nodeType === "task") {
          const worktreePath = path.join(worktreesDir, sanitizeNodeIdPart(node.id));
          await ensureGitWorktree({ rootDir: paths.rootDir, worktreePath });
          nodeCwd = worktreePath;
        }
      }
      const nodeAbort = new AbortController();
      abortControllersByNodeId.set(node.id, nodeAbort);
      const nodeAbortSignal = AbortSignal.any([abortSignal, nodeAbort.signal]);
      try {
        await executeNode({
          rootDir,
          paths,
          config,
          node,
          nodeCwd,
          run,
          activityPath,
          errorsPath,
          live,
          ui,
          abortSignal: nodeAbortSignal,
          serial,
        });
      } finally {
        abortControllersByNodeId.delete(node.id);
      }
      await repairChoreoStateOwnership({ paths, ui });
      if (once) return;
    }
  } finally {
    mailboxController.abort();
    await mailboxTask.catch(() => {});
    cancel.cleanup();
    await appendLine(activityPath, `[${nowIso()}] supervisor-exit pid=${process.pid}`);
    await releaseSupervisorLock(paths.lockPath);
    await repairChoreoStateOwnership({ paths, ui });
  }
}

async function clearStaleLocksDb({ paths, staleLockSeconds }) {
  const host = os.hostname();
  const shouldCheckAge = Number.isFinite(staleLockSeconds) && staleLockSeconds > 0;
  const nowMs = Date.now();
  const rows = await sqliteQueryJson(
    paths.dbPath,
    "SELECT id, status, lock_started_at, lock_pid, lock_host FROM nodes WHERE lock_run_id IS NOT NULL;",
  );
  let changed = false;
  for (const row of rows) {
    const nodeId = String(row?.id || "").trim();
    if (!nodeId) continue;
    let stale = false;
    const pid = Number(row?.lock_pid);
    const lockHost = typeof row?.lock_host === "string" ? row.lock_host : "";
    if (Number.isFinite(pid) && pid > 0 && lockHost === host) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code !== "EPERM") stale = true;
      }
    }
    if (!stale && shouldCheckAge) {
      const started = new Date(String(row?.lock_started_at || "")).getTime();
      if (!Number.isNaN(started) && (nowMs - started) / 1000 > staleLockSeconds) stale = true;
    }
    if (!stale) continue;
    const status = String(row?.status || "").toLowerCase();
    const nextStatus = status === "in_progress" ? "open" : String(row?.status || "open");
    await unlockNodeDb({ dbPath: paths.dbPath, nodeId, status: nextStatus, nowIso: nowIso() });
    changed = true;
  }
  return changed;
}

async function ensureMergeNodeForTaskDb({ paths, config, taskId }) {
  const taskNodeId = String(taskId || "").trim();
  if (!taskNodeId) return "";

  const mergeId = `merge-${sanitizeNodeIdPart(taskNodeId)}`;
  const existing = await sqliteQueryJson(paths.dbPath, `SELECT id FROM nodes WHERE id=${sqlQuote(mergeId)} LIMIT 1;\n`);
  const now = nowIso();

  if (!existing?.[0]?.id) {
    const defaultMergeRunner = String(config?.defaults?.mergeRunner || "shellMerge").trim();
    const defaultRetryPolicy = resolveDefaultRetryPolicy(config) || { maxAttempts: 1 };
    await sqliteExec(
      paths.dbPath,
      `INSERT OR IGNORE INTO nodes(\n` +
        `  id, title, type, status, parent_id,\n` +
        `  runner, inputs_json, ownership_json, acceptance_json, verify_json,\n` +
        `  retry_policy_json, attempts,\n` +
        `  created_at, updated_at\n` +
        `)\n` +
        `VALUES(\n` +
        `  ${sqlQuote(mergeId)}, ${sqlQuote(`Merge: ${taskNodeId}`)}, 'merge', 'open', NULL,\n` +
        `  ${defaultMergeRunner ? sqlQuote(defaultMergeRunner) : "NULL"}, '[]', ${sqlQuote(JSON.stringify(["__global__"]))}, ${sqlQuote(
          JSON.stringify(["Applies the task worktree changes back to the root workspace"]),
        )}, '[]',\n` +
        `  ${sqlQuote(JSON.stringify(defaultRetryPolicy))}, 0,\n` +
        `  ${sqlQuote(now)}, ${sqlQuote(now)}\n` +
        `);\n`,
    );
    await sqliteExec(
      paths.dbPath,
      `INSERT OR IGNORE INTO deps(node_id, depends_on_id)\n` + `VALUES(${sqlQuote(mergeId)}, ${sqlQuote(taskNodeId)});\n`,
    );
  }

  const verifyRows = await sqliteQueryJson(
    paths.dbPath,
    `SELECT d.node_id AS id\n` +
      `FROM deps d\n` +
      `JOIN nodes n ON n.id = d.node_id\n` +
      `WHERE d.depends_on_id = ${sqlQuote(taskNodeId)} AND lower(n.type)='verify'\n` +
      `ORDER BY d.node_id;\n`,
  );

  for (const row of verifyRows) {
    const verifyId = String(row?.id || "").trim();
    if (!verifyId) continue;
    await sqliteExec(
      paths.dbPath,
      `DELETE FROM deps WHERE node_id=${sqlQuote(verifyId)} AND depends_on_id=${sqlQuote(taskNodeId)};\n` +
        `INSERT OR IGNORE INTO deps(node_id, depends_on_id) VALUES(${sqlQuote(verifyId)}, ${sqlQuote(mergeId)});\n` +
        `UPDATE nodes SET updated_at=${sqlQuote(nowIso())} WHERE id=${sqlQuote(verifyId)};\n`,
    );
  }

  return mergeId;
}

async function ensurePlannerScaffoldingDb({ paths, config }) {
  const graph = await loadWorkgraphFromDb({ dbPath: paths.dbPath });
  const beforeDepsSigById = new Map();
  const beforeInputsSigById = new Map();
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (!node?.id) continue;
    const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
    beforeDepsSigById.set(node.id, deps.slice().sort().join("|"));
    beforeInputsSigById.set(node.id, stableJsonSig(Array.isArray(node?.inputs) ? node.inputs : []));
  }

  const scaffold = ensurePlannerScaffolding({ graph, config });
  if (!scaffold.updated) return scaffold;

  const nodesById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  for (const nodeId of scaffold.addedIds) {
    const node = nodesById.get(nodeId);
    if (!node) continue;
    const createdAt = typeof node.createdAt === "string" && node.createdAt ? node.createdAt : nowIso();
    const updatedAt = typeof node.updatedAt === "string" && node.updatedAt ? node.updatedAt : createdAt;
    const runner = typeof node.runner === "string" && node.runner.trim() ? node.runner.trim() : null;
    await sqliteExec(
      paths.dbPath,
      `INSERT OR IGNORE INTO nodes(\n` +
        `  id, title, type, status, parent_id,\n` +
        `  runner, inputs_json, ownership_json, acceptance_json, verify_json,\n` +
        `  retry_policy_json, attempts,\n` +
        `  created_at, updated_at\n` +
        `)\n` +
        `VALUES(\n` +
        `  ${sqlQuote(node.id)}, ${sqlQuote(node.title || "")}, ${sqlQuote(node.type || "task")}, ${sqlQuote(node.status || "open")}, NULL,\n` +
        `  ${runner ? sqlQuote(runner) : "NULL"}, ${sqlQuote(JSON.stringify(node.inputs || []))}, ${sqlQuote(JSON.stringify(node.ownership || []))}, ${sqlQuote(
          JSON.stringify(node.acceptance || []),
        )}, ${sqlQuote(JSON.stringify(node.verify || []))},\n` +
        `  ${sqlQuote(JSON.stringify(node.retryPolicy || { maxAttempts: 3 }))}, ${String(Number(node.attempts || 0) || 0)},\n` +
        `  ${sqlQuote(createdAt)}, ${sqlQuote(updatedAt)}\n` +
        `);\n`,
    );

    const deps = Array.isArray(node.dependsOn) ? node.dependsOn : [];
    for (const depId of deps) {
      const dep = String(depId || "").trim();
      if (!dep) continue;
      await sqliteExec(paths.dbPath, `INSERT OR IGNORE INTO deps(node_id, depends_on_id) VALUES(${sqlQuote(node.id)}, ${sqlQuote(dep)});\n`);
    }
  }

  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (!node?.id) continue;
    if (!beforeDepsSigById.has(node.id)) continue;
    const beforeSig = beforeDepsSigById.get(node.id) || "";
    const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
    const nextSig = deps.slice().sort().join("|");
    if (beforeSig === nextSig) continue;
    await sqliteExec(paths.dbPath, `DELETE FROM deps WHERE node_id=${sqlQuote(node.id)};\n`);
    for (const depId of deps) {
      const dep = String(depId || "").trim();
      if (!dep) continue;
      await sqliteExec(paths.dbPath, `INSERT OR IGNORE INTO deps(node_id, depends_on_id) VALUES(${sqlQuote(node.id)}, ${sqlQuote(dep)});\n`);
    }
    await sqliteExec(paths.dbPath, `UPDATE nodes SET updated_at=${sqlQuote(nowIso())} WHERE id=${sqlQuote(node.id)};\n`);
  }

  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (!node?.id) continue;
    if (!beforeInputsSigById.has(node.id)) continue;
    const beforeSig = beforeInputsSigById.get(node.id) || "[]";
    const nextSig = stableJsonSig(Array.isArray(node?.inputs) ? node.inputs : []);
    if (beforeSig === nextSig) continue;
    await sqliteExec(
      paths.dbPath,
      `UPDATE nodes SET inputs_json=${sqlQuote(nextSig)}, updated_at=${sqlQuote(nowIso())} WHERE id=${sqlQuote(node.id)};\n`,
    );
  }

  return scaffold;
}

async function answerNeedsHumanInteractiveDb({ paths, ui, abortSignal }) {
  const canPrompt = isPromptEnabled();
  if (!canPrompt) return false;
  if (abortSignal?.aborted) return false;

  const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
  const needsHuman = (graph.nodes || []).filter((n) => String(n?.status || "").toLowerCase() === "needs_human");
  if (needsHuman.length === 0) return false;

  let node = null;
  if (needsHuman.length === 1) {
    node = needsHuman[0];
  } else {
    while (true) {
      ui.writeLine(ui.hr("needs human"));
      for (let i = 0; i < needsHuman.length; i += 1) {
        const n = needsHuman[i];
        const q = n?.checkpoint?.question ? ui.truncate(n.checkpoint.question, 80) : "";
        ui.writeLine(`${String(i + 1).padStart(2, " ")}. ${n.id}${q ? ` — ${q}` : ""}`);
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const picked = (await rl.question("Pick a node number to answer (or 'q' to quit): ", { signal: abortSignal }))
          .trim()
          .toLowerCase();
        if (!picked || picked === "q" || picked === "quit") return false;
        const idx = Number(picked);
        if (!Number.isFinite(idx) || idx < 1 || idx > needsHuman.length) {
          ui.event("warn", "Invalid selection.");
          continue;
        }
        node = needsHuman[idx - 1];
        break;
      } finally {
        rl.close();
      }
    }
  }
  if (!node?.id) return false;

  const { checkpointPathAbs, checkpoint } = await resolveCheckpointForAnswer({ paths, graph, nodeId: node.id, checkpointFile: "" });
  const question = String(checkpoint?.question || "").trim();
  const context = String(checkpoint?.context || "").trim();
  const options = Array.isArray(checkpoint?.options) ? checkpoint.options.map((o) => String(o)) : [];

  ui.writeLine(ui.hr(`checkpoint ${node.id}`));
  if (question) ui.writeLine(question);
  if (context) ui.writeLine(`\n${context}`);
  if (options.length > 0) {
    ui.writeLine("\nOptions:");
    for (const opt of options) ui.writeLine(`- ${opt}`);
  }
  ui.detail(`checkpoint: ${path.relative(paths.rootDir, checkpointPathAbs)}`);
  ui.writeLine(ui.hr());

  let answer = "";
  while (true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      answer = (await rl.question("Your answer (or 'q' to quit): ", { signal: abortSignal })).trim();
    } finally {
      rl.close();
    }
    if (!answer) {
      ui.event("warn", "Answer was empty.");
      continue;
    }
    if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") return false;
    break;
  }

  const checkpointId = String(checkpoint?.id || "").trim() || deriveCheckpointIdFromPath(checkpointPathAbs);
  const responsePathAbs = path.join(paths.checkpointsDir, `response-${checkpointId}.json`);
  await writeJsonAtomic(responsePathAbs, {
    version: 1,
    checkpointId,
    nodeId: node.id,
    answeredAt: nowIso(),
    answer,
  });

  const checkpointMeta = {
    ...(typeof node.checkpoint === "object" && node.checkpoint ? node.checkpoint : {}),
    version: 1,
    runId: node?.checkpoint?.runId || null,
    path: path.relative(paths.rootDir, checkpointPathAbs),
    question: question || node?.checkpoint?.question || "",
    answeredAt: nowIso(),
    answer,
    responsePath: path.relative(paths.rootDir, responsePathAbs),
  };

  await sqliteExec(
    paths.dbPath,
    `UPDATE nodes\n` +
      `SET status='open',\n` +
      `    checkpoint_json=${sqlQuote(JSON.stringify(checkpointMeta))},\n` +
      `    lock_run_id=NULL,\n` +
      `    lock_started_at=NULL,\n` +
      `    lock_pid=NULL,\n` +
      `    lock_host=NULL,\n` +
      `    updated_at=${sqlQuote(nowIso())}\n` +
      `WHERE id=${sqlQuote(node.id)};\n`,
  );

  const refreshed = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
  await syncTaskPlan({ paths, graph: refreshed });

  const progressPath = path.join(paths.memoryDir, "progress.md");
  const lines = [];
  lines.push("");
  lines.push(`## [${nowIso()}] Answered checkpoint for ${node.id}`);
  if (question) lines.push(`- question: ${question}`);
  lines.push(`- answer: ${answer}`);
  lines.push(`- checkpoint: ${path.relative(paths.rootDir, checkpointPathAbs)}`);
  lines.push(`- response: ${path.relative(paths.rootDir, responsePathAbs)}`);
  await writeFile(progressPath, lines.join("\n") + "\n", { encoding: "utf8", flag: "a" });

  ui.event("done", `Reopened ${node.id}. Continuing...`);
  return true;
}

function clearStaleLocks(graph, staleSeconds) {
  const host = os.hostname();
  const shouldCheckAge = Number.isFinite(staleSeconds) && staleSeconds > 0;
  const now = Date.now();
  let changed = false;
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    const lock = node?.lock;
    if (!lock?.runId || !lock?.startedAt) continue;
    let stale = false;
    const pid = Number(lock.pid);
    const lockHost = typeof lock.host === "string" ? lock.host : "";
    if (Number.isFinite(pid) && pid > 0 && lockHost === host) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        // EPERM => process exists but we can't signal it; treat as alive.
        if (error?.code !== "EPERM") stale = true;
      }
    }
    if (!stale && shouldCheckAge) {
      const started = new Date(lock.startedAt).getTime();
      if (!Number.isNaN(started) && (now - started) / 1000 > staleSeconds) stale = true;
    }
    if (!stale) continue;
    node.lock = null;
    if (String(node.status || "").toLowerCase() === "in_progress") node.status = "open";
    node.updatedAt = nowIso();
    changed = true;
  }
  return changed;
}

async function executeNode({
  rootDir,
  paths,
  config,
  node,
  nodeCwd = null,
  run,
  activityPath,
  errorsPath,
  live = false,
  ui,
  abortSignal = null,
  serial = null,
  multiWorker = false,
}) {
  const consoleUi = ui || createUi({ noColor: false });
  const runnerCwd = typeof nodeCwd === "string" && nodeCwd.trim() ? nodeCwd : paths.rootDir;
  const spawnIdentity = await resolveSpawnIdentity({ rootDir: paths.rootDir });
  const identityEnv = envForIdentity(spawnIdentity);

  const now = nowIso();
  const claimed = await claimNode({
    dbPath: paths.dbPath,
    nodeId: node.id,
    runId: run,
    pid: process.pid,
    host: os.hostname(),
    nowIso: now,
  });
  if (!claimed) return;

  const syncAfterClaim = async () => {
    const graphAfterClaim = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
    await syncTaskPlan({ paths, graph: graphAfterClaim });
  };
  if (serial?.enqueue) await serial.enqueue(syncAfterClaim);
  else await syncAfterClaim();

  const runDir = path.join(paths.runsDir, run);
  await ensureDir(runDir);

  const role = resolveNodeRole(node);
  let runnerName = typeof node?.runner === "string" ? node.runner.trim() : "";
  if (!runnerName) {
    runnerName = resolveRoleRunnerPick(role, config, { seed: node.id, attempt: Number(node.attempts || 0) });
  }

  const claudeSensitiveFallback = String(config.supervisor?.claudeSensitiveFallbackRunner || "codex").trim() || "codex";
  if (runnerName === "claude" && claudeSensitiveFallback && claudeSensitiveFallback !== "claude") {
    const ownership = Array.isArray(node?.ownership) ? node.ownership : [];
    const touchesClaudeSensitive = ownership.some((p) => String(p || "").includes("/.claude/") || String(p || "").startsWith(".claude/"));
    const fallbackRunner = config.runners?.[claudeSensitiveFallback];
    if (touchesClaudeSensitive && fallbackRunner?.cmd) {
      consoleUi.event("info", `runner override: claude -> ${claudeSensitiveFallback} (sensitive path)`);
      runnerName = claudeSensitiveFallback;
    }
  }

  const runner = config.runners?.[runnerName];
  if (!runner?.cmd) {
    const handleMissingRunner = async () => {
      await appendLine(errorsPath, `[${nowIso()}] missing runner for role=${role} runner=${runnerName}`);
      await unlockNodeDb({ dbPath: paths.dbPath, nodeId: node.id, status: "open", nowIso: nowIso() });
      const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
      await syncTaskPlan({ paths, graph });
    };
    if (serial?.enqueue) await serial.enqueue(handleMissingRunner);
    else await handleMissingRunner();
    return;
  }

  const packetPath = path.join(runDir, "packet.md");
  const resultPath = path.join(runDir, "result.json");
  const stdoutPath = path.join(runDir, "stdout.log");
  const checkpointOutPath = path.join(paths.checkpointsDir, `checkpoint-${run}.json`);

  const packetMode = String(config?.supervisor?.packetMode || "full").toLowerCase().trim() || "full";
  const thinPacket = packetMode === "thin";
  const includePlanningDrafts = !thinPacket || role === "planner" || role === "finalVerifier";

  const goalDraftMax = thinPacket && role !== "planner" && role !== "finalVerifier" ? 4_000 : 20_000;
  const goalDraft = await readTextTruncated(paths.goalPath, goalDraftMax);
  const runMode = inferRunMode(goalDraft, config);
  const templateName =
    runMode === "analysis" && role === "integrator"
      ? "integrator-analysis"
      : runMode === "analysis" && role === "finalVerifier"
        ? "final-verifier-analysis"
        : role === "finalVerifier"
          ? "final-verifier"
          : role;
  const template = await resolveTemplate(rootDir, templateName);
  const taskPlanPath = path.join(paths.memoryDir, "task_plan.md");
  const findingsPath = path.join(paths.memoryDir, "findings.md");
  const progressPath = path.join(paths.memoryDir, "progress.md");
  const taskPlanDraft = includePlanningDrafts ? await readTextTruncated(taskPlanPath, 20_000) : "";
  const findingsDraft = includePlanningDrafts ? await readTextTruncated(findingsPath, 20_000) : "";
  const progressDraft = includePlanningDrafts ? await readTextTruncated(progressPath, 20_000) : "";
  const taskPlanPathForPacket = runnerCwd === paths.rootDir ? path.relative(paths.rootDir, taskPlanPath) : taskPlanPath;
  const findingsPathForPacket = runnerCwd === paths.rootDir ? path.relative(paths.rootDir, findingsPath) : findingsPath;
  const progressPathForPacket = runnerCwd === paths.rootDir ? path.relative(paths.rootDir, progressPath) : progressPath;
  const nodeResume = formatNodeResume(node);
  const nodeInputs = await formatNodeInputs({ dbPath: paths.dbPath, node });
  const packet = renderTemplate(template, {
    REPO_ROOT: runnerCwd,
    GOAL_PATH: paths.goalPath,
    RUN_ID: run,
    RUN_MODE: runMode,
    GOAL_DRAFT: goalDraft,
    TASK_PLAN_PATH: taskPlanPathForPacket,
    FINDINGS_PATH: findingsPathForPacket,
    PROGRESS_PATH: progressPathForPacket,
    TASK_PLAN_DRAFT: taskPlanDraft,
    FINDINGS_DRAFT: findingsDraft,
    PROGRESS_DRAFT: progressDraft,
    NODE_RESUME: nodeResume,
    NODE_INPUTS: nodeInputs,
    NODE_ID: node.id,
    NODE_TITLE: node.title || "",
    NODE_TYPE: node.type || "",
    NODE_ACCEPTANCE: formatBullets(Array.isArray(node.acceptance) ? node.acceptance : []),
    NODE_VERIFY: formatBullets((Array.isArray(node.verify) ? node.verify : []).map((v) => (typeof v === "string" ? v : JSON.stringify(v)))),
    NODE_OWNERSHIP: formatBullets(Array.isArray(node.ownership) ? node.ownership : []),
    RESULT_PATH: resultPath,
    CHECKPOINT_OUT_PATH: checkpointOutPath,
  });
  await writeFile(packetPath, packet, "utf8");

  await appendLine(activityPath, `[${nowIso()}] spawn role=${role} runner=${runnerName} node=${node.id} run=${run}`);
  consoleUi.event("spawn", `${role} runner=${runnerName} run=${run} node=${node.id}`);
  if (node.title) consoleUi.detail(node.title);
  consoleUi.detail(`log: ${stdoutPath}`);

  if (abortSignal?.aborted) {
    const handleCancelled = async () => {
      await appendLine(activityPath, `[${nowIso()}] cancelled node=${node.id} run=${run}`);
      await unlockNodeDb({ dbPath: paths.dbPath, nodeId: node.id, status: "open", nowIso: nowIso() });
      const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
      await syncTaskPlan({ paths, graph });
    };
    if (serial?.enqueue) await serial.enqueue(handleCancelled);
    else await handleCancelled();
    return;
  }

  const startedAtMs = Date.now();
  if (live) consoleUi.writeLine(consoleUi.hr(`runner ${runnerName}`));
  const spinner = !live && !multiWorker ? consoleUi.spinnerStart(`${role} ${node.id}`) : null;
  const liveLinePrefix = consoleUi.c.gray(multiWorker ? `│${node.id}│` : "│") + " ";
  const runnerEnv = mergeEnv(
    mergeEnv(resolveRunnerEnv({ runnerName, runner, cwd: runnerCwd, paths }), identityEnv),
    choreoRunnerEnv(paths, { nodeId: node.id, runId: run, runMode }),
  );
  await ensureRunnerTmpDir(runnerEnv);
  if (runnerName === "claude")
    await ensureClaudeProjectTmpWritable({ cwd: runnerCwd, ui: consoleUi, uid: spawnIdentity?.uid, gid: spawnIdentity?.gid });
  const execRes = await runRunnerCommand({
    cmd: runner.cmd,
    packetPath,
    cwd: runnerCwd,
    logPath: stdoutPath,
    timeoutMs: Number(runner.timeoutMs ?? config?.supervisor?.runnerTimeoutMs ?? 0),
    tee: Boolean(live),
    teePrefix: live ? { stdout: liveLinePrefix, stderr: liveLinePrefix } : null,
    abortSignal,
    env: runnerEnv,
    uid: spawnIdentity?.uid ?? null,
    gid: spawnIdentity?.gid ?? null,
  });
  spinner?.stop?.();
  if (live) consoleUi.writeLine(consoleUi.hr());
  const duration = consoleUi.formatDuration(Date.now() - startedAtMs);

  await appendLine(activityPath, `[${nowIso()}] exit code=${execRes.code} signal=${execRes.signal || ""} node=${node.id} run=${run}`);
  consoleUi.event(
    "exit",
    `${role} node=${node.id} code=${execRes.code}${execRes.signal ? ` signal=${execRes.signal}` : ""}${duration ? ` (${duration})` : ""}`,
  );

  if (execRes.aborted || abortSignal?.aborted) {
    const handleCancelled = async () => {
      await appendLine(activityPath, `[${nowIso()}] cancelled node=${node.id} run=${run}`);
      await unlockNodeDb({ dbPath: paths.dbPath, nodeId: node.id, status: "open", nowIso: nowIso() });
      const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
      await syncTaskPlan({ paths, graph });
    };
    if (serial?.enqueue) await serial.enqueue(handleCancelled);
    else await handleCancelled();
    return;
  }

  let result = await safeReadResult(resultPath);
  if (!result) {
    const stdoutText = await readTextTruncated(stdoutPath, 200_000);
    const extracted = extractResultJson(stdoutText);
    if (extracted) {
      result = extracted;
      await writeJsonAtomic(resultPath, result);
    }
  }
  if (!result) {
    await appendLine(errorsPath, `[${nowIso()}] missing/invalid result.json node=${node.id} run=${run} cmd=${execRes.cmd}`);
    result = { status: "fail", summary: "Missing/invalid result.json", next: { addNodes: [], setStatus: [] }, checkpoint: null, errors: [] };
  }

  if (String(result?.status || "").toLowerCase() === "checkpoint") {
    const checkpointExisting = await safeReadJson(checkpointOutPath);
    if (!checkpointExisting) {
      const checkpoint = buildCheckpointFromResult(result, run);
      if (checkpoint) await writeJsonAtomic(checkpointOutPath, checkpoint);
    }
    const checkpoint = await safeReadJson(checkpointOutPath);
    const question = String(checkpoint?.question || "").trim();
    const checkpointMeta = {
      version: 1,
      runId: run,
      path: path.relative(paths.rootDir, checkpointOutPath),
      question,
      createdAt: nowIso(),
      answeredAt: null,
      answer: null,
    };
    result = { ...result, checkpoint: checkpointMeta };
    consoleUi.event("checkpoint", `${node.id}${question ? ` — ${consoleUi.truncate(question, 160)}` : ""}`);
    consoleUi.detail(`checkpoint: ${checkpointOutPath}`);
  }

  const finalStatus = String(result?.status || "").toLowerCase();
  if (finalStatus === "success") await appendLine(activityPath, `[${nowIso()}] done node=${node.id}`);
  else if (finalStatus === "checkpoint") await appendLine(activityPath, `[${nowIso()}] checkpoint node=${node.id}`);
  else await appendLine(errorsPath, `[${nowIso()}] fail node=${node.id}`);

  const applyOutcome = async () => {
    const attempt = Number(node?.attempts || 0) + 1;
    const summary = typeof result?.summary === "string" ? result.summary : "";
    const stdoutRel = path.relative(paths.rootDir, stdoutPath);
    const resultRel = path.relative(paths.rootDir, resultPath);
    const errSummary =
      finalStatus === "success"
        ? ""
        : summary.trim() ||
          (Array.isArray(result?.errors) && result.errors.length > 0
            ? String(result.errors[0] || "").trim()
            : "");

    await kvPut({ dbPath: paths.dbPath, nodeId: node.id, key: "out.summary", valueText: summary, runId: run, attempt, nowIso: nowIso() });
    await kvPut({
      dbPath: paths.dbPath,
      nodeId: node.id,
      key: "out.last_stdout_path",
      valueText: stdoutRel,
      runId: run,
      attempt,
      nowIso: nowIso(),
    });
    await kvPut({
      dbPath: paths.dbPath,
      nodeId: node.id,
      key: "out.last_result_path",
      valueText: resultRel,
      runId: run,
      attempt,
      nowIso: nowIso(),
    });
    if (errSummary) {
      await kvPut({ dbPath: paths.dbPath, nodeId: node.id, key: "err.summary", valueText: errSummary, runId: run, attempt, nowIso: nowIso() });
    }

    const defaultRetryPolicy = resolveDefaultRetryPolicy(config);
    await applyResultDb({
      dbPath: paths.dbPath,
      nodeId: node.id,
      runId: run,
      result,
      nowIso: nowIso(),
      defaultRetryPolicy,
    });
    const graphAfter = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
    await syncTaskPlan({ paths, graph: graphAfter });
    await appendProgress({ paths, node, run, role, runnerName, result, stdoutPath });
  };
  if (serial?.enqueue) await serial.enqueue(applyOutcome);
  else await applyOutcome();

  const summary = consoleUi.truncate(result?.summary || "", 180);
  if (finalStatus === "success") {
    consoleUi.event("done", `${node.id}${duration ? ` (${duration})` : ""}${summary ? ` — ${summary}` : ""}`);
  } else if (finalStatus !== "checkpoint") {
    consoleUi.event("fail", `${node.id}${duration ? ` (${duration})` : ""}${summary ? ` — ${summary}` : ""}`);
  }
}

function createSerialQueue() {
  let chain = Promise.resolve();
  return {
    enqueue: (fn) => {
      const next = chain.then(fn);
      chain = next.catch(() => {});
      return next;
    },
  };
}

function formatNodeResume(node) {
  const cp = node?.checkpoint && typeof node.checkpoint === "object" ? node.checkpoint : null;
  const question = String(cp?.question || "").trim();
  const answer = String(cp?.answer || "").trim();
  const responsePath = String(cp?.responsePath || "").trim();
  const askedRunId = String(cp?.runId || "").trim();
  const askedPath = String(cp?.path || "").trim();
  if (!question && !answer && !askedRunId && !askedPath) return "- (none)";
  const lines = [];
  if (askedRunId) lines.push(`- checkpoint run: ${askedRunId}`);
  if (askedPath) lines.push(`- checkpoint file: ${askedPath}`);
  if (question) lines.push(`- question: ${question}`);
  if (answer) lines.push(`- answer: ${answer}`);
  if (responsePath) lines.push(`- response file: ${responsePath}`);
  return lines.join("\n");
}

function normalizeNodeInputSpec(value, { defaultNodeId }) {
  if (typeof value === "string") {
    const key = value.trim();
    if (!key) return null;
    return { nodeId: defaultNodeId, key, as: "" };
  }
  if (!value || typeof value !== "object") return null;
  const nodeIdRaw = typeof value.nodeId === "string" ? value.nodeId : typeof value.node_id === "string" ? value.node_id : "";
  const keyRaw = typeof value.key === "string" ? value.key : "";
  const asRaw = typeof value.as === "string" ? value.as : typeof value.alias === "string" ? value.alias : "";
  const nodeId = String(nodeIdRaw || "").trim() || defaultNodeId;
  const key = String(keyRaw || "").trim();
  const as = String(asRaw || "").trim();
  if (!nodeId || !key) return null;
  return { nodeId, key, as };
}

function formatNodeInputPreview(valueText, { maxChars = 2000 } = {}) {
  const n = Number(maxChars);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
  const normalized = String(valueText || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return normalized.slice(0, Math.max(0, limit - 1)) + "…";
}

async function formatNodeInputs({ dbPath, node }) {
  const specsRaw = node?.inputs ?? [];
  const specs = Array.isArray(specsRaw) ? specsRaw : [];
  if (!dbPath) return "- (none)";
  if (!node?.id) return "- (none)";
  if (specs.length === 0) return "- (none)";

  const out = [];
  for (const specRaw of specs) {
    const spec = normalizeNodeInputSpec(specRaw, { defaultNodeId: node.id });
    if (!spec) continue;
    const label = spec.as || spec.key;
    const ref = `${spec.nodeId}:${spec.key}`;
    let preview = "";
    try {
      const row = await kvGet({ dbPath, nodeId: spec.nodeId, key: spec.key });
      if (row && typeof row.value_text === "string") preview = formatNodeInputPreview(row.value_text);
      if (preview && preview.length > 0) {
        out.push(`- ${label}: ${ref} — ${preview}`);
      } else {
        out.push(`- ${label}: ${ref}`);
      }
      if (row && typeof row.artifact_path === "string" && row.artifact_path.trim()) {
        out.push(`  - artifact: ${row.artifact_path.trim()}`);
      }
    } catch {
      out.push(`- ${label}: ${ref}`);
    }
  }

  return out.length > 0 ? out.join("\n") : "- (none)";
}

function stableCountsSig(counts) {
  const keys = Object.keys(counts || {}).sort();
  return keys.map((k) => `${k}:${counts[k]}`).join("|");
}

function normalizeNodeType(value) {
  return String(value || "").toLowerCase().trim();
}

function sanitizeNodeIdPart(value) {
  const s = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "x";
}

function ensureUniqueNodeId(base, existingIds) {
  const baseId = String(base || "").trim();
  if (!baseId) return "";
  if (!existingIds.has(baseId)) return baseId;
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${baseId}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${baseId}-${Date.now()}`;
}

function listTaskNodes(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return nodes.filter((n) => normalizeNodeType(n?.type) === "task");
}

function listMergeNodes(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return nodes.filter((n) => normalizeNodeType(n?.type) === "merge");
}

function listVerifyNodes(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return nodes.filter((n) => normalizeNodeType(n?.type) === "verify");
}

function listIntegrateNodes(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return nodes.filter((n) => normalizeNodeType(n?.type) === "integrate");
}

function listFinalVerifyNodes(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return nodes.filter((n) => {
    const t = normalizeNodeType(n?.type);
    return t === "final_verify" || t === "final-verify";
  });
}

function unionOwnership(nodes) {
  const out = [];
  const seen = new Set();
  for (const node of nodes) {
    const ownership = Array.isArray(node?.ownership) ? node.ownership : [];
    for (const item of ownership) {
      const v = String(item || "").trim();
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function ensurePlannerScaffolding({ graph, config }) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const ids = new Set(nodes.map((n) => n.id).filter(Boolean));
  const now = nowIso();
  const addedIds = [];
  let updated = false;

  const tasks = listTaskNodes(graph);
  if (tasks.length === 0) return { addedIds, updated };
  const mergeNodes = listMergeNodes(graph);
  const verifyNodes = listVerifyNodes(graph);

  const configuredMaxAttempts = normalizeMaxAttempts(config?.defaults?.retryPolicy?.maxAttempts);
  const verifyMaxAttempts = configuredMaxAttempts ?? 2;
  const integrateMaxAttempts = configuredMaxAttempts ?? 2;

  const defaultVerifyRunner = String(config?.defaults?.verifyRunner || "").trim();
  const defaultMergeRunner = String(config?.defaults?.mergeRunner || "shellMerge").trim();

  const verifierRunners = [...new Set(normalizeRunnerList(config?.roles?.verifier ?? config?.roles?.main ?? []))];
  const multiVerifier = String(config?.supervisor?.multiVerifier || "one").toLowerCase().trim() === "all";

  const worktreeMode = normalizeWorktreeMode(config?.supervisor?.worktrees?.mode);
  const mergeByTaskId = new Map();
  for (const mergeNode of mergeNodes) {
    if (!mergeNode?.id) continue;
    const deps = Array.isArray(mergeNode?.dependsOn) ? mergeNode.dependsOn : [];
    if (deps.length !== 1) continue;
    const taskId = String(deps[0] || "").trim();
    if (!taskId) continue;
    if (!mergeByTaskId.has(taskId)) mergeByTaskId.set(taskId, mergeNode);
  }

  if (worktreeMode === "always") {
    for (const task of tasks) {
      if (!task?.id) continue;
      if (mergeByTaskId.has(task.id)) continue;

      const baseId = `merge-${task.id}`;
      const id = ensureUniqueNodeId(baseId, ids);
      ids.add(id);

      const mergeNode = {
        id,
        title: `Merge: ${task.title || task.id}`,
        type: "merge",
        status: "open",
        dependsOn: [task.id],
        ...(defaultMergeRunner ? { runner: defaultMergeRunner } : {}),
        ownership: ["__global__"],
        acceptance: ["Applies the task worktree changes back to the root workspace"],
        verify: [],
        attempts: 0,
        retryPolicy: { maxAttempts: integrateMaxAttempts },
        createdAt: now,
        updatedAt: now,
      };
      nodes.push(mergeNode);
      addedIds.push(id);
      updated = true;
      mergeByTaskId.set(task.id, mergeNode);
    }
  }

  for (const task of tasks) {
    if (!task?.id) continue;
    const mergeNode = mergeByTaskId.get(task.id) || null;
    const verifyDepId = mergeNode?.id ? mergeNode.id : task.id;
    const existing = verifyNodes.filter(
      (v) => Array.isArray(v?.dependsOn) && v.dependsOn.some((d) => d === task.id || d === verifyDepId),
    );

    if (multiVerifier && verifierRunners.length > 0) {
      for (const runnerName of verifierRunners) {
        const hasRunner = existing.some((v) => String(v?.runner || "").trim() === runnerName);
        if (hasRunner) {
          for (const v of existing) {
            if (String(v?.runner || "").trim() !== runnerName) continue;
            const deps = Array.isArray(v?.dependsOn) ? v.dependsOn.map(String) : [];
            if (deps.length === 1 && deps[0] === verifyDepId) continue;
            v.dependsOn = [verifyDepId];
            v.updatedAt = now;
            updated = true;
          }
          continue;
        }

        const baseId = `verify-${task.id}-${sanitizeNodeIdPart(runnerName)}`;
        const id = ensureUniqueNodeId(baseId, ids);
        ids.add(id);

        nodes.push({
          id,
          title: `Verify (${runnerName}): ${task.title || task.id}`,
          type: "verify",
          status: "open",
          dependsOn: [verifyDepId],
          runner: runnerName,
          ownership: Array.isArray(task.ownership) ? task.ownership : [],
          acceptance: Array.isArray(task.acceptance) ? task.acceptance : [],
          verify: Array.isArray(task.verify) ? task.verify : [],
          attempts: 0,
          retryPolicy: { maxAttempts: verifyMaxAttempts },
          createdAt: now,
          updatedAt: now,
        });
        addedIds.push(id);
        updated = true;
      }
      continue;
    }

    if (existing.length > 0) {
      for (const v of existing) {
        const deps = Array.isArray(v?.dependsOn) ? v.dependsOn.map(String) : [];
        if (deps.length === 1 && deps[0] === verifyDepId) continue;
        v.dependsOn = [verifyDepId];
        v.updatedAt = now;
        updated = true;
      }
      continue;
    }
    const baseId = `verify-${task.id}`;
    const id = ensureUniqueNodeId(baseId, ids);
    ids.add(id);

    nodes.push({
      id,
      title: `Verify: ${task.title || task.id}`,
      type: "verify",
      status: "open",
      dependsOn: [verifyDepId],
      ...(defaultVerifyRunner ? { runner: defaultVerifyRunner } : {}),
      ownership: Array.isArray(task.ownership) ? task.ownership : [],
      acceptance: Array.isArray(task.acceptance) ? task.acceptance : [],
      verify: Array.isArray(task.verify) ? task.verify : [],
      attempts: 0,
      retryPolicy: { maxAttempts: verifyMaxAttempts },
      createdAt: now,
      updatedAt: now,
    });
    addedIds.push(id);
    updated = true;
  }

  const integrates = listIntegrateNodes(graph);
  const integrateNode = integrates[0] || null;
  let integrateId = integrateNode?.id || "";
  if (!integrateId) {
    const gateIds = new Set(
      tasks
        .map((t) => mergeByTaskId.get(t.id)?.id || t.id)
        .map((v) => String(v || "").trim())
        .filter(Boolean),
    );
    const verifyIds = listVerifyNodes(graph)
      .filter((n) => Array.isArray(n?.dependsOn) && n.dependsOn.some((d) => gateIds.has(d)))
      .map((n) => n.id)
      .filter(Boolean);
    const deps = verifyIds.length > 0 ? verifyIds : [...gateIds];
    const taskInputs = tasks
      .map((t) => String(t?.id || "").trim())
      .filter(Boolean)
      .sort()
      .map((taskId) => ({ nodeId: taskId, key: "out.summary", as: `${taskId}.summary` }));
    const verifyInputs = verifyIds
      .slice()
      .sort()
      .map((verifyId) => ({ nodeId: verifyId, key: "out.summary", as: `${verifyId}.summary` }));
    const inputs = [...taskInputs, ...verifyInputs];
    const id = ensureUniqueNodeId("integrate-000", ids);
    ids.add(id);
    integrateId = id;

    nodes.push({
      id,
      title: "Integrate changes and resolve cross-cutting issues",
      type: "integrate",
      status: "open",
      dependsOn: deps,
      inputs,
      ownership: unionOwnership(tasks),
      acceptance: ["Integrates changes and ensures the repo is in a consistent, buildable state"],
      verify: [],
      attempts: 0,
      retryPolicy: { maxAttempts: integrateMaxAttempts },
      createdAt: now,
      updatedAt: now,
    });
    addedIds.push(id);
    updated = true;
  } else if (normalizeStatus(integrateNode?.status) === "open") {
    const gateIds = new Set(
      tasks
        .map((t) => mergeByTaskId.get(t.id)?.id || t.id)
        .map((v) => String(v || "").trim())
        .filter(Boolean),
    );
    const verifyIds = listVerifyNodes(graph)
      .filter((n) => Array.isArray(n?.dependsOn) && n.dependsOn.some((d) => gateIds.has(d)))
      .map((n) => n.id)
      .filter(Boolean);
    const deps = verifyIds.length > 0 ? verifyIds : [...gateIds];
    const taskInputs = tasks
      .map((t) => String(t?.id || "").trim())
      .filter(Boolean)
      .sort()
      .map((taskId) => ({ nodeId: taskId, key: "out.summary", as: `${taskId}.summary` }));
    const verifyInputs = verifyIds
      .slice()
      .sort()
      .map((verifyId) => ({ nodeId: verifyId, key: "out.summary", as: `${verifyId}.summary` }));
    const desiredInputsSig = stableJsonSig([...taskInputs, ...verifyInputs]);
    const currentInputsSig = stableJsonSig(Array.isArray(integrateNode?.inputs) ? integrateNode.inputs : []);
    const currentDeps = Array.isArray(integrateNode?.dependsOn) ? integrateNode.dependsOn.map(String) : [];
    const desiredSig = deps.slice().sort().join("|");
    const currentSig = currentDeps.slice().sort().join("|");
    if (desiredSig !== currentSig || desiredInputsSig !== currentInputsSig) {
      integrateNode.dependsOn = deps;
      integrateNode.inputs = JSON.parse(desiredInputsSig);
      integrateNode.updatedAt = now;
      updated = true;
    }
  }

  const finals = listFinalVerifyNodes(graph);
  if (finals.length === 0) {
    const id = ensureUniqueNodeId("final-verify-000", ids);
    ids.add(id);
    nodes.push({
      id,
      title: "Final verification against GOAL.md",
      type: "final_verify",
      status: "open",
      dependsOn: integrateId ? [integrateId] : [],
      inputs: integrateId ? [{ nodeId: integrateId, key: "out.summary", as: "integrate.summary" }] : [],
      ownership: [],
      acceptance: ["All work is complete and verified against GOAL.md"],
      verify: [],
      attempts: 0,
      retryPolicy: { maxAttempts: 1 },
      createdAt: now,
      updatedAt: now,
    });
    addedIds.push(id);
    updated = true;
  } else {
    const finalNode = finals[0];
    if (finalNode && normalizeStatus(finalNode.status) === "open") {
      const desiredDeps = integrateId ? [integrateId] : [];
      const currentDeps = Array.isArray(finalNode.dependsOn) ? finalNode.dependsOn.map(String) : [];
      const desiredDepsSig = desiredDeps.slice().sort().join("|");
      const currentDepsSig = currentDeps.slice().sort().join("|");
      const desiredInputs = integrateId ? [{ nodeId: integrateId, key: "out.summary", as: "integrate.summary" }] : [];
      const desiredInputsSig = stableJsonSig(desiredInputs);
      const currentInputsSig = stableJsonSig(Array.isArray(finalNode.inputs) ? finalNode.inputs : []);
      if (desiredDepsSig !== currentDepsSig || desiredInputsSig !== currentInputsSig) {
        finalNode.dependsOn = desiredDeps;
        finalNode.inputs = JSON.parse(desiredInputsSig);
        finalNode.updatedAt = now;
        updated = true;
      }
    }
  }

  if (updated) graph.nodes = nodes;
  return { addedIds, updated };
}

async function safeReadResult(resultPath) {
  try {
    return await readJson(resultPath);
  } catch {
    return null;
  }
}

async function applyResult({ graph, node, result, activityPath, errorsPath }) {
  const status = String(result?.status || "").toLowerCase();
  if (status === "success") {
    node.status = "done";
    node.lock = null;
    node.completedAt = nowIso();
    await appendLine(activityPath, `[${nowIso()}] done node=${node.id}`);
  } else if (status === "checkpoint") {
    node.status = "needs_human";
    node.lock = null;
    await appendLine(activityPath, `[${nowIso()}] checkpoint node=${node.id}`);
  } else {
    node.attempts = Number(node.attempts || 0) + 1;
    const maxAttempts = node.retryPolicy?.maxAttempts || 3;
    node.status = node.attempts >= maxAttempts ? "failed" : "open";
    node.lock = null;
    await appendLine(errorsPath, `[${nowIso()}] fail node=${node.id} attempts=${node.attempts}/${maxAttempts}`);
  }

  const addNodes = result?.next?.addNodes;
  if (Array.isArray(addNodes) && addNodes.length > 0) {
    const existing = new Set(graph.nodes.map((n) => n.id));
    for (const n of addNodes) {
      if (!n || typeof n !== "object") continue;
      if (!n.id || typeof n.id !== "string") continue;
      if (existing.has(n.id)) continue;
      n.status = n.status || "open";
      n.createdAt = n.createdAt || nowIso();
      graph.nodes.push(n);
      existing.add(n.id);
    }
  }
}

function sleep(ms, abortSignal) {
  const n = Number(ms);
  const duration = Number.isFinite(n) && n >= 0 ? n : 0;
  if (!abortSignal) return new Promise((resolve) => setTimeout(resolve, duration));
  if (abortSignal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    const id = setTimeout(() => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve();
    }, duration);
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

function installCancellation({ ui, label }) {
  const controller = new AbortController();
  let requested = false;

  function exitCodeFor(sig) {
    if (sig === "SIGINT") return 130;
    if (sig === "SIGTERM") return 143;
    return 1;
  }

  const handler = (sig) => {
    const signalName = typeof sig === "string" ? sig : "SIGINT";
    const code = exitCodeFor(signalName);
    if (!requested) {
      requested = true;
      process.exitCode = process.exitCode || code;
      ui?.event?.("warn", `Cancel requested (${signalName})${label ? ` [${label}]` : ""}. Press again to force.`);
      controller.abort(signalName);
      return;
    }
    ui?.event?.("warn", `Force exit (${signalName}).`);
    process.exit(code);
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);

  return {
    signal: controller.signal,
    cleanup: () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    },
  };
}

async function runChatMicrocall({ rootDir, paths, config, prompt, runnerName, role }) {
  const runnerNameFlag = typeof runnerName === "string" ? runnerName.trim() : "";
  const resolvedRole = typeof role === "string" && role.trim() ? role.trim() : "researcher";
  const pickedRunnerName = runnerNameFlag || resolveRoleRunnerPick(resolvedRole, config, { seed: prompt, attempt: 0 });
  const runner = config.runners?.[pickedRunnerName];
  if (!runner?.cmd) throw new Error(`Unknown runner: ${pickedRunnerName}`);

  const microId = `chat-${runId()}`;
  const microcallsBaseDir = path.join(paths.choreoDir, "microcalls");
  const microDir = path.join(microcallsBaseDir, microId);
  await ensureDir(microDir);

  const packetPath = path.join(microDir, "packet.md");
  const stdoutPath = path.join(microDir, "stdout.log");
  const resultPath = path.join(microDir, "result.json");

  const template = await resolveTemplate(rootDir, "microcall");
  const packet = renderTemplate(template, {
    REPO_ROOT: paths.rootDir,
    MICROCALL_PROMPT: prompt,
  });
  await writeFile(packetPath, packet, "utf8");

  const spawnIdentity = await resolveSpawnIdentity({ rootDir: paths.rootDir });
  const identityEnv = envForIdentity(spawnIdentity);
  const runnerEnv = mergeEnv(resolveRunnerEnv({ runnerName: pickedRunnerName, runner, cwd: paths.rootDir, paths }), identityEnv);
  await ensureRunnerTmpDir(runnerEnv);
  if (pickedRunnerName === "claude")
    await ensureClaudeProjectTmpWritable({ cwd: paths.rootDir, uid: spawnIdentity?.uid ?? null, gid: spawnIdentity?.gid ?? null });

  const execRes = await runRunnerCommand({
    cmd: runner.cmd,
    packetPath,
    cwd: paths.rootDir,
    logPath: stdoutPath,
    timeoutMs: Number(runner.timeoutMs ?? 0),
    env: runnerEnv,
    uid: spawnIdentity?.uid ?? null,
    gid: spawnIdentity?.gid ?? null,
  });

  const stdoutText = await readFile(stdoutPath, "utf8").catch(() => "");
  const parsed = extractResultJson(stdoutText);
  if (!parsed) {
    const code = typeof execRes.code === "number" ? execRes.code : null;
    const sig = execRes.signal ? String(execRes.signal) : "";
    throw new Error(`Could not extract result JSON from chat microcall output${code ? ` (code=${code})` : ""}${sig ? ` (signal=${sig})` : ""}.`);
  }

  await writeJsonAtomic(resultPath, parsed);
  return parsed;
}

async function startSupervisorDetached({ rootDir, flags }) {
  const paths = choreoPaths(rootDir);
  const lock = await readSupervisorLock(paths.lockPath);
  if (lock?.pid && String(lock.host || "").trim() === os.hostname()) {
    process.stdout.write(`Supervisor already running pid=${lock.pid}.\n`);
    return;
  }
  const choreoBin = fileURLToPath(new URL("../bin/choreo.js", import.meta.url));
  const args = [choreoBin, "run", "--no-live", "--no-color"];
  const child = spawn(process.execPath, args, {
    cwd: paths.rootDir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.unref?.();
  process.stdout.write(`Started supervisor pid=${child.pid}\n`);
}

async function chatCommand(rootDir, flags) {
  const paths = choreoPaths(rootDir);
  if (!(await pathExists(paths.dbPath))) throw new Error("Missing .dagain/state.sqlite. Run `dagain init`.");
  const config = await loadConfig(paths.configPath);
  if (!config) throw new Error("Missing .dagain/config.json. Run `dagain init`.");
  process.stdout.write("dagain chat (type /help)\n");
  const noLlm = Boolean(flags["no-llm"]) || Boolean(flags.noLlm);
  const runnerOverride = typeof flags.runner === "string" ? flags.runner.trim() : "";
  const roleOverride = typeof flags.role === "string" ? flags.role.trim() : "planner";

  function truncateText(value, maxLen) {
    const s = String(value || "");
    const n = Number(maxLen);
    const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if (!limit) return "";
    if (s.length <= limit) return s;
    return s.slice(0, Math.max(0, limit - 1)) + "…";
  }

  function safeJsonParse(text) {
    const s = typeof text === "string" ? text.trim() : "";
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("dagain> ");
  rl.prompt();
  try {
    for await (const lineRaw of rl) {
      const line = String(lineRaw || "").trim();
      if (!line) {
        rl.prompt();
        continue;
      }
      if (line === "/exit" || line === "/quit") break;
      if (line === "/help") {
        process.stdout.write(
          "Commands:\n" +
            "- /status\n" +
            "- /run\n" +
            "- /stop\n" +
            "- /pause\n" +
            "- /resume\n" +
            "- /workers <n>\n" +
            "- /replan\n" +
            "- /cancel <nodeId>\n" +
            "- /memory\n" +
            "- /forget\n" +
            "- /exit\n",
        );
        rl.prompt();
        continue;
      }
      if (line === "/status") {
        await statusCommand(rootDir);
        rl.prompt();
        continue;
      }
      if (line === "/run") {
        await startSupervisorDetached({ rootDir, flags });
        rl.prompt();
        continue;
      }
      if (line === "/stop") {
        await stopCommand(rootDir, flags);
        rl.prompt();
        continue;
      }
      if (line === "/pause") {
        try {
          await controlCommand(rootDir, ["pause"], {});
        } catch (error) {
          process.stdout.write(`Chat error: ${error?.message || String(error)}\n`);
        }
        rl.prompt();
        continue;
      }
      if (line === "/resume") {
        try {
          await controlCommand(rootDir, ["resume"], {});
        } catch (error) {
          process.stdout.write(`Chat error: ${error?.message || String(error)}\n`);
        }
        rl.prompt();
        continue;
      }
      if (line.startsWith("/workers")) {
        const parts = line.split(/\s+/).filter(Boolean);
        const n = parts[1] || "";
        try {
          await controlCommand(rootDir, ["set-workers"], { workers: n });
        } catch (error) {
          process.stdout.write(`Chat error: ${error?.message || String(error)}\n`);
        }
        rl.prompt();
        continue;
      }
      if (line === "/replan") {
        try {
          await controlCommand(rootDir, ["replan"], {});
        } catch (error) {
          process.stdout.write(`Chat error: ${error?.message || String(error)}\n`);
        }
        rl.prompt();
        continue;
      }
      if (line.startsWith("/cancel")) {
        const parts = line.split(/\s+/).filter(Boolean);
        const nodeId = parts[1] || "";
        try {
          await controlCommand(rootDir, ["cancel"], { node: nodeId });
        } catch (error) {
          process.stdout.write(`Chat error: ${error?.message || String(error)}\n`);
        }
        rl.prompt();
        continue;
      }
      if (line === "/memory") {
        try {
          const chatNodeId = "__run__";
          const chatRollupRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.rollup" }).catch(() => null);
          const chatSummaryRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.summary" }).catch(() => null);
          const chatLastOpsRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.last_ops" }).catch(() => null);
          const chatTurnsRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.turns" }).catch(() => null);
          const rollup = typeof chatRollupRow?.value_text === "string" ? chatRollupRow.value_text.trim() : "";
          const summary = typeof chatSummaryRow?.value_text === "string" ? chatSummaryRow.value_text.trim() : "";
          const lastOpsTextRaw = typeof chatLastOpsRow?.value_text === "string" ? chatLastOpsRow.value_text.trim() : "";
          const lastOpsText = lastOpsTextRaw === "[]" ? "" : lastOpsTextRaw;
          const turnsText = typeof chatTurnsRow?.value_text === "string" ? chatTurnsRow.value_text.trim() : "";
          const turnsParsed = safeJsonParse(turnsText);
          const turns = Array.isArray(turnsParsed) ? turnsParsed : [];
          const hasTurns = turns.length > 0;

          if (!rollup && !summary && !lastOpsText && !hasTurns) {
            process.stdout.write("Chat memory: (empty)\n");
          } else {
            if (rollup) process.stdout.write(`rolling_summary: ${rollup}\n`);
            if (summary) process.stdout.write(`summary: ${summary}\n`);
            if (lastOpsText) process.stdout.write(`last_ops: ${lastOpsText}\n`);
            if (hasTurns) process.stdout.write(`turns: ${turns.length}\n`);
          }
        } catch (error) {
          process.stdout.write(`Chat error: ${error?.message || String(error)}\n`);
        }
        rl.prompt();
        continue;
      }
      if (line === "/forget") {
        try {
          const chatNodeId = "__run__";
          const now = nowIso();
          await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.rollup", valueText: "", nowIso: now });
          await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.summary", valueText: "", nowIso: now });
          await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.last_ops", valueText: "", nowIso: now });
          await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.turns", valueText: "[]", nowIso: now });
          process.stdout.write("Cleared chat memory.\n");
        } catch (error) {
          process.stdout.write(`Chat error: ${error?.message || String(error)}\n`);
        }
        rl.prompt();
        continue;
      }
      if (!line.startsWith("/") && /^pause(\s+launching)?$/i.test(line)) {
        try {
          await controlCommand(rootDir, ["pause"], {});
        } catch (error) {
          process.stdout.write(`Chat error: ${error?.message || String(error)}\n`);
        }
        rl.prompt();
        continue;
      }
      if (!line.startsWith("/")) {
        if (noLlm) {
          process.stdout.write("LLM disabled. Use /help or /status.\n");
          rl.prompt();
          continue;
        }
        try {
          const counts = await countByStatusDb({ dbPath: paths.dbPath });
          const next = await selectNextRunnableNode({ dbPath: paths.dbPath, nowIso: nowIso() });
          const nodeLines = (await listNodes({ dbPath: paths.dbPath }))
            .map((n) => formatNodeLine(n))
            .slice(0, 40)
            .join("\n");
          const activityPath = path.join(paths.memoryDir, "activity.log");
          const recent = await readTextTruncated(activityPath, 4_000);

          const chatNodeId = "__run__";
          const chatRollupRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.rollup" }).catch(() => null);
          const chatSummaryRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.summary" }).catch(() => null);
          const chatLastOpsRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.last_ops" }).catch(() => null);
          const chatTurnsRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.turns" }).catch(() => null);

          const chatRollup = typeof chatRollupRow?.value_text === "string" ? chatRollupRow.value_text.trim() : "";
          const chatSummary = typeof chatSummaryRow?.value_text === "string" ? chatSummaryRow.value_text.trim() : "";
          const chatLastOpsText = typeof chatLastOpsRow?.value_text === "string" ? chatLastOpsRow.value_text.trim() : "";
          const chatTurnsParsed = safeJsonParse(typeof chatTurnsRow?.value_text === "string" ? chatTurnsRow.value_text : "");
          const chatTurns = Array.isArray(chatTurnsParsed) ? chatTurnsParsed : [];

          let memorySection = "";
          if (chatRollup || chatSummary || chatLastOpsText || chatTurns.length > 0) {
            const lines = [];
            lines.push("Chat memory (kv __run__):");
            if (chatRollup) lines.push(`- rolling_summary: ${truncateText(chatRollup, 800)}`);
            if (chatSummary) lines.push(`- summary: ${truncateText(chatSummary, 400)}`);
            if (chatLastOpsText) lines.push(`- last_ops: ${truncateText(chatLastOpsText, 800)}`);
            if (chatTurns.length > 0) {
              lines.push("- recent turns:");
              const recentTurns = chatTurns.slice(Math.max(0, chatTurns.length - 6));
              for (const t of recentTurns) {
                const u = truncateText(t?.user || "", 200);
                const a = truncateText(t?.reply || "", 200);
                if (u) lines.push(`  - user: ${u}`);
                if (a) lines.push(`    assistant: ${a}`);
              }
            }
            memorySection = lines.join("\n");
          }

	          const prompt =
	            `You are Choreo Chat Router.\n` +
	            `Return JSON in <result> with {status, summary, data:{reply, ops, rollup}}.\n` +
	            `Allowed ops:\n` +
	            `- {"type":"status"}\n` +
            `- {"type":"control.pause"}\n` +
            `- {"type":"control.resume"}\n` +
            `- {"type":"control.setWorkers","workers":3}\n` +
            `- {"type":"control.replan"}\n` +
            `- {"type":"control.cancel","nodeId":"task-001"}\n` +
            `- {"type":"node.add","id":"task-001","title":"...","nodeType":"task","parentId":"plan-000","status":"open","runner":null,"inputs":[{"nodeId":"task-000","key":"out.summary"}],"ownership":[{"resources":["__global__"],"mode":"read"}],"acceptance":["..."],"verify":["..."],"retryPolicy":{"maxAttempts":2},"dependsOn":["task-000"]}\n` +
            `- {"type":"node.update","id":"task-001","title":"...","runner":null,"inputs":[],"ownership":[],"acceptance":[],"verify":[],"retryPolicy":{"maxAttempts":2},"force":false}\n` +
            `- {"type":"node.setStatus","id":"task-001","status":"open|done|failed|needs_human","force":false}\n` +
            `- {"type":"dep.add","nodeId":"task-002","dependsOnId":"task-001","requiredStatus":"done|terminal"}\n` +
            `- {"type":"dep.remove","nodeId":"task-002","dependsOnId":"task-001"}\n` +
            `- {"type":"run.start"}\n` +
            `- {"type":"run.stop","signal":"SIGTERM"}\n` +
	            `Rules:\n` +
	            `- Do not tell the user to run CLI commands; emit ops and Choreo will execute them.\n` +
	            `- Use control.* ops for supervisor controls (pause/resume/workers/replan/cancel).\n` +
	            `- Always include data.rollup as an updated rolling summary (<= 800 chars). If Chat memory includes rolling_summary, update it.\n` +
	            `- Prefer ops for status checks and simple replanning.\n` +
	            `- If unclear, ask one clarifying question in reply and ops=[].\n` +
	            (memorySection ? `\n${memorySection}\n` : "\n") +
            `\n` +
            `State counts: ${JSON.stringify(counts)}\n` +
            `Next runnable: ${next ? formatNodeLine(next) : "(none)"}\n` +
            `Nodes (first 40):\n${nodeLines}\n` +
            (recent ? `\nRecent activity (tail):\n${recent}\n` : "") +
            `\nUser: ${line}\n`;

          const routed = await runChatMicrocall({
            rootDir,
            paths,
            config,
            prompt,
            runnerName: runnerOverride,
            role: roleOverride,
          });
          const data = routed?.data && typeof routed.data === "object" ? routed.data : null;
          const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
          if (reply) process.stdout.write(reply + "\n");
          const opsRaw = data?.ops;
          const ops = Array.isArray(opsRaw) ? opsRaw : [];
          for (const op of ops) {
              const type = typeof op?.type === "string" ? op.type.trim() : "";
              if (!type) continue;
              if (type === "status") {
                await statusCommand(rootDir);
                continue;
              }
              if (type === "control.pause") {
                await controlCommand(rootDir, ["pause"], {});
                continue;
              }
              if (type === "control.resume") {
                await controlCommand(rootDir, ["resume"], {});
                continue;
              }
              if (type === "control.setWorkers") {
                await controlCommand(rootDir, ["set-workers"], { workers: op?.workers });
                continue;
              }
              if (type === "control.replan") {
                await controlCommand(rootDir, ["replan"], {});
                continue;
              }
              if (type === "control.cancel") {
                await controlCommand(rootDir, ["cancel"], { node: typeof op?.nodeId === "string" ? op.nodeId : "" });
                continue;
              }
              if (type === "node.add") {
                await nodeCommand(rootDir, ["add"], {
                  id: typeof op.id === "string" ? op.id : "",
                  title: typeof op.title === "string" ? op.title : "",
                  type: typeof op.nodeType === "string" ? op.nodeType : "task",
                status: typeof op.status === "string" ? op.status : "open",
                parent: typeof op.parentId === "string" ? op.parentId : "plan-000",
                runner: typeof op.runner === "string" ? op.runner : "",
                inputs: op?.inputs,
                ownership: op?.ownership,
                acceptance: op?.acceptance,
                verify: op?.verify,
                retryPolicy: op?.retryPolicy,
                dependsOn: op?.dependsOn,
              });
              continue;
            }
            if (type === "node.update") {
              const updateFlags = {
                id: typeof op.id === "string" ? op.id : "",
                force: Boolean(op.force),
              };
              if (Object.prototype.hasOwnProperty.call(op, "title") && typeof op.title === "string") updateFlags.title = op.title;
              if (Object.prototype.hasOwnProperty.call(op, "nodeType") && typeof op.nodeType === "string") updateFlags.type = op.nodeType;
              if (Object.prototype.hasOwnProperty.call(op, "parentId") && typeof op.parentId === "string") updateFlags.parent = op.parentId;
              if (Object.prototype.hasOwnProperty.call(op, "runner")) updateFlags.runner = typeof op.runner === "string" ? op.runner : "";
              if (Object.prototype.hasOwnProperty.call(op, "inputs")) updateFlags.inputs = op.inputs;
              if (Object.prototype.hasOwnProperty.call(op, "ownership")) updateFlags.ownership = op.ownership;
              if (Object.prototype.hasOwnProperty.call(op, "acceptance")) updateFlags.acceptance = op.acceptance;
              if (Object.prototype.hasOwnProperty.call(op, "verify")) updateFlags.verify = op.verify;
              if (Object.prototype.hasOwnProperty.call(op, "retryPolicy")) updateFlags.retryPolicy = op.retryPolicy;
              await nodeCommand(rootDir, ["update"], updateFlags);
              continue;
            }
            if (type === "node.setStatus") {
              await nodeCommand(rootDir, ["set-status"], {
                id: typeof op.id === "string" ? op.id : "",
                status: typeof op.status === "string" ? op.status : "",
                force: Boolean(op.force),
              });
              continue;
            }
            if (type === "dep.add") {
              await depCommand(rootDir, ["add"], {
                node: typeof op.nodeId === "string" ? op.nodeId : "",
                "depends-on": typeof op.dependsOnId === "string" ? op.dependsOnId : "",
                "required-status": typeof op.requiredStatus === "string" ? op.requiredStatus : "",
              });
              continue;
            }
            if (type === "dep.remove") {
              await depCommand(rootDir, ["remove"], {
                node: typeof op.nodeId === "string" ? op.nodeId : "",
                "depends-on": typeof op.dependsOnId === "string" ? op.dependsOnId : "",
              });
              continue;
            }
            if (type === "run.start") {
              await startSupervisorDetached({ rootDir, flags });
              continue;
            }
            if (type === "run.stop") {
              await stopCommand(rootDir, { ...flags, signal: typeof op.signal === "string" ? op.signal : undefined });
              continue;
            }
          }

          try {
            const now = nowIso();
            const storedOpsText = JSON.stringify(ops);
            const turn = {
              at: now,
              user: truncateText(line, 800),
              reply: truncateText(reply, 1200),
              ops: ops.map((o) => (typeof o?.type === "string" ? o.type : null)).filter(Boolean),
            };
            const nextTurns = chatTurns.concat([turn]).slice(-10);

            const rollup = typeof data?.rollup === "string" ? data.rollup.trim() : "";
            if (rollup) {
              await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.rollup", valueText: truncateText(rollup, 4000), nowIso: now });
            }
            await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.summary", valueText: truncateText(reply, 400), nowIso: now });
            await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.last_ops", valueText: truncateText(storedOpsText, 4000), nowIso: now });
            await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.turns", valueText: JSON.stringify(nextTurns), nowIso: now });
          } catch (error) {
            process.stdout.write(`Chat memory error: ${error?.message || String(error)}\n`);
          }
        } catch (error) {
          process.stdout.write(`Chat error: ${error?.message || String(error)}\n`);
        }
        rl.prompt();
        continue;
      }
      if (line === "/run.start") {
        await startSupervisorDetached({ rootDir, flags });
        rl.prompt();
        continue;
      }
      if (line === "/run.stop") {
        await stopCommand(rootDir, flags);
        rl.prompt();
        continue;
      }
      if (line === "/run.status") {
        const lock = await readSupervisorLock(paths.lockPath);
        if (!lock) process.stdout.write("No supervisor lock found.\n");
        else process.stdout.write(`Supervisor lock pid=${lock.pid || "?"} host=${lock.host || "?"}\n`);
        rl.prompt();
        continue;
      }
      if (line === "/node.add") {
        process.stdout.write('Tip: use natural language, or run `dagain node add --id=... --title="..." --parent=plan-000`.\n');
        rl.prompt();
        continue;
      }
      if (line === "/node.set-status") {
        process.stdout.write("Tip: run `dagain node set-status --id=<id> --status=<open|done|failed|needs_human>`.\n");
        rl.prompt();
        continue;
      }
      process.stdout.write(`Unknown command: ${line}\n`);
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}

async function nodeCommand(rootDir, positional, flags) {
  const paths = choreoPaths(rootDir);
  const config = await loadConfig(paths.configPath);
  if (!config) throw new Error("Missing .dagain/config.json. Run `dagain init`.");
  if (!(await pathExists(paths.dbPath))) throw new Error("Missing .dagain/state.sqlite. Run `dagain init`.");
  await ensureDepsRequiredStatusColumn({ dbPath: paths.dbPath });

  const sub = String(positional?.[0] || "").trim();
  if (!sub) throw new Error("Missing node subcommand. Use `dagain node add` or `dagain node set-status`.");

  if (sub === "add") {
    const id = typeof flags.id === "string" ? flags.id.trim() : "";
    if (!id) throw new Error("Missing --id.");
    const title = typeof flags.title === "string" ? flags.title : "";
    const type = typeof flags.type === "string" ? flags.type.trim() : "task";
    const status = typeof flags.status === "string" ? flags.status.trim() : "open";
    const parentId = typeof flags.parent === "string" ? flags.parent.trim() : "";
    const runner = typeof flags.runner === "string" ? flags.runner.trim() : "";

    const defaultRetryPolicy = resolveDefaultRetryPolicy(config) ?? { maxAttempts: 3 };
    const inputs = parseJsonArrayFlag(flags.inputs, [], "inputs");
    const ownership = parseJsonArrayFlag(flags.ownership, [], "ownership");
    const acceptance = parseJsonArrayFlag(flags.acceptance, [], "acceptance");
    const verify = parseJsonArrayFlag(flags.verify, [], "verify");

    const retryPolicyRaw = Object.prototype.hasOwnProperty.call(flags, "retryPolicy") ? flags.retryPolicy : flags["retry-policy"];
    const retryPolicy = parseRetryPolicyFlag(retryPolicyRaw, defaultRetryPolicy);

    const dependsOnRaw = Object.prototype.hasOwnProperty.call(flags, "dependsOn") ? flags.dependsOn : flags["depends-on"];
    const dependsOn = parseDependsOnFlag(dependsOnRaw);

    const now = nowIso();
    await sqliteExec(
      paths.dbPath,
      `BEGIN IMMEDIATE;\n` +
        `INSERT OR IGNORE INTO nodes(\n` +
        `  id, title, type, status, parent_id,\n` +
        `  runner,\n` +
        `  inputs_json, ownership_json, acceptance_json, verify_json,\n` +
        `  retry_policy_json, attempts,\n` +
        `  created_at, updated_at\n` +
        `)\n` +
        `VALUES(\n` +
        `  ${sqlQuote(id)}, ${sqlQuote(title)}, ${sqlQuote(type)}, ${sqlQuote(status)}, ${parentId ? sqlQuote(parentId) : "NULL"},\n` +
        `  ${runner ? sqlQuote(runner) : "NULL"},\n` +
        `  ${sqlQuote(stableJsonSig(inputs, "[]"))}, ${sqlQuote(stableJsonSig(ownership, "[]"))}, ${sqlQuote(stableJsonSig(acceptance, "[]"))}, ${sqlQuote(stableJsonSig(verify, "[]"))},\n` +
        `  ${sqlQuote(stableJsonSig(retryPolicy, stableJsonSig(defaultRetryPolicy, '{"maxAttempts":3}')))}, 0,\n` +
        `  ${sqlQuote(now)}, ${sqlQuote(now)}\n` +
        `);\n` +
        dependsOn.map((depId) => `INSERT OR IGNORE INTO deps(node_id, depends_on_id) VALUES(${sqlQuote(id)}, ${sqlQuote(depId)});\n`).join("") +
        `COMMIT;\n`,
    );

    const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
    await syncTaskPlan({ paths, graph });
    return;
  }

  if (sub === "update") {
    const id = typeof flags.id === "string" ? flags.id.trim() : "";
    if (!id) throw new Error("Missing --id.");

    const force = Boolean(flags.force);
    const rows = await sqliteQueryJson(paths.dbPath, `SELECT lock_run_id FROM nodes WHERE id=${sqlQuote(id)} LIMIT 1;\n`);
    const lockRunId = rows[0]?.lock_run_id ?? null;
    if (lockRunId && !force) throw new Error(`Refusing to update locked node ${id} without --force.`);

    const updates = [];
    if (Object.prototype.hasOwnProperty.call(flags, "title") && typeof flags.title === "string") {
      updates.push(`title=${sqlQuote(flags.title)}`);
    }
    if (Object.prototype.hasOwnProperty.call(flags, "type") && typeof flags.type === "string") {
      updates.push(`type=${sqlQuote(flags.type.trim() || "task")}`);
    }
    if (Object.prototype.hasOwnProperty.call(flags, "parent") && typeof flags.parent === "string") {
      const parentId = flags.parent.trim();
      updates.push(`parent_id=${parentId ? sqlQuote(parentId) : "NULL"}`);
    }
    if (Object.prototype.hasOwnProperty.call(flags, "runner")) {
      const runner = typeof flags.runner === "string" ? flags.runner.trim() : "";
      updates.push(`runner=${runner ? sqlQuote(runner) : "NULL"}`);
    }
    if (Object.prototype.hasOwnProperty.call(flags, "inputs")) {
      const inputs = parseJsonArrayFlag(flags.inputs, [], "inputs");
      updates.push(`inputs_json=${sqlQuote(stableJsonSig(inputs, "[]"))}`);
    }
    if (Object.prototype.hasOwnProperty.call(flags, "ownership")) {
      const ownership = parseJsonArrayFlag(flags.ownership, [], "ownership");
      updates.push(`ownership_json=${sqlQuote(stableJsonSig(ownership, "[]"))}`);
    }
    if (Object.prototype.hasOwnProperty.call(flags, "acceptance")) {
      const acceptance = parseJsonArrayFlag(flags.acceptance, [], "acceptance");
      updates.push(`acceptance_json=${sqlQuote(stableJsonSig(acceptance, "[]"))}`);
    }
    if (Object.prototype.hasOwnProperty.call(flags, "verify")) {
      const verify = parseJsonArrayFlag(flags.verify, [], "verify");
      updates.push(`verify_json=${sqlQuote(stableJsonSig(verify, "[]"))}`);
    }
    const hasRetryPolicy =
      Object.prototype.hasOwnProperty.call(flags, "retryPolicy") || Object.prototype.hasOwnProperty.call(flags, "retry-policy");
    if (hasRetryPolicy) {
      const defaultRetryPolicy = resolveDefaultRetryPolicy(config) ?? { maxAttempts: 3 };
      const retryPolicyRaw = Object.prototype.hasOwnProperty.call(flags, "retryPolicy") ? flags.retryPolicy : flags["retry-policy"];
      const retryPolicy = parseRetryPolicyFlag(retryPolicyRaw, defaultRetryPolicy);
      updates.push(`retry_policy_json=${sqlQuote(stableJsonSig(retryPolicy, stableJsonSig(defaultRetryPolicy, '{"maxAttempts":3}')))}`);
    }

    if (updates.length === 0) throw new Error("No updates specified.");

    const now = nowIso();
    await sqliteExec(
      paths.dbPath,
      `BEGIN IMMEDIATE;\n` +
        `UPDATE nodes\n` +
        `SET ${updates.join(",\n    ")},\n` +
        `    updated_at=${sqlQuote(now)}\n` +
        `WHERE id=${sqlQuote(id)};\n` +
        `COMMIT;\n`,
    );

    const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
    await syncTaskPlan({ paths, graph });
    return;
  }

  if (sub === "set-status") {
    const id = typeof flags.id === "string" ? flags.id.trim() : "";
    if (!id) throw new Error("Missing --id.");
    const desired = normalizeStatus(flags.status);
    const allowed = desired === "open" || desired === "done" || desired === "failed" || desired === "needs_human";
    if (!allowed) throw new Error("Invalid --status. Use open|done|failed|needs_human.");

    const force = Boolean(flags.force);
    const rows = await sqliteQueryJson(
      paths.dbPath,
      `SELECT lock_run_id FROM nodes WHERE id=${sqlQuote(id)} LIMIT 1;\n`,
    );
    const lockRunId = rows[0]?.lock_run_id ?? null;
    if (lockRunId && !force) throw new Error(`Refusing to update locked node ${id} without --force.`);

    const isOpen = desired === "open";
    const isTerminal = desired === "done" || desired === "failed";
    const now = nowIso();
    await sqliteExec(
      paths.dbPath,
      `UPDATE nodes\n` +
        `SET status=${sqlQuote(desired)},\n` +
        `    attempts=${isOpen ? "0" : "attempts"},\n` +
        `    checkpoint_json=${isOpen ? "NULL" : "checkpoint_json"},\n` +
        `    lock_run_id=NULL,\n` +
        `    lock_started_at=NULL,\n` +
        `    lock_pid=NULL,\n` +
        `    lock_host=NULL,\n` +
        `    completed_at=${isOpen ? "NULL" : isTerminal ? sqlQuote(now) : "completed_at"},\n` +
        `    updated_at=${sqlQuote(now)}\n` +
        `WHERE id=${sqlQuote(id)};\n`,
    );

    const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
    await syncTaskPlan({ paths, graph });
    return;
  }

  throw new Error(`Unknown node subcommand: ${sub}`);
}

async function depCommand(rootDir, positional, flags) {
  const paths = choreoPaths(rootDir);
  if (!(await pathExists(paths.dbPath))) throw new Error("Missing .dagain/state.sqlite. Run `dagain init`.");
  await ensureDepsRequiredStatusColumn({ dbPath: paths.dbPath });

  const sub = String(positional?.[0] || "").trim();
  if (!sub) throw new Error("Missing dep subcommand. Use `dagain dep add` or `dagain dep remove`.");

  const nodeIdRaw =
    typeof flags.node === "string"
      ? flags.node
      : typeof flags.id === "string"
        ? flags.id
        : typeof flags.nodeId === "string"
          ? flags.nodeId
          : "";
  const nodeId = String(nodeIdRaw || "").trim();
  if (!nodeId) throw new Error("Missing --node=<id>.");

  const dependsOnIdRaw =
    typeof flags["depends-on"] === "string"
      ? flags["depends-on"]
      : typeof flags.dependsOnId === "string"
        ? flags.dependsOnId
        : typeof flags.dep === "string"
          ? flags.dep
          : "";
  const dependsOnId = String(dependsOnIdRaw || "").trim();
  if (!dependsOnId) throw new Error("Missing --depends-on=<id>.");

  const now = nowIso();
  if (sub === "add") {
    const requiredRaw =
      typeof flags["required-status"] === "string"
        ? flags["required-status"]
        : typeof flags.requiredStatus === "string"
          ? flags.requiredStatus
          : "";
    const requiredStatus = String(requiredRaw || "").trim().toLowerCase() || "done";
    if (requiredStatus !== "done" && requiredStatus !== "terminal") {
      throw new Error("Invalid --required-status. Use done|terminal.");
    }

    await sqliteExec(
      paths.dbPath,
      `BEGIN IMMEDIATE;\n` +
        `INSERT INTO deps(node_id, depends_on_id, required_status)\n` +
        `VALUES(${sqlQuote(nodeId)}, ${sqlQuote(dependsOnId)}, ${sqlQuote(requiredStatus)})\n` +
        `ON CONFLICT(node_id, depends_on_id)\n` +
        `DO UPDATE SET required_status=excluded.required_status;\n` +
        `COMMIT;\n`,
    );

    const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
    await syncTaskPlan({ paths, graph });
    return;
  }

  if (sub === "remove") {
    await sqliteExec(
      paths.dbPath,
      `BEGIN IMMEDIATE;\n` +
        `DELETE FROM deps WHERE node_id=${sqlQuote(nodeId)} AND depends_on_id=${sqlQuote(dependsOnId)};\n` +
        `COMMIT;\n`,
    );

    const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
    await syncTaskPlan({ paths, graph });
    return;
  }

  throw new Error(`Unknown dep subcommand: ${sub}`);
}

async function controlCommand(rootDir, positional, flags) {
  const paths = choreoPaths(rootDir);
  if (!(await pathExists(paths.dbPath))) throw new Error("Missing .dagain/state.sqlite. Run `dagain init`.");
  await ensureMailboxTable({ dbPath: paths.dbPath });

  const sub = String(positional[0] || "").trim();
  if (!sub) throw new Error("Missing control subcommand. Use pause|resume|set-workers|replan|cancel.");

  const now = nowIso();
  if (sub === "pause") {
    const res = await mailboxEnqueue({ dbPath: paths.dbPath, command: "pause", args: {}, nowIso: now });
    process.stdout.write(`Enqueued pause (id=${res.id}).\n`);
    return;
  }

  if (sub === "resume") {
    const res = await mailboxEnqueue({ dbPath: paths.dbPath, command: "resume", args: {}, nowIso: now });
    process.stdout.write(`Enqueued resume (id=${res.id}).\n`);
    return;
  }

  if (sub === "set-workers") {
    const nRaw = flags.workers ?? flags.n ?? flags.count;
    const nNum = Number(nRaw);
    const workers = Number.isFinite(nNum) && nNum > 0 ? Math.floor(nNum) : null;
    if (workers == null) throw new Error("Missing --workers=<n>.");
    const res = await mailboxEnqueue({ dbPath: paths.dbPath, command: "set_workers", args: { workers }, nowIso: now });
    process.stdout.write(`Enqueued set-workers=${workers} (id=${res.id}).\n`);
    return;
  }

  if (sub === "replan") {
    const res = await mailboxEnqueue({ dbPath: paths.dbPath, command: "replan_now", args: {}, nowIso: now });
    process.stdout.write(`Enqueued replan (id=${res.id}).\n`);
    return;
  }

  if (sub === "cancel") {
    const idFlag = typeof flags.node === "string" ? flags.node : typeof flags.id === "string" ? flags.id : "";
    const nodeId = String(idFlag || positional[1] || "").trim();
    if (!nodeId) throw new Error("Missing --node=<id>.");
    const res = await mailboxEnqueue({ dbPath: paths.dbPath, command: "cancel", args: { nodeId }, nowIso: now });
    process.stdout.write(`Enqueued cancel node=${nodeId} (id=${res.id}).\n`);
    return;
  }

  throw new Error(`Unknown control subcommand: ${sub}`);
}

export async function main(argv) {
  const { command, positional, flags } = parseArgs(argv);
  const rootDir = process.cwd();
  const forceChat = String(process.env.CHOREO_FORCE_CHAT || "").trim() === "1";
  const interactive = (process.stdin.isTTY && process.stdout.isTTY) || forceChat;

  if (!(flags.h || flags.help) && (command || interactive)) {
    await maybeMigrateLegacyStateDir(rootDir);
  }

  if (!command || flags.h || flags.help) {
    if (flags.h || flags.help || !interactive) {
      process.stdout.write(usage());
      return;
    }
    const paths = choreoPaths(rootDir);
    if (await pathExists(paths.dbPath)) await chatCommand(rootDir, flags);
    else await startCommand(rootDir, flags, []);
    return;
  }

  if (command === "start") {
    await startCommand(rootDir, flags, positional);
    return;
  }

  if (command === "init") {
    await initCommand(rootDir, flags);
    return;
  }

  if (command === "status") {
    await statusCommand(rootDir);
    return;
  }

  if (command === "run") {
    await runCommand(rootDir, flags);
    return;
  }

  if (command === "resume") {
    await runCommand(rootDir, flags);
    return;
  }

  if (command === "goal") {
    await goalCommand(rootDir, flags);
    return;
  }

  if (command === "answer") {
    await answerCommand(rootDir, flags);
    return;
  }

  if (command === "kv") {
    await kvCommand(rootDir, positional, flags);
    return;
  }

  if (command === "microcall") {
    await microcallCommand(rootDir, flags);
    return;
  }

  if (command === "chat") {
    await chatCommand(rootDir, flags);
    return;
  }

  if (command === "node") {
    await nodeCommand(rootDir, positional, flags);
    return;
  }

  if (command === "dep") {
    await depCommand(rootDir, positional, flags);
    return;
  }

  if (command === "control") {
    await controlCommand(rootDir, positional, flags);
    return;
  }

  if (command === "templates" && positional[0] === "sync") {
    await templatesSyncCommand(rootDir, flags);
    return;
  }

  if (command === "stop") {
    await stopCommand(rootDir, flags);
    return;
  }

  if (command === "graph" && positional[0] === "validate") {
    await graphValidateCommand(rootDir);
    return;
  }

  // Shorthand: treat unknown command as an implicit goal string.
  await startCommand(rootDir, flags, [command, ...positional]);
}

async function stopCommand(rootDir, flags) {
  const paths = choreoPaths(rootDir);
  const ui = createUi({ noColor: resolveNoColorFlag(flags), forceColor: resolveForceColorFlag(flags) });

  const lock = await readSupervisorLock(paths.lockPath);
  if (!lock) {
    ui.event("warn", "No supervisor lock found.");
    return;
  }

  const pid = Number(lock.pid);
  const host = String(lock.host || "").trim();
  if (!Number.isFinite(pid) || pid <= 0) {
    ui.event("warn", `Invalid supervisor lock pid=${String(lock.pid)}.`);
    return;
  }
  if (host && host !== os.hostname()) {
    ui.event("warn", `Supervisor appears to be on host=${host}; refusing to signal from host=${os.hostname()}.`);
    return;
  }

  const sigRaw = typeof flags.signal === "string" ? flags.signal : "SIGTERM";
  const sig = String(sigRaw).trim().toUpperCase() || "SIGTERM";

  try {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        await rm(paths.lockPath, { force: true });
        ui.event("warn", `Supervisor pid=${pid} not found; cleared stale lock.`);
        return;
      }
    }
    process.kill(pid, sig);
  } catch (error) {
    ui.event("warn", `Failed to signal pid=${pid}: ${error?.message || String(error)}`);
    process.exitCode = 1;
    return;
  }

  ui.event("done", `Sent ${sig} to supervisor pid=${pid}.`);
}

async function templatesSyncCommand(rootDir, flags) {
  const paths = choreoPaths(rootDir);
  if (!(await pathExists(paths.choreoDir))) throw new Error("Missing .dagain directory. Run `dagain init` first.");
  const force = Boolean(flags.force);
  await copyTemplates(rootDir, { force });
  process.stdout.write(`Templates synced${force ? " (force)" : ""}.\n`);
}

async function answerCommand(rootDir, flags) {
  const paths = choreoPaths(rootDir);
  const ui = createUi({ noColor: resolveNoColorFlag(flags), forceColor: resolveForceColorFlag(flags) });
  const cancel = installCancellation({ ui, label: "answer" });
  const abortSignal = cancel.signal;

  try {
    if (!(await pathExists(paths.dbPath))) throw new Error("Missing .dagain/state.sqlite. Run `dagain init`.");
    const graph = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });

    const targetNodeId = typeof flags.node === "string" ? flags.node.trim() : "";
    const checkpointFile = typeof flags.checkpoint === "string" ? flags.checkpoint.trim() : "";
    const answerFlag = typeof flags.answer === "string" ? String(flags.answer) : "";
    const canPrompt = isPromptEnabled();
    const noPrompt = Boolean(flags["no-prompt"]) || Boolean(flags.noPrompt);

    const needsHuman = (graph.nodes || []).filter((n) => String(n?.status || "").toLowerCase() === "needs_human");
    if (needsHuman.length === 0 && !checkpointFile) {
      ui.event("warn", "No nodes need human input.");
      return;
    }

    let node = null;
    if (targetNodeId) {
      node = (graph.nodes || []).find((n) => n.id === targetNodeId) || null;
      if (!node) throw new Error(`Unknown node id: ${targetNodeId}`);
      if (String(node.status || "").toLowerCase() !== "needs_human") {
        throw new Error(`Node is not waiting for human input: ${targetNodeId} (status=${node.status || "?"})`);
      }
    } else if (needsHuman.length === 1) {
      node = needsHuman[0];
    } else if (checkpointFile) {
      // resolve by checkpoint mapping below
      node = null;
    } else {
      if (!canPrompt || noPrompt) {
        throw new Error(`Multiple nodes need human input; specify --node=<id>.\nNodes: ${needsHuman.map((n) => n.id).join(", ")}`);
      }
      ui.writeLine(ui.hr("needs human"));
      for (let i = 0; i < needsHuman.length; i += 1) {
        const n = needsHuman[i];
        const q = n?.checkpoint?.question ? ui.truncate(n.checkpoint.question, 80) : "";
        ui.writeLine(`${String(i + 1).padStart(2, " ")}. ${n.id}${q ? ` — ${q}` : ""}`);
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const picked = (await rl.question("Pick a node number (or 'q'): ", { signal: abortSignal })).trim();
        if (!picked || picked.toLowerCase() === "q") return;
        const idx = Number(picked);
        if (!Number.isFinite(idx) || idx < 1 || idx > needsHuman.length) throw new Error("Invalid selection.");
        node = needsHuman[idx - 1];
      } finally {
        rl.close();
      }
    }

    const { checkpointPathAbs, checkpoint, resolvedNodeId } = await resolveCheckpointForAnswer({
      paths,
      graph,
      nodeId: node?.id || "",
      checkpointFile,
    });

    if (!node && resolvedNodeId) {
      node = (graph.nodes || []).find((n) => n.id === resolvedNodeId) || null;
    }
    if (!node) throw new Error("Could not resolve which node to answer. Use --node=<id>.");
    if (String(node.status || "").toLowerCase() !== "needs_human") {
      throw new Error(`Node is not waiting for human input: ${node.id} (status=${node.status || "?"})`);
    }

    const question = String(checkpoint?.question || "").trim();
    const context = String(checkpoint?.context || "").trim();
    const options = Array.isArray(checkpoint?.options) ? checkpoint.options.map((o) => String(o)) : [];
    if (question) {
      ui.writeLine(ui.hr(`checkpoint ${node.id}`));
      ui.writeLine(question);
      if (context) ui.writeLine(`\n${context}`);
      if (options.length > 0) {
        ui.writeLine("\nOptions:");
        for (const opt of options) ui.writeLine(`- ${opt}`);
      }
      ui.detail(`checkpoint: ${path.relative(paths.rootDir, checkpointPathAbs)}`);
      ui.writeLine(ui.hr());
    }

    let answer = answerFlag.trim();
    if (!answer) {
      if (!canPrompt || noPrompt) throw new Error("Missing answer. Provide --answer=\"...\" or run in a TTY.");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        answer = (await rl.question("Your answer (or 'q'): ", { signal: abortSignal })).trim();
      } finally {
        rl.close();
      }
      if (!answer || answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") return;
    }

    const checkpointId = String(checkpoint?.id || "").trim() || deriveCheckpointIdFromPath(checkpointPathAbs);
    const responsePathAbs = path.join(paths.checkpointsDir, `response-${checkpointId}.json`);
    await writeJsonAtomic(responsePathAbs, {
      version: 1,
      checkpointId,
      nodeId: node.id,
      answeredAt: nowIso(),
      answer,
    });

    const checkpointMeta = {
      ...(typeof node.checkpoint === "object" && node.checkpoint ? node.checkpoint : {}),
      version: 1,
      runId: node?.checkpoint?.runId || null,
      path: path.relative(paths.rootDir, checkpointPathAbs),
      question: question || node?.checkpoint?.question || "",
      answeredAt: nowIso(),
      answer,
      responsePath: path.relative(paths.rootDir, responsePathAbs),
    };

    await sqliteExec(
      paths.dbPath,
      `UPDATE nodes\n` +
        `SET status='open',\n` +
        `    checkpoint_json=${sqlQuote(JSON.stringify(checkpointMeta))},\n` +
        `    lock_run_id=NULL,\n` +
        `    lock_started_at=NULL,\n` +
        `    lock_pid=NULL,\n` +
        `    lock_host=NULL,\n` +
        `    updated_at=${sqlQuote(nowIso())}\n` +
        `WHERE id=${sqlQuote(node.id)};\n`,
    );

    const refreshed = await exportWorkgraphJson({ dbPath: paths.dbPath, snapshotPath: paths.graphSnapshotPath });
    await syncTaskPlan({ paths, graph: refreshed });

    const progressPath = path.join(paths.memoryDir, "progress.md");
    const lines = [];
    lines.push("");
    lines.push(`## [${nowIso()}] Answered checkpoint for ${node.id}`);
    if (question) lines.push(`- question: ${question}`);
    lines.push(`- answer: ${answer}`);
    lines.push(`- checkpoint: ${path.relative(paths.rootDir, checkpointPathAbs)}`);
    lines.push(`- response: ${path.relative(paths.rootDir, responsePathAbs)}`);
    await writeFile(progressPath, lines.join("\n") + "\n", { encoding: "utf8", flag: "a" });

    ui.event("done", `Recorded answer and reopened ${node.id}.`);
    ui.detail("Run `dagain run` (or keep the supervisor running) to continue.");
  } finally {
    cancel.cleanup();
  }
}

async function kvCommand(rootDir, positional, flags) {
  const paths = choreoPaths(rootDir);
  const ui = createUi({ noColor: resolveNoColorFlag(flags), forceColor: resolveForceColorFlag(flags) });

  const sub = String(positional?.[0] || "").trim().toLowerCase();
  if (!sub || sub === "help") {
    process.stdout.write(usage());
    return;
  }

  const dbPath = String(process.env.CHOREO_DB || paths.dbPath || "").trim();
  if (!dbPath || !(await pathExists(dbPath))) throw new Error("Missing state DB. Run `dagain init`.");

  const runScoped = Boolean(flags.run);
  const nodeFlag = typeof flags.node === "string" ? flags.node.trim() : "";
  const envNodeId = String(process.env.CHOREO_NODE_ID || "").trim();
  const nodeId = runScoped ? "__run__" : nodeFlag || envNodeId;

  if ((sub === "get" || sub === "put" || sub === "ls") && !nodeId) {
    throw new Error("Missing node id. Provide `--node <id>` or set $CHOREO_NODE_ID (or use `--run`).");
  }

  const key = typeof flags.key === "string" ? flags.key.trim() : "";
  const json = Boolean(flags.json);
  const prefix = typeof flags.prefix === "string" ? flags.prefix : "";

  if (sub === "get") {
    if (!key) throw new Error("Missing key. Provide `--key <k>`.");
    const row = await kvGet({ dbPath, nodeId, key });
    if (!row) {
      ui.event("warn", `Key not found: ${nodeId}:${key}`);
      process.exitCode = 1;
      return;
    }
    if (json) {
      process.stdout.write(JSON.stringify(row, null, 2) + "\n");
      return;
    }
    if (typeof row.value_text === "string") process.stdout.write(row.value_text + "\n");
    else if (typeof row.artifact_path === "string") process.stdout.write(row.artifact_path + "\n");
    return;
  }

  if (sub === "ls") {
    const rows = await kvList({ dbPath, nodeId, prefix });
    if (json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      return;
    }
    for (const row of rows) process.stdout.write(String(row.key || "") + "\n");
    return;
  }

  if (sub === "put") {
    if (!key) throw new Error("Missing key. Provide `--key <k>`.");
    const valueText = typeof flags.value === "string" ? String(flags.value) : "";
    if (!valueText) throw new Error("Missing value. Provide `--value \"...\"`.");

    const allowCrossNodeWrite = Boolean(flags["allow-cross-node-write"]);
    const allowedWriteTarget = nodeId === "__run__" || (envNodeId && nodeId === envNodeId);
    if (!allowedWriteTarget && !allowCrossNodeWrite) {
      throw new Error(
        `Refusing to write ${nodeId}:${key} without --allow-cross-node-write (allowed: ${envNodeId ? `${envNodeId} or __run__` : "__run__"}).`,
      );
    }

    await kvPut({
      dbPath,
      nodeId,
      key,
      valueText,
      runId: String(process.env.CHOREO_RUN_ID || "").trim() || null,
      nowIso: nowIso(),
    });
    ui.event("done", `Wrote ${nodeId}:${key}`);
    return;
  }

  throw new Error(`Unknown kv subcommand: ${sub}`);
}

async function microcallCommand(rootDir, flags) {
  const paths = choreoPaths(rootDir);

  const prompt = typeof flags.prompt === "string" ? flags.prompt.trim() : "";
  if (!prompt) throw new Error('Missing prompt. Provide `--prompt "..."`.');

  const config = await loadConfig(paths.configPath);
  if (!config) throw new Error("Missing .dagain/config.json. Run `dagain init` first.");

  const runnerNameFlag = typeof flags.runner === "string" ? flags.runner.trim() : "";
  const role = typeof flags.role === "string" ? flags.role.trim() : "researcher";
  const runnerName = runnerNameFlag || resolveRoleRunnerPick(role || "researcher", config, { seed: prompt, attempt: 0 });
  const runner = config.runners?.[runnerName];
  if (!runner?.cmd) throw new Error(`Unknown runner: ${runnerName}`);

  const microId = `micro-${runId()}`;
  const parentRunId = String(process.env.CHOREO_RUN_ID || "").trim();
  const microcallsBaseDir = parentRunId
    ? path.join(paths.runsDir, parentRunId, "microcalls")
    : path.join(paths.choreoDir, "microcalls");
  const microDir = path.join(microcallsBaseDir, microId);
  await ensureDir(microDir);

  const packetPath = path.join(microDir, "packet.md");
  const stdoutPath = path.join(microDir, "stdout.log");
  const resultPath = path.join(microDir, "result.json");

  const template = await resolveTemplate(rootDir, "microcall");
  const packet = renderTemplate(template, {
    REPO_ROOT: paths.rootDir,
    MICROCALL_PROMPT: prompt,
  });
  await writeFile(packetPath, packet, "utf8");

  const spawnIdentity = await resolveSpawnIdentity({ rootDir: paths.rootDir });
  const identityEnv = envForIdentity(spawnIdentity);
  const runnerEnv = mergeEnv(resolveRunnerEnv({ runnerName, runner, cwd: paths.rootDir, paths }), identityEnv);
  await ensureRunnerTmpDir(runnerEnv);
  if (runnerName === "claude")
    await ensureClaudeProjectTmpWritable({ cwd: paths.rootDir, uid: spawnIdentity?.uid ?? null, gid: spawnIdentity?.gid ?? null });

  const execRes = await runRunnerCommand({
    cmd: runner.cmd,
    packetPath,
    cwd: paths.rootDir,
    logPath: stdoutPath,
    timeoutMs: Number(runner.timeoutMs ?? 0),
    env: runnerEnv,
    uid: spawnIdentity?.uid ?? null,
    gid: spawnIdentity?.gid ?? null,
  });

  const stdoutText = await readFile(stdoutPath, "utf8").catch(() => "");
  const parsed = extractResultJson(stdoutText);
  if (!parsed) {
    const code = typeof execRes.code === "number" ? execRes.code : null;
    const sig = execRes.signal ? String(execRes.signal) : "";
    throw new Error(
      `Could not extract result JSON from microcall output${code ? ` (code=${code})` : ""}${sig ? ` (signal=${sig})` : ""}.`,
    );
  }

  await writeJsonAtomic(resultPath, parsed);

  const storeKey = typeof flags["store-key"] === "string" ? flags["store-key"].trim() : "";
  if (storeKey) {
    const dbPath = String(process.env.CHOREO_DB || paths.dbPath || "").trim();
    if (!dbPath || !(await pathExists(dbPath))) throw new Error("Missing $CHOREO_DB for --store-key (or run `dagain init`).");

    const storeRunScoped = Boolean(flags.run);
    const envNodeId = String(process.env.CHOREO_NODE_ID || "").trim();
    const nodeId = storeRunScoped ? "__run__" : envNodeId;
    if (!nodeId) throw new Error("Missing $CHOREO_NODE_ID for --store-key (or use --run).");

    await kvPut({
      dbPath,
      nodeId,
      key: storeKey,
      valueText: JSON.stringify(parsed),
      runId: parentRunId || null,
      nowIso: nowIso(),
    });
  }

  process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
}

function deriveCheckpointIdFromPath(checkpointPathAbs) {
  const base = path.basename(String(checkpointPathAbs || ""));
  if (base.startsWith("checkpoint-") && base.endsWith(".json")) return base.slice("checkpoint-".length, -".json".length);
  return base.replace(/\.json$/i, "");
}

async function resolveCheckpointForAnswer({ paths, graph, nodeId, checkpointFile }) {
  const explicit = checkpointFile ? checkpointFile : "";
  if (explicit) {
    const abs = path.isAbsolute(explicit) ? explicit : path.join(paths.checkpointsDir, explicit);
    const checkpoint = await safeReadJson(abs);
    if (!checkpoint) throw new Error(`Invalid checkpoint file: ${abs}`);
    const runIdFromName = deriveCheckpointIdFromPath(abs);
    let resolvedNodeId = "";
    const runResultPath = path.join(paths.runsDir, runIdFromName, "result.json");
    const runResult = await safeReadJson(runResultPath);
    if (runResult?.nodeId) resolvedNodeId = String(runResult.nodeId);
    return { checkpointPathAbs: abs, checkpoint, resolvedNodeId };
  }

  // Prefer node.checkpoint.path when present.
  const node = (graph.nodes || []).find((n) => n.id === nodeId);
  const candidateRel = typeof node?.checkpoint?.path === "string" ? node.checkpoint.path : "";
  if (candidateRel) {
    const abs = path.isAbsolute(candidateRel) ? candidateRel : path.join(paths.rootDir, candidateRel);
    const checkpoint = await safeReadJson(abs);
    if (checkpoint) return { checkpointPathAbs: abs, checkpoint, resolvedNodeId: nodeId };
  }

  // Fallback: scan checkpoint files and map runId -> nodeId via runs/<runId>/result.json.
  const checkpointFiles = await listCheckpoints(paths.checkpointsDir);
  const candidates = [];
  for (const file of checkpointFiles) {
    const runId = deriveCheckpointIdFromPath(file);
    if (runId.startsWith("goal-")) continue;
    const runResultPath = path.join(paths.runsDir, runId, "result.json");
    const runResult = await safeReadJson(runResultPath);
    const rid = String(runResult?.nodeId || "").trim();
    if (!rid) continue;
    if (rid !== nodeId) continue;
    candidates.push({ runId, file });
  }
  candidates.sort((a, b) => String(a.runId).localeCompare(String(b.runId)));
  const best = candidates[candidates.length - 1] || null;
  if (!best) throw new Error(`Could not find checkpoint file for node ${nodeId}.`);
  const abs = path.join(paths.checkpointsDir, best.file);
  const checkpoint = await safeReadJson(abs);
  if (!checkpoint) throw new Error(`Invalid checkpoint file: ${abs}`);
  return { checkpointPathAbs: abs, checkpoint, resolvedNodeId: nodeId };
}

async function answerNeedsHumanInteractive({ paths, graph, ui, abortSignal }) {
  const canPrompt = isPromptEnabled();
  if (!canPrompt) return false;
  if (abortSignal?.aborted) return false;
  const needsHuman = (graph.nodes || []).filter((n) => String(n?.status || "").toLowerCase() === "needs_human");
  if (needsHuman.length === 0) return false;

  let node = null;
  if (needsHuman.length === 1) {
    node = needsHuman[0];
  } else {
    while (true) {
      ui.writeLine(ui.hr("needs human"));
      for (let i = 0; i < needsHuman.length; i += 1) {
        const n = needsHuman[i];
        const q = n?.checkpoint?.question ? ui.truncate(n.checkpoint.question, 80) : "";
        ui.writeLine(`${String(i + 1).padStart(2, " ")}. ${n.id}${q ? ` — ${q}` : ""}`);
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const picked = (await rl.question("Pick a node number to answer (or 'q' to quit): ", { signal: abortSignal }))
          .trim()
          .toLowerCase();
        if (!picked || picked === "q" || picked === "quit") return false;
        const idx = Number(picked);
        if (!Number.isFinite(idx) || idx < 1 || idx > needsHuman.length) {
          ui.event("warn", "Invalid selection.");
          continue;
        }
        node = needsHuman[idx - 1];
        break;
      } finally {
        rl.close();
      }
    }
  }

  const { checkpointPathAbs, checkpoint } = await resolveCheckpointForAnswer({ paths, graph, nodeId: node.id, checkpointFile: "" });
  const question = String(checkpoint?.question || "").trim();
  const context = String(checkpoint?.context || "").trim();
  const options = Array.isArray(checkpoint?.options) ? checkpoint.options.map((o) => String(o)) : [];

  ui.writeLine(ui.hr(`checkpoint ${node.id}`));
  if (question) ui.writeLine(question);
  if (context) ui.writeLine(`\n${context}`);
  if (options.length > 0) {
    ui.writeLine("\nOptions:");
    for (const opt of options) ui.writeLine(`- ${opt}`);
  }
  ui.detail(`checkpoint: ${path.relative(paths.rootDir, checkpointPathAbs)}`);
  ui.writeLine(ui.hr());

  let answer = "";
  while (true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      answer = (await rl.question("Your answer (or 'q' to quit): ", { signal: abortSignal })).trim();
    } finally {
      rl.close();
    }
    if (!answer) {
      ui.event("warn", "Answer was empty.");
      continue;
    }
    if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") return false;
    break;
  }

  const checkpointId = String(checkpoint?.id || "").trim() || deriveCheckpointIdFromPath(checkpointPathAbs);
  const responsePathAbs = path.join(paths.checkpointsDir, `response-${checkpointId}.json`);
  await writeJsonAtomic(responsePathAbs, {
    version: 1,
    checkpointId,
    nodeId: node.id,
    answeredAt: nowIso(),
    answer,
  });

  node.status = "open";
  node.lock = null;
  node.updatedAt = nowIso();
  node.checkpoint = {
    ...(typeof node.checkpoint === "object" && node.checkpoint ? node.checkpoint : {}),
    version: 1,
    runId: node?.checkpoint?.runId || null,
    path: path.relative(paths.rootDir, checkpointPathAbs),
    question: question || node?.checkpoint?.question || "",
    answeredAt: nowIso(),
    answer,
    responsePath: path.relative(paths.rootDir, responsePathAbs),
  };
  await saveWorkgraph(paths.graphPath, graph);
  await syncTaskPlan({ paths, graph });

  const progressPath = path.join(paths.memoryDir, "progress.md");
  const lines = [];
  lines.push("");
  lines.push(`## [${nowIso()}] Answered checkpoint for ${node.id}`);
  if (question) lines.push(`- question: ${question}`);
  lines.push(`- answer: ${answer}`);
  lines.push(`- checkpoint: ${path.relative(paths.rootDir, checkpointPathAbs)}`);
  lines.push(`- response: ${path.relative(paths.rootDir, responsePathAbs)}`);
  await writeFile(progressPath, lines.join("\n") + "\n", { encoding: "utf8", flag: "a" });

  ui.event("done", `Reopened ${node.id}. Continuing...`);
  return true;
}

function defaultFindingsMarkdown() {
  return (
    "# Findings & Decisions\n" +
    "\n" +
    "Use this file to persist discoveries, links, and technical decisions across agents.\n" +
    "\n" +
    "## Requirements\n" +
    "-\n" +
    "\n" +
    "## Research Findings\n" +
    "-\n" +
    "\n" +
    "## Technical Decisions\n" +
    "| Decision | Rationale |\n" +
    "|----------|-----------|\n" +
    "|          |           |\n" +
    "\n" +
    "## Resources\n" +
    "-\n"
  );
}

function defaultTaskPlanMarkdown() {
  return (
    "# Task Plan\n" +
    "\n" +
    "This file is shared working memory for all agents.\n" +
    "\n" +
    "## Goal\n" +
    "See `GOAL.md`.\n" +
    "\n" +
    "## Workgraph (auto)\n" +
    "<!-- CHOREO:BEGIN_WORKGRAPH -->\n" +
    "- (pending)\n" +
    "<!-- CHOREO:END_WORKGRAPH -->\n" +
    "\n" +
    "## Notes\n" +
    "-\n"
  );
}

async function syncTaskPlan({ paths, graph }) {
  const taskPlanPath = path.join(paths.memoryDir, "task_plan.md");
  const start = "<!-- CHOREO:BEGIN_WORKGRAPH -->";
  const end = "<!-- CHOREO:END_WORKGRAPH -->";

  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const lines = [];
  for (const node of nodes) {
    const status = String(node?.status || "").toLowerCase();
    const box = status === "done" ? "x" : " ";
    const extra =
      status === "in_progress"
        ? " **Status:** in_progress"
        : status === "needs_human"
          ? " **Status:** needs_human"
          : status === "failed"
            ? " **Status:** failed"
            : "";
    lines.push(`- [${box}] ${node.id} — ${node.title || "(untitled)"}${extra}`);
  }
  const replacement = lines.length ? lines.join("\n") : "- (no nodes)";

  let current = "";
  try {
    current = await readFile(taskPlanPath, "utf8");
  } catch {
    current = defaultTaskPlanMarkdown();
  }

  const startIdx = current.indexOf(start);
  const endIdx = current.indexOf(end);
  let out = current;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = current.slice(0, startIdx + start.length);
    const after = current.slice(endIdx);
    out = `${before}\n${replacement}\n${after}`;
  } else {
    out = current.trimEnd() + `\n\n## Workgraph (auto)\n${start}\n${replacement}\n${end}\n`;
  }

  await writeFile(taskPlanPath, out.endsWith("\n") ? out : out + "\n", "utf8");
}

async function appendProgress({ paths, node, run, role, runnerName, result, stdoutPath }) {
  const progressPath = path.join(paths.memoryDir, "progress.md");
  const status = String(result?.status || "").toLowerCase();
  const summary = String(result?.summary || "").trim();

  const lines = [];
  lines.push("");
  lines.push(`## [${nowIso()}] ${node.id} (${role}) — ${status}`);
  lines.push(`- runner: ${runnerName}`);
  lines.push(`- run: ${run}`);
  lines.push(`- log: ${stdoutPath}`);
  if (summary) lines.push(`- summary: ${summary}`);
  await writeFile(progressPath, lines.join("\n") + "\n", { encoding: "utf8", flag: "a" });
}
