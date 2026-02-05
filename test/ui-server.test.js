// Input — node:test/assert/http plus `dagain ui` subprocess. If this file changes, update this header and the folder Markdown.
// Output — validates `/api/state` JSON from the dashboard server. If this file changes, update this header and the folder Markdown.
// Position — Integration test for the lightweight web dashboard. If this file changes, update this header and the folder Markdown.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { dagainSessionTestPaths } from "./helpers/session.js";

function runCli({ binPath, cwd, args, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", ...env },
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

function waitForMatch(stream, re, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${re}`));
    }, timeoutMs);
    function onData(d) {
      buf += String(d || "");
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

function waitForUiUrl(child, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const re = /dagain ui listening on (http:\/\/127\.0\.0\.1:\d+)/;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ui url. Output:\n${buf}`));
    }, timeoutMs);
    function onError(err) {
      cleanup();
      reject(err);
    }
    function onData(d) {
      buf += String(d || "");
      const m = buf.match(re);
      if (m) {
        cleanup();
        resolve(m);
      }
    }
    function onClose(code, signal) {
      cleanup();
      reject(new Error(`ui exited before listening (code=${code ?? "?"} signal=${signal ?? "?"}). Output:\n${buf}`));
    }
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("close", onClose);
      child.off("error", onError);
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("close", onClose);
    child.on("error", onError);

    if (child.exitCode != null || child.signalCode != null) {
      onClose(child.exitCode, child.signalCode);
    }
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
  });
}

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
  });
}

