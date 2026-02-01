# Dagain Upstream Context + Status UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Dagain runs faster and more reliable by (1) automatically feeding upstream node summaries into `integrate` / `final_verify` nodes, (2) tightening analysis-mode prompts to avoid redundant long-running commands (Codex tool timeouts), and (3) improving `dagain status` so users can see which node is running and where logs live.

**Architecture:** Keep `.dagain/state.sqlite` as the source of truth and `.dagain/workgraph.json` as the UX snapshot. Use `inputs_json` to store *references* to upstream KV keys (e.g. `<dep>:out.summary`) rather than copying large context. Render these refs in packets via the existing “Node Inputs” block. LLM roles (`integrator`, `finalVerifier`) should treat upstream `verify` nodes as the authoritative execution of expensive commands and should not re-run heavy scripts.

**Tech Stack:** Node.js (`node --test`), SQLite (via existing helpers), Dagain CLI (`src/cli.js`), packet templates (`templates/*.md`)

---

## Success Metrics

- `integrate-000` and `final-verify-000` packets include upstream summaries in **`## Node Inputs`** by default (no “I think nothing ran” behavior).
- Analysis-mode `integrator` no longer tries to rerun long commands that routinely exceed Codex exec timeouts; instead it relies on `verify-*` nodes (or proposes new verify nodes if needed).
- `dagain status` shows **in-progress node(s)** with `runId` and the path to `stdout.log`.

---

### Task 1: Add upstream summary inputs for integrate/final-verify nodes

**Files:**
- Modify: `src/cli.js` (planner scaffolding + DB persistence)
- Test: `test/scaffold-upstream-inputs.test.js`

**Step 1: Write failing test**

Create `test/scaffold-upstream-inputs.test.js`:
- Create a temp dagain project (`dagain init --goal ... --no-refine --force`)
- Use the existing tasks-only mock planner (`scripts/mock-planner-tasks-only.js`)
- Run `dagain run` to completion with mock agents
- Query `.dagain/state.sqlite` and assert:
  - `integrate-000.inputs_json` contains refs to `task-hello:out.summary` **and** `verify-task-hello:out.summary`
  - `final-verify-000.inputs_json` contains a ref to `integrate-000:out.summary`

Run: `npm test -- test/scaffold-upstream-inputs.test.js`
Expected: FAIL (inputs missing)

**Step 2: Implement scaffolding changes**

In `ensurePlannerScaffolding` (graph builder):
- When creating `integrate-000`, populate `inputs` with stable-sorted refs:
  - For each task: `{ nodeId: <taskId>, key: "out.summary", as: "<taskId>.summary" }`
  - For each verify node that gates integrate: `{ nodeId: <verifyId>, key: "out.summary", as: "<verifyId>.summary" }`
- When creating `final-verify-000`, set `inputs` to include:
  - `{ nodeId: "integrate-000", key: "out.summary", as: "integrate.summary" }`

In `ensurePlannerScaffoldingDb` (DB persistence):
- Track “before” and “after” signatures for `inputs` (similar to dep signature handling).
- When inputs differ, `UPDATE nodes SET inputs_json=?, updated_at=?`.

Run: `npm test -- test/scaffold-upstream-inputs.test.js`
Expected: PASS

**Step 3: Commit**

```bash
git add src/cli.js test/scaffold-upstream-inputs.test.js
git commit -m "feat(scaffold): feed upstream summaries to integrate/final verify"
```

---

### Task 2: Harden analysis integrator/final-verifier prompts to avoid redundant heavy exec

**Files:**
- Modify: `templates/integrator-analysis.md`
- Modify: `templates/final-verifier-analysis.md`
- Test: `test/run-mode-templates.test.js`

**Step 1: Write failing test**

Extend `test/run-mode-templates.test.js` to assert the analysis integrator and final-verifier packets include:
- “Do not re-run expensive commands that already ran in verify nodes”
- “If you need new execution, add a new verify node (shellVerify) instead of running long commands here”

Run: `npm test -- test/run-mode-templates.test.js`
Expected: FAIL (strings missing)

**Step 2: Update templates**

In `templates/integrator-analysis.md` and `templates/final-verifier-analysis.md`:
- Add an explicit **“Long-running commands”** rule:
  - Treat upstream verify nodes as the canonical place for expensive execution
  - Avoid rerunning heavy scripts; prefer reading artifacts and using `dagain kv get` for summaries
  - If execution is truly missing, propose a new `verify-*` node in `next.addNodes` (runner `shellVerify`)

Run: `npm test -- test/run-mode-templates.test.js`
Expected: PASS

**Step 3: Commit**

```bash
git add templates/integrator-analysis.md templates/final-verifier-analysis.md test/run-mode-templates.test.js
git commit -m "docs(templates): prevent integrator from rerunning heavy analysis"
```

---

### Task 3: Improve `dagain status` to show in-progress node(s) and log paths

**Files:**
- Modify: `src/cli.js`
- Test: `test/status-inprogress.test.js`

**Step 1: Write failing test**

Create `test/status-inprogress.test.js`:
- Create a temp dagain project
- Manually set a node to `in_progress` in sqlite with a `lock_run_id`
- Run `dagain status`
- Assert output contains an “In progress” section with:
  - node id
  - run id
  - `.dagain/runs/<runId>/stdout.log` path

Run: `npm test -- test/status-inprogress.test.js`
Expected: FAIL (no in-progress section)

**Step 2: Implement**

In `statusCommand`:
- Read from sqlite to list nodes where `status='in_progress'`
- Print a new block:
  - `In progress:` list each node as `- <id> (run=<runId>)` and `  log: <path>`

Run: `npm test -- test/status-inprogress.test.js`
Expected: PASS

**Step 3: Commit**

```bash
git add src/cli.js test/status-inprogress.test.js
git commit -m "feat(status): show running nodes and log paths"
```

---

### Task 4: Validate on the real-world alpha workspace (manual)

**Workspace:** `/home/mojians/projects/alpha-0x8dxd`

**Step 1: Resume run**

```bash
cd /home/mojians/projects/alpha-0x8dxd
node /home/mojians/projects/dagain/bin/dagain.js resume --workers 2 --interval-ms 0 --max-iterations 50 --no-live --no-color
```

Expected:
- `integrate-000` completes quickly without rerunning `analysis/02_run_tests.py`
- `final-verify-000` completes (or cleanly proposes follow-up nodes)

---

### Task 5: Finish branch

> REQUIRED SUB-SKILL: Use superpowers:finishing-a-development-branch

- Run full test suite: `npm test`
- Merge worktree branch back to `master`
- Remove worktree

