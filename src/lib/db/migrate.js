import { sqliteExec, sqliteQueryJson } from "./sqlite3.js";

function hasColumn(rows, name) {
  const wanted = String(name || "").trim();
  if (!wanted) return false;
  for (const row of rows || []) {
    if (String(row?.name || "").trim() === wanted) return true;
  }
  return false;
}

export async function ensureDepsRequiredStatusColumn({ dbPath }) {
  const path = String(dbPath || "").trim();
  if (!path) throw new Error("Missing dbPath");

  const cols = await sqliteQueryJson(path, "PRAGMA table_info(deps);");
  if (cols.length === 0) throw new Error("Missing deps table");
  if (hasColumn(cols, "required_status")) return { changed: false };

  await sqliteExec(path, "ALTER TABLE deps ADD COLUMN required_status TEXT NOT NULL DEFAULT 'done';\n");
  return { changed: true };
}

