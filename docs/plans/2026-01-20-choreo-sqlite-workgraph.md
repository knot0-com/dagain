# Dagain SQLite Workgraph Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Replace `.dagain/workgraph.json` as the source of truth with a SQLite-backed workgraph, while still exporting a read-only `.dagain/workgraph.json` snapshot for human readability.

**Architecture:** Treat `.dagain/state.sqlite` as the canonical state store for nodes, deps, locks, and node-scoped KV (“env variables”) keyed by `(node_id, key)`. Keep SQLite writes small by storing large payloads as files under `.dagain/artifacts/` and saving pointers/hashes in SQLite. Export `.dagain/workgraph.json` after every state mutation for UX/debugging.

**Tech Stack:** Node.js `>=18`, `sqlite3` CLI on `PATH`, existing `node:test` suite, existing runner model (Codex/Claude/Gemini) unchanged.

---

## Scope / Non-goals

- In scope: DB-backed graph state, DB-backed locking semantics, export JSON snapshot for readability, **agent↔DB interaction contract** (how nodes are created/spawned + how node context is loaded), `(node_id,key)` KV with history retention (last 5), **parent escalation on permanent failure**, **in-node microcalls via `dagain microcall`**, update tests + docs.
- Out of scope (for this plan): true parallel supervisor/workers, worktrees, importing legacy `workgraph.json` state, cross-node full-text search, advanced microcall budgets/caching.

## Breaking changes

- Existing `.dagain/workgraph.json` will no longer be read as authoritative state. It becomes a derived snapshot.
- `sqlite3` becomes a runtime dependency for `dagain` (not just spawned agents).

---

## DB Schema (initial)

Create: `src/lib/db/schema.sql`

```sql
-- schema.sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', '1');

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_id TEXT,

  runner TEXT,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  ownership_json TEXT NOT NULL DEFAULT '[]',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  verify_json TEXT NOT NULL DEFAULT '[]',
  retry_policy_json TEXT NOT NULL DEFAULT '{"maxAttempts":3}',
  attempts INTEGER NOT NULL DEFAULT 0,

  blocked_until TEXT,

  -- lock fields (NULL means unlocked)
  lock_run_id TEXT,
  lock_started_at TEXT,
  lock_pid INTEGER,
  lock_host TEXT,

  checkpoint_json TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);

CREATE TABLE IF NOT EXISTS deps (
  node_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  PRIMARY KEY(node_id, depends_on_id),
  FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY(depends_on_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON deps(depends_on_id);

-- Node-scoped environment variables (fast latest + bounded history)
CREATE TABLE IF NOT EXISTS kv_latest (
  node_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_text TEXT,
  artifact_path TEXT,
  artifact_sha256 TEXT,
  fingerprint_json TEXT,
  run_id TEXT,
  attempt INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(node_id, key)
);

CREATE TABLE IF NOT EXISTS kv_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_text TEXT,
  artifact_path TEXT,
  artifact_sha256 TEXT,
  fingerprint_json TEXT,
  run_id TEXT,
  attempt INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kv_history_node_key ON kv_history(node_id, key, id);
```

---

## Agent ↔ Graph/DB Contract (how recursion + context actually works)

### 1) Who controls the workgraph?

- **Dagain is the only writer** for graph control-plane tables: `nodes`, `deps`, lock fields, and node `status`.
- A runner/agent does **not** directly mutate graph state via `sqlite3`. Instead, it proposes graph changes via its normal `<result>...</result>` output:
  - `result.status` sets the current node outcome (`success`, `checkpoint`, `fail`).
  - `result.next.addNodes[]` is how an agent **generates new work** (recursive decomposition).
  - Dagain receives the result, validates it, and persists it into SQLite (and exports the JSON snapshot).

This keeps scheduling/locking deterministic and runner-agnostic.

### 2) How are “sub agents” spawned?

