import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";

export function resolveRoleRunner(role, config) {
  const roles = config?.roles || {};
  const raw = roles[role] ?? roles.main;
  const list = normalizeRunnerList(raw);
  if (list.length === 0) return "";
  return list[0];
}

export function resolveNodeRole(node) {
  const type = String(node?.type || "").toLowerCase();
  if (type === "task") return "executor";
  if (type === "verify") return "verifier";
  if (type === "integrate") return "integrator";
  if (type === "plan" || type === "epic") return "planner";
  if (type === "final_verify" || type === "final-verify") return "finalVerifier";
  return "executor";
}

export function normalizeRunnerList(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => String(v || "").trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (!trimmed.includes(",")) return [trimmed];
    return trimmed
      .split(",")
      .map((v) => String(v || "").trim())
      .filter(Boolean);
  }
  return [];
}

function fnv1a32(text) {
  let h = 0x811c9dc5;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function resolveRoleRunnerPick(role, config, { seed = "", attempt = 0 } = {}) {
  const roles = config?.roles || {};
  const raw = roles[role] ?? roles.main;
  const list = normalizeRunnerList(raw);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  const key = `${role}|${seed}|${attempt}`;
  const idx = fnv1a32(key) % list.length;
  return list[idx];
}

function substitutePacket(cmd, packetPathAbs) {
  return cmd.split("{packet}").join(shellQuotePosix(packetPathAbs));
}

function shellQuotePosix(value) {
  const v = String(value);
  return `'${v.replace(/'/g, "'\"'\"'")}'`;
}

function stripClaudeDangerousOnRoot(cmd) {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!isRoot) return cmd;
  if (!cmd.includes("--dangerously-skip-permissions")) return cmd;
  return cmd
    .replace(/\s--dangerously-skip-permissions\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripClaudeDangerousOnRootForUid(cmd, uid) {
  const n = Number(uid);
  const isRoot = Number.isFinite(n) ? n === 0 : typeof process.getuid === "function" && process.getuid() === 0;
  if (!isRoot) return cmd;
  return stripClaudeDangerousOnRoot(cmd);
}

function killProcessTree(child, signal) {
  const sig = signal || "SIGTERM";
  try {
    if (child?.pid) {
      process.kill(-child.pid, sig);
      return;
    }
  } catch {
    // ignore
  }
  try {
    child?.kill?.(sig);
  } catch {
    // ignore
  }
}

function createLinePrefixTransform(prefix) {
  const p = String(prefix || "");
  if (!p) return null;
  let atLineStart = true;
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const endsWithNewline = text.endsWith("\n");
        const parts = text.split("\n");
        let out = "";
        for (let i = 0; i < parts.length; i += 1) {
          const isLast = i === parts.length - 1;
          const line = parts[i];
          if (isLast && endsWithNewline && line === "") break;
          if (atLineStart) out += p;
          out += line;
          if (!isLast) {
            out += "\n";
            atLineStart = true;
            continue;
          }
          if (endsWithNewline) {
            out += "\n";
            atLineStart = true;
          } else {
            atLineStart = false;
          }
        }
        callback(null, out);
      } catch (error) {
        callback(error);
      }
    },
  });
}

