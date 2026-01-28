# Dagain Fast Config

This profile minimizes full LLM invocations (especially verification) and reduces prompt size per node.

## Recommended settings

- `defaults.retryPolicy.maxAttempts = 1`
- `defaults.verifyRunner = "shellVerify"` (non‑LLM verification)
- `supervisor.packetMode = "thin"` (omit large planning drafts for executor/verifier/integrator)
- `supervisor.idleSleepMs = 0` (faster loop; higher CPU)

## Example `.dagain/config.json`

```json
{
  "version": 1,
  "defaults": {
    "retryPolicy": { "maxAttempts": 1 },
    "verifyRunner": "shellVerify"
  },
  "runners": {
    "shellVerify": { "cmd": "node \"$DAGAIN_SHELL_VERIFIER\"" },
    "codex": { "cmd": "codex exec --yolo --skip-git-repo-check -" }
  },
  "roles": {
    "main": "codex",
    "planner": "codex",
    "executor": "codex",
    "verifier": "codex",
    "integrator": "codex",
    "finalVerifier": "codex",
    "researcher": "codex"
  },
  "supervisor": {
    "packetMode": "thin",
    "idleSleepMs": 0,
    "staleLockSeconds": 3600
  }
}
```

## Quick benchmark

- Count runner spawns: `rg "spawn role=" .dagain/memory/activity.log`
- Inspect verify runner selection: `sqlite3 -json .dagain/state.sqlite "SELECT id,type,runner FROM nodes WHERE type='verify' ORDER BY id;"`