async function waitFor(asyncPredicate, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    // eslint-disable-next-line no-await-in-loop
    const ok = await asyncPredicate().catch(() => false);
    if (ok) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("ui: serves dashboard state json", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-ui-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);
  const sessionPaths = await dagainSessionTestPaths(tmpDir);

  // Configure deterministic runners so `/api/control/start` and chat-triggered starts don't try
  // to run real LLM tooling in CI/test.
  const mockPlannerPath = path.join(tmpDir, "mock-planner.js");
  await writeFile(
    mockPlannerPath,
    [
      "function result(obj) { process.stdout.write(`<result>${JSON.stringify(obj)}</result>\\n`); }",
      "result({",
      "  version: 1,",
      "  role: 'planner',",
      "  status: 'success',",
      "  summary: 'planned',",
      "  next: { addNodes: [], setStatus: [] },",
      "  checkpoint: null,",
      "  errors: [],",
      "  confidence: 1,",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const mockChatPath = path.join(tmpDir, "mock-chat-router.js");
  await writeFile(
    mockChatPath,
    [
      "function result(obj) { process.stdout.write(`<result>${JSON.stringify(obj)}</result>\\n`); }",
      "result({",
      "  status: 'success',",
      "  summary: 'ok',",
      "  data: {",
      "    reply: 'Starting and resuming.',",
      "    rollup: 'rollup',",
      "    ops: [{ type: 'control.resume' }],",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(tmpDir, ".dagain", "config.json"),
    JSON.stringify(
      {
        version: 1,
        runners: {
          mockPlanner: { cmd: `node ${mockPlannerPath} {packet}` },
          mockChat: { cmd: `node ${mockChatPath} {packet}` },
        },
        roles: {
          main: "mockPlanner",
          planner: "mockPlanner",
          executor: "mockPlanner",
          verifier: "mockPlanner",
          integrator: "mockPlanner",
          finalVerifier: "mockPlanner",
          researcher: "mockPlanner",
        },
        supervisor: { workers: 1, idleSleepMs: 0, staleLockSeconds: 3600, mailboxPollMs: 0 },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const runId = "2026-01-01T00-00-00-000Z-aaaaaa";
  const runDir = path.join(tmpDir, ".dagain", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "stdout.log"), "hello from run\n", "utf8");
  await writeFile(path.join(runDir, "result.json"), JSON.stringify({ status: "success", nodeId: "task-123" }, null, 2) + "\n", "utf8");

  const child = spawn(process.execPath, [binPath, "ui", "--host", "127.0.0.1", "--port", "0"], {
    cwd: tmpDir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  try {
    const m = await waitForUiUrl(child);
    const baseUrl = m[1];

    const home = await httpGetText(`${baseUrl}/`);
    assert.match(home, /<link\s+rel="stylesheet"\s+href="\/static\/styles\.css"/);
    assert.match(home, /id="toggleRuns"/);
    assert.match(home, /id="toggleChat"/);
    assert.match(home, /id="toggleSelection"/);
    assert.match(home, /id="toggleConfig"/);

    const css = await httpGetText(`${baseUrl}/static/styles.css`);
    assert.match(css, /\.appBody\s*\{[^}]*display:\s*flex/);
    assert.match(css, /\.activityBar\s*\{/);

    const state = await httpGetJson(`${baseUrl}/api/state`);
    assert.ok(state && typeof state === "object");
    assert.ok(Array.isArray(state.nodes));
    assert.ok(state.nodes.some((n) => n.id === "plan-000"));

    const runs = await httpGetJson(`${baseUrl}/api/runs?limit=5`);
    assert.ok(runs && typeof runs === "object");
    assert.ok(Array.isArray(runs.runs));
    assert.ok(runs.runs.some((r) => r.runId === runId));

    const log = await httpGetJson(`${baseUrl}/api/run/log?runId=${encodeURIComponent(runId)}&tail=1000`);
    assert.equal(log.runId, runId);
    assert.match(String(log.text || ""), /hello from run/);

    // Extract auth token from the page HTML
    const tokenMatch = home.match(/__DAGAIN_TOKEN__/) ? null : home.match(/token:\s*"([^"]+)"/);
    const uiToken = tokenMatch ? tokenMatch[1] : "";

    function httpPost(url, body, extraHeaders = {}) {
      return new Promise((resolve, reject) => {
        const reqUrl = new URL(url);
        const data = JSON.stringify(body);
        const postReq = http.request(reqUrl, { method: "POST", headers: { "content-type": "application/json", "x-dagain-token": uiToken, ...extraHeaders } }, (postRes) => {
          let buf = "";
          postRes.setEncoding("utf8");
          postRes.on("data", (d) => (buf += d));
          postRes.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
        });
        postReq.on("error", reject);
        postReq.end(data);
      });
    }

    // POST /api/control/start: detects an existing supervisor lock (uses .dagain/lock, not legacy .supervisor.lock)
    const lockJson = {
      version: 1,
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    await writeFile(sessionPaths.lockPath, JSON.stringify(lockJson, null, 2) + "\n", "utf8");
    const startResult = await httpPost(`${baseUrl}/api/control/start`, {});
    assert.ok(startResult && startResult.ok);
    assert.equal(startResult.alreadyRunning, true);

    // Chat can enqueue control ops and still start the supervisor even if the model does not emit run.start.
    await rm(sessionPaths.lockPath, { force: true });
    const chatRes = await httpPost(`${baseUrl}/api/chat/send`, { message: "resume", runner: "mockChat", role: "planner" });
    assert.ok(chatRes && chatRes.ok);
    assert.match(String(chatRes.reply || ""), /Starting/);
    assert.ok(Array.isArray(chatRes.applied));
    assert.ok(chatRes.applied.some((a) => a.type === "control.resume"), "expected control.resume to be applied");
    assert.ok(chatRes.applied.some((a) => a.type === "run.start"), "expected run.start to be auto-applied");

    await waitFor(async () => {
      const s = await httpGetJson(`${baseUrl}/api/state`);
      return Array.isArray(s.nodes) && s.nodes.some((n) => n.id === "plan-000" && n.status === "done");
    });

    // CLEAR chat via POST /api/chat/clear
    const clearResult = await httpPost(`${baseUrl}/api/chat/clear`, {});
    assert.ok(clearResult && clearResult.ok, "chat clear should return ok");

    // GET /api/config
    const configResult = await httpGetJson(`${baseUrl}/api/config`);
    assert.ok(configResult && configResult.ok);
    assert.ok(configResult.config && typeof configResult.config === "object");
    assert.ok(configResult.config.runners && typeof configResult.config.runners === "object");

    // POST /api/config (save)
    const savedConfig = { ...configResult.config };
    savedConfig.supervisor = { ...savedConfig.supervisor, workers: 2 };
    const saveResult = await httpPost(`${baseUrl}/api/config`, { config: savedConfig });
    assert.ok(saveResult && saveResult.ok);

    // Verify save persisted
    const configAfter = await httpGetJson(`${baseUrl}/api/config`);
    assert.equal(configAfter.config.supervisor.workers, 2);

    // DELETE run via POST /api/run/delete
    const delResult = await httpPost(`${baseUrl}/api/run/delete`, { runId });
    assert.ok(delResult && delResult.ok, "delete should return ok");
    assert.equal(delResult.runId, runId);

    // Verify run is gone from listing
    const runsAfter = await httpGetJson(`${baseUrl}/api/runs?limit=5`);
    assert.ok(!runsAfter.runs.some((r) => r.runId === runId), "deleted run should not appear in listing");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("close", () => resolve()));
  }
});

test("ui: auto-initializes missing state.sqlite (oneshot)", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-ui-autoinit-"));

  try {
    const res = await runCli({
      binPath,
      cwd: tmpDir,
      args: ["ui", "--host", "127.0.0.1", "--port", "0"],
      env: { DAGAIN_UI_ONESHOT: "1" },
    });
    assert.equal(res.code, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /dagain ui listening on http:\/\/127\.0\.0\.1:\d+/, res.stdout);

    const sessionPaths = await dagainSessionTestPaths(tmpDir);
    assert.ok(await stat(sessionPaths.dbPath), "expected state.sqlite to exist after auto-init");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("ui: /api/sessions/delete removes session", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-ui-sessions-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const child = spawn(process.execPath, [binPath, "ui", "--host", "127.0.0.1", "--port", "0"], {
    cwd: tmpDir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  try {
    const m = await waitForUiUrl(child);
    const baseUrl = m[1];
    const home = await httpGetText(`${baseUrl}/`);
    const tokenMatch = home.match(/__DAGAIN_TOKEN__/) ? null : home.match(/token:\s*"([^"]+)"/);
    const uiToken = tokenMatch ? tokenMatch[1] : "";
    assert.ok(uiToken, "expected UI token");

    function httpPost(url, body) {
      return new Promise((resolve, reject) => {
        const reqUrl = new URL(url);
        const data = JSON.stringify(body);
        const postReq = http.request(
          reqUrl,
          { method: "POST", headers: { "content-type": "application/json", "x-dagain-token": uiToken } },
          (postRes) => {
            let buf = "";
            postRes.setEncoding("utf8");
            postRes.on("data", (d) => (buf += d));
            postRes.on("end", () => {
              try {
                resolve(JSON.parse(buf));
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        postReq.on("error", reject);
        postReq.end(data);
      });
    }

    const before = await httpGetJson(`${baseUrl}/api/sessions`);
    assert.ok(before && before.ok);
    assert.ok(Array.isArray(before.sessions));

    const created = await httpPost(`${baseUrl}/api/sessions/new`, {});
    assert.ok(created && created.ok);

    const afterCreate = await httpGetJson(`${baseUrl}/api/sessions`);
    assert.ok(Array.isArray(afterCreate.sessions));
    assert.ok(afterCreate.sessions.length >= 2, "expected at least 2 sessions after create");

    const currentId = String(afterCreate.currentId || "");
    const toDelete = afterCreate.sessions.map((s) => String(s?.id || "")).find((id) => id && id !== currentId);
    assert.ok(toDelete, "expected a non-current session to delete");

    const delRes = await httpPost(`${baseUrl}/api/sessions/delete`, { id: toDelete });
    assert.ok(delRes && delRes.ok, delRes?.error || "expected delete ok");

    const afterDelete = await httpGetJson(`${baseUrl}/api/sessions`);
    const ids = afterDelete.sessions.map((s) => String(s?.id || ""));
    assert.ok(!ids.includes(toDelete), "expected deleted session to be removed from listing");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("close", () => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("ui: /api/control/start works with stale supervisor lock", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-ui-stale-lock-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const mockPlannerPath = path.join(tmpDir, "mock-planner.js");
  await writeFile(
    mockPlannerPath,
    [
      "function result(obj) { process.stdout.write(`<result>${JSON.stringify(obj)}</result>\\n`); }",
      "result({",
      "  version: 1,",
      "  role: 'planner',",
      "  status: 'success',",
      "  summary: 'planned',",
      "  next: { addNodes: [], setStatus: [] },",
      "  checkpoint: null,",
      "  errors: [],",
      "  confidence: 1,",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(tmpDir, ".dagain", "config.json"),
    JSON.stringify(
      {
        version: 1,
        runners: { mockPlanner: { cmd: `node ${mockPlannerPath} {packet}` } },
        roles: {
          main: "mockPlanner",
          planner: "mockPlanner",
          executor: "mockPlanner",
          verifier: "mockPlanner",
          integrator: "mockPlanner",
          finalVerifier: "mockPlanner",
          researcher: "mockPlanner",
        },
        supervisor: { workers: 1, idleSleepMs: 0, staleLockSeconds: 1, mailboxPollMs: 0 },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const child = spawn(process.execPath, [binPath, "ui", "--host", "127.0.0.1", "--port", "0"], {
    cwd: tmpDir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  try {
    const m = await waitForUiUrl(child);
    const baseUrl = m[1];
    const home = await httpGetText(`${baseUrl}/`);
    const tokenMatch = home.match(/__DAGAIN_TOKEN__/) ? null : home.match(/token:\s*"([^"]+)"/);
    const uiToken = tokenMatch ? tokenMatch[1] : "";

    function httpPost(url, body, extraHeaders = {}) {
      return new Promise((resolve, reject) => {
        const reqUrl = new URL(url);
        const data = JSON.stringify(body);
        const postReq = http.request(
          reqUrl,
          { method: "POST", headers: { "content-type": "application/json", "x-dagain-token": uiToken, ...extraHeaders } },
          (postRes) => {
            let buf = "";
            postRes.setEncoding("utf8");
            postRes.on("data", (d) => (buf += d));
            postRes.on("end", () => {
              try {
                resolve(JSON.parse(buf));
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        postReq.on("error", reject);
        postReq.end(data);
      });
    }

    // Stale lock: local host, but PID is not running.
    const lockJson = {
      version: 1,
      pid: 9_999_999,
      host: os.hostname(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await writeFile(path.join(tmpDir, ".dagain", "lock"), JSON.stringify(lockJson, null, 2) + "\n", "utf8");

    const startRes = await httpPost(`${baseUrl}/api/control/start`, {});
    assert.ok(startRes && startRes.ok);
    assert.notEqual(startRes.alreadyRunning, true);
    assert.ok(Number(startRes.pid || 0) > 0);

    await waitFor(async () => {
      const s = await httpGetJson(`${baseUrl}/api/state`);
      return Array.isArray(s.nodes) && s.nodes.some((n) => n.id === "plan-000" && n.status === "done");
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("close", () => resolve()));
  }
});
