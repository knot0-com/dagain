// Input — node:http/crypto/fs/path/child_process/url + dagain DB snapshot/kv/control helpers. If this file changes, update this header and the folder Markdown.
// Output — `serveDashboard()` local HTTP dashboard server (HTML+SSE+control/log/chat APIs). If this file changes, update this header and the folder Markdown.
// Position — Minimal web UI for live DAG viewing (animated layout + pan/zoom + chat) and safe controls. If this file changes, update this header and the folder Markdown.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { open, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadDashboardSnapshot } from "../lib/dashboard.js";
import { kvGet, kvPut } from "../lib/db/kv.js";
import { mailboxEnqueue } from "../lib/db/mailbox.js";
import { ensureMailboxTable } from "../lib/db/migrate.js";
import { dagainSessionPaths, loadConfig, saveConfig, defaultConfig } from "../lib/config.js";
import { executeContextOps, formatContextOpsResults, isContextOp } from "../lib/context-ops.js";
import { readSupervisorLock } from "../lib/lock.js";
import { createNewSession, ensureSessionLayout, listSessionIds, readCurrentSessionId, writeCurrentSessionId } from "../lib/sessions.js";

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2) + "\n";
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
}

function safeJsonParse(text, fallback = null) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function truncateText(value, maxLen) {
  const s = String(value ?? "");
  const n = Number(maxLen);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (!limit) return "";
  if (s.length <= limit) return s;
  return s.slice(0, Math.max(0, limit - 1)) + "\u2026";
}

function formatNodeLine(node) {
  const id = node?.id || "(missing-id)";
  const title = node?.title || "(untitled)";
  const type = node?.type || "(type?)";
  const status = node?.status || (node?.lock?.runId ? "in_progress" : "(status?)");
  const q =
    String(status || "").toLowerCase() === "needs_human" && node?.checkpoint?.question
      ? ` — q: ${truncateText(node.checkpoint.question, 80)}`
      : "";
  return `${id} [${type}] (${status}) \u2014 ${title}${q}`;
}

function dagainBinPath() {
  return fileURLToPath(new URL("../../bin/dagain.js", import.meta.url));
}

function runCliCapture({ cwd, args }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [dagainBinPath(), ...args], {
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
    child.on("close", (code, signal) => resolve({ code: code ?? 0, signal: signal ?? null, stdout, stderr }));
    child.on("error", (err) =>
      resolve({ code: 1, signal: null, stdout: "", stderr: String(err?.message || err || "spawn error") }),
    );
  });
}

async function readJsonBody(req, { maxBytes = 64_000 } = {}) {
  const limitRaw = Number(maxBytes);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 64_000;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(new Error(`Request body too large (>${limit} bytes).`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const parsed = safeJsonParse(bodyText, null);
      if (!parsed || typeof parsed !== "object") {
        reject(new Error("Invalid JSON body."));
        return;
      }
      resolve(parsed);
    });
    req.on("error", reject);
  });
}

