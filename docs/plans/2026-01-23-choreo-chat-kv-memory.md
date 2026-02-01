# Dagain Chat KV Memory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Persist lightweight `dagain chat` conversation memory into SQLite KV (`__run__`) and inject it into the chat router prompt so the default planner runner can keep context across turns.

**Architecture:** Treat chat memory as run-scoped state stored in `kv_latest` under node id `__run__`. After each routed chat turn, write `chat.summary` (short assistant reply), `chat.last_ops` (JSON), and `chat.turns` (JSON array of last N turns). Before each routed chat turn, read these keys and include a compact “Chat memory” section in the router prompt.

**Tech Stack:** Node.js (>=18), SQLite (`sqlite3` CLI), `node:test`, existing KV helpers in `src/lib/db/kv.js`.

---

## Task 1: Persist chat memory after routed turns

**Files:**
- Modify: `src/cli.js`
- Test: `test/chat-kv-memory.test.js`
- Create: `scripts/mock-chat-router-memory.js`

**Step 1: Write the failing test**

Create `test/chat-kv-memory.test.js`:
- Init a temp project (`dagain init --no-refine`).
- Configure a mock runner for chat routing that prints different replies depending on whether the packet contains prior “Chat memory”.
- Run `dagain chat --runner mock` twice:
  1) First run sends `hello` then `/exit`; assert KV contains `__run__:chat.turns` with `hello`.
  2) Second run sends `hi again` then `/exit`; assert stdout includes a reply indicating memory was present.

Run: `npm test -- test/chat-kv-memory.test.js`  
Expected: FAIL (no KV writes / no memory injected)

**Step 2: Implement minimal KV writes**

In `chatCommand(...)`:
- After a successful microcall and after executing `ops`, write:
  - `kvPut(__run__, "chat.summary", <assistant reply truncated>)`
  - `kvPut(__run__, "chat.last_ops", <JSON string>)`
  - `kvPut(__run__, "chat.turns", <JSON array string with last N turns>)`

Run: `npm test -- test/chat-kv-memory.test.js`  
Expected: PASS

---

## Task 2: Inject KV memory into router prompt

**Files:**
- Modify: `src/cli.js`
- Test: `test/chat-kv-memory.test.js`

**Step 1: Implement KV reads + prompt injection**

In `chatCommand(...)`, before constructing the router prompt:
- Read `__run__:chat.summary`, `__run__:chat.last_ops`, `__run__:chat.turns`.
- If any exist, include a compact section like:

```text
Chat memory (kv __run__):
- summary: ...
- last_ops: [...]
- recent turns:
  - user: ...
    assistant: ...
```

Keep it short (truncate and keep last N turns only).

Run: `npm test -- test/chat-kv-memory.test.js`  
Expected: PASS

---

## Task 3: Full suite

Run: `npm test`  
Expected: PASS

