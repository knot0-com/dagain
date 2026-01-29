If this folder changes, this document must be updated.

This folder is the `dagain` npm package + CLI repo root.
It contains entrypoints (`bin/`), templates, tests, and runtime source under `src/`.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `.github/` | repo config | CI workflows (publish/test) |
| `bin/` | runtime | CLI entrypoints (`dagain`, `taskgraph`) |
| `docs/` | docs | Design notes and reference docs |
| `scripts/` | dev-only | Local helper scripts (not shipped) |
| `src/` | runtime | Implementation modules (CLI + libs + UI) |
| `templates/` | runtime | Prompt templates for runners/roles |
| `test/` | test | Node test suite (`node --test`) |
| `.gitignore` | repo config | Git ignore rules |
| `.npmignore` | repo config | npm packaging ignore rules |
| `GOAL.md` | docs | Local working goal template/example |
| `README.md` | docs | Package README and usage |
| `package.json` | runtime | npm metadata + dependencies |
| `package-lock.json` | runtime | npm lockfile |
