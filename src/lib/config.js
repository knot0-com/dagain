// Input — node:path and JSON/file helpers. If this file changes, update this header and the folder Markdown.
// Output — `.dagain/` global + session path helpers and config load/save/defaults. If this file changes, update this header and the folder Markdown.
// Position — Config and state path conventions for dagain (global + per-session). If this file changes, update this header and the folder Markdown.

import path from "node:path";
import { pathExists, readJson, writeJsonAtomic } from "./fs.js";

export function dagainPaths(rootDir) {
  const stateDir = path.join(rootDir, ".dagain");
  return {
    rootDir,
    stateDir,
    sessionsDir: path.join(stateDir, "sessions"),
    currentSessionPath: path.join(stateDir, "current-session.json"),
    configPath: path.join(stateDir, "config.json"),
    // Legacy "current session view" paths (symlinks maintained by sessions.js).
    dbPath: path.join(stateDir, "state.sqlite"),
    graphPath: path.join(stateDir, "workgraph.json"),
    graphSnapshotPath: path.join(stateDir, "workgraph.json"),
    lockPath: path.join(stateDir, "lock"),
    checkpointsDir: path.join(stateDir, "checkpoints"),
    runsDir: path.join(stateDir, "runs"),
    artifactsDir: path.join(stateDir, "artifacts"),
    memoryDir: path.join(stateDir, "memory"),
    templatesDir: path.join(stateDir, "templates"),
    tmpDir: path.join(stateDir, "tmp"),
    goalPath: path.join(stateDir, "GOAL.md"),
  };
}

export function dagainSessionPaths(rootDir, sessionId) {
  const globalPaths = dagainPaths(rootDir);
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Missing sessionId for dagainSessionPaths()");
  const sessionDir = path.join(globalPaths.sessionsDir, id);
  return {
    ...globalPaths,
    sessionId: id,
    sessionDir,
    graphPath: path.join(sessionDir, "workgraph.json"),
    graphSnapshotPath: path.join(sessionDir, "workgraph.json"),
    dbPath: path.join(sessionDir, "state.sqlite"),
    lockPath: path.join(sessionDir, "lock"),
    checkpointsDir: path.join(sessionDir, "checkpoints"),
    runsDir: path.join(sessionDir, "runs"),
    artifactsDir: path.join(sessionDir, "artifacts"),
    memoryDir: path.join(sessionDir, "memory"),
    tmpDir: path.join(sessionDir, "tmp"),
    goalPath: path.join(sessionDir, "GOAL.md"),
  };
}

export function defaultConfig() {
  return {
    version: 1,
    defaults: {
      retryPolicy: { maxAttempts: 1 },
      verifyRunner: "shellVerify",
      mergeRunner: "shellMerge",
    },
    runners: {
      shellVerify: { cmd: 'node "${DAGAIN_SHELL_VERIFIER:-${CHOREO_SHELL_VERIFIER:-$TASKGRAPH_SHELL_VERIFIER}}"' },
      shellMerge: { cmd: 'node "${DAGAIN_SHELL_MERGE:-${CHOREO_SHELL_MERGE:-$TASKGRAPH_SHELL_MERGE}}"' },
      codex: { cmd: "codex exec --yolo --skip-git-repo-check -" },
      codexMedium: { cmd: "codex exec --yolo --skip-git-repo-check -m gpt-5.2-codex -c model_reasoning_effort=medium -" },
      // Note: Claude forbids --dangerously-skip-permissions when running as root/sudo.
      // dagain strips that flag automatically in those contexts.
      claude: {
        cmd: "claude --dangerously-skip-permissions -p \"$(cat {packet})\"",
        env: { TMPDIR: ".dagain/tmp" },
      },
      gemini: { cmd: "gemini -y -p \"$(cat {packet})\"" },
    },
    roles: {
      main: "codex",
      planner: "codex",
      executor: "codexMedium",
      verifier: "codex",
      integrator: "codex",
      finalVerifier: "codex",
      researcher: "codex"
    },
		    supervisor: {
		      workers: 3,
		      idleSleepMs: 2000,
		      staleLockSeconds: 3600,
		      needsHumanTimeoutMs: 30 * 60 * 1000,
	      autoResetFailedMax: 1,
	      runnerPool: {
	        mode: "off",
	        promoteOn: ["timeout", "missing_result", "spawn_error"],
	        promoteAfterAttempts: 2,
	      },
	      claudeSensitiveFallbackRunner: "codex",
	      multiVerifier: "one",
	      worktrees: { mode: "off", dir: ".dagain/worktrees" },
	    }
  };
}

export async function loadConfig(configPath) {
  if (!(await pathExists(configPath))) return null;
  return readJson(configPath);
}

export async function saveConfig(configPath, config) {
  await writeJsonAtomic(configPath, config);
}
