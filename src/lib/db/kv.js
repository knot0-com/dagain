import { sqliteExec, sqliteQueryJson } from "./sqlite3.js";

function sqlQuote(value) {
  const s = String(value ?? "");
  return `'${s.replace(/'/g, "''")}'`;
}

function sqlMaybeText(value) {
  if (value == null) return "NULL";
  return sqlQuote(String(value));
}

function sqlMaybeInt(value) {
  if (value == null) return "NULL";
  const n = Number(value);
  if (!Number.isFinite(n)) return "NULL";
  return String(Math.trunc(n));
}

export async function kvPut({
  dbPath,
  nodeId,
  key,
  valueText = null,
  artifactPath = null,
  artifactSha256 = null,
  fingerprintJson = null,
  runId = null,
  attempt = null,
  nowIso,
}) {
  const node = String(nodeId || "").trim();
  const k = String(key || "").trim();
  if (!node) throw new Error("kvPut: missing nodeId");
  if (!k) throw new Error("kvPut: missing key");
  if (!dbPath) throw new Error("kvPut: missing dbPath");

  const now = String(nowIso || "").trim() || new Date().toISOString();
  const fingerprintText =
    fingerprintJson == null ? null : typeof fingerprintJson === "string" ? fingerprintJson : JSON.stringify(fingerprintJson);

  await sqliteExec(
    dbPath,
    `BEGIN;\n` +
      `INSERT INTO kv_history(\n` +
      `  node_id, key,\n` +
      `  value_text, artifact_path, artifact_sha256,\n` +
      `  fingerprint_json, run_id, attempt,\n` +
      `  created_at\n` +
      `)\n` +
      `VALUES(\n` +
      `  ${sqlQuote(node)}, ${sqlQuote(k)},\n` +
      `  ${sqlMaybeText(valueText)}, ${sqlMaybeText(artifactPath)}, ${sqlMaybeText(artifactSha256)},\n` +
      `  ${sqlMaybeText(fingerprintText)}, ${sqlMaybeText(runId)}, ${sqlMaybeInt(attempt)},\n` +
      `  ${sqlQuote(now)}\n` +
      `);\n` +
      `INSERT INTO kv_latest(\n` +
      `  node_id, key,\n` +
      `  value_text, artifact_path, artifact_sha256,\n` +
      `  fingerprint_json, run_id, attempt,\n` +
      `  updated_at\n` +
      `)\n` +
      `VALUES(\n` +
      `  ${sqlQuote(node)}, ${sqlQuote(k)},\n` +
      `  ${sqlMaybeText(valueText)}, ${sqlMaybeText(artifactPath)}, ${sqlMaybeText(artifactSha256)},\n` +
      `  ${sqlMaybeText(fingerprintText)}, ${sqlMaybeText(runId)}, ${sqlMaybeInt(attempt)},\n` +
      `  ${sqlQuote(now)}\n` +
      `)\n` +
      `ON CONFLICT(node_id, key) DO UPDATE SET\n` +
      `  value_text=excluded.value_text,\n` +
      `  artifact_path=excluded.artifact_path,\n` +
      `  artifact_sha256=excluded.artifact_sha256,\n` +
      `  fingerprint_json=excluded.fingerprint_json,\n` +
      `  run_id=excluded.run_id,\n` +
      `  attempt=excluded.attempt,\n` +
      `  updated_at=excluded.updated_at;\n` +
      `DELETE FROM kv_history\n` +
      `WHERE node_id=${sqlQuote(node)}\n` +
      `  AND key=${sqlQuote(k)}\n` +
      `  AND id NOT IN (\n` +
      `    SELECT id FROM kv_history\n` +
      `    WHERE node_id=${sqlQuote(node)} AND key=${sqlQuote(k)}\n` +
      `    ORDER BY id DESC\n` +
      `    LIMIT 5\n` +
      `  );\n` +
      `COMMIT;\n`,
  );
}

export async function kvGet({ dbPath, nodeId, key }) {
  const node = String(nodeId || "").trim();
  const k = String(key || "").trim();
  if (!node) throw new Error("kvGet: missing nodeId");
  if (!k) throw new Error("kvGet: missing key");
  if (!dbPath) throw new Error("kvGet: missing dbPath");

  const rows = await sqliteQueryJson(
    dbPath,
    `SELECT node_id, key, value_text, artifact_path, artifact_sha256, fingerprint_json, run_id, attempt, updated_at\n` +
      `FROM kv_latest\n` +
      `WHERE node_id=${sqlQuote(node)} AND key=${sqlQuote(k)}\n` +
      `LIMIT 1;\n`,
  );
  return rows[0] || null;
}

export async function kvList({ dbPath, nodeId, prefix = "" }) {
  const node = String(nodeId || "").trim();
  if (!node) throw new Error("kvList: missing nodeId");
  if (!dbPath) throw new Error("kvList: missing dbPath");

  const p = String(prefix || "");
  const wherePrefix = p ? ` AND key LIKE ${sqlQuote(`${p}%`)}` : "";
  return sqliteQueryJson(
    dbPath,
    `SELECT key, updated_at\n` + `FROM kv_latest\n` + `WHERE node_id=${sqlQuote(node)}${wherePrefix}\n` + `ORDER BY key ASC;\n`,
  );
}

