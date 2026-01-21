import { sqliteExec, sqliteQueryJson } from "./sqlite3.js";

function sqlQuote(value) {
  const s = String(value ?? "");
  return `'${s.replace(/'/g, "''")}'`;
}

function safeJsonParse(value, fallback) {
  if (value == null) return fallback;
  const text = String(value);
  if (!text.trim()) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeStatus(value) {
  return String(value || "").toLowerCase().trim();
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

function parseRetryPolicyJson(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function selectNextRunnableNode({ dbPath, nowIso }) {
  const now = typeof nowIso === "string" && nowIso.trim() ? nowIso : new Date().toISOString();
  const rows = await sqliteQueryJson(
    dbPath,
    `SELECT n.*\n` +
      `FROM nodes n\n` +
      `WHERE n.status='open'\n` +
      `  AND (n.blocked_until IS NULL OR n.blocked_until <= ${sqlQuote(now)})\n` +
      `  AND n.lock_run_id IS NULL\n` +
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
      `ORDER BY\n` +
      `  CASE lower(n.type)\n` +
      `    WHEN 'verify' THEN 0\n` +
      `    WHEN 'merge' THEN 1\n` +
      `    WHEN 'task' THEN 1\n` +
      `    WHEN 'plan' THEN 2\n` +
      `    WHEN 'epic' THEN 2\n` +
      `    WHEN 'integrate' THEN 3\n` +
      `    WHEN 'final_verify' THEN 4\n` +
      `    WHEN 'final-verify' THEN 4\n` +
      `    ELSE 100\n` +
      `  END,\n` +
      `  n.id\n` +
      `LIMIT 1;\n`,
  );
  return rows[0] || null;
}

export async function selectRunnableCandidates({ dbPath, nowIso, limit = 50 }) {
  const now = typeof nowIso === "string" && nowIso.trim() ? nowIso : new Date().toISOString();
  const limitNum = Number(limit);
  const limitInt = Number.isFinite(limitNum) && limitNum > 0 ? Math.floor(limitNum) : 50;
  const rows = await sqliteQueryJson(
    dbPath,
    `SELECT n.*\n` +
      `FROM nodes n\n` +
      `WHERE n.status='open'\n` +
      `  AND (n.blocked_until IS NULL OR n.blocked_until <= ${sqlQuote(now)})\n` +
      `  AND n.lock_run_id IS NULL\n` +
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
      `ORDER BY\n` +
      `  CASE lower(n.type)\n` +
      `    WHEN 'verify' THEN 0\n` +
      `    WHEN 'merge' THEN 1\n` +
      `    WHEN 'task' THEN 1\n` +
      `    WHEN 'plan' THEN 2\n` +
      `    WHEN 'epic' THEN 2\n` +
      `    WHEN 'integrate' THEN 3\n` +
      `    WHEN 'final_verify' THEN 4\n` +
      `    WHEN 'final-verify' THEN 4\n` +
      `    ELSE 100\n` +
      `  END,\n` +
      `  n.id\n` +
      `LIMIT ${String(limitInt)};\n`,
  );
  return rows;
}

export async function getNode({ dbPath, nodeId }) {
  const rows = await sqliteQueryJson(dbPath, `SELECT * FROM nodes WHERE id=${sqlQuote(nodeId)} LIMIT 1;\n`);
  const row = rows[0] || null;
  if (!row) return null;

  const depRows = await sqliteQueryJson(
    dbPath,
    `SELECT depends_on_id FROM deps WHERE node_id=${sqlQuote(nodeId)} ORDER BY depends_on_id;\n`,
  );
  const dependsOn = depRows.map((r) => r.depends_on_id).filter(Boolean);

  const lockRunId = row.lock_run_id ?? null;
  const lock = lockRunId
    ? {
        runId: lockRunId,
        startedAt: row.lock_started_at ?? null,
        pid: row.lock_pid ?? null,
        host: row.lock_host ?? null,
      }
    : null;

  return {
    id: row.id,
    title: row.title ?? "",
    type: row.type ?? "",
    status: row.status ?? "open",
    dependsOn,
    runner: row.runner ?? null,
    inputs: safeJsonParse(row.inputs_json, []),
    ownership: safeJsonParse(row.ownership_json, []),
    acceptance: safeJsonParse(row.acceptance_json, []),
    verify: safeJsonParse(row.verify_json, []),
    retryPolicy: safeJsonParse(row.retry_policy_json, { maxAttempts: 3 }),
    attempts: row.attempts ?? 0,
    blockedUntil: row.blocked_until ?? null,
    lock,
    checkpoint: safeJsonParse(row.checkpoint_json, null),
    parentId: row.parent_id ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    completedAt: row.completed_at ?? null,
    autoResetCount: row.auto_reset_count ?? 0,
    lastAutoResetAt: row.last_auto_reset_at ?? null,
    manualResetCount: row.manual_reset_count ?? 0,
    lastManualResetAt: row.last_manual_reset_at ?? null,
  };
}

export async function listNodes({ dbPath }) {
  const nodeRows = await sqliteQueryJson(dbPath, "SELECT * FROM nodes ORDER BY id;");
  const depRows = await sqliteQueryJson(dbPath, "SELECT node_id, depends_on_id FROM deps ORDER BY node_id, depends_on_id;");
  const dependsOnByNodeId = new Map();
  for (const row of depRows) {
    const nodeId = typeof row?.node_id === "string" ? row.node_id : "";
    const depId = typeof row?.depends_on_id === "string" ? row.depends_on_id : "";
    if (!nodeId || !depId) continue;
    const arr = dependsOnByNodeId.get(nodeId) || [];
    arr.push(depId);
    dependsOnByNodeId.set(nodeId, arr);
  }

  return nodeRows.map((row) => {
    const id = row.id;
    const lockRunId = row.lock_run_id ?? null;
    const lock = lockRunId
      ? {
          runId: lockRunId,
          startedAt: row.lock_started_at ?? null,
          pid: row.lock_pid ?? null,
          host: row.lock_host ?? null,
        }
      : null;
    return {
      id,
      title: row.title ?? "",
      type: row.type ?? "",
      status: row.status ?? "open",
      dependsOn: dependsOnByNodeId.get(id) || [],
      runner: row.runner ?? null,
      inputs: safeJsonParse(row.inputs_json, []),
      ownership: safeJsonParse(row.ownership_json, []),
      acceptance: safeJsonParse(row.acceptance_json, []),
      verify: safeJsonParse(row.verify_json, []),
      retryPolicy: safeJsonParse(row.retry_policy_json, { maxAttempts: 3 }),
      attempts: row.attempts ?? 0,
      blockedUntil: row.blocked_until ?? null,
      lock,
      checkpoint: safeJsonParse(row.checkpoint_json, null),
      parentId: row.parent_id ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      completedAt: row.completed_at ?? null,
      autoResetCount: row.auto_reset_count ?? 0,
      lastAutoResetAt: row.last_auto_reset_at ?? null,
      manualResetCount: row.manual_reset_count ?? 0,
      lastManualResetAt: row.last_manual_reset_at ?? null,
    };
  });
}

export async function countByStatusDb({ dbPath }) {
  const rows = await sqliteQueryJson(dbPath, "SELECT status, COUNT(*) AS n FROM nodes GROUP BY status;");
  const out = {};
  for (const row of rows) {
    const key = typeof row?.status === "string" ? row.status : "";
    if (!key) continue;
    out[key] = Number(row.n || 0);
  }
  return out;
}

export async function allDoneDb({ dbPath }) {
  const rows = await sqliteQueryJson(dbPath, "SELECT COUNT(*) AS n FROM nodes;");
  const total = Number(rows?.[0]?.n ?? 0);
  if (!Number.isFinite(total) || total <= 0) return false;
  const notDoneRows = await sqliteQueryJson(dbPath, "SELECT COUNT(*) AS n FROM nodes WHERE status <> 'done';");
  const notDone = Number(notDoneRows?.[0]?.n ?? 0);
  return Number.isFinite(notDone) && notDone === 0;
}

export async function listFailedDepsBlockingOpenNodes({ dbPath }) {
  const rows = await sqliteQueryJson(
    dbPath,
    `SELECT DISTINCT dep.id AS id\n` +
      `FROM nodes n\n` +
      `JOIN deps d ON d.node_id = n.id\n` +
      `JOIN nodes dep ON dep.id = d.depends_on_id\n` +
      `WHERE n.status='open'\n` +
      `  AND dep.status='failed'\n` +
      `  AND COALESCE(NULLIF(lower(d.required_status), ''), 'done') = 'done'\n` +
      `ORDER BY dep.id;\n`,
  );
  return rows.map((r) => r.id).filter(Boolean);
}

export async function unlockNode({ dbPath, nodeId, status = "open", nowIso }) {
  const now = typeof nowIso === "string" && nowIso.trim() ? nowIso : new Date().toISOString();
  const nextStatus = String(status || "open").trim() || "open";
  await sqliteExec(
    dbPath,
    `UPDATE nodes\n` +
      `SET status=${sqlQuote(nextStatus)},\n` +
      `    lock_run_id=NULL,\n` +
      `    lock_started_at=NULL,\n` +
      `    lock_pid=NULL,\n` +
      `    lock_host=NULL,\n` +
      `    updated_at=${sqlQuote(now)}\n` +
      `WHERE id=${sqlQuote(nodeId)};\n`,
  );
}

export async function claimNode({ dbPath, nodeId, runId, pid, host, nowIso }) {
  const now = typeof nowIso === "string" && nowIso.trim() ? nowIso : new Date().toISOString();
  const pidNum = Number(pid);
  const lockPid = Number.isFinite(pidNum) ? Math.floor(pidNum) : null;
  const rows = await sqliteQueryJson(
    dbPath,
    `UPDATE nodes\n` +
      `SET status='in_progress',\n` +
      `    lock_run_id=${sqlQuote(runId)},\n` +
      `    lock_started_at=${sqlQuote(now)},\n` +
      `    lock_pid=${lockPid == null ? "NULL" : String(lockPid)},\n` +
      `    lock_host=${sqlQuote(host)},\n` +
      `    updated_at=${sqlQuote(now)}\n` +
      `WHERE id=${sqlQuote(nodeId)}\n` +
      `  AND status='open'\n` +
      `  AND lock_run_id IS NULL;\n` +
      `SELECT changes() AS changes;\n`,
  );
  const changes = Number(rows?.[0]?.changes ?? 0);
  return Number.isFinite(changes) && changes === 1;
}

export async function applyResult({ dbPath, nodeId, runId, result, nowIso, defaultRetryPolicy = null }) {
  const now = typeof nowIso === "string" && nowIso.trim() ? nowIso : new Date().toISOString();
  const nodeRows = await sqliteQueryJson(
    dbPath,
    `SELECT id, parent_id, attempts, retry_policy_json FROM nodes WHERE id=${sqlQuote(nodeId)};\n`,
  );
  const node = nodeRows[0] || null;
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  const attemptsRaw = Number(node.attempts ?? 0);
  const attempts = Number.isFinite(attemptsRaw) && attemptsRaw >= 0 ? Math.floor(attemptsRaw) : 0;
  const retryPolicy = parseRetryPolicyJson(node.retry_policy_json) || {};
  const maxAttemptsRaw = Number(retryPolicy.maxAttempts ?? 3);
  const maxAttempts = Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw > 0 ? Math.floor(maxAttemptsRaw) : 3;

  const status = normalizeStatus(result?.status);

  let nextStatus = "open";
  let nextAttempts = attempts;
  let completedAt = null;
  let checkpointJson = null;

  if (status === "success") {
    nextStatus = "done";
    completedAt = now;
  } else if (status === "checkpoint") {
    nextStatus = "needs_human";
    checkpointJson = safeJsonStringify(result?.checkpoint ?? null);
  } else {
    nextAttempts = attempts + 1;
    nextStatus = nextAttempts >= maxAttempts ? "failed" : "open";
  }

  await sqliteExec(
    dbPath,
    `UPDATE nodes\n` +
      `SET status=${sqlQuote(nextStatus)},\n` +
      `    attempts=${String(nextAttempts)},\n` +
      `    checkpoint_json=${checkpointJson == null ? "NULL" : sqlQuote(checkpointJson)},\n` +
      `    lock_run_id=NULL,\n` +
      `    lock_started_at=NULL,\n` +
      `    lock_pid=NULL,\n` +
      `    lock_host=NULL,\n` +
      `    completed_at=${completedAt == null ? "NULL" : sqlQuote(completedAt)},\n` +
      `    updated_at=${sqlQuote(now)}\n` +
      `WHERE id=${sqlQuote(nodeId)};\n`,
  );

  const addNodesRaw = result?.next?.addNodes ?? [];
  const addNodes = Array.isArray(addNodesRaw) ? addNodesRaw : [];
  for (const spec of addNodes) {
    const id = typeof spec?.id === "string" ? spec.id.trim() : "";
    if (!id) continue;
    const title = typeof spec?.title === "string" ? spec.title : "";
    const type = typeof spec?.type === "string" ? spec.type : "task";
    const specStatus = typeof spec?.status === "string" ? spec.status : "open";
    const runner = typeof spec?.runner === "string" ? spec.runner : null;

    const inputsJson = safeJsonStringify(spec?.inputs ?? []);
    const ownershipJson = safeJsonStringify(spec?.ownership ?? []);
    const acceptanceJson = safeJsonStringify(spec?.acceptance ?? []);
    const verifyJson = safeJsonStringify(spec?.verify ?? []);
    const retryPolicyJson = safeJsonStringify(spec?.retryPolicy ?? defaultRetryPolicy ?? { maxAttempts: 3 });

    await sqliteExec(
      dbPath,
      `INSERT OR IGNORE INTO nodes(\n` +
        `  id, title, type, status, parent_id,\n` +
        `  runner, inputs_json, ownership_json, acceptance_json, verify_json,\n` +
        `  retry_policy_json, attempts,\n` +
        `  created_at, updated_at\n` +
        `)\n` +
        `VALUES(\n` +
        `  ${sqlQuote(id)}, ${sqlQuote(title)}, ${sqlQuote(type)}, ${sqlQuote(specStatus)}, ${sqlQuote(nodeId)},\n` +
        `  ${runner ? sqlQuote(runner) : "NULL"}, ${sqlQuote(inputsJson)}, ${sqlQuote(ownershipJson)}, ${sqlQuote(acceptanceJson)}, ${sqlQuote(verifyJson)},\n` +
        `  ${sqlQuote(retryPolicyJson)}, 0,\n` +
        `  ${sqlQuote(now)}, ${sqlQuote(now)}\n` +
        `);\n`,
    );

    const depsRaw = spec?.dependsOn ?? [];
    const deps = Array.isArray(depsRaw) ? depsRaw : [];
    for (const depIdRaw of deps) {
      const depId = typeof depIdRaw === "string" ? depIdRaw.trim() : "";
      if (!depId) continue;
      await sqliteExec(
        dbPath,
        `INSERT OR IGNORE INTO deps(node_id, depends_on_id) VALUES(${sqlQuote(id)}, ${sqlQuote(depId)});\n`,
      );
    }
  }

  const setStatusRaw = result?.next?.setStatus ?? [];
  const setStatus = Array.isArray(setStatusRaw) ? setStatusRaw : [];
  for (const entry of setStatus) {
    if (!entry || typeof entry !== "object") continue;
    const idRaw =
      typeof entry.id === "string" ? entry.id : typeof entry.nodeId === "string" ? entry.nodeId : typeof entry.node_id === "string" ? entry.node_id : "";
    const targetId = String(idRaw || "").trim();
    if (!targetId) continue;

    const desired = normalizeStatus(entry.status);
    const allowed = desired === "open" || desired === "done" || desired === "failed" || desired === "needs_human";
    if (!allowed) continue;

    const isOpen = desired === "open";
    const isTerminal = desired === "done" || desired === "failed";

    await sqliteExec(
      dbPath,
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
        `WHERE id=${sqlQuote(targetId)};\n`,
    );
  }

  if (nextStatus === "failed") {
    const nodeParentId = typeof node.parent_id === "string" && node.parent_id.trim() ? node.parent_id.trim() : null;

    const isEscalationNode = nodeId.startsWith("plan-escalate-");
    const escalationSubjectId = isEscalationNode && nodeParentId ? nodeParentId : nodeId;
    const escalationId = `plan-escalate-${escalationSubjectId}`;
    const dependsOnId = isEscalationNode && nodeParentId ? nodeId : escalationSubjectId;

    let parentId = nodeParentId;
    if (isEscalationNode && nodeParentId) {
      const parentRows = await sqliteQueryJson(
        dbPath,
        `SELECT parent_id FROM nodes WHERE id=${sqlQuote(nodeParentId)} LIMIT 1;\n`,
      );
      const parentRow = parentRows[0] || null;
      parentId = typeof parentRow?.parent_id === "string" && parentRow.parent_id.trim() ? parentRow.parent_id.trim() : null;
    }

    const inputsJson = safeJsonStringify([
      { nodeId, key: "err.summary" },
      { nodeId, key: "out.last_stdout_path" },
      { nodeId, key: "out.last_result_path" },
    ]);
    const retryPolicyJson = safeJsonStringify(defaultRetryPolicy ?? { maxAttempts: 3 });

    await sqliteExec(
      dbPath,
      `INSERT OR IGNORE INTO nodes(\n` +
        `  id, title, type, status, parent_id,\n` +
        `  inputs_json,\n` +
        `  retry_policy_json,\n` +
        `  created_at, updated_at\n` +
        `)\n` +
        `VALUES(\n` +
        `  ${sqlQuote(escalationId)}, ${sqlQuote(`Escalate ${nodeId}`)}, 'plan', 'open', ${parentId ? sqlQuote(parentId) : "NULL"},\n` +
        `  ${sqlQuote(inputsJson)},\n` +
        `  ${sqlQuote(retryPolicyJson)},\n` +
        `  ${sqlQuote(now)}, ${sqlQuote(now)}\n` +
        `);\n` +
        `INSERT OR IGNORE INTO deps(node_id, depends_on_id, required_status)\n` +
        `VALUES(${sqlQuote(escalationId)}, ${sqlQuote(dependsOnId)}, 'terminal');\n`,
    );
  }
}
