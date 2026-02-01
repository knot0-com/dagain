import os from "node:os";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

import { ensureDir, pathExists, writeJsonAtomic } from "./fs.js";

function nowIso() {
  return new Date().toISOString();
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    // EPERM => process exists but we can't signal it; treat as alive.
    if (error?.code === "EPERM") return true;
    return false;
  }
}

async function safeReadJson(lockPath) {
  try {
    const text = await readFile(lockPath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isStaleSupervisorLock(lock, { staleSeconds = 0 } = {}) {
  const host = os.hostname();
  const lockHost = typeof lock?.host === "string" ? lock.host : "";
  const lockPid = Number(lock?.pid);

  if (lockHost === host && Number.isFinite(lockPid) && lockPid > 0) {
    return !isPidAlive(lockPid);
  }

  const n = Number(staleSeconds);
  if (!Number.isFinite(n) || n <= 0) return false;
  const stamp = String(lock?.heartbeatAt || lock?.startedAt || "");
  const t = new Date(stamp).getTime();
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) / 1000 > n;
}

async function writeLockExclusive(lockPath, value) {
  const dir = path.dirname(lockPath);
  await ensureDir(dir);
  const text = JSON.stringify(value, null, 2) + "\n";
  await writeFile(lockPath, text, { encoding: "utf8", flag: "wx" });
}

export async function readSupervisorLock(lockPath) {
  if (!(await pathExists(lockPath))) return null;
  const lock = await safeReadJson(lockPath);
  if (!lock || typeof lock !== "object") return null;
  return lock;
}

export async function acquireSupervisorLock(lockPath, { staleSeconds = 0 } = {}) {
  const lock = {
    version: 1,
    pid: process.pid,
    host: os.hostname(),
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
  };

  try {
    await writeLockExclusive(lockPath, lock);
    return { ok: true, lock };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const existing = await readSupervisorLock(lockPath);
  if (!existing) {
    try {
      await rm(lockPath, { force: true });
    } catch {
      // ignore
    }
    await writeLockExclusive(lockPath, lock);
    return { ok: true, lock };
  }

  if (isStaleSupervisorLock(existing, { staleSeconds })) {
    try {
      await rm(lockPath, { force: true });
    } catch {
      // ignore
    }
    await writeLockExclusive(lockPath, lock);
    return { ok: true, lock };
  }

  return { ok: false, lock: existing };
}

export async function heartbeatSupervisorLock(lockPath) {
  const current = await readSupervisorLock(lockPath);
  if (!current) return;
  if (Number(current.pid) !== process.pid) return;
  if (String(current.host || "") !== os.hostname()) return;

  current.heartbeatAt = nowIso();
  await writeJsonAtomic(lockPath, current);
}

export async function releaseSupervisorLock(lockPath) {
  const current = await readSupervisorLock(lockPath);
  if (!current) return;
  if (Number(current.pid) !== process.pid) return;
  if (String(current.host || "") !== os.hostname()) return;
  try {
    await rm(lockPath, { force: true });
  } catch {
    // ignore
  }
}

