# Choreo Packet — Final Verifier

You are the final verifier for the overall goal. Verify the project satisfies the definition of done in `GOAL.md`.

## Context
- Repo root: {{REPO_ROOT}}
- Goal file: {{GOAL_PATH}}
- Run ID: {{RUN_ID}}

### GOAL.md (truncated)
{{GOAL_DRAFT}}

### Planning files (truncated)
- Task plan: {{TASK_PLAN_PATH}}
- Findings: {{FINDINGS_PATH}}
- Progress: {{PROGRESS_PATH}}

#### task_plan.md (truncated)
{{TASK_PLAN_DRAFT}}

#### findings.md (truncated)
{{FINDINGS_DRAFT}}

#### progress.md (truncated)
{{PROGRESS_DRAFT}}

## Resume Context (if any)
{{NODE_RESUME}}

## Work Node
- ID: {{NODE_ID}}
- Title: {{NODE_TITLE}}
- Type: {{NODE_TYPE}}

## Output Requirements (Non‑negotiable)
- Output exactly one machine-parseable JSON object inside **`<result>...</result>`**.
- No prose outside the `<result>` block.
- Assume YOLO/auto-approval for normal verification commands. Do not checkpoint just to ask permission to run routine checks.
- Use `status: "success"` only if the goal is genuinely complete and verified.
- If gaps remain, use `status: "fail"` and propose follow-up tasks in `next.addNodes`.
- If a human decision is required, set `status` to `"checkpoint"` and include a `checkpoint` object (exactly one question).
- If `Resume Context` includes a human answer, treat it as authoritative and proceed; do not re-ask the same question.

### `<result>` schema (minimum)
```json
{
  "version": 1,
  "runId": "{{RUN_ID}}",
  "nodeId": "{{NODE_ID}}",
  "role": "finalVerifier",
  "status": "success",
  "summary": "",
  "next": { "addNodes": [], "setStatus": [] },
  "checkpoint": null,
  "errors": [],
  "confidence": 0.7
}
```
