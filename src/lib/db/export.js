import { sqliteQueryJson } from "./sqlite3.js";
import { writeJsonAtomic } from "../fs.js";

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

export async function exportWorkgraphJson({ dbPath, snapshotPath }) {
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

  const nodes = nodeRows.map((row) => {
    const id = row?.id;
    const lockRunId = row?.lock_run_id ?? null;
    const lock = lockRunId
      ? {
          runId: lockRunId,
          startedAt: row?.lock_started_at ?? null,
          pid: row?.lock_pid ?? null,
          host: row?.lock_host ?? null,
        }
      : null;
    const checkpoint = safeJsonParse(row?.checkpoint_json, null);

    return {
      id,
      title: row?.title ?? "",
      type: row?.type ?? "",
      status: row?.status ?? "open",
      dependsOn: dependsOnByNodeId.get(id) || [],
      runner: row?.runner ?? null,
      inputs: safeJsonParse(row?.inputs_json, []),
      ownership: safeJsonParse(row?.ownership_json, []),
      acceptance: safeJsonParse(row?.acceptance_json, []),
      verify: safeJsonParse(row?.verify_json, []),
      attempts: row?.attempts ?? 0,
      retryPolicy: safeJsonParse(row?.retry_policy_json, { maxAttempts: 3 }),
      blockedUntil: row?.blocked_until ?? null,
      lock,
      checkpoint,
      parentId: row?.parent_id ?? null,
      createdAt: row?.created_at ?? null,
      updatedAt: row?.updated_at ?? null,
      completedAt: row?.completed_at ?? null,
    };
  });

  await writeJsonAtomic(snapshotPath, { version: 1, nodes });
}

