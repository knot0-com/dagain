// Input — filesystem under `.dagain/`, sqlite3 CLI, and supervisor lock file semantics.
// Output — session layout helpers (migrate legacy state, current session pointer, active detection).
// Position — Central session-scoping layer for dagain state paths and UX defaults.

import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { lstat, rename, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";

import { ensureDir, pathExists, writeJsonAtomic } from "./fs.js";
import { dagainPaths, dagainSessionPaths } from "./config.js";
import { readSupervisorLock } from "./lock.js";
import { sqliteQueryJson } from "./db/sqlite3.js";

function nowSessionId(prefix) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = randomBytes(3).toString("hex");
  return `${prefix}-${ts}-${rand}`;
}

export async function readCurrentSessionId(rootDir) {
  const globalPaths = dagainPaths(rootDir);
  if (!(await pathExists(globalPaths.currentSessionPath))) return null;
  try {
    const raw = await readFile(globalPaths.currentSessionPath, "utf8");
    const parsed = JSON.parse(raw);
    const id = String(parsed?.id || "").trim();
    return id || null;
  } catch {
    return null;
  }
}

export async function writeCurrentSessionId(rootDir, sessionId) {
  const globalPaths = dagainPaths(rootDir);
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Missing sessionId");
  await writeJsonAtomic(globalPaths.currentSessionPath, { id });
  await ensureLegacyCompatLinks(rootDir, id);
}

