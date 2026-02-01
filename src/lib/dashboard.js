// Input — dagain DB helpers and supervisor lock reader. If this file changes, update this header and the folder Markdown.
// Output — `loadDashboardSnapshot({ paths })` snapshot for UIs. If this file changes, update this header and the folder Markdown.
// Position — Shared snapshot adapter over SQLite + lock state. If this file changes, update this header and the folder Markdown.

import { countByStatusDb, listNodes, selectNextRunnableNode } from "./db/nodes.js";
import { readSupervisorLock } from "./lock.js";

export async function loadDashboardSnapshot({ paths }) {
  const nowIso = new Date().toISOString();
  const counts = await countByStatusDb({ dbPath: paths.dbPath });
  const next = await selectNextRunnableNode({ dbPath: paths.dbPath, nowIso }).catch(() => null);
  const nodes = await listNodes({ dbPath: paths.dbPath });
  const supervisor = await readSupervisorLock(paths.lockPath).catch(() => null);
  return { nowIso, counts, next, nodes, supervisor };
}