async function readTailText(filePath, maxBytes) {
  const nRaw = Number(maxBytes);
  const n = Number.isFinite(nRaw) && nRaw > 0 ? Math.floor(nRaw) : 10_000;
  try {
    const fh = await open(filePath, "r");
    try {
      const stat = await fh.stat();
      const size = Number(stat.size || 0);
      const start = Math.max(0, size - n);
      const len = Math.max(0, size - start);
      if (!len) return "";
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

function formatHumanResultText(result) {
  const status = typeof result?.status === "string" ? result.status.trim() : "";
  const summary = typeof result?.summary === "string" ? result.summary.trim() : "";
  const lines = [];
  if (status) lines.push(`status: ${status}`);
  if (summary) lines.push(`summary: ${summary}`);
  const checkpoint = result?.checkpoint && typeof result.checkpoint === "object" ? result.checkpoint : null;
  const question = typeof checkpoint?.question === "string" ? checkpoint.question.trim() : "";
  const context = typeof checkpoint?.context === "string" ? checkpoint.context.trim() : "";
  const options = Array.isArray(checkpoint?.options) ? checkpoint.options.map((o) => String(o)) : [];
  if (question) lines.push(`question: ${question}`);
  if (context) lines.push(`context: ${context}`);
  if (options.length > 0) {
    lines.push("options:");
    for (const opt of options) lines.push(`- ${opt}`);
  }
  return lines.join("\n").trim();
}

async function readResultHumanText(resultPathAbs) {
  if (!resultPathAbs) return "";
  try {
    const raw = await readFile(resultPathAbs, "utf8");
    const parsed = safeJsonParse(raw, null);
    if (!parsed) return "";
    return formatHumanResultText(parsed);
  } catch {
    return "";
  }
}

function safeResolveUnderRoot(rootDir, relPath) {
  const root = path.resolve(String(rootDir || "."));
  const rel = String(relPath || "").trim();
  if (!rel) return null;
  if (path.isAbsolute(rel)) return null;
  const resolved = path.resolve(root, rel);
  if (resolved === root) return null;
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/* ── Static file serving ──────────────────────────────────────────────── */

const __uiDir = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.join(__uiDir, "static");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const staticCache = new Map();

async function readStaticFile(filename) {
  if (staticCache.has(filename)) return staticCache.get(filename);
  const filePath = path.join(staticDir, filename);
  const content = await readFile(filePath, "utf8");
  staticCache.set(filename, content);
  return content;
}

/* ── Dashboard server ─────────────────────────────────────────────────── */

export async function serveDashboard({ paths, host = "127.0.0.1", port = 3876 }) {
  const token = randomBytes(18).toString("hex");
  let lastSnapshot = null;
  let lastSnapshotAt = 0;
  const snapshotTtlMs = 200;

  async function getSnapshot() {
    const now = Date.now();
    if (lastSnapshot && now - lastSnapshotAt < snapshotTtlMs) return lastSnapshot;
    lastSnapshot = await loadDashboardSnapshot({ paths });
    lastSnapshotAt = now;
    return lastSnapshot;
  }

  async function requireToken(req) {
    const got = String(req.headers["x-dagain-token"] || "").trim();
    if (!got || got !== token) throw new Error("Unauthorized");
  }

  async function enqueueControl({ command, args }) {
    await ensureMailboxTable({ dbPath: paths.dbPath });
    const res = await mailboxEnqueue({ dbPath: paths.dbPath, command, args: args ?? {}, nowIso: new Date().toISOString() });
    return res.id;
  }

  async function readRunningSupervisorLock() {
    const lock = await readSupervisorLock(paths.lockPath).catch(() => null);
    const pid = Number(lock?.pid);
    const lockHost = String(lock?.host || "").trim();
    if (Number.isFinite(pid) && pid > 0 && lockHost === os.hostname()) {
      try {
        process.kill(pid, 0);
        return lock;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function startSupervisorDetached() {
    const existing = await readRunningSupervisorLock();
    if (existing?.pid) return { alreadyRunning: true, pid: Number(existing.pid) || 0, message: "Supervisor already running." };

    // Spawn fully detached (no stdout/stderr pipes). Piped/destroyed stdio can cause the supervisor
    // to terminate later due to EPIPE when it writes logs.
    const child = spawn(process.execPath, [dagainBinPath(), "run", "--no-live", "--no-color", "--no-prompt"], {
      cwd: paths.rootDir,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const pid = child.pid || 0;
    let exited = null;
    child.on("exit", (code) => {
      exited = code ?? 0;
    });
    child.unref?.();

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (exited !== null && exited !== 0) throw new Error(`Supervisor exited with code ${exited}.`);
      const lock = await readRunningSupervisorLock();
      if (lock?.pid && Number(lock.pid) === pid) return { alreadyRunning: false, pid, message: `Started supervisor pid=${pid}.` };
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
    }

    return { alreadyRunning: false, pid, message: `Started supervisor pid=${pid}.` };
  }

  function respondError(res, error) {
    const message = error?.message || String(error);
    const code = error?.code || "";
    if (message === "Unauthorized") return json(res, 401, { error: "Unauthorized" });
    if (message.startsWith("Request body too large")) return json(res, 413, { error: message });
    if (message === "Invalid JSON body.") return json(res, 400, { error: message });
    if (code === "ENOENT") return json(res, 404, { error: message });
    return json(res, 500, { error: message });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/") {
        const template = await readStaticFile("index.html");
        const html = template.replace("__DAGAIN_TOKEN__", token);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/static/")) {
        const relPath = url.pathname.slice("/static/".length);
        if (!relPath || relPath.includes("..") || relPath.includes("\\") || path.isAbsolute(relPath)) {
          return notFound(res);
        }
        const ext = path.extname(relPath);
        const mime = MIME_TYPES[ext];
        if (!mime) return notFound(res);
        try {
          const content = await readStaticFile(relPath);
          res.writeHead(200, { "content-type": mime });
          res.end(content);
        } catch {
          notFound(res);
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const snapshot = await getSnapshot();
        json(res, 200, snapshot);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/node/log") {
        const nodeId = String(url.searchParams.get("id") || "").trim();
        if (!nodeId) return json(res, 400, { error: "Missing ?id=<nodeId>." });
        const tail = Number(url.searchParams.get("tail") || 10_000);

        const snapshot = await getSnapshot();
        const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
        const node = nodes.find((n) => n?.id === nodeId) || null;
        if (!node) return json(res, 404, { error: `Node not found: ${nodeId}` });

        const lockRunId = typeof node?.lock?.runId === "string" ? node.lock.runId : "";
        let resultRel = "";
        if (lockRunId) {
          resultRel = path.relative(paths.rootDir, path.join(paths.runsDir, lockRunId, "result.json"));
        } else {
          const resultRow = await kvGet({ dbPath: paths.dbPath, nodeId, key: "out.last_result_path" }).catch(() => null);
          resultRel = typeof resultRow?.value_text === "string" ? resultRow.value_text.trim() : "";
        }

        const resultAbs = resultRel ? safeResolveUnderRoot(paths.rootDir, resultRel) : null;
        const text = resultAbs ? await readResultHumanText(resultAbs) : "";
        json(res, 200, { nodeId, path: resultRel || "", text: text || (lockRunId ? "status: in_progress" : "") });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        await ensureSessionLayout(paths.rootDir);
        const currentId = await readCurrentSessionId(paths.rootDir);
        const ids = await listSessionIds(paths.rootDir);
        const sessions = [];
        for (const id of ids) {
          const sp = dagainSessionPaths(paths.rootDir, id);
          let hasDb = false;
          try {
            await stat(sp.dbPath);
            hasDb = true;
          } catch {
            hasDb = false;
          }
          sessions.push({ id, current: id === currentId, hasDb });
        }
        json(res, 200, { ok: true, currentId: currentId || "", sessions });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/sessions/select") {
        await requireToken(req);
        const body = await readJsonBody(req, { maxBytes: 2_000 });
        const id = typeof body?.id === "string" ? body.id.trim() : "";
        if (!id) return json(res, 400, { error: "Missing session id." });
        const sp = dagainSessionPaths(paths.rootDir, id);
        try {
          const st = await stat(sp.sessionDir);
          if (!st.isDirectory()) throw new Error("not a dir");
        } catch {
          return json(res, 404, { error: `Unknown session: ${id}` });
        }
        await writeCurrentSessionId(paths.rootDir, id);
        json(res, 200, { ok: true, id });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/sessions/new") {
        await requireToken(req);
        const id = await createNewSession(paths.rootDir);
        const initRes = await runCliCapture({ cwd: paths.rootDir, args: ["init", "--no-refine", "--reuse", "--no-color"] });
        if (initRes.code !== 0) {
          return json(res, 500, { error: initRes.stderr.trim() || initRes.stdout.trim() || "init failed" });
        }
        json(res, 200, { ok: true, id });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/runs") {
        const limitRaw = Number(url.searchParams.get("limit") || 60);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 60;
        const entries = await readdir(paths.runsDir, { withFileTypes: true }).catch(() => []);
        const dirNames = entries
          .filter((e) => e && typeof e.isDirectory === "function" && e.isDirectory())
          .map((e) => String(e.name || ""))
          .filter(Boolean)
          .sort()
          .reverse()
          .slice(0, limit);

        const runs = [];
        for (const runId of dirNames) {
          const resultAbs = path.join(paths.runsDir, runId, "result.json");
          const stdoutAbs = path.join(paths.runsDir, runId, "stdout.log");
          const resultRel = path.relative(paths.rootDir, resultAbs);
          const stdoutRel = path.relative(paths.rootDir, stdoutAbs);
          let nodeId = "";
          let status = "";
          let summary = "";
          try {
            const parsed = safeJsonParse(await readFile(resultAbs, "utf8"), null);
            nodeId = typeof parsed?.nodeId === "string" ? parsed.nodeId : "";
            status = typeof parsed?.status === "string" ? parsed.status : "";
            summary = typeof parsed?.summary === "string" ? parsed.summary : "";
          } catch {
            // ignore
          }
          runs.push({ runId, nodeId, status, summary, resultPath: resultRel, stdoutPath: stdoutRel });
        }

        json(res, 200, { ok: true, runs });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        const config = await loadConfig(paths.configPath);
        json(res, 200, { ok: true, config: config || defaultConfig() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        await requireToken(req);
        const body = await readJsonBody(req, { maxBytes: 64_000 });
        const config = body?.config;
        if (!config || typeof config !== "object") return json(res, 400, { error: "Missing config object." });
        await saveConfig(paths.configPath, config);
        json(res, 200, { ok: true, message: "Config saved." });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/run/log") {
        const runIdRaw = String(url.searchParams.get("runId") || "").trim();
        const runId = runIdRaw && !runIdRaw.includes("/") && !runIdRaw.includes("\\") && !runIdRaw.includes("..") ? runIdRaw : "";
        if (!runId) return json(res, 400, { error: "Missing or invalid ?runId=<runId>." });
        const tail = Number(url.searchParams.get("tail") || 10_000);

        const stdoutRel = path.relative(paths.rootDir, path.join(paths.runsDir, runId, "stdout.log"));
        const stdoutAbs = safeResolveUnderRoot(paths.rootDir, stdoutRel);
        const text = stdoutAbs ? await readTailText(stdoutAbs, tail) : "";
        json(res, 200, { runId, path: stdoutRel, text });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/run/delete") {
        await requireToken(req);
        const body = await readJsonBody(req, { maxBytes: 2_000 });
        const runIdRaw = typeof body?.runId === "string" ? body.runId.trim() : "";
        const runId = runIdRaw && !runIdRaw.includes("/") && !runIdRaw.includes("\\") && !runIdRaw.includes("..") ? runIdRaw : "";
        if (!runId) return json(res, 400, { error: "Missing or invalid runId." });
        const runDir = path.join(paths.runsDir, runId);
        const safe = safeResolveUnderRoot(paths.rootDir, path.relative(paths.rootDir, runDir));
        if (!safe) return json(res, 400, { error: "Invalid runId." });
        await rm(safe, { recursive: true, force: true });
        json(res, 200, { ok: true, runId });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/chat/history") {
        const chatNodeId = "__run__";
        const [chatRollupRow, chatSummaryRow, chatLastOpsRow, chatTurnsRow] = await Promise.all([
          kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.rollup" }).catch(() => null),
          kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.summary" }).catch(() => null),
          kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.last_ops" }).catch(() => null),
          kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.turns" }).catch(() => null),
        ]);

        const rollup = typeof chatRollupRow?.value_text === "string" ? chatRollupRow.value_text.trim() : "";
        const summary = typeof chatSummaryRow?.value_text === "string" ? chatSummaryRow.value_text.trim() : "";
        const lastOps = typeof chatLastOpsRow?.value_text === "string" ? chatLastOpsRow.value_text.trim() : "";
        const turnsText = typeof chatTurnsRow?.value_text === "string" ? chatTurnsRow.value_text.trim() : "";
        const turnsParsed = safeJsonParse(turnsText, []);
        const turns = Array.isArray(turnsParsed) ? turnsParsed : [];
        json(res, 200, { ok: true, rollup, summary, lastOps, turns });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chat/clear") {
        await requireToken(req);
        const chatNodeId = "__run__";
        const now = new Date().toISOString();
        await Promise.all([
          kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.rollup", valueText: "", nowIso: now }),
          kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.summary", valueText: "", nowIso: now }),
          kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.last_ops", valueText: "", nowIso: now }),
          kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.turns", valueText: "[]", nowIso: now }),
        ]);
        json(res, 200, { ok: true, message: "Chat history cleared." });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/control/start") {
        await requireToken(req);
        const started = await startSupervisorDetached();
        json(res, 200, { ok: true, ...started });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chat/send") {
        await requireToken(req);
        const body = await readJsonBody(req, { maxBytes: 64_000 });
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) return json(res, 400, { error: "Missing message." });

        const runnerOverride = typeof body?.runner === "string" ? body.runner.trim() : "";
        const roleOverride = typeof body?.role === "string" ? body.role.trim() : "";
        const role = roleOverride || "planner";

        const snapshot = await getSnapshot();
        const counts = snapshot?.counts || {};
        const next = snapshot?.next || null;
        const nodeLines = (Array.isArray(snapshot?.nodes) ? snapshot.nodes : [])
          .map((n) => formatNodeLine(n))
          .slice(0, 40)
          .join("\n");

        const recent = await readTailText(path.join(paths.memoryDir, "activity.log"), 4_000);
        const goalText = await readTailText(paths.goalPath, 8_000);
        const taskPlanText = await readTailText(path.join(paths.memoryDir, "task_plan.md"), 8_000);
        const findingsText = await readTailText(path.join(paths.memoryDir, "findings.md"), 8_000);
        const progressText = await readTailText(path.join(paths.memoryDir, "progress.md"), 8_000);

        const chatNodeId = "__run__";
        const [chatRollupRow, chatSummaryRow, chatLastOpsRow, chatTurnsRow] = await Promise.all([
          kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.rollup" }).catch(() => null),
          kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.summary" }).catch(() => null),
          kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.last_ops" }).catch(() => null),
          kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.turns" }).catch(() => null),
        ]);

        const chatRollup = typeof chatRollupRow?.value_text === "string" ? chatRollupRow.value_text.trim() : "";
        const chatSummary = typeof chatSummaryRow?.value_text === "string" ? chatSummaryRow.value_text.trim() : "";
        const chatLastOpsText = typeof chatLastOpsRow?.value_text === "string" ? chatLastOpsRow.value_text.trim() : "";
        const chatTurnsParsed = safeJsonParse(typeof chatTurnsRow?.value_text === "string" ? chatTurnsRow.value_text : "", []);
        const chatTurns = Array.isArray(chatTurnsParsed) ? chatTurnsParsed : [];

        if (message.startsWith("/answer")) {
          const parts = message.split(/\s+/).filter(Boolean);
          const rest = parts.slice(1);
          if (rest.length === 0) return json(res, 400, { error: "Usage: /answer [nodeId] <answer...>" });

          const needsHumanIds = (Array.isArray(snapshot?.nodes) ? snapshot.nodes : [])
            .filter((n) => String(n?.status || "").toLowerCase() === "needs_human")
            .map((n) => String(n?.id || "").trim())
            .filter(Boolean);

          let nodeId = "";
          let answerParts = rest;
          if (answerParts.length >= 2 && needsHumanIds.includes(answerParts[0])) {
            nodeId = answerParts[0];
            answerParts = answerParts.slice(1);
          }
          const answer = answerParts.join(" ").trim();
          if (!answer) return json(res, 400, { error: "Missing answer text." });

          const args = ["answer", "--no-prompt", "--answer", answer];
          if (nodeId) args.push("--node", nodeId);
          const answered = await runCliCapture({ cwd: paths.rootDir, args });
          if (answered.code !== 0) throw new Error(String(answered.stderr || answered.stdout || `answer failed (exit ${answered.code})`));

          const started = await startSupervisorDetached();
          const applied = [{ type: "checkpoint.answer", nodeId: nodeId || null, ...started }];
          const reply = `Recorded answer${nodeId ? ` for ${nodeId}` : ""} and reopened checkpoint.`;

          const now = new Date().toISOString();
          const turn = {
            at: now,
            user: truncateText(message, 800),
            reply: truncateText(reply, 1200),
            ops: ["checkpoint.answer"],
          };
          const turnsNext = chatTurns.concat([turn]).slice(-10);
          await kvPut({ dbPath: paths.dbPath, nodeId: "__run__", key: "chat.summary", valueText: truncateText(reply, 400), nowIso: now });
          await kvPut({
            dbPath: paths.dbPath,
            nodeId: "__run__",
            key: "chat.last_ops",
            valueText: truncateText(JSON.stringify([{ type: "checkpoint.answer", nodeId: nodeId || null }]), 4000),
            nowIso: now,
          });
          await kvPut({ dbPath: paths.dbPath, nodeId: "__run__", key: "chat.turns", valueText: JSON.stringify(turnsNext), nowIso: now });

          json(res, 200, { ok: true, reply, applied, chat: { turns: turnsNext, rollup: chatRollup, summary: truncateText(reply, 400) } });
          return;
        }

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

        const promptPrefix =
          `You are Dagain Chat Router.\n` +
          `Return JSON in <result> with {status, summary, data:{reply, ops, rollup}}.\n` +
          `Allowed ops:\n` +
          `- {"type":"status"}\n` +
          `- {"type":"run.start"}\n` +
          `- {"type":"control.pause"}\n` +
          `- {"type":"control.resume"}\n` +
          `- {"type":"control.setWorkers","workers":3}\n` +
          `- {"type":"control.replan"}\n` +
          `- {"type":"control.cancel","nodeId":"task-001"}\n` +
          `- {"type":"checkpoint.answer","nodeId":"task-002","answer":"..."}\n` +
          `- {"type":"ctx.readFile","path":"README.md","maxBytes":8000}\n` +
          `- {"type":"ctx.rg","pattern":"needs_human","glob":"src/**","maxMatches":50}\n` +
          `- {"type":"ctx.gitStatus"}\n` +
          `- {"type":"ctx.gitDiffStat"}\n` +
          `Rules:\n` +
          `- Do not tell the user to run CLI commands; emit ops and Dagain will execute them.\n` +
          `- If any node is needs_human, prefer checkpoint.answer over control.resume alone.\n` +
          `- Use ctx.* ops to request additional read-only context (Dagain will execute and re-call you with results).\n` +
          `- Always include data.rollup as an updated rolling summary (<= 800 chars). If Chat memory includes rolling_summary, update it.\n` +
          `- If unclear, ask one clarifying question in reply and ops=[].\n` +
          (memorySection ? `\n${memorySection}\n` : "\n") +
          (goalText ? `\nGOAL.md:\n${goalText}\n` : "") +
          (taskPlanText ? `\nTask plan (.dagain/memory/task_plan.md):\n${taskPlanText}\n` : "") +
          (findingsText ? `\nFindings (.dagain/memory/findings.md):\n${findingsText}\n` : "") +
          (progressText ? `\nProgress (.dagain/memory/progress.md):\n${progressText}\n` : "") +
          `\n` +
          `State counts: ${JSON.stringify(counts)}\n` +
          `Next runnable: ${next ? formatNodeLine(next) : "(none)"}\n` +
          `Supervisor: ${snapshot?.supervisor?.pid ? `pid=${snapshot.supervisor.pid} host=${snapshot.supervisor.host || "?"}` : "(none)"}\n` +
          `Nodes (first 40):\n${nodeLines}\n` +
          (recent ? `\nRecent activity (tail):\n${recent}\n` : "");

        let parsed = null;
        let reply = "";
        let rollupNext = "";
        let ops = [];

        const ctxBlocks = [];
        let ctxResultsText = "";
        for (let round = 0; round < 3; round += 1) {
          const prompt = `${promptPrefix}${ctxResultsText ? `\n${ctxResultsText}\n` : "\n"}User: ${message}\n`;
          const args = ["microcall", "--prompt", prompt, "--role", role];
          if (runnerOverride) args.push("--runner", runnerOverride);
          const micro = await runCliCapture({ cwd: paths.rootDir, args });
          if (micro.code !== 0) throw new Error(String(micro.stderr || micro.stdout || `microcall failed (exit ${micro.code})`));
          parsed = safeJsonParse(String(micro.stdout || ""), null);
          if (!parsed) throw new Error("Chat router returned invalid JSON.");

          const dataRound = parsed?.data && typeof parsed.data === "object" ? parsed.data : null;
          reply = typeof dataRound?.reply === "string" ? dataRound.reply.trim() : "";
          rollupNext = typeof dataRound?.rollup === "string" ? dataRound.rollup.trim() : "";
          ops = Array.isArray(dataRound?.ops) ? dataRound.ops : [];

          const ctxOps = ops.filter((o) => isContextOp(o));
          if (ctxOps.length === 0) break;
          const results = await executeContextOps({ rootDir: paths.rootDir, ops: ctxOps });
          const formatted = formatContextOpsResults(results);
          if (!formatted) break;
          ctxBlocks.push(formatted);
          ctxResultsText = ctxBlocks.join("\n\n");
        }

        // ctx.* ops are internal prompt-enrichment ops; never apply them to the supervisor.
        ops = ops.filter((o) => !isContextOp(o));

        const applied = [];
        let requestedStart = false;
        for (const op of ops) {
          const type = typeof op?.type === "string" ? op.type.trim() : "";
          if (!type || type === "status") continue;
          if (type === "run.start") {
            requestedStart = true;
            continue;
          }

          if (type === "checkpoint.answer") {
            const nodeId = typeof op?.nodeId === "string" ? op.nodeId.trim() : "";
            const answer = typeof op?.answer === "string" ? op.answer.trim() : "";
            if (!answer) continue;
            const args = ["answer", "--no-prompt", "--answer", answer];
            if (nodeId) args.push("--node", nodeId);
            const answered = await runCliCapture({ cwd: paths.rootDir, args });
            if (answered.code !== 0) throw new Error(String(answered.stderr || answered.stdout || `answer failed (exit ${answered.code})`));
            applied.push({ type, nodeId: nodeId || null });
            continue;
          }

          if (type === "control.pause") {
            const id = await enqueueControl({ command: "pause", args: {} });
            applied.push({ type, id });
            continue;
          }
          if (type === "control.resume") {
            const id = await enqueueControl({ command: "resume", args: {} });
            applied.push({ type, id });
            continue;
          }
          if (type === "control.replan") {
            const id = await enqueueControl({ command: "replan_now", args: {} });
            applied.push({ type, id });
            continue;
          }
          if (type === "control.setWorkers") {
            const n = Number(op?.workers);
            const workers = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
            if (workers == null) continue;
            const id = await enqueueControl({ command: "set_workers", args: { workers } });
            applied.push({ type, id });
            continue;
          }
          if (type === "control.cancel") {
            const nodeId = typeof op?.nodeId === "string" ? op.nodeId.trim() : "";
            if (!nodeId) continue;
            const id = await enqueueControl({ command: "cancel", args: { nodeId } });
            applied.push({ type, id });
            continue;
          }
        }

        const hasControlOps = applied.some((a) => String(a?.type || "").startsWith("control."));
        const hasCheckpointOps = applied.some((a) => String(a?.type || "") === "checkpoint.answer");
        if (requestedStart || hasControlOps || hasCheckpointOps) {
          const started = await startSupervisorDetached();
          applied.push({ type: "run.start", ...started });
        }

        const now = new Date().toISOString();
        const storedOpsText = JSON.stringify(ops);
        const turn = {
          at: now,
          user: truncateText(message, 800),
          reply: truncateText(reply, 1200),
          ops: ops.map((o) => (typeof o?.type === "string" ? o.type : null)).filter(Boolean),
        };
        const turnsNext = chatTurns.concat([turn]).slice(-10);

        if (rollupNext) {
          await kvPut({
            dbPath: paths.dbPath,
            nodeId: "__run__",
            key: "chat.rollup",
            valueText: truncateText(rollupNext, 4000),
            nowIso: now,
          });
        }
        await kvPut({ dbPath: paths.dbPath, nodeId: "__run__", key: "chat.summary", valueText: truncateText(reply, 400), nowIso: now });
        await kvPut({
          dbPath: paths.dbPath,
          nodeId: "__run__",
          key: "chat.last_ops",
          valueText: truncateText(storedOpsText, 4000),
          nowIso: now,
        });
        await kvPut({ dbPath: paths.dbPath, nodeId: "__run__", key: "chat.turns", valueText: JSON.stringify(turnsNext), nowIso: now });

        json(res, 200, {
          ok: true,
          reply,
          applied,
          chat: { turns: turnsNext, rollup: rollupNext || chatRollup, summary: truncateText(reply, 400) },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/control/pause") {
        await requireToken(req);
        const id = await enqueueControl({ command: "pause", args: {} });
        await startSupervisorDetached();
        json(res, 200, { ok: true, id, message: `Enqueued pause (id=${id}).` });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/control/resume") {
        await requireToken(req);
        const id = await enqueueControl({ command: "resume", args: {} });
        await startSupervisorDetached();
        json(res, 200, { ok: true, id, message: `Enqueued resume (id=${id}).` });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/control/replan") {
        await requireToken(req);
        const id = await enqueueControl({ command: "replan_now", args: {} });
        await startSupervisorDetached();
        json(res, 200, { ok: true, id, message: `Enqueued replan (id=${id}).` });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/control/set-workers") {
        await requireToken(req);
        const body = await readJsonBody(req);
        const n = Number(body?.workers);
        const workers = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
        if (workers == null) return json(res, 400, { error: "Invalid workers; expected {workers:number>0}." });
        const id = await enqueueControl({ command: "set_workers", args: { workers } });
        await startSupervisorDetached();
        json(res, 200, { ok: true, id, message: `Enqueued set-workers=${workers} (id=${id}).` });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/control/cancel") {
        await requireToken(req);
        const body = await readJsonBody(req);
        const nodeId = typeof body?.nodeId === "string" ? body.nodeId.trim() : "";
        if (!nodeId) return json(res, 400, { error: "Missing nodeId." });
        const id = await enqueueControl({ command: "cancel", args: { nodeId } });
        await startSupervisorDetached();
        json(res, 200, { ok: true, id, message: `Enqueued cancel node=${nodeId} (id=${id}).` });
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        res.write("\n");

        let closed = false;
        req.on("close", () => {
          closed = true;
        });

        while (!closed) {
          const snapshot = await getSnapshot();
          res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
          await new Promise((r) => setTimeout(r, 500));
        }
        return;
      }

      notFound(res);
    } catch (error) {
      respondError(res, error);
    }
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
