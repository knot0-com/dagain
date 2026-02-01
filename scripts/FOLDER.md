If this folder changes, this document must be updated.

This folder contains shipped helper scripts (shell verifier/merge) and test-only mock runners.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `FOLDER.md` | docs | Folder contract + file index (not shipped to npm) |
| `shell-verifier.js` | runtime | Run `verify_json` shell commands and emit `<result>` |
| `shell-merge.js` | runtime | Merge a worktree task into root (emit patch + `git apply --3way`) |
| `sleep-agent.js` | dev-only | Simple delay runner used for local debugging |
| `mock-agent.js` | test-only | Mock runner that emits deterministic `<result>` |
| `mock-agent-checkpoint.js` | test-only | Mock runner that emits a checkpoint result |
| `mock-agent-env.js` | test-only | Mock runner that validates env injection |
| `mock-agent-fail-marker.js` | test-only | Mock runner that fails with a marker in stdout |
| `mock-agent-log.js` | test-only | Mock runner that writes logs and succeeds |
| `mock-agent-marker.js` | test-only | Mock runner that prints a marker for parsing tests |
| `mock-agent-noresult.js` | test-only | Mock runner that produces no `<result>` |
| `mock-agent-packet-dump.js` | test-only | Mock runner that prints packet contents |
| `mock-planner-tasks-only.js` | test-only | Mock planner that generates tasks-only workgraph |
| `mock-sleep-agent.js` | test-only | Mock runner that sleeps (parallelism tests) |
| `mock-chat-router.js` | test-only | Mock chat router for command routing tests |
| `mock-chat-router-graph-ops.js` | test-only | Mock chat router that emits graph ops |
| `mock-chat-router-memory.js` | test-only | Mock chat router that stores memory in KV |
| `mock-chat-router-rollup.js` | test-only | Mock chat router that updates rolling summary |
