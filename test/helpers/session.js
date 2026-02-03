// Input — `.dagain/current-session.json` produced by dagain commands in a temp test project.
// Output — helpers that resolve session-scoped paths for assertions.
// Position — test-only utilities for the new per-session `.dagain/sessions/<id>/...` layout.

import path from "node:path";
import { readFile } from "node:fs/promises";

export async function readCurrentSessionId(projectDir) {
  const raw = await readFile(path.join(projectDir, ".dagain", "current-session.json"), "utf8");
  const parsed = JSON.parse(raw);
  const id = String(parsed?.id || "").trim();
  if (!id) throw new Error("Missing session id in .dagain/current-session.json");
  return id;
}

export async function dagainSessionTestPaths(projectDir) {
  const sessionId = await readCurrentSessionId(projectDir);
  const sessionDir = path.join(projectDir, ".dagain", "sessions", sessionId);
  return {
    sessionId,
    sessionDir,
    dbPath: path.join(sessionDir, "state.sqlite"),
    graphPath: path.join(sessionDir, "workgraph.json"),
    goalPath: path.join(sessionDir, "GOAL.md"),
    runsDir: path.join(sessionDir, "runs"),
    checkpointsDir: path.join(sessionDir, "checkpoints"),
    artifactsDir: path.join(sessionDir, "artifacts"),
    memoryDir: path.join(sessionDir, "memory"),
    lockPath: path.join(sessionDir, "lock"),
  };
}

