If this folder changes, this document must be updated.

This folder contains built-in prompt templates copied into `.dagain/templates/`.
These templates define role instructions and required output schemas for runners.

| Name | Role/Status | Responsibility |
| --- | --- | --- |
| `FOLDER.md` | docs | Folder contract and file index |
| `executor.md` | runtime | Executor role prompt (code changes) |
| `final-verifier-analysis.md` | runtime | Final verifier prompt for analysis runs |
| `final-verifier.md` | runtime | Final verifier prompt for coding runs |
| `goal-refiner.md` | runtime | Goal refinement prompt (no tools) |
| `integrator-analysis.md` | runtime | Integrator prompt for analysis runs |
| `integrator.md` | runtime | Integrator prompt (merge/synthesis) |
| `microcall.md` | runtime | Microcall prompt (think-only JSON) |
| `planner.md` | runtime | Planner role prompt (graph expansion) |
| `verifier.md` | runtime | Verifier role prompt (node verification) |
