---
title: "dagain"
status: active
date: "2026-02-02"
parents: []
tags: ["dagain", "docs"]
input: "GitHub/npm readers and CLI users"
output: "User-facing docs for `dagain`"
position: "Repo/package README and primary usage reference"
---

<!-- Input — GitHub/npm readers and CLI users. If this file changes, update this header and the folder Markdown. -->
<!-- Output — user-facing docs for `dagain`. If this file changes, update this header and the folder Markdown. -->
<!-- Position — repo/package README and primary usage reference. If this file changes, update this header and the folder Markdown. -->

# dagain

DAG-based orchestration for coding agents (Codex, Claude Code, Gemini).

Dagain runs a **work graph** (nodes + deps) stored in **SQLite**, and executes each node with a configured runner. It’s built to keep agents “fresh”: context is loaded from the graph/DB when needed, not carried indefinitely in prompts.


## Docs

- https://knot0.com/writing/dagain

## Install

Once published to npm:

```bash
npx dagain --help
```

Or install globally:

```bash
npm i -g dagain
dagain --help
```

## Quickstart (in a repo you want to work on)

```bash
# 1) init state + config (creates .dagain/ and a new session)
dagain init --goal "Add a CLI flag --foo and tests" --no-refine

# 2) run the supervisor (defaults to 3 workers; drops into chat on completion)
dagain run --live
# disable post-run chat:
dagain run --no-post-chat

# 3) in another terminal: check status / interact
dagain status
dagain chat          # TUI by default on a real terminal
dagain chat --plain  # force the plain readline REPL (useful for piping / non-TTY)
dagain control resume # enqueue resume (auto-starts supervisor if stopped; add --no-start to enqueue only)

# 4) optional: live dashboards
dagain tui           # terminal dashboard + chat (shows a GUI URL)
dagain ui            # web dashboard (chat + DAG + node logs, sessions drawer, pan/zoom+fit, controls)
```

Note: if you run `dagain` as root (e.g. via `sudo`) inside a repo, it will prefer executing runners as the repo owner to avoid root-owned outputs.

## Sessions

- `dagain` stores state per session under `.dagain/sessions/<sessionId>/`.
- `dagain init --goal "..."` creates/updates the **current session goal** (`.dagain/GOAL.md`). If the current session already has state and is “inactive” (all nodes `done`), it auto-creates a new session unless you pass `--reuse`.
- Use `--new-session` to force a new session even if the current one still has unfinished work.

### Common chat controls

Inside `dagain chat` (both TUI and `--plain`):

- `/status` — print graph status
- `/run` — start supervisor
- `/pause` / `/resume` — stop/resume launching new nodes (in-flight nodes finish)
- `/workers <n>` — set concurrency (default: 3)
- `/replan` — force plan node (`plan-000`) to reopen and block launches until it completes
- `/cancel <nodeId>` — cancel a running node (best-effort)
- `/answer [nodeId] <answer...>` — answer a checkpoint and reopen a `needs_human` node
- `/artifacts [nodeId]` — show run artifact paths (and last stdout/result for a node)
- `/memory` / `/forget` — inspect/reset chat memory stored in SQLite KV

## Concepts

### Nodes and dependencies

Dagain is a DAG of **nodes**:

- `plan` nodes decompose goals into tasks
- `task` nodes do work (code, analysis, etc)
- `verify` nodes check task outputs
- `integrate` nodes merge/roll up results
- `final_verify` nodes do final checks

Dependencies live in the `deps` table. A dep can require:

- `done` (default): upstream must be `done`
- `terminal`: upstream must be terminal (`done` or `failed`) — useful for “investigate failure” / escalation flows

### External memory (SQLite)

All durable state is session-scoped under `.dagain/sessions/<sessionId>/state.sqlite`.

For backwards-compat and convenience, `.dagain/state.sqlite` is a symlink to the **current session** DB:

- `nodes` / `deps` — the DAG and statuses
- `kv_latest` / `kv_history` — durable “memory” and artifacts
- `mailbox` — supervisor control queue (pause/resume/workers/replan/cancel)

Chat memory is stored in KV under `node_id="__run__"`:

