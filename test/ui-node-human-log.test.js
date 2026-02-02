// Input — node:test/assert, temporary dagain project, ui server. If this file changes, update this header and the folder Markdown.
// Output — regression coverage for node log view returning human-readable result text. If this file changes, update this header and the folder Markdown.
// Position — guards UI against showing raw runner stdout by default. If this file changes, update this header and the folder Markdown.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec } from "./helpers/sqlite.js";

function runCli({ binPath, cwd, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
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

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const reqUrl = new URL(url);
    const r = http.request(reqUrl, { method: "GET" }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (buf += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(buf));
        } catch (e) {
          reject(e);
        }
      });
    });
    r.on("error", reject);
    r.end();
  });
}

function waitForMatch(stream, re, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for ${re}`));
    }, timeoutMs);
    function onData(d) {
      buf += String(d);
      const m = buf.match(re);
      if (m) {
        cleanup();
        resolve(m);
      }
    }
    function cleanup() {
      clearTimeout(timer);
      stream.off("data", onData);
    }
    stream.on("data", onData);
  });
}

test("ui: /api/node/log returns result-derived human text", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-ui-human-log-"));

  const initRes = await runCli({ binPath, cwd: tmpDir, args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"] });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const runId = "plan-000-2026-01-01T00-00-00-000Z-aaaaaa";
  const runDir = path.join(tmpDir, ".dagain", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "stdout.log"), "[debug] noisy stdout\n", "utf8");
  await writeFile(
    path.join(runDir, "result.json"),
    JSON.stringify({ status: "success", summary: "Human summary here", nodeId: "plan-000" }, null, 2) + "\n",
    "utf8",
  );

  const dbPath = path.join(tmpDir, ".dagain", "state.sqlite");
  const now = new Date().toISOString().replace(/'/g, "''");
  const resultRel = path.relative(tmpDir, path.join(runDir, "result.json")).replace(/'/g, "''");
  await sqliteExec(
    dbPath,
    `INSERT OR REPLACE INTO kv_latest(node_id, key, value_text, updated_at)\n` +
      `VALUES('plan-000', 'out.last_result_path', '${resultRel}', '${now}');\n`,
  );

  const child = spawn(process.execPath, [binPath, "ui", "--host", "127.0.0.1", "--port", "0"], {
    cwd: tmpDir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  try {
    const m = await waitForMatch(child.stdout, /dagain ui listening on (http:\/\/127\.0\.0\.1:\d+)/);
    const baseUrl = m[1];

    const log = await httpGetJson(`${baseUrl}/api/node/log?id=plan-000&tail=10000`);
    assert.equal(log.nodeId, "plan-000");
    assert.match(String(log.text || ""), /status:\s*success/i);
    assert.match(String(log.text || ""), /Human summary here/);
    assert.doesNotMatch(String(log.text || ""), /\[debug\]/);
  } finally {
    child.kill("SIGTERM");
    await rm(tmpDir, { recursive: true, force: true });
  }
});