export async function listSessionIds(rootDir) {
  const globalPaths = dagainPaths(rootDir);
  if (!(await pathExists(globalPaths.sessionsDir))) return [];
  const entries = await readdir(globalPaths.sessionsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function migrateLegacyState(rootDir) {
  const globalPaths = dagainPaths(rootDir);
  const legacyStateDir = globalPaths.stateDir;

  const legacyDb = path.join(legacyStateDir, "state.sqlite");
  const legacyGraph = path.join(legacyStateDir, "workgraph.json");
  const legacyLock = path.join(legacyStateDir, "lock");
  const legacyDirs = ["checkpoints", "runs", "artifacts", "memory", "tmp"];

  const legacyDirExists = await Promise.all(legacyDirs.map((d) => pathExists(path.join(legacyStateDir, d))));
  const hasLegacy =
    (await pathExists(legacyDb)) ||
    (await pathExists(legacyGraph)) ||
    (await pathExists(legacyLock)) ||
    legacyDirExists.some(Boolean);

  const legacyGoal = path.join(rootDir, "GOAL.md");
  const hasLegacyGoal = await pathExists(legacyGoal);

  if (!hasLegacy && !hasLegacyGoal) return null;

  const sessionId = nowSessionId("legacy");
  const sessionPaths = dagainSessionPaths(rootDir, sessionId);
  await ensureDir(sessionPaths.sessionDir);

  const moves = [
    { from: legacyDb, to: sessionPaths.dbPath },
    { from: legacyGraph, to: sessionPaths.graphPath },
    { from: legacyLock, to: sessionPaths.lockPath },
    ...legacyDirs.map((d) => ({ from: path.join(legacyStateDir, d), to: path.join(sessionPaths.sessionDir, d) })),
  ];

  for (const { from, to } of moves) {
    if (!(await pathExists(from))) continue;
    await rename(from, to);
  }

  if (hasLegacyGoal) {
    await rename(legacyGoal, sessionPaths.goalPath);
  }

  await ensureLegacyCompatLinks(rootDir, sessionId);
  return sessionId;
}

async function ensureSymlink(linkPath, targetPath, { type = "file" } = {}) {
  const exists = await pathExists(linkPath);
  if (exists) {
    const st = await lstat(linkPath).catch(() => null);
    if (st?.isSymbolicLink()) {
      await rm(linkPath, { force: true });
    } else if (st) {
      // A previous dagain version (or a user/tool) may have replaced the compat link with a real file/dir.
      // That breaks session switching because the "current session view" can no longer be rewired.
      //
      // Only force-rewire when the target is a session-scoped path; otherwise keep existing behavior.
      const sessionMarker = `${path.sep}sessions${path.sep}`;
      const shouldRewire = String(targetPath || "").includes(sessionMarker);
      if (!shouldRewire) return;

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const rand = randomBytes(3).toString("hex");
      const backupPath = `${linkPath}.bak-${ts}-${rand}`;
      try {
        await rename(linkPath, backupPath);
      } catch (error) {
        const msg = error?.message || String(error);
        throw new Error(`Failed to move aside compat path before rewiring: ${linkPath} -> ${backupPath}: ${msg}`);
      }
    }
  }
  const linkDir = path.dirname(linkPath);
  const rel = path.relative(linkDir, targetPath);
  const symlinkType = type === "dir" && process.platform === "win32" ? "junction" : type;
  try {
    await symlink(rel, linkPath, symlinkType);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") return;
    throw error;
  }
}

export async function ensureLegacyCompatLinks(rootDir, sessionId) {
  const globalPaths = dagainPaths(rootDir);
  const sessionPaths = dagainSessionPaths(rootDir, sessionId);
  await ensureDir(globalPaths.stateDir);
  await ensureDir(sessionPaths.sessionDir);

  await ensureSymlink(path.join(globalPaths.stateDir, "state.sqlite"), sessionPaths.dbPath, { type: "file" });
  await ensureSymlink(path.join(globalPaths.stateDir, "workgraph.json"), sessionPaths.graphPath, { type: "file" });
  await ensureSymlink(path.join(globalPaths.stateDir, "lock"), sessionPaths.lockPath, { type: "file" });
  await ensureSymlink(path.join(globalPaths.stateDir, "GOAL.md"), sessionPaths.goalPath, { type: "file" });
  await ensureSymlink(path.join(globalPaths.stateDir, "checkpoints"), sessionPaths.checkpointsDir, { type: "dir" });
  await ensureSymlink(path.join(globalPaths.stateDir, "runs"), sessionPaths.runsDir, { type: "dir" });
  await ensureSymlink(path.join(globalPaths.stateDir, "artifacts"), sessionPaths.artifactsDir, { type: "dir" });
  await ensureSymlink(path.join(globalPaths.stateDir, "memory"), sessionPaths.memoryDir, { type: "dir" });
  await ensureSymlink(path.join(globalPaths.stateDir, "tmp"), sessionPaths.tmpDir, { type: "dir" });
}

export async function ensureSessionLayout(rootDir) {
  const globalPaths = dagainPaths(rootDir);
  await ensureDir(globalPaths.stateDir);
  await ensureDir(globalPaths.sessionsDir);

  const current = await readCurrentSessionId(rootDir);
  if (current) {
    const sessionPaths = dagainSessionPaths(rootDir, current);
    if (await pathExists(sessionPaths.sessionDir)) {
      await ensureLegacyCompatLinks(rootDir, current);
      return current;
    }
  }

  const migrated = await migrateLegacyState(rootDir);
  if (migrated) {
    await writeCurrentSessionId(rootDir, migrated);
    return migrated;
  }

  const created = nowSessionId("session");
  const sessionPaths = dagainSessionPaths(rootDir, created);
  await ensureDir(sessionPaths.sessionDir);
  await writeCurrentSessionId(rootDir, created);
  return created;
}

export async function isSessionActive({ rootDir, sessionId }) {
  const sessionPaths = dagainSessionPaths(rootDir, sessionId);

  const lock = await readSupervisorLock(sessionPaths.lockPath).catch(() => null);
  const pid = Number(lock?.pid);
  const lockHost = String(lock?.host || "").trim();
  if (Number.isFinite(pid) && pid > 0 && lockHost === os.hostname()) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // ignore
    }
  }

  if (!(await pathExists(sessionPaths.dbPath))) return false;
  try {
    const rows = await sqliteQueryJson(
      sessionPaths.dbPath,
      "SELECT id FROM nodes WHERE status != 'done' LIMIT 1;",
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function sessionHasState({ rootDir, sessionId }) {
  const sessionPaths = dagainSessionPaths(rootDir, sessionId);
  if (await pathExists(sessionPaths.dbPath)) return true;
  if (await pathExists(sessionPaths.goalPath)) return true;
  if (await pathExists(sessionPaths.graphPath)) return true;
  try {
    const entries = await readdir(sessionPaths.sessionDir, { withFileTypes: true });
    return entries.some((e) => e.name !== "." && e.name !== "..");
  } catch {
    return false;
  }
}

export async function createNewSession(rootDir) {
  const id = nowSessionId("session");
  const sessionPaths = dagainSessionPaths(rootDir, id);
  await ensureDir(sessionPaths.sessionDir);
  await ensureDir(sessionPaths.checkpointsDir);
  await ensureDir(sessionPaths.runsDir);
  await ensureDir(sessionPaths.artifactsDir);
  await ensureDir(sessionPaths.memoryDir);
  await ensureDir(sessionPaths.tmpDir);
  await writeCurrentSessionId(rootDir, id);
  await ensureLegacyCompatLinks(rootDir, id);
  return id;
}