- Every node execution is one fresh runner invocation (Codex/Claude/Gemini) driven by the supervisor loop.
- The supervisor:
  1) selects a runnable node (SQL selection rules),
  2) atomically claims it (sets `status='in_progress'` + lock fields),
  3) renders a packet from templates,
  4) spawns the runner command in the repo root,
  5) parses `<result>`,
  6) applies state changes (node done/checkpoint/fail + inserts new nodes/deps),
  7) exports `.dagain/workgraph.json` snapshot.

### 3) How node context is fed to sub agents

There are two complementary mechanisms (use both):

- **(A) Environment pointers (always available):** dagain injects env vars into the runner process so the agent can load exactly what it needs on-demand:
  - `DAGAIN_DB=.dagain/state.sqlite`
  - `DAGAIN_NODE_ID=<current node id>`
  - `DAGAIN_RUN_ID=<current run id>`
  - `DAGAIN_PARENT_NODE_ID=<parent id or empty>`
  - `DAGAIN_ARTIFACTS_DIR=.dagain/artifacts`
  - `DAGAIN_CHECKPOINTS_DIR=.dagain/checkpoints`
  - `DAGAIN_RUNS_DIR=.dagain/runs`
  - `DAGAIN_BIN=bin/dagain.js` (executable; optional helper commands)

- **(B) Explicit node inputs (small “context refs”):** each node can declare `inputs_json` (a list of refs) that dagain renders into the packet for convenience:
  - Each input is `{ "nodeId": "task-123", "key": "out.summary", "as": "priorSummary" }` (the `as` field is optional).
  - Dagain should render inputs as **refs** by default (node+key), and may inline small `value_text` (e.g. ≤2KB) but must avoid bloating packets.

**Key point:** context stays in the environment (SQLite + artifacts), and sub agents load it dynamically.

### 4) How agents store + retrieve sub-context (KV)

- Agents write “sub-context” into `kv_latest/kv_history` (not into `nodes`).
- Retrieval is key-based, cross-node: `(node_id, key)` lookups.
- Retention: keep only the last **5** history rows per `(node_id, key)` (plus `kv_latest` as the current view).
- Add a **run-scoped namespace** by reserving a sentinel `node_id="__run__"`. This is shared memory across nodes for the current dagain session.
  - Agents may write to their own node (`$DAGAIN_NODE_ID`) and to `__run__`.
  - Agents may read any node (including `__run__`).

Concrete `sqlite3` examples (parameterized to avoid quoting bugs):

```bash
# Read a key from the current node:
sqlite3 -json "$DAGAIN_DB" \\
  -cmd ".parameter init" \\
  -cmd ".parameter set :n '$DAGAIN_NODE_ID'" \\
  -cmd ".parameter set :k 'out.summary'" \\
  "SELECT value_text, artifact_path, artifact_sha256, updated_at FROM kv_latest WHERE node_id=:n AND key=:k;"

# Read a key from parent:
sqlite3 -json "$DAGAIN_DB" \\
  -cmd ".parameter init" \\
  -cmd ".parameter set :n '$DAGAIN_PARENT_NODE_ID'" \\
  -cmd ".parameter set :k 'ctx.decision'" \\
  "SELECT value_text, artifact_path FROM kv_latest WHERE node_id=:n AND key=:k;"

# Read a shared run-scoped key:
sqlite3 -json "$DAGAIN_DB" \\
  -cmd ".parameter init" \\
  -cmd ".parameter set :n '__run__'" \\
  -cmd ".parameter set :k 'ctx.repo_overview'" \\
  "SELECT value_text, artifact_path FROM kv_latest WHERE node_id=:n AND key=:k;"
```

---

## Permanent failure “promotion” to parent (escalation node)

When a node reaches max retries and becomes `status='failed'`, dagain should automatically “promote” it to a higher-level agent by creating an **escalation node**:

- New node:
  - `id`: `plan-escalate-<failedNodeId>` (or another deterministic scheme)
  - `type`: `plan` (planner role)
  - `dependsOn`: `[<failedNodeId>]`
  - `parent_id`: `<failedNode.parent_id>` (or `NULL` if none)
  - `inputs_json`: include pointers back to the failed node’s debug keys (example):
    - `{nodeId: "<failedNodeId>", key: "err.summary"}`
    - `{nodeId: "<failedNodeId>", key: "out.last_stdout_path"}`
    - `{nodeId: "<failedNodeId>", key: "out.last_result_path"}`

