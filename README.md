# choreo

Goal-driven, runner-agnostic orchestration for coding agents (Codex, Claude Code, Gemini).

## Status

Early MVP scaffolding.

## CLI

- `choreo` — interactive start (TTY); prompts for a goal and runs until done/checkpoint
- `choreo "your goal..."` — shorthand goal + start
- `choreo start "your goal..."` — explicit start command
- `choreo init` — create `.choreo/` state + starter `GOAL.md`
- `choreo goal --goal "..."` — refine `GOAL.md` interactively via configured runner (`--live` streams runner output)
- `choreo status` — show graph/queue status
- `choreo run` — run the supervisor loop (`--live` streams runner output)
- `choreo resume` — alias for `choreo run`
- `choreo answer` — answer a checkpoint and reopen the blocked node
- `choreo stop` — gracefully stop a running supervisor (via `.choreo/lock`)

## Monitoring

- Primary (interactive): keep a TTY open running `choreo run --live` so you can see output and answer checkpoints.
- Secondary (any terminal): `choreo status`, `tail -f .choreo/memory/activity.log`, and `tail -f .choreo/runs/<run>/stdout.log` (the run log path is printed on spawn).

## Resuming

- Choreo is resumable by design: rerun `choreo run` (or `choreo`) in the same repo/worktree; it continues from `.choreo/workgraph.json`.
- If interrupted mid-node, the node lock includes the supervisor PID; on restart, dead locks are cleared and the node is retried.
- `Ctrl+C` (SIGINT) or `choreo stop` (SIGTERM) cancels the current runner, unlocks the node, and exits so you can resume later.

## State

Project state is stored in:

- `.choreo/config.json` — runner + role configuration
- `.choreo/workgraph.json` — work DAG + statuses/locks
- `.choreo/lock` — supervisor lock (prevents concurrent supervisors; supports `choreo stop`)
- `.choreo/runs/` — per-run packets + logs + results
- `.choreo/checkpoints/` — human-in-the-loop checkpoints
- `.choreo/memory/task_plan.md` — durable plan rendered from the workgraph
- `.choreo/memory/findings.md` — durable findings/decisions across agents
- `.choreo/memory/progress.md` — durable progress log across runs
- `.choreo/memory/activity.log` / `.choreo/memory/errors.log` — append-only event + error logs

## Roles and Planning

- Nodes drive which roles run:
  - `type: "plan"` → planner
  - `type: "task"` → executor
  - `type: "verify"` → verifier
  - `type: "integrate"` → integrator
  - `type: "final_verify"` → finalVerifier
- To avoid “planner forgot to add verifiers”, choreo automatically scaffolds missing gates when a plan node succeeds:
  - Adds `verify-*` nodes for each task (if missing)
  - Adds an `integrate-*` node (if missing)
  - Adds a `final-verify-*` node (if missing)

## Multiple Runners per Role

- `.choreo/config.json` roles can be a string or a list of runner names:
  - `"verifier": "codex"` or `"verifier": ["codex", "gemini"]`
  - CLI flags accept comma-separated lists: `--verifier=codex,gemini`
- By default, choreo picks one runner deterministically per node (hash of node id + attempt).
- To run multiple independent verifiers for every task, set:
  - `"supervisor": { "multiVerifier": "all" }`
  - `"roles": { "verifier": ["codex", "gemini"] }`
  - choreo will create one verify node per verifier runner and pin it via `node.runner`.

## Performance

- Default verify nodes can run as a non‑LLM shell runner (`defaults.verifyRunner`).
- `supervisor.packetMode="thin"` reduces repeated context sent to executors/verifiers/integrators.
- See `docs/fast-config.md` for a recommended “fast profile”.
