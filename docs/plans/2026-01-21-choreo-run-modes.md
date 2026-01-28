# Dagain Run Modes (Auto) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically infer an orchestration run mode (`analysis` vs `coding`) from `GOAL.md` and use it to select safer role templates (especially `integrator`/`finalVerifier`) so analysis runs don’t accidentally do git merges or run unrelated repo-wide test suites. Expose the mode to runners via packet vars + env.

**Architecture:** Add a deterministic `inferRunMode(goalText, config)` helper (with optional override), compute a `runMode` for each node packet from `GOAL.md`, and propagate it as:
- Template var: `{{RUN_MODE}}`
- Runner env var: `DAGAIN_RUN_MODE`

For `integrator` and `finalVerifier`, select mode-specific templates when `runMode==="analysis"`:
- `integrator-analysis.md`
- `final-verifier-analysis.md`

Keep existing templates for `coding`.

**Tech Stack:** Node.js (ESM), `node:test`, Dagain CLI (`src/cli.js`), templates (`templates/*.md`).

---

### Task 1: Add run-mode inference + propagate to packets/env

**Files:**
- Modify: `src/cli.js`
- Modify: `src/lib/config.js` (optional: config defaults / new config key)
- Test: `test/run-mode-templates.test.js` (new)

**Step 1: Write a failing test for template selection**
- Create a temp project with `dagain init`.
- Write a `GOAL.md` containing obvious analysis keywords (e.g., “analyze… data… report…”).
- Insert an `integrate-000` node in sqlite and configure `integrator` runner to dump packet content (reuse `scripts/mock-agent-packet-dump.js`).
- Run `dagain run --once` and assert the generated packet contains an analysis-template sentinel string.

**Step 2: Implement `inferRunMode`**
- Support (in order):
  1) explicit override in `GOAL.md` line like `Run mode: analysis|coding` (case-insensitive)
  2) config override: `config.supervisor.runMode` (if set to `analysis`/`coding`)
  3) heuristic keyword scoring on `GOAL.md`

**Step 3: Pass runMode into packet rendering**
- Add `RUN_MODE` to the `renderTemplate()` vars.
- Add `DAGAIN_RUN_MODE` to the runner env (`dagainRunnerEnv`).

**Step 4: Run test**
- Run: `node --test test/run-mode-templates.test.js`
- Expected: PASS

---

### Task 2: Add analysis-mode templates for integrator/final verifier

**Files:**
- Create: `templates/integrator-analysis.md`
- Create: `templates/final-verifier-analysis.md`
- Modify: `src/cli.js` (template selection)
- Modify: `src/cli.js` (copyTemplates list)

**Step 1: Add analysis templates**
- `integrator-analysis.md` must explicitly forbid git merge/rebase and repo-wide test suites; it should verify artifacts + update `.dagain/memory/*` + write KV `out.summary`.
- `final-verifier-analysis.md` should verify artifacts against `GOAL.md` “Done means” and avoid repo-wide test suites.

**Step 2: Wire template name selection**
- If `role === "integrator"` and `runMode === "analysis"`, use `integrator-analysis` template.
- If `role === "finalVerifier"` and `runMode === "analysis"`, use `final-verifier-analysis` template.

**Step 3: Ensure `dagain init` copies these templates**
- Add the new template names to the `copyTemplates()` list.

**Step 4: Run test**
- Run: `node --test test/run-mode-templates.test.js`
- Expected: PASS

---

### Task 3: Document run modes

**Files:**
- Modify: `README.md`

**Step 1: Add docs section**
- Describe `DAGAIN_RUN_MODE` and `{{RUN_MODE}}`.
- Mention optional `GOAL.md` line `Run mode: analysis|coding`.
- Mention config override `supervisor.runMode` and default behavior.

**Step 2: Verify docs build (sanity)**
- Run: `node --check src/cli.js`

---

### Task 4: Full verification

**Step 1: Run full test suite**
- Run: `npm test`
- Expected: PASS