The escalation node’s acceptance criteria:
- either (a) proposes a fix by adding new nodes, or (b) checkpoints a human decision, or (c) reopens/resets the failed node with a new approach.

This is how “sub node → higher-level agent context” happens without needing microcalls.

---

## System Prompt / Template Design (stock runners, DB-first context)

Dagain’s “system prompt” is effectively the role packet template (`templates/*.md`). The goal is to make DB usage and recursive graph decomposition the default behavior for stock coding agents.

### Shared snippet (add to every role template)

Add this section (or equivalent) to `templates/planner.md`, `templates/executor.md`, `templates/verifier.md`, `templates/integrator.md`, and `templates/final-verifier.md`:

```markdown
## DB-First Context (REQUIRED)

You have access to a SQLite state DB and an artifacts directory:
- DB: `$DAGAIN_DB`
- Node: `$DAGAIN_NODE_ID`
- Parent node (may be empty): `$DAGAIN_PARENT_NODE_ID`
- Run: `$DAGAIN_RUN_ID`
- Artifacts dir: `$DAGAIN_ARTIFACTS_DIR`

Rules:
- Do not write to `nodes` / `deps` tables. Only Dagain mutates the workgraph.
- Use the DB only for *node context*: read other nodes via `(node_id,key)` lookups and write your own keys.
- If something is large (logs, long snippets, analyses), write it to `$DAGAIN_ARTIFACTS_DIR` as a file and store only a pointer in the DB.
- Prefer `dagain kv ...` helper commands when available; otherwise use `sqlite3 "$DAGAIN_DB" ...`.
```

### Planner prompt rules (recursive graph mechanism)

Planner templates should explicitly teach “spawning subagents” as graph recursion:

- To create sub work, return `next.addNodes` entries.
- Each node you add should include:
  - `dependsOn` for ordering
  - `ownership` globs for safe parallelism later
  - `acceptance` + `verify`
  - optional `inputs` refs, for context handoff without bloating prompts:
    - `inputs: [{"nodeId":"{{NODE_ID}}","key":"ctx.goalSummary","as":"goal"}]`

Add this to `templates/planner.md`:

```markdown
## Recursion (How to Spawn Subagents)

To spawn follow-up agents, add nodes in your `<result>.next.addNodes`.
Dagain will persist them to the workgraph and execute them as fresh agents.

When you add nodes, include small `inputs` refs that point to DB keys (nodeId+key) instead of pasting large context.
```

### Executor/Verifier prompt rules (what to write to the DB)

Add explicit key conventions so downstream nodes can reliably retrieve context:

- `out.summary` (1–3 sentences)
- `out.filesChanged` (JSON list or `value_text`)
- `out.commandsRun` (JSON list)
- `out.last_stdout_path` (path to run log)
- `err.summary` (short failure reason)
- `err.repro` (minimal repro steps / failing command)

Add this to `templates/executor.md` and `templates/verifier.md`:

```markdown
## REQUIRED: Write Node Outputs to DB

Before returning `<result>`, write:
- `out.summary`
- `out.last_stdout_path`

If failing or checkpointing, also write:
- `err.summary`
- `err.repro`
```

### Direct SQLite vs `dagain kv` wrapper (recommended posture)

- Reads: allow raw `sqlite3 -json "$DAGAIN_DB" "SELECT ..."` for ad-hoc debugging.
- Writes: strongly prefer `dagain kv put` so we can enforce “only write your own node” and centralize retention/artifact pointer logic.

### Enforcing DB-first behavior (“required keys”)

Use **strict** enforcement, but make it cheap and reliable:

- Dagain auto-populates the following keys from the runner execution context and `<result>` payload (agents do not need to write these manually):
  - `out.summary` (from `result.summary`)
  - `out.last_stdout_path` (from the run log path)
  - `out.last_result_path` (from the parsed `result.json` path)
  - `err.summary` (from `result.summary` when status is `fail`/`checkpoint`, or from `result.errors[0]`)
