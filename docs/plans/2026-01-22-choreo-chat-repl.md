# Choreo Chat REPL (Codex-first) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add a human-facing chat REPL (`choreo chat`) and make `choreo` (no args) drop into chat when stdin/stdout are TTY. Chat should support natural-language steering, status checks, and replanning ergonomics, without letting runners write directly to `nodes/deps`.

**Architecture:** Implement `choreo chat` as a readline REPL. Built-in slash commands handle common operations without LLM (`/status`, `/run`, `/stop`, `/exit`). For natural language messages, call a Codex microcall that returns structured “ops” (add node / set status / kv get/put) and an assistant reply; Choreo executes ops (single-writer) and prints results. Add a `choreo node ...` command for ergonomic, safe graph edits (idempotent SQL, transactions, guardrails).

**Tech Stack:** Node.js (>=18), SQLite (`sqlite3` CLI), `node:test`

---

## Success Metrics

- `choreo chat` starts a REPL and exits cleanly on `/exit` (non-TTY friendly for scripting/tests).
- `choreo` (no args) enters chat only when stdin+stdout are TTY; otherwise prints usage and exits (no hanging in CI).
- Humans can add tasks and change node status without raw SQL via `choreo node ...` or via chat NL.
- Operations are idempotent and safe under concurrency (`--workers > 1`): use transactions + `INSERT OR IGNORE`.

---

## Task 1: Add `choreo chat` command skeleton + tests (REPL only)

**Files:**
- Create: `test/chat-repl.test.js`
- Modify: `src/cli.js`

**Step 1: Write failing test**

Create `test/chat-repl.test.js`:
- Create tmp dir, run `choreo init --goal X --no-refine`.
- Spawn `node bin/choreo.js chat` with stdin pipe.
- Write `/status\n/exit\n` and assert exit code 0 and output contains `choreo chat` or a prompt banner.

Run: `npm test -- test/chat-repl.test.js`  
Expected: FAIL (command missing)

**Step 2: Implement minimal chat REPL**

In `src/cli.js`:
- Add `chat` to `usage()`.
- Add `chatCommand(rootDir, flags)` that:
  - loads config/db
  - prints a short banner
  - uses readline to accept lines
  - handles `/help`, `/status`, `/exit`

Run: `npm test -- test/chat-repl.test.js`  
Expected: PASS

---

## Task 2: Make `choreo` (no args) enter chat when TTY (guarded)

**Files:**
- Modify: `src/cli.js`
- Create: `test/chat-default-tty-guard.test.js`

**Step 1: Write failing test**

Create `test/chat-default-tty-guard.test.js`:
- Spawn `node bin/choreo.js` with no args in non-TTY (pipes).
- Assert it prints usage and exits (does not hang).

Run: `npm test -- test/chat-default-tty-guard.test.js`  
Expected: FAIL (after we switch default behavior without guard)

**Step 2: Implement guarded default**

In `main()`:
- If no `command` and tty: call `chatCommand(...)`.
- If no `command` and non-tty: print usage.
- Keep `choreo <goal...>` behavior for unknown commands (implicit goal string).

Run: `npm test -- test/chat-default-tty-guard.test.js`  
Expected: PASS

---

## Task 3: Add `choreo node` ergonomic graph operations (add, set-status)

**Files:**
- Modify: `src/cli.js`
- Create: `test/node-cli.test.js`

**Step 1: Write failing test**

Create `test/node-cli.test.js`:
- Init tmp project.
- Run: `choreo node add --id task-001 --title "T" --type task --parent plan-000`
- Assert node exists in sqlite with expected fields.
- Run: `choreo node set-status --id task-001 --status done`
- Assert node status updated.

Run: `npm test -- test/node-cli.test.js`  
Expected: FAIL (command missing)

**Step 2: Implement `node` subcommands**

In `src/cli.js`:
- Add dispatch for `command === "node"`.
- Implement `nodeCommand(rootDir, positional, flags)` with:
  - `add`: inserts node (transaction), optionally inserts deps, updates snapshot + task_plan
  - `set-status`: updates status (guard: refuse if `lock_run_id` set unless `--force`)
  - Use `INSERT OR IGNORE` for idempotency.

Run: `npm test -- test/node-cli.test.js`  
Expected: PASS

---

## Task 4: Natural-language chat via Codex microcall (optional for MVP, feature-flagged)

**Files:**
- Modify: `src/cli.js`
- Modify: `templates/microcall.md` or add `templates/chat.md`
- Create: `test/chat-nl-disabled.test.js` (ensures no-llm mode doesn’t crash)

**Step 1: Add `--no-llm` flag**

Chat supports:
- `/...` commands always
- Free-form NL:
  - if `--no-llm`, print a helpful message and continue
  - else call microcall runner to get `{ reply, ops[] }` and apply ops

**Step 2: Tests**

Add a test that runs `choreo chat --no-llm` and sends a free-form line + `/exit`, asserting it exits and prints a fallback message.

---

## Task 5: Full suite

Run: `npm test`  
Expected: PASS