export async function runRunnerCommand({
  cmd,
  packetPath,
  cwd,
  logPath,
  timeoutMs = 0,
  tee = false,
  teePrefix = null,
  abortSignal = null,
  env = null,
  uid = null,
  gid = null,
}) {
  const packetAbs = path.resolve(cwd, packetPath);
  const logStream = createWriteStream(logPath, { flags: "w" });

  const usesPacketPlaceholder = cmd.includes("{packet}");
  const finalCmdRaw = usesPacketPlaceholder ? substitutePacket(cmd, packetAbs) : cmd;
  const finalCmd = stripClaudeDangerousOnRootForUid(finalCmdRaw, uid);
  const envOverrides = env && typeof env === "object" ? env : null;
  let finalEnv = process.env;
  if (envOverrides) {
    const merged = { ...process.env };
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value == null) {
        delete merged[key];
        continue;
      }
      merged[key] = String(value);
    }
    finalEnv = merged;
  }

  return new Promise((resolve) => {
    let settled = false;
    let abortHandler = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try {
        if (abortSignal && abortHandler) abortSignal.removeEventListener("abort", abortHandler);
      } catch {
        // ignore
      }
      try {
        logStream.end(() => resolve(payload));
        return;
      } catch {
        // ignore
      }
      resolve(payload);
    };

    try {
      logStream.write(`[choreo] cmd: ${finalCmd}\n`);
      logStream.write(`[choreo] cwd: ${cwd}\n`);
      logStream.write(`[choreo] packet: ${packetAbs}\n`);
      if (uid != null || gid != null) logStream.write(`[choreo] as: uid=${uid ?? ""} gid=${gid ?? ""}\n`);
      if (timeoutMs && Number(timeoutMs) > 0) logStream.write(`[choreo] timeoutMs: ${Number(timeoutMs)}\n`);
      if (envOverrides) {
        const keys = Object.keys(envOverrides).sort();
        if (keys.length > 0) logStream.write(`[choreo] env overrides: ${keys.join(", ")}\n`);
      }
      logStream.write("\n");
    } catch {
      // ignore
    }

    const canSetIds = typeof process.getuid === "function" && process.getuid() === 0;
    const uidNum = Number(uid);
    const gidNum = Number(gid);
    const child = spawn(finalCmd, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: finalEnv,
      ...(canSetIds && Number.isFinite(uidNum) && uidNum >= 0 ? { uid: uidNum } : {}),
      ...(canSetIds && Number.isFinite(gidNum) && gidNum >= 0 ? { gid: gidNum } : {}),
    });

    let killedByTimeout = false;
    let killedByAbort = false;
    const timeoutNum = Number(timeoutMs);
    let timeoutId = null;
    if (Number.isFinite(timeoutNum) && timeoutNum > 0) {
      timeoutId = setTimeout(() => {
        killedByTimeout = true;
        try {
          logStream.write(`[choreo] ERROR: runner timed out after ${timeoutNum}ms\n`);
        } catch {
          // ignore
        }
        try {
          killProcessTree(child, "SIGTERM");
        } catch {
          // ignore
        }
        const killId = setTimeout(() => {
          try {
            killProcessTree(child, "SIGKILL");
          } catch {
            // ignore
          }
        }, 5_000);
        killId.unref?.();
      }, timeoutNum);
      timeoutId.unref?.();
    }

    abortHandler = () => {
      killedByAbort = true;
      try {
        logStream.write("[choreo] CANCEL: abortSignal triggered\n");
      } catch {
        // ignore
      }
      killProcessTree(child, "SIGTERM");
      const killId = setTimeout(() => killProcessTree(child, "SIGKILL"), 5_000);
      killId.unref?.();
    };

    if (abortSignal) {
      if (abortSignal.aborted) abortHandler();
      else abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    if (tee) {
      const stdoutPrefix = typeof teePrefix?.stdout === "string" ? teePrefix.stdout : "";
      const stderrPrefix = typeof teePrefix?.stderr === "string" ? teePrefix.stderr : "";
      const outXform = createLinePrefixTransform(stdoutPrefix);
      const errXform = createLinePrefixTransform(stderrPrefix);
      if (outXform) child.stdout.pipe(outXform).pipe(process.stdout, { end: false });
      else child.stdout.pipe(process.stdout, { end: false });
      if (errXform) child.stderr.pipe(errXform).pipe(process.stderr, { end: false });
      else child.stderr.pipe(process.stderr, { end: false });
    }

    if (!usesPacketPlaceholder) {
      const packetStream = createReadStream(packetAbs);
      packetStream.on("error", (error) => {
        try {
          logStream.write(`[choreo] ERROR: failed reading packet for stdin: ${error?.message || String(error)}\n`);
        } catch {
          // ignore
        }
      });
      if (child.stdin) {
        child.stdin.on("error", (error) => {
          if (error?.code === "EPIPE") return;
          try {
            logStream.write(`[choreo] ERROR: stdin pipe failed: ${error?.message || String(error)}\n`);
          } catch {
            // ignore
          }
        });
        packetStream.pipe(child.stdin);
      }
    } else {
      child.stdin.end();
    }

    child.on("error", (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      try {
        logStream.write(`[choreo] ERROR: spawn failed: ${error?.message || String(error)}\n`);
      } catch {
        // ignore
      }
      finish({
        code: 127,
        signal: null,
        cmd: finalCmd,
        timedOut: false,
        aborted: killedByAbort,
        error: error?.message || String(error),
      });
    });

    child.on("close", (code, signal) => {
      if (timeoutId) clearTimeout(timeoutId);
      finish({
        code: code ?? 0,
        signal: signal || null,
        cmd: finalCmd,
        timedOut: killedByTimeout,
        aborted: killedByAbort,
      });
    });
  });
}
