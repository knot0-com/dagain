import { sqliteExec, sqliteQueryJson } from "./sqlite3.js";

function sqlQuote(value) {
  const s = String(value ?? "");
  return `'${s.replace(/'/g, "''")}'`;
}

function safeJsonStringify(value, fallback = "{}") {
  try {
    const json = JSON.stringify(value ?? {});
    return typeof json === "string" ? json : fallback;
  } catch {
    return fallback;
  }
}

function safeJsonParse(value, fallback = {}) {
  if (value == null) return fallback;
  const text = String(value || "");
  if (!text.trim()) return fallback;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function normalizeCommand(value) {
  return String(value || "").trim();
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePid(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function claimToken() {
  return `claim-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function mailboxEnqueue({ dbPath, command, args = null, nowIso }) {
  const path = String(dbPath || "").trim();
  if (!path) throw new Error("mailboxEnqueue: missing dbPath");

  const cmd = normalizeCommand(command);
  if (!cmd) throw new Error("mailboxEnqueue: missing command");

  const now = typeof nowIso === "string" && nowIso.trim() ? nowIso : new Date().toISOString();
  const argsJson = safeJsonStringify(args ?? {});

  const rows = await sqliteQueryJson(
    path,
    `INSERT INTO mailbox(status, command, args_json, created_at)\n` +
      `VALUES('pending', ${sqlQuote(cmd)}, ${sqlQuote(argsJson)}, ${sqlQuote(now)})\n` +
      `RETURNING id;\n`,
  );
  const id = Number(rows?.[0]?.id ?? 0);
  if (!Number.isFinite(id) || id <= 0) throw new Error("mailboxEnqueue: failed to create mailbox row");
  return { id };
}

export async function mailboxClaimNext({ dbPath, pid, host, nowIso }) {
  const path = String(dbPath || "").trim();
  if (!path) throw new Error("mailboxClaimNext: missing dbPath");

  const lockPid = normalizePid(pid);
  if (lockPid == null) throw new Error("mailboxClaimNext: invalid pid");

  const lockHost = String(host || "").trim();
  if (!lockHost) throw new Error("mailboxClaimNext: missing host");

  const now = typeof nowIso === "string" && nowIso.trim() ? nowIso : new Date().toISOString();
  const token = claimToken();

  const rows = await sqliteQueryJson(
    path,
    `UPDATE mailbox\n` +
      `SET status='processing',\n` +
      `    claim_token=${sqlQuote(token)},\n` +
      `    claimed_at=${sqlQuote(now)},\n` +
      `    claimed_by_pid=${String(lockPid)},\n` +
      `    claimed_by_host=${sqlQuote(lockHost)}\n` +
      `WHERE id=(SELECT id FROM mailbox WHERE status='pending' ORDER BY id LIMIT 1)\n` +
      `  AND status='pending'\n` +
      `RETURNING id, command, args_json;\n`,
  );
  const row = rows?.[0] || null;
  if (!row) return null;

  const id = Number(row.id ?? 0);
  const cmd = normalizeCommand(row.command);
  const args = safeJsonParse(row.args_json, {});
  if (!Number.isFinite(id) || id <= 0 || !cmd) return null;
  return { id, command: cmd, args };
}

export async function mailboxAck({ dbPath, id, status, result = null, errorText = null, nowIso }) {
  const path = String(dbPath || "").trim();
  if (!path) throw new Error("mailboxAck: missing dbPath");

  const idNum = Number(id);
  const rowId = Number.isFinite(idNum) && idNum > 0 ? Math.floor(idNum) : null;
  if (rowId == null) throw new Error("mailboxAck: invalid id");

  const nextStatus = normalizeStatus(status);
  if (nextStatus !== "done" && nextStatus !== "failed") throw new Error("mailboxAck: invalid status");

  const now = typeof nowIso === "string" && nowIso.trim() ? nowIso : new Date().toISOString();
  const resultJson = result == null ? null : safeJsonStringify(result, "null");
  const error = typeof errorText === "string" && errorText.trim() ? errorText.trim() : null;

  await sqliteExec(
    path,
    `UPDATE mailbox\n` +
      `SET status=${sqlQuote(nextStatus)},\n` +
      `    completed_at=${sqlQuote(now)},\n` +
      `    result_json=${resultJson == null ? "NULL" : sqlQuote(resultJson)},\n` +
      `    error_text=${error == null ? "NULL" : sqlQuote(error)}\n` +
      `WHERE id=${String(rowId)};\n`,
  );
}

