import path from "node:path";
import { pathExists, readJson, writeJsonAtomic } from "./fs.js";

export function choreoPaths(rootDir) {
  const choreoDir = path.join(rootDir, ".choreo");
  return {
    rootDir,
    choreoDir,
    configPath: path.join(choreoDir, "config.json"),
    graphPath: path.join(choreoDir, "workgraph.json"),
    graphSnapshotPath: path.join(choreoDir, "workgraph.json"),
    dbPath: path.join(choreoDir, "state.sqlite"),
    lockPath: path.join(choreoDir, "lock"),
    checkpointsDir: path.join(choreoDir, "checkpoints"),
    runsDir: path.join(choreoDir, "runs"),
    artifactsDir: path.join(choreoDir, "artifacts"),
    memoryDir: path.join(choreoDir, "memory"),
    templatesDir: path.join(choreoDir, "templates"),
    tmpDir: path.join(choreoDir, "tmp"),
    goalPath: path.join(rootDir, "GOAL.md"),
  };
}

export function defaultConfig() {
  return {
    version: 1,
    defaults: {
      retryPolicy: { maxAttempts: 1 },
      verifyRunner: "shellVerify",
    },
    runners: {
      shellVerify: { cmd: 'node "$CHOREO_SHELL_VERIFIER"' },
      codex: { cmd: "codex exec --yolo --skip-git-repo-check -" },
      // Note: Claude forbids --dangerously-skip-permissions when running as root/sudo.
      // choreo strips that flag automatically in those contexts.
      claude: {
        cmd: "claude --dangerously-skip-permissions -p \"$(cat {packet})\"",
        env: { TMPDIR: ".choreo/tmp" },
      },
      gemini: { cmd: "gemini -y -p \"$(cat {packet})\"" },
    },
    roles: {
      main: "codex",
      planner: "codex",
      executor: "codex",
      verifier: "codex",
      integrator: "codex",
      finalVerifier: "codex",
      researcher: "codex"
    },
	    supervisor: {
	      workers: 1,
	      idleSleepMs: 2000,
	      staleLockSeconds: 3600,
	      autoResetFailedMax: 1,
	      claudeSensitiveFallbackRunner: "codex",
	      multiVerifier: "one",
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
