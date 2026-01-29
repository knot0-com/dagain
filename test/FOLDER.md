If this folder changes, this document must be updated.

This folder contains the `dagain` Node.js test suite (`node --test`).
It covers CLI behavior, DB migrations, scheduling logic, and integrations.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `answer-db.test.js` | test | Answer application and DB persistence |
| `apply-result-setstatus.test.js` | test | Apply-result: set-status handling |
| `apply-result.test.js` | test | Apply-result behaviors and edge cases |
| `args.test.js` | test | CLI args parsing |
| `auto-kv-envelope.test.js` | test | Auto KV envelope behavior |
| `cancel.test.js` | test | Cancel behavior and propagation |
| `chat-controls.test.js` | test | Chat → mailbox control ops |
| `chat-default-planner-runner.test.js` | test | Chat defaults: planner runner selection |
| `chat-default-tty-guard.test.js` | test | Chat non-TTY guardrails |
| `chat-graph-ops.test.js` | test | Chat graph operations (node/dep ops) |
| `chat-kv-memory.test.js` | test | Chat KV memory persistence |
| `chat-memory-commands.test.js` | test | Chat memory commands (`/memory`, `/forget`) |
| `chat-no-llm.test.js` | test | Chat behavior when LLM is disabled |
| `chat-repl.test.js` | test | Plain chat REPL behavior |
| `chat-rollup.test.js` | test | Chat rollup summary behavior |
| `chat-router-controls.test.js` | test | Router control ops behavior |
| `claim-node.test.js` | test | Node claiming/locking in DB |
| `control-cli.test.js` | test | `dagain control` CLI |
| `dashboard-snapshot.test.js` | test | Dashboard snapshot shape |
| `db-init.test.js` | test | DB initialization |
| `db-migrate-required-status.test.js` | test | Dep required-status migration |
| `deadlock-auto-reset.test.js` | test | Deadlock auto-reset behavior |
| `e2e.test.js` | test | End-to-end flows |
| `failure-escalation-promotion.test.js` | test | Failure escalation: runner promotion |
| `failure-escalation-scope.test.js` | test | Failure escalation: scope handling |
| `failure-escalation.test.js` | test | Failure escalation: general behavior |
| `helpers/` | test helper | Shared test utilities |
| `interactive-checkpoint.test.js` | test | Interactive checkpoint flows |
| `kv-cli.test.js` | test | `dagain kv` CLI behavior |
| `kv-retention.test.js` | test | KV retention and history behavior |
| `mailbox-db.test.js` | test | Mailbox table behavior |
| `mailbox-migration.test.js` | test | Mailbox schema migration |
| `mailbox-supervisor.test.js` | test | Supervisor mailbox interactions |
| `microcall.test.js` | test | `dagain microcall` CLI behavior |
| `node-cli.test.js` | test | `dagain node` CLI behavior |
| `ownership-locks.test.js` | test | Ownership locks behavior |
| `packet-db-pointers.test.js` | test | Packet DB pointers behavior |
| `packet-node-inputs.test.js` | test | Packet node input resolution |
| `packet-thin-mode.test.js` | test | Thin packet mode behavior |
| `parallel-workers-flag.test.js` | test | Workers flag parsing |
| `parallel-workers-live-prefix.test.js` | test | Live output prefixing in workers mode |
| `parallel-workers-locking.test.js` | test | Workers locking behavior |
| `parallel-workers-scheduling.test.js` | test | Workers scheduling behavior |
| `planner-scaffold.test.js` | test | Planner scaffold behavior |
| `retry-policy-default.test.js` | test | Default retry policy behavior |
| `run-mode-templates.test.js` | test | Run modes + template selection |
| `runner-identity.test.js` | test | Runner identity resolution |
| `runner-pool-promotion.test.js` | test | Runner pool promotion behavior |
| `scaffold-default-verifier-runner.test.js` | test | Scaffold defaults: verifier runner |
| `scaffold-upstream-inputs.test.js` | test | Scaffold upstream inputs |
| `select-runnable-candidates.test.js` | test | SQL candidate selection |
| `select-sql.test.js` | test | SQL selection logic |
| `select.test.js` | test | Selection logic (non-SQL) |
| `sensitive-runner-override.test.js` | test | Sensitive runner override behavior |
| `shell-verifier.test.js` | test | Shell verifier behavior |
| `state-dir-taskgraph.test.js` | test | Legacy state dir migration |
| `status-inprogress.test.js` | test | Status in-progress rendering |
| `templates-sync.test.js` | test | Templates sync behavior |
| `ui-server.test.js` | test | Web UI server behavior |
| `workgraph-snapshot.test.js` | test | Workgraph snapshot behavior |
| `worktrees-parallel-executors.test.js` | test | Worktrees + parallel executors |
