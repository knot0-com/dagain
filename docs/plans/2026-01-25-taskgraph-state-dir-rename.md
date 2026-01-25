# Taskgraph State Dir Rename Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan.

**Goal:** Rename Taskgraph’s state directory from `.choreo/` to `.taskgraph/` and update all references (tests, docs, scripts) while keeping the test suite green.

**Architecture:** `choreoPaths()` becomes the single source of truth for state paths, pointing at `.taskgraph/`. CLI strings/tests/docs/scripts stop hardcoding `.choreo/`. (Optional back-compat) If a legacy `.choreo/` exists, migrate it to `.taskgraph/` and leave a `.choreo` symlink for old path references.

**Tech Stack:** Node.js CLI, SQLite, `node:test`.

---

### Task 1: Add/adjust state-dir tests

**Files:**
- Create: `test/state-dir-taskgraph.test.js`

**Step 1: Write/confirm failing test**
- Assert `taskgraph init` creates:
  - `.taskgraph/config.json`
  - `.taskgraph/state.sqlite`

**Step 2: Run test to verify it fails**
- Run: `npm test -- test/state-dir-taskgraph.test.js`
- Expected: FAIL until code switches default dir.

**Step 3: Implement minimal code**
- Update `src/lib/config.js` `choreoPaths()` to use `.taskgraph`.

**Step 4: Run test to verify it passes**
- Run: `npm test -- test/state-dir-taskgraph.test.js`
- Expected: PASS

---

### Task 2: Replace hardcoded `.choreo` references in CLI + scripts

**Files:**
- Modify: `src/cli.js`
- Modify: `scripts/shell-merge.js`
- Modify: `scripts/shell-verifier.js` (only if it prints/assumes `.choreo`)

**Step 1: Update user-facing strings**
- Update usage “State:” section to `.taskgraph/...`.
- Update error messages that mention `.choreo/*` to `.taskgraph/*`.
- Update comments that mention `.choreo/tmp` to `.taskgraph/tmp`.

**Step 2 (Optional back-compat): Migrate legacy dir**
- Add a small helper invoked early in `main()`:
  - If `.choreo/` exists and `.taskgraph/` does not:
    - `rename(".choreo", ".taskgraph")`
    - best-effort create symlink `.choreo -> .taskgraph`
  - If migration fails, print a warning and continue (do not crash `--help`).

**Step 3: Run targeted tests**
- Run: `npm test -- test/microcall.test.js test/e2e.test.js`

---

### Task 3: Update tests to use `.taskgraph`

**Files:**
- Modify: `test/*.test.js` (all `.choreo` path joins and assertions)

**Step 1: Replace `.choreo` → `.taskgraph`**
- Update all temp-dir path construction:
  - `path.join(tmpDir, ".taskgraph", ...)`
- Update assertions for stored relative paths:
  - `.taskgraph/runs/...` instead of `.choreo/runs/...`
- Update any config defaults in tests:
  - worktrees dir `.taskgraph/worktrees`

**Step 2: Run full test suite**
- Run: `npm test`
- Expected: PASS

---

### Task 4: Update docs + ignore files

**Files:**
- Modify: `README.md`
- Modify: `docs/fast-config.md` (if it references `.choreo`)
- Modify: `.gitignore`
- Modify: `.npmignore`

**Step 1: Replace `.choreo` → `.taskgraph`**
- README Quickstart + State layout sections.
- If back-compat migration is implemented, mention `.choreo` as legacy/symlink.

**Step 2: Verify packaging ignores**
- Ensure `.taskgraph/` is excluded from git + npm publishing.

---

### Task 5: Merge back to master

**Step 1: Verify one last time**
- Run: `npm test`

**Step 2: Commit**
```bash
git add -A
git commit -m "refactor(state): rename .choreo to .taskgraph"
```

**Step 3: Merge**
- Merge the feature branch/worktree back to `master` and push.

