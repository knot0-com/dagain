# dagain Rename Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename the project from `taskgraph` to `dagain` (repo + npm package + primary CLI), while keeping backward-compatible CLI aliases and state-dir migration.

**Architecture:** Make `dagain` the canonical name: npm package name, default CLI command, docs. Keep `taskgraph` + `dagain` as CLI aliases. Rename the canonical state directory to `.dagain/` and auto-migrate from legacy `.taskgraph/` and `.dagain/`, leaving symlinks for back-compat.

**Tech Stack:** Node.js CLI (ESM), SQLite state, `node --test`, GitHub + npm.

---

### Task 1: Update state-dir test to `.dagain/`

**Files:**
- Modify: `test/state-dir-taskgraph.test.js`

**Step 1: Make the test fail**
- Change assertions to expect `.dagain/config.json` + `.dagain/state.sqlite`.

**Step 2: Run targeted test**
- Run: `npm test -- test/state-dir-taskgraph.test.js`
- Expected: FAIL (until code updated).

---

### Task 2: Switch canonical state dir to `.dagain/` + migrate legacy dirs

**Files:**
- Modify: `src/lib/config.js`
- Modify: `src/cli.js`
- Modify: `scripts/shell-merge.js`

**Step 1: Update `dagainPaths()`**
- Set canonical dir to `.dagain/`.
- Update default config paths:
  - Claude `TMPDIR`: `.dagain/tmp`
  - Worktrees dir: `.dagain/worktrees`

**Step 2: Extend migration logic**
- In `src/cli.js`, migrate in this order:
  1) If `.dagain/` exists: no-op
  2) Else if `.taskgraph/` exists: rename to `.dagain/` and symlink `.taskgraph -> .dagain`
  3) Else if `.dagain/` exists: rename to `.dagain/` and symlink `.dagain -> .dagain` (and also symlink `.taskgraph -> .dagain`)

**Step 3: Update `scripts/shell-merge.js` config lookup**
- Prefer `.dagain/config.json`, then `.taskgraph/config.json`, then `.dagain/config.json`.
- Ensure git excludes both `.dagain/` and legacy dirs.

**Step 4: Re-run the failing test**
- Run: `npm test -- test/state-dir-taskgraph.test.js`
- Expected: PASS.

---

### Task 3: Rename npm package + add primary `dagain` CLI

**Files:**
- Modify: `package.json`
- Create: `bin/dagain.js`
- Modify: `bin/taskgraph.js` (if needed)
- Modify: `bin/dagain.js` (if needed)
- Modify: `README.md`
- Modify: `src/cli.js` (usage banner)

**Step 1: Update `package.json` metadata**
- `"name": "dagain"`
- Update `repository.url` and `bugs.url` to `knot0-com/dagain` (once repo renamed).
- Keep `bin` aliases:
  - `dagain` → `bin/dagain.js` (primary)
  - `taskgraph` → existing entry (compat)
  - `dagain` → existing entry (compat)

**Step 2: Add `bin/dagain.js`**
- Same behavior as other bins: import `src/cli.js` and call `main(process.argv.slice(2))`.

**Step 3: Update CLI help text**
- In `src/cli.js`, replace `taskgraph` in `usage()` with `dagain`.
- Mention aliases in help/README (briefly).

**Step 4: Run full test suite**
- Run: `npm test`
- Expected: PASS.

---

### Task 4: Update docs + templates + ignores

**Files:**
- Modify: `README.md`
- Modify: `docs/fast-config.md`
- Modify: `templates/*.md` (any user-facing references)
- Modify: `.gitignore`
- Modify: `.npmignore`

**Step 1: Replace user-facing “taskgraph” branding**
- README: project name, examples, install commands: `npx dagain`, `dagain run`, etc.
- Keep note: `taskgraph` + `dagain` are aliases.

**Step 2: Replace state-dir references**
- `.taskgraph/` → `.dagain/` in docs/templates.
- Mention auto-migration from `.taskgraph/` and `.dagain/`.

**Step 3: Update ignore lists**
- Ensure `.dagain/` is ignored in git + npm.
- Keep legacy dirs ignored too.

**Step 4: Re-run tests**
- Run: `npm test`
- Expected: PASS.

---

### Task 5: Rename GitHub repo + push

**Files:** none (ops)

**Step 1: Rename repo**
- Run: `gh repo rename knot0-com/taskgraph dagain`

**Step 2: Update local remotes**
- Update `origin` to `ssh://git@github.com/knot0-com/dagain.git`

**Step 3: Push**
- Run: `git push origin master`

---

### Task 6: Merge + cleanup

**Step 1: Commit in focused chunks**
- `refactor(state): rename .taskgraph to .dagain`
- `refactor(cli): add dagain binary and rename package`
- `docs(readme): rename taskgraph to dagain`

**Step 2: Merge worktree branch back to `master`**
- Prefer fast-forward merge if possible.

**Step 3: Remove worktree + delete branch**

