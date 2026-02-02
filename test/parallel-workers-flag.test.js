// Input — `defaultConfig()` and CLI help output. If this file changes, update this header and the folder Markdown.
// Output — test coverage for workers flag + defaults. If this file changes, update this header and the folder Markdown.
// Position — regression tests for CLI/config behavior. If this file changes, update this header and the folder Markdown.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defaultConfig } from "../src/lib/config.js";

function runCliHelp({ binPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, "--help"], {
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? 0, signal, stdout, stderr }));
  });
}

test("help: run documents --workers flag", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");

  const res = await runCliHelp({ binPath });
  assert.equal(res.code, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /--workers(?:=<n>)?/);
});

test("defaultConfig: supervisor.workers defaults to 3", () => {
  const config = defaultConfig();
  assert.equal(config?.supervisor?.workers, 3);
});

test("defaultConfig: shellVerify cmd supports CHOREO_/TASKGRAPH_ fallbacks", () => {
  const config = defaultConfig();
  const cmd = String(config?.runners?.shellVerify?.cmd || "");
  assert.match(cmd, /DAGAIN_SHELL_VERIFIER/);
  assert.match(cmd, /CHOREO_SHELL_VERIFIER/);
  assert.match(cmd, /TASKGRAPH_SHELL_VERIFIER/);
});