- If these keys are missing after apply, treat the node as `fail` (retry), because escalation/promotions depend on them.

Agents may add additional keys for richer context (e.g., `ctx.repo_findings`, `out.rationale`, `err.stacktrace_artifact`).
If writing shared/global keys, use `node_id="__run__"` and prefix keys with `ctx.` (example: `ctx.decisions`, `ctx.constraints`, `ctx.shared_findings`).

---

## Hidden in-node microcalls (`dagain microcall`)

“Recursive graph nodes” are Dagain’s **control-plane recursion** (visible work items in the DB). “Microcalls” are **in-node recursion** (hidden helpers inside a single node run).

Use **microcalls** when the output is small and you want to keep the main agent fresh:
- Summarize/transform context into a tight JSON blob
- Generate alternatives + tradeoffs for a decision
- Extract structured fields from logs/files (after you loaded them)

Use **graph nodes** (`next.addNodes`) when the work:
- Requires file edits/commands, or needs verification
- Benefits from retries + escalation semantics
- Needs ownership/deps to avoid conflicts

### `dagain microcall` CLI contract (MVP)

- The agent runs: `dagain microcall --prompt "..." [--runner <name> | --role researcher] [--store-key ctx.foo] [--run]`
- Dagain:
  - renders `templates/microcall.md`
  - runs the chosen runner (same mechanism as nodes: `runRunnerCommand`)
  - extracts JSON from stdout (`<result>...</result>` / ```json fences / raw JSON)
  - writes artifacts under:
    - preferred: `.dagain/runs/$DAGAIN_RUN_ID/microcalls/<microId>/`
    - fallback: `.dagain/microcalls/<microId>/`
  - prints the extracted JSON to stdout (so the parent agent can use it immediately)
  - optionally persists the JSON into KV (see below)

### Microcall output shape (recommended)

`templates/microcall.md` should require:
- no tool use / no file modifications
- output **only** a `<result>{...}</result>` JSON block

Suggested schema:

```json
{
  "version": 1,
  "status": "success",
  "summary": "1-2 sentence takeaway",
  "data": {}
}
```

### Storing microcall results in the DB (recommended)

If `--store-key <k>` is provided:
- default store target is the current node (`$DAGAIN_NODE_ID`)
- `--run` stores into the shared run namespace (`node_id="__run__"`)
- the stored value should be the **full JSON string** of the microcall result (so downstream reads can re-parse)

This keeps the parent agent fresh while still allowing downstream nodes to “rehydrate” the microcall outcome via `dagain kv get`.

---

## Task 1: Add DB plumbing + schema initialization

**Files:**
- Create: `src/lib/db/schema.sql`
- Create: `src/lib/db/sqlite3.js`
- Modify: `src/lib/config.js`
- Modify: `src/cli.js`
- Test: `test/db-init.test.js`
- Test helper: `test/helpers/sqlite.js`

**Step 1: Write failing test for DB creation**

Create `test/db-init.test.js` that:
- Runs `node bin/dagain.js init --goal "X" --no-refine --force --no-color` in a tmp dir.
- Asserts `.dagain/state.sqlite` exists.
- Asserts `nodes` contains `plan-000`.

Use helper `test/helpers/sqlite.js`:

```js
import { spawn } from "node:child_process";

export function sqliteJson(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", ["-json", dbPath, sql], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err || `sqlite3 exited ${code}`));
      resolve(out.trim() ? JSON.parse(out) : []);
    });
  });
}
```

Run: `node --test test/db-init.test.js`  
Expected: FAIL (no DB yet).

**Step 2: Implement DB init**

Create `src/lib/db/sqlite3.js` that can:
- `exec(dbPath, sql)` (for schema)
- `queryJson(dbPath, sql)` (uses `sqlite3 -json`)

Update `src/lib/config.js` `dagainPaths()` to include:
- `dbPath: path.join(dagainDir, "state.sqlite")`
- `graphSnapshotPath: path.join(dagainDir, "workgraph.json")` (export-only)
- `artifactsDir: path.join(dagainDir, "artifacts")`

Update `initCommand` in `src/cli.js` to:
- Ensure `.dagain/artifacts/`
- Create DB and apply `schema.sql`
- Insert `plan-000` node + timestamps (no JSON workgraph generation)

**Step 3: Re-run test**

Run: `node --test test/db-init.test.js`  
Expected: PASS.

**Step 4: Commit**

```bash
git add src/lib/db/schema.sql src/lib/db/sqlite3.js src/lib/config.js src/cli.js test/db-init.test.js test/helpers/sqlite.js
git commit -m "feat(dagain): add sqlite state db scaffold"
```

---

## Task 2: Feed DB pointers + node inputs into runner packets (agent UX)

**Files:**
- Modify: `src/cli.js`
- Modify: `templates/*.md` (built-ins) AND `.dagain/templates/*.md` (copied templates, if used)
- Create: `test/packet-db-pointers.test.js`

**Step 1: Write failing test**

Create `test/packet-db-pointers.test.js` that:
- Creates a tmp dagain project, runs `dagain init`.
- Forces a single node execution using a mock runner that prints `$DAGAIN_DB` and `$DAGAIN_NODE_ID`.
- Asserts the runner process received those env vars (e.g., check `.dagain/runs/<run>/stdout.log` contains the DB path).

Run: `node --test test/packet-db-pointers.test.js`  
Expected: FAIL.

**Step 2: Inject env vars into runner spawn**

In `executeNode()` (and goal-refine if desired), add runner env:
- `DAGAIN_DB` (absolute path)
- `DAGAIN_NODE_ID`
- `DAGAIN_RUN_ID`
- `DAGAIN_PARENT_NODE_ID` (query parent_id from DB; empty if none)
- `DAGAIN_ARTIFACTS_DIR` (absolute path)
- `DAGAIN_BIN` (absolute path to `bin/dagain.js`)

**Step 3: Render node inputs into packet**

Update packet rendering to include:
- “DB access” section with the env vars above.
- “Node inputs” section: read `nodes.inputs_json`, and print refs (and optional inlined small values from `kv_latest`).

**Step 4: Re-run test**

Run: `node --test test/packet-db-pointers.test.js`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/cli.js templates .dagain/templates test/packet-db-pointers.test.js
git commit -m "feat(dagain): inject db pointers + node inputs into packets"
```

---

## Task 3: Export `.dagain/workgraph.json` snapshot from DB (UX-only)

**Files:**
- Create: `src/lib/db/export.js`
- Modify: `src/cli.js`
- Test: `test/workgraph-snapshot.test.js`

**Step 1: Write failing test**

Create `test/workgraph-snapshot.test.js`:
- Run `dagain init ...`
- Assert `.dagain/workgraph.json` exists and includes `nodes[0].id === "plan-000"`.

Run: `node --test test/workgraph-snapshot.test.js`  
Expected: FAIL.

**Step 2: Implement exporter**

In `src/lib/db/export.js`, implement `exportWorkgraphJson({ dbPath, snapshotPath })`:
- `SELECT` all nodes (parse JSON fields)
- `SELECT` all deps and attach `dependsOn` arrays per node
- Emit JSON with a stable shape compatible with existing UX (include `nodes`, `version`, timestamps)

Call exporter:
- At end of `initCommand`
- After every node state mutation path in `runCommand` / `answerCommand`

**Step 3: Re-run test**

Run: `node --test test/workgraph-snapshot.test.js`  
Expected: PASS.

**Step 4: Commit**

```bash
git add src/lib/db/export.js src/cli.js test/workgraph-snapshot.test.js
git commit -m "feat(dagain): export workgraph.json snapshot from sqlite"
```

---

## Task 4: Replace scheduler logic with SQL (recursive graph remains)

**Files:**
- Create: `src/lib/db/nodes.js`
- Modify: `src/cli.js`
- Delete or deprecate: `src/lib/workgraph.js`, `src/lib/select.js` (only after tests pass)
- Test: `test/select-sql.test.js`

**Step 1: Write failing test for node selection**

Create `test/select-sql.test.js` that sets up a DB with:
- node `a` done
- node `b` open depends on `a`
- node `c` open type verify
Then asserts `selectNextRunnableNode()` returns `c` (verify priority).

Run: `node --test test/select-sql.test.js`  
Expected: FAIL.

**Step 2: Implement SQL selection**

In `src/lib/db/nodes.js` implement:
- `selectNextRunnableNode({ dbPath, nowIso })` with SQL equivalent of current rules:
  - `status='open'`
  - `blocked_until IS NULL OR blocked_until <= now`
  - `lock_run_id IS NULL`
  - all deps are `status='done'`
  - order by type priority (`verify` < `task` < `plan/epic` < `integrate` < `final_verify`) then `id`

**Step 3: Wire into `runCommand` loop**

In `src/cli.js`, replace `loadWorkgraph/selectNextNode/saveWorkgraph` usage with DB calls.

**Step 4: Re-run test**

Run: `node --test test/select-sql.test.js`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/db/nodes.js src/cli.js test/select-sql.test.js
git commit -m "refactor(dagain): SQL-backed node selection"
```

---

## Task 5: Atomic claim/lock + applyResult in SQL

**Files:**
- Modify: `src/lib/db/nodes.js`
- Modify: `src/cli.js`
- Test: `test/claim-node.test.js`

**Step 1: Write failing test**

Create `test/claim-node.test.js` that:
- Inserts one open node
- Calls `claimNode({nodeId, runId, pid, host})` twice and asserts second claim fails

Run: `node --test test/claim-node.test.js`  
Expected: FAIL.

**Step 2: Implement `claimNode`**

Add `claimNode()` with a single `UPDATE ... WHERE status='open' AND lock_run_id IS NULL` and check affected rows.

**Step 3: Implement `applyResult` against DB**

Replace JSON `applyResult()` with DB version:
- `success` => set `status='done'`, clear lock, set `completed_at`
- `checkpoint` => set `status='needs_human'`, clear lock, set `checkpoint_json`
- else => increment `attempts`, set `status` to `failed` or `open` per retry policy, clear lock
- Insert `next.addNodes`:
  - If node doesn’t exist, insert with defaults + `parent_id=currentNodeId`
  - Insert deps from `dependsOn`

Always export JSON snapshot afterward.

**Step 3b: Permanent failure escalation (promotion)**

When `applyResult` transitions a node to `status='failed'` (attempts >= maxAttempts):
- Create an escalation node (type `plan`) as described above.
- Ensure it depends on the failed node.
- Seed its `inputs_json` to point back to failed-node debug keys.

Add assertions to `test/claim-node.test.js` (or a new test) verifying the escalation node is created exactly once.

**Step 4: Re-run tests**

Run: `node --test test/claim-node.test.js`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/db/nodes.js src/cli.js test/claim-node.test.js
git commit -m "feat(dagain): atomic claim + applyResult in sqlite"
```

---

## Task 6: Update `answer` command to DB

**Files:**
- Modify: `src/cli.js`
- Test: `test/answer-db.test.js`

**Step 1: Write failing test**

Create `test/answer-db.test.js` that:
- Creates DB with one node `needs_human` and a checkpoint file
- Runs `node bin/dagain.js answer --node=... --answer="..." --no-prompt`
- Asserts node status becomes `open` and `checkpoint_json` includes the answer

Run: `node --test test/answer-db.test.js`  
Expected: FAIL.

**Step 2: Implement DB-backed answer**

Replace `loadWorkgraph/saveWorkgraph` in `answerCommand` with DB queries/updates:
- List `needs_human` nodes from DB
- Update node `status='open'`, clear locks, update `checkpoint_json`
- Export JSON snapshot

**Step 3: Re-run test**

Run: `node --test test/answer-db.test.js`  
Expected: PASS.

**Step 4: Commit**

```bash
git add src/cli.js test/answer-db.test.js
git commit -m "refactor(dagain): answer uses sqlite state"
```

---

## Task 7: Planner scaffolding in SQL (verify/integrate/final gates)

**Files:**
- Modify: `src/cli.js` (or move to `src/lib/db/scaffold.js`)
- Test: `test/planner-scaffold-db.test.js`

**Step 1: Write failing test**

Create `test/planner-scaffold-db.test.js` that:
- Creates DB with 1 task node but no verify/integrate/final nodes
- Runs the scaffold function
- Asserts verify + integrate + final nodes exist with correct deps

Run: `node --test test/planner-scaffold-db.test.js`  
Expected: FAIL.

**Step 2: Implement**

Port existing `ensurePlannerScaffolding()` logic to SQL:
- Find tasks
- Ensure at least one verify per task (or multi-verifier behavior if configured)
- Ensure exactly one integrate depending on all verify nodes
- Ensure exactly one final_verify depending on integrate

Export JSON snapshot.

**Step 3: Re-run test**

Run: `node --test test/planner-scaffold-db.test.js`  
Expected: PASS.

**Step 4: Commit**

```bash
git add src/cli.js test/planner-scaffold-db.test.js
git commit -m "refactor(dagain): planner scaffolding via sqlite"
```

---

## Task 8: KV env (`node_id + key`) with last-5 retention

**Files:**
- Create: `src/lib/db/kv.js`
- Modify: `src/cli.js` (env injection only)
- Create: `bin/dagain-kv.js` (optional CLI wrapper) OR add subcommands to `bin/dagain.js`
- Test: `test/kv-retention.test.js`

**Step 1: Write failing test**

Create `test/kv-retention.test.js` that:
- Writes 6 values to the same `(node_id,key)`
- Asserts `kv_latest` returns the 6th
- Asserts `kv_history` count is 5 (oldest pruned)

Run: `node --test test/kv-retention.test.js`  
Expected: FAIL.

**Step 2: Implement KV writes**

In `src/lib/db/kv.js`, implement:
- `kvPut({dbPath, nodeId, key, valueText, artifactPath, artifactSha256, fingerprintJson, runId, attempt, nowIso})`
  - insert into `kv_history`
  - upsert `kv_latest`
  - delete history rows beyond newest 5 for `(node_id,key)`
- `kvGet({dbPath, nodeId, key})`

**Step 2b: Provide an agent-friendly CLI**

Add a `dagain kv` subcommand (preferred over raw SQL in prompts):
- `dagain kv get --node <id> --key <k> [--json]`
- `dagain kv put --node <id> --key <k> --value <text>`
- `dagain kv ls --node <id> [--prefix ctx.]`
- Run-scoped helpers (write/read shared `__run__` keys):
  - `dagain kv get --run --key <k> [--json]`
  - `dagain kv put --run --key <k> --value <text>`
  - `dagain kv ls --run [--prefix ctx.]`

Make sure these subcommands:
- do not take the supervisor lock,
- are safe to call from inside node execution,
- use `DAGAIN_DB`/`DAGAIN_NODE_ID` defaults when flags omitted,
- **restrict writes**:
  - allow writing only to `$DAGAIN_NODE_ID` or `__run__` by default
  - require `--allow-cross-node-write` for any other `--node <id>` (intended for humans, not agents)

Update templates to include a short “KV cheat sheet” using `dagain kv ...`.

**Step 3: Wire runner env**

When spawning agents in `executeNode`, set:
- `DAGAIN_DB=.dagain/state.sqlite`
- `DAGAIN_NODE_ID=<node.id>`
- `DAGAIN_RUN_ID=<run>`
- `DAGAIN_ARTIFACTS_DIR=.dagain/artifacts`

(Use these later in templates; no microcalls required.)

**Step 4: Re-run test**

Run: `node --test test/kv-retention.test.js`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/db/kv.js src/cli.js test/kv-retention.test.js
git commit -m "feat(dagain): node-scoped kv with retention"
```

---

## Task 9: Update end-to-end tests + remove JSON state dependency

**Files:**
- Modify: `test/e2e.test.js`
- Modify: `test/deadlock-auto-reset.test.js`
- Modify: any other tests that directly edit `.dagain/workgraph.json`

**Step 1: Make e2e test assert on snapshot + DB**

Update `test/e2e.test.js` to assert:
- `.dagain/state.sqlite` exists
- `.dagain/workgraph.json` snapshot exists and shows nodes `done`

Run: `node --test test/e2e.test.js`  
Expected: PASS.

**Step 2: Rewrite deadlock test to manipulate DB**

Instead of writing `.dagain/workgraph.json`, use `sqlite3` to set up `nodes/deps` into the DB, then run `dagain run --dry-run` and assert the reset behavior via DB or snapshot.

Run: `node --test test/deadlock-auto-reset.test.js`  
Expected: PASS.

**Step 3: Commit**

```bash
git add test/e2e.test.js test/deadlock-auto-reset.test.js
git commit -m "test(dagain): update tests for sqlite-backed state"
```

---

## Task 10: Docs + cleanup

**Files:**
- Modify: `README.md`
- Modify: `src/lib/config.js`
- Delete (if unused): `src/lib/workgraph.js`, `src/lib/select.js`

**Step 1: Update README state section**

Document:
- `.dagain/state.sqlite` is canonical
- `.dagain/workgraph.json` is exported snapshot
- `.dagain/artifacts/` for large context payloads

**Step 2: Remove dead code**

Delete any unused JSON graph logic once tests are green.

**Step 3: Full test run**

Run: `npm test`  
Expected: PASS.

**Step 4: Commit**

```bash
git add README.md src/lib/config.js src/lib/workgraph.js src/lib/select.js
git commit -m "docs(dagain): document sqlite state + remove json graph internals"
```

---

## Task 11: Add `dagain microcall` (in-node helper calls)

**Files:**
- Create: `templates/microcall.md`
- Modify: `src/cli.js`
- Test: `test/microcall.test.js`

**Step 1: Write failing test**

Create `test/microcall.test.js` that:
- sets up a tmp dagain project with a config runner like `node scripts/mock-agent-log.js microcall {packet}`
- runs `node bin/dagain.js microcall --prompt "hello" --runner mock --json`
- asserts stdout is valid JSON and includes `status: "success"`

Run: `node --test test/microcall.test.js`  
Expected: FAIL (command missing).

**Step 2: Add `templates/microcall.md`**

Template must:
- include `MICROCALL_PROMPT`
- require output as `<result>{...}</result>`
- forbid file edits and tool use

**Step 3: Implement `microcall` command**

In `src/cli.js`:
- add a `microcall` subcommand in `usage()` and CLI dispatch
- load config/paths (no supervisor lock)
- pick runner:
  - `--runner` wins
  - else `--role` picks from config (default `researcher`)
- create run dir under `.dagain/runs/$DAGAIN_RUN_ID/microcalls/<microId>` when env is present, otherwise `.dagain/microcalls/<microId>`
- render `templates/microcall.md` into `packet.md`
- run runner with `runRunnerCommand`
- read `stdout.log`, extract JSON with `extractResultJson`, write `result.json`, and print JSON to stdout
- if `--store-key` is provided and `DAGAIN_DB` exists, call KV write logic (Task 8) to store the JSON under:
  - current node by default
  - `__run__` when `--run` is used

**Step 4: Re-run test**

Run: `node --test test/microcall.test.js`  
Expected: PASS.

**Step 5: Commit**

```bash
git add templates/microcall.md src/cli.js test/microcall.test.js
git commit -m "feat(dagain): add microcall helper command"
```

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-01-20-dagain-sqlite-workgraph.md`. Two execution options:

1. **Subagent-Driven (this session)** — use `superpowers:subagent-driven-development` and implement task-by-task with review checkpoints.
2. **Parallel Session (separate)** — open a new session in an isolated worktree and use `superpowers:executing-plans` to execute with checkpoints.
