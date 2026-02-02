// Input — node:child_process/fs/path, repo root path, and allowlisted ctx.* op specs. If this file changes, update this header and the folder Markdown.
// Output — `executeContextOps()` for safe read-only context gathering + `formatContextOpsResults()` for prompt injection. If this file changes, update this header and the folder Markdown.
// Position — Shared helper used by web/TUI chat to gather extra context without giving the router arbitrary tool access. If this file changes, update this header and the folder Markdown.

import { spawn } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";

function truncateText(value, maxLen) {
  const s = String(value ?? "");
  const n = Number(maxLen);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (!limit) return "";
  if (s.length <= limit) return s;
  return s.slice(0, Math.max(0, limit - 1)) + "\u2026";
}

function safeRelPath(relPathRaw) {
  const rel = typeof relPathRaw === "string" ? relPathRaw.trim() : "";
  if (!rel) return null;
  if (rel.includes("\0")) return null;
  if (path.isAbsolute(rel)) return null;
  const norm = path.normalize(rel).replaceAll("\\", "/");
  if (norm.startsWith("../") || norm === "..") return null;
  return norm;
}

function resolvePathWithinRoot(rootDir, relPathRaw) {
  const rel = safeRelPath(relPathRaw);
  if (!rel) return null;
  const abs = path.resolve(rootDir, rel);
  const root = path.resolve(rootDir);
  if (abs === root) return abs;
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}

async function runCommandCapture({ cwd, cmd, args, timeoutMs = 1500, maxBytes = 10_000 }) {
  const maxBytesNum = Number(maxBytes);
  const limit = Number.isFinite(maxBytesNum) && maxBytesNum > 0 ? Math.floor(maxBytesNum) : 10_000;
  const timeoutNum = Number(timeoutMs);
  const timeout = Number.isFinite(timeoutNum) && timeoutNum > 0 ? Math.floor(timeoutNum) : 1500;

  return await new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, code: 1, stdout: "", stderr: String(error?.message || error || "spawn error"), timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeout);

    function onStdout(d) {
      if (!d) return;
      const s = String(d);
      stdoutBytes += Buffer.byteLength(s);
      if (stdoutBytes <= limit) stdout += s;
    }
    function onStderr(d) {
      if (!d) return;
      const s = String(d);
      stderrBytes += Buffer.byteLength(s);
      if (stderrBytes <= limit) stderr += s;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("error", (error) => {
      clearTimeout(killTimer);
      resolve({ ok: false, code: 1, stdout, stderr: stderr || String(error?.message || error || "spawn error"), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      const c = typeof code === "number" ? code : 0;
      resolve({ ok: c === 0 && !timedOut, code: c, stdout, stderr, timedOut });
    });
  });
}

export function isContextOp(op) {
  const type = typeof op?.type === "string" ? op.type.trim() : "";
  return Boolean(type) && type.startsWith("ctx.");
}

