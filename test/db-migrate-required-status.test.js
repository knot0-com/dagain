import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { sqliteExec, sqliteJson } from "./helpers/sqlite.js";
import { ensureDepsRequiredStatusColumn } from "../src/lib/db/migrate.js";

function normalizeDefault(value) {
  return String(value || "")
    .trim()
    .replace(/^'+|'+$/g, "")
    .toLowerCase();
}

test("ensureDepsRequiredStatusColumn: adds deps.required_status with default done", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-migrate-"));
  const dbPath = path.join(tmpDir, "state.sqlite");

  await sqliteExec(
    dbPath,
    `CREATE TABLE deps (\n` +
      `  node_id TEXT NOT NULL,\n` +
      `  depends_on_id TEXT NOT NULL,\n` +
      `  PRIMARY KEY(node_id, depends_on_id)\n` +
      `);\n`,
  );

  const first = await ensureDepsRequiredStatusColumn({ dbPath });
  assert.equal(first.changed, true);

  const cols = await sqliteJson(dbPath, "PRAGMA table_info(deps);");
  const requiredStatus = cols.find((c) => c?.name === "required_status");
  assert.ok(requiredStatus, "expected required_status column");
  assert.equal(Number(requiredStatus.notnull ?? 0), 1);
  assert.equal(normalizeDefault(requiredStatus.dflt_value), "done");

  const second = await ensureDepsRequiredStatusColumn({ dbPath });
  assert.equal(second.changed, false);
});

