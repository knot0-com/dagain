# taskgraph

DAG-based orchestration for coding agents (Codex, Claude Code, Gemini).

Taskgraph runs a **work graph** (nodes + deps) stored in **SQLite**, and executes each node with a configured runner. It’s built to keep agents “fresh”: context is loaded from the graph/DB when needed, not carried indefinitely in prompts.

> Back-compat: if a legacy `.choreo/` state dir exists, Taskgraph migrates it to `.taskgraph/` and leaves a `.choreo` symlink. (CLI alias: `choreo`.)

## Install

Once published to npm:

```bash
npx taskgraph --help
```

Or install globally:

```bash
npm i -g taskgraph
taskgraph --help
```

## Quickstart (in a repo you want to work on)

```bash
# 1) init state + config (creates .taskgraph/)
taskgraph init --goal "Add a CLI flag --foo and tests" --no-refine

# 2) run the supervisor (streams runner output)
taskgraph run --live

# 3) in another terminal: check status / interact
taskgraph status
taskgraph chat
```

### Common chat controls

Inside `taskgraph chat`:

- `/status` — print graph status
- `/run` — start supervisor
- `/pause` / `/resume` — stop/resume launching new nodes (in-flight nodes finish)
- `/workers <n>` — set concurrency
- `/replan` — force plan node (`plan-000`) to reopen and block launches until it completes
- `/cancel <nodeId>` — cancel a running node (best-effort)
- `/memory` / `/forget` — inspect/reset chat memory stored in SQLite KV

## Concepts

### Nodes and dependencies

Taskgraph is a DAG of **nodes**:

- `plan` nodes decompose goals into tasks
- `task` nodes do work (code, analysis, etc)
- `verify` nodes check task outputs
- `integrate` nodes merge/roll up results
- `final_verify` nodes do final checks

Dependencies live in the `deps` table. A dep can require:

- `done` (default): upstream must be `done`
- `terminal`: upstream must be terminal (`done` or `failed`) — useful for “investigate failure” / escalation flows

### External memory (SQLite)

All durable state is in `.taskgraph/state.sqlite`:

- `nodes` / `deps` — the DAG and statuses
- `kv_latest` / `kv_history` — durable “memory” and artifacts
- `mailbox` — supervisor control queue (pause/resume/workers/replan/cancel)

Chat memory is stored in KV under `node_id="__run__"`:

- `chat.rollup` — rolling summary (router-maintained)
- `chat.turns` — last ~10 turns
- `chat.last_ops` — last emitted ops JSON
- `chat.summary` — last assistant reply

### Safety model: “ops, not commands”

Taskgraph keeps the model from directly mutating state by having it emit **ops**. The host applies them safely.

In `taskgraph chat`, the router can emit:

- `control.*` ops (pause/resume/workers/replan/cancel)
- `node.add`, `node.update`, `node.setStatus`
- `dep.add`, `dep.remove`
- `run.start`, `run.stop`, `status`

## Runners (Codex / Claude / Gemini)

Runners are just shell commands that receive a `{packet}` filepath and should print:

```text
<result>{...json...}</result>
```

Configure them in `.taskgraph/config.json`:

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
- Taskgraph strips Claude’s `--dangerously-skip-permissions` when running as root.
- For speed, you can set `defaults.verifyRunner` to `shellVerify` so verification doesn’t use an LLM.

## Parallelism and worktrees

- `taskgraph run --workers N` runs up to `N` nodes concurrently (subject to ownership locks).
- For conflict-prone code edits, set `supervisor.worktrees.mode="always"` to run executors in worktrees and merge serially.

## State layout

Taskgraph stores state in:

- `.taskgraph/config.json` — runner + role configuration
- `.taskgraph/state.sqlite` — workgraph + KV + mailbox
- `.taskgraph/workgraph.json` — human-readable graph snapshot (mirrors SQLite)
- `.taskgraph/lock` — supervisor lock (used by `taskgraph stop`)
- `.taskgraph/runs/` — per-node packets + logs + results
- `.taskgraph/checkpoints/` — human-in-the-loop checkpoints
- `.taskgraph/memory/` — durable notes + logs (`task_plan.md`, `findings.md`, `progress.md`)

## Publishing

### GitHub (knot0-com org)

```bash
gh repo create knot0-com/taskgraph --public --source=. --remote=origin --push
```

If you don’t have permission to create repos in `knot0-com`, create a staging repo under your user and transfer it:

```bash
gh repo create <you>/taskgraph --public --source=. --remote=origin --push
```

Then transfer via GitHub UI: **Settings → General → Transfer ownership**.

### npm + npx

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
npx taskgraph --help
```