export async function executeContextOps({ rootDir, ops, maxOps = 3 }) {
  const root = typeof rootDir === "string" && rootDir.trim() ? rootDir : null;
  if (!root) return [];
  const opList = Array.isArray(ops) ? ops : [];
  const maxOpsNum = Number(maxOps);
  const max = Number.isFinite(maxOpsNum) && maxOpsNum > 0 ? Math.floor(maxOpsNum) : 3;

  const out = [];
  for (const raw of opList.slice(0, max)) {
    const type = typeof raw?.type === "string" ? raw.type.trim() : "";
    if (!type || !type.startsWith("ctx.")) continue;

    if (type === "ctx.readFile") {
      const rel = typeof raw?.path === "string" ? raw.path.trim() : "";
      const abs = resolvePathWithinRoot(root, rel);
      const maxBytes = Number(raw?.maxBytes ?? 8_000);
      const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 8_000;
      if (!abs) {
        out.push({ type, ok: false, summary: "Invalid path (must be within repo root).", meta: { path: rel } });
        continue;
      }
      try {
        const text = await readFile(abs, "utf8");
        out.push({
          type,
          ok: true,
          summary: `Read ${path.relative(root, abs) || rel}`,
          meta: { path: path.relative(root, abs) || rel },
          text: truncateText(text, limit),
        });
      } catch (error) {
        out.push({
          type,
          ok: false,
          summary: `Failed to read ${path.relative(root, abs) || rel}: ${error?.message || String(error)}`,
          meta: { path: path.relative(root, abs) || rel },
        });
      }
      continue;
    }

    if (type === "ctx.rg") {
      const pattern = typeof raw?.pattern === "string" ? raw.pattern : "";
      const glob = typeof raw?.glob === "string" ? raw.glob.trim() : "";
      const maxMatchesNum = Number(raw?.maxMatches ?? 50);
      const maxMatches = Number.isFinite(maxMatchesNum) && maxMatchesNum > 0 ? Math.floor(maxMatchesNum) : 50;
      const safePattern = truncateText(pattern, 200);
      if (!safePattern) {
        out.push({ type, ok: false, summary: "Missing pattern.", meta: {} });
        continue;
      }

      const args = ["--color=never", "--no-heading", "-n", "--max-count", String(maxMatches)];
      if (glob) args.push("--glob", glob);
      args.push(safePattern, ".");
      const res = await runCommandCapture({ cwd: root, cmd: "rg", args, timeoutMs: 2000, maxBytes: 12_000 });
      if (!res.ok && /ENOENT/i.test(String(res.stderr || ""))) {
        // Fallback: grep -R (best-effort)
        const grepArgs = ["-R", "-n", "--", safePattern, "."];
        const grepRes = await runCommandCapture({ cwd: root, cmd: "grep", args: grepArgs, timeoutMs: 2000, maxBytes: 12_000 });
        out.push({
          type,
          ok: grepRes.ok,
          summary: grepRes.ok ? `grep matches for ${JSON.stringify(safePattern)}` : `grep failed (code=${grepRes.code})`,
          meta: { pattern: safePattern, glob: glob || null },
          text: truncateText(grepRes.stdout || grepRes.stderr || "", 12_000),
        });
        continue;
      }

      out.push({
        type,
        ok: res.ok,
        summary: res.ok ? `rg matches for ${JSON.stringify(safePattern)}` : `rg failed (code=${res.code}${res.timedOut ? ", timeout" : ""})`,
        meta: { pattern: safePattern, glob: glob || null },
        text: truncateText(res.stdout || res.stderr || "", 12_000),
      });
      continue;
    }

    if (type === "ctx.gitStatus") {
      const res = await runCommandCapture({ cwd: root, cmd: "git", args: ["status", "--porcelain=v1", "-b"], timeoutMs: 2000, maxBytes: 12_000 });
      out.push({
        type,
        ok: res.ok,
        summary: res.ok ? "git status (porcelain)" : `git status failed (code=${res.code}${res.timedOut ? ", timeout" : ""})`,
        meta: {},
        text: truncateText(res.stdout || res.stderr || "", 12_000),
      });
      continue;
    }

    if (type === "ctx.gitDiffStat") {
      const res = await runCommandCapture({ cwd: root, cmd: "git", args: ["diff", "--stat"], timeoutMs: 2000, maxBytes: 12_000 });
      out.push({
        type,
        ok: res.ok,
        summary: res.ok ? "git diff --stat" : `git diff --stat failed (code=${res.code}${res.timedOut ? ", timeout" : ""})`,
        meta: {},
        text: truncateText(res.stdout || res.stderr || "", 12_000),
      });
      continue;
    }

    out.push({ type, ok: false, summary: "Unknown/unsupported ctx op.", meta: {} });
  }

  return out;
}

export function formatContextOpsResults(results) {
  const rows = Array.isArray(results) ? results : [];
  if (rows.length === 0) return "";
  const lines = [];
  lines.push("Context ops results:");
  for (const r of rows) {
    const type = typeof r?.type === "string" ? r.type : "ctx.unknown";
    const summary = typeof r?.summary === "string" ? r.summary : "";
    lines.push(`- ${type}: ${summary || (r?.ok ? "ok" : "failed")}`);
    const meta = r?.meta && typeof r.meta === "object" ? r.meta : null;
    if (meta?.path) lines.push(`  - path: ${meta.path}`);
    if (meta?.pattern) lines.push(`  - pattern: ${meta.pattern}`);
    if (meta?.glob) lines.push(`  - glob: ${meta.glob}`);
    const text = typeof r?.text === "string" ? r.text.trim() : "";
    if (text) {
      lines.push("  - output:");
      for (const ln of text.split("\n").slice(0, 40)) lines.push(`    ${ln}`);
    }
  }
  return lines.join("\n");
}