- `chat.rollup` — rolling summary (router-maintained)
- `chat.turns` — last ~10 turns
- `chat.last_ops` — last emitted ops JSON
- `chat.summary` — last assistant reply

### Safety model: “ops, not commands”

Dagain keeps the model from directly mutating state by having it emit **ops**. The host applies them safely.

In `dagain chat`, the router can emit:

- `control.*` ops (pause/resume/workers/replan/cancel)
- `ctx.*` ops (read-only context requests like `ctx.readFile`, `ctx.rg`, `ctx.gitStatus`) — Dagain executes these and re-invokes the router with results
- `node.add`, `node.update`, `node.setStatus`
- `dep.add`, `dep.remove`
- `run.start`, `run.stop`, `status`

## Runners (Codex / Claude / Gemini)

Runners are just shell commands that receive a `{packet}` filepath and should print:

```text
<result>{...json...}</result>
```

Configure them in `.dagain/config.json`:

```json
{
  "version": 1,
  "runners": {
    "codex":  { "cmd": "codex exec --yolo --skip-git-repo-check -" },
    "claude": { "cmd": "claude --dangerously-skip-permissions -p \"$(cat {packet})\"" },
    "gemini": { "cmd": "gemini -y -p \"$(cat {packet})\"" }
  },
  "roles": {
    "planner": "codex",
    "executor": "codex",
    "verifier": "codex",
    "integrator": "codex",
    "finalVerifier": "codex"
  }
}
```

Notes:
- Dagain strips Claude’s `--dangerously-skip-permissions` when running as root.
- For speed, you can set `defaults.verifyRunner` to `shellVerify` so verification doesn’t use an LLM.

## Parallelism and worktrees

- `dagain run --workers N` runs up to `N` nodes concurrently (subject to ownership locks). If you omit `--workers`, Dagain defaults to at least 3 workers.
- For conflict-prone code edits, set `supervisor.worktrees.mode="always"` to run executors in worktrees and merge serially.
- If a node reaches `needs_human` in a non-interactive context, the supervisor waits up to `supervisor.needsHumanTimeoutMs` (default: 30 minutes), then auto-answers with “decide safest default” and reopens the node so planning can continue.
- To unblock `needs_human` immediately, use `dagain answer --node <id> --answer "..."` or (in the web UI chat) send `/answer [nodeId] <answer...>`.

## State layout

Dagain stores state in:

- `.dagain/config.json` — runner + role configuration (shared across sessions)
- `.dagain/current-session.json` — pointer to the current session id
- `.dagain/sessions/<sessionId>/` — session storage (goal + db + runs + logs + artifacts)
- `.dagain/state.sqlite` / `.dagain/workgraph.json` / `.dagain/runs/` / `.dagain/artifacts/` / `.dagain/checkpoints/` / `.dagain/memory/` — current-session “view” (symlinks)
- `.dagain/GOAL.md` — current session goal (symlink)

The UI “Log” panel shows **human-readable result output** (status/summary, checkpoint question) derived from `result.json` by default; raw stdout is still available in `.dagain/runs/*/stdout.log`.

## Publishing

### GitHub (knot0-com org)

```bash
gh repo create knot0-com/dagain --public --source=. --remote=origin --push
```

If you don’t have permission to create repos in `knot0-com`, create a staging repo under your user and transfer it:

```bash
gh repo create <you>/dagain --public --source=. --remote=origin --push
```

Then transfer via GitHub UI: **Settings → General → Transfer ownership**.

### npm + npx

#### Automated publish (recommended)

Publishing is automated via GitHub Actions on version tags (`vX.Y.Z`). The tag must match `package.json.version`.

1) Configure npm Trusted Publishing (OIDC) for `knot0-com/dagain` and workflow filename `npm-publish.yml` (npmjs.com → package Settings → Trusted Publisher).

2) Cut a release:

```bash
npm version patch
git push --follow-tags
```

3) Verify:

```bash
npx dagain --help
```

#### Manual publish

1) Ensure you’re logged in:

```bash
npm whoami
```

2) Publish:

```bash
npm publish --access public
```

Then:

```bash
npx dagain --help
```
