import { sqliteQueryJson } from "./sqlite3.js";

function sqlQuote(value) {
  const s = String(value ?? "");
  return `'${s.replace(/'/g, "''")}'`;
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
      `    WHERE d.node_id = n.id AND dep.status <> 'done'\n` +
      `  )\n` +
      `ORDER BY\n` +
      `  CASE lower(n.type)\n` +
      `    WHEN 'verify' THEN 0\n` +
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

