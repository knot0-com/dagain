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

export async function ensureMailboxTable({ dbPath }) {
  const path = String(dbPath || "").trim();
  if (!path) throw new Error("Missing dbPath");

  await sqliteExec(
    path,
    "CREATE TABLE IF NOT EXISTS mailbox (\n" +
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      "  status TEXT NOT NULL,\n" +
      "  command TEXT NOT NULL,\n" +
      "  args_json TEXT NOT NULL DEFAULT '{}',\n" +
      "  claim_token TEXT,\n" +
      "  claimed_at TEXT,\n" +
      "  claimed_by_pid INTEGER,\n" +
      "  claimed_by_host TEXT,\n" +
      "  completed_at TEXT,\n" +
      "  result_json TEXT,\n" +
      "  error_text TEXT,\n" +
      "  created_at TEXT NOT NULL\n" +
      ");\n" +
      "CREATE INDEX IF NOT EXISTS idx_mailbox_status_id ON mailbox(status, id);\n" +
      "CREATE INDEX IF NOT EXISTS idx_mailbox_claim_token ON mailbox(claim_token);\n",
  );

  return { changed: false };
}
