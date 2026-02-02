// Input — node:test/assert/http plus `dagain ui` subprocess. If this file changes, update this header and the folder Markdown.
// Output — E2E coverage for web UI + SSE updates and supervisor start. If this file changes, update this header and the folder Markdown.
// Position — High-level integration test spanning UI server, SSE events, and a deterministic supervisor run. If this file changes, update this header and the folder Markdown.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

function httpPostJson(url, body, { token }) {
  return new Promise((resolve, reject) => {
    const reqUrl = new URL(url);
    const data = JSON.stringify(body);
    const postReq = http.request(
      reqUrl,
      { method: "POST", headers: { "content-type": "application/json", "x-dagain-token": token } },
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

function extractUiToken(homeHtml) {
  const tokenMatch = homeHtml.match(/__DAGAIN_TOKEN__/) ? null : homeHtml.match(/token:\s*"([^"]+)"/);
  return tokenMatch ? tokenMatch[1] : "";
}

function nodeStatus(snapshot, nodeId) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  return nodes.find((n) => n && n.id === nodeId)?.status || null;
}

function openSse(baseUrl) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/events`, (res) => resolve({ req, res }));
    req.setTimeout(10_000);
    req.on("error", reject);
  });
}

function createSseReader(res) {
  res.setEncoding("utf8");

  let buf = "";
  const waiters = new Set();
  let ended = false;
  let endErr = null;

  function rejectAll(err) {
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    waiters.clear();
  }

  function feed(snap) {
    for (const w of [...waiters]) {
      let ok = false;
      try {
        ok = w.predicate(snap);
      } catch (err) {
        clearTimeout(w.timer);
        waiters.delete(w);
        w.reject(err);
        continue;
      }
      if (!ok) continue;
      clearTimeout(w.timer);
      waiters.delete(w);
      w.resolve(snap);
    }
  }

  function parseMessage(msg) {
    const line = msg
      .split("\n")
      .map((l) => l.trimEnd())
      .find((l) => l.startsWith("data:"));
    if (!line) return null;
    const jsonText = line.slice("data:".length).trim();
    if (!jsonText) return null;
    try {
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  }

  res.on("data", (chunk) => {
    buf += String(chunk || "");
    // Consume complete messages.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sep = buf.indexOf("\n\n");
      if (sep < 0) break;
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const snap = parseMessage(raw);
      if (snap) feed(snap);
    }
  });
  res.on("error", (err) => {
    ended = true;
    endErr = err;
    rejectAll(err);
  });
  res.on("end", () => {
    ended = true;
    rejectAll(new Error("SSE stream ended"));
  });

  function waitFor(predicate, { timeoutMs = 10_000 } = {}) {
    if (ended) return Promise.reject(endErr || new Error("SSE stream ended"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(w);
        reject(new Error("Timed out waiting for SSE snapshot"));
      }, timeoutMs);
      const w = { predicate, resolve, reject, timer };
      waiters.add(w);
    });
  }

  return { waitFor };
}

test("ui e2e: SSE updates as plan-000 transitions open->done", { timeout: 25_000 }, async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-ui-e2e-"));

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  // Deterministic planner: marks plan-000 success quickly so `dagain run` completes.
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
        supervisor: { workers: 1, idleSleepMs: 0, staleLockSeconds: 3600, mailboxPollMs: 0 },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const ui = spawn(process.execPath, [binPath, "ui", "--host", "127.0.0.1", "--port", "0"], {
    cwd: tmpDir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ui.stdout.setEncoding("utf8");
  ui.stderr.setEncoding("utf8");

  let baseUrl = "";
  try {
    baseUrl = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("Timed out waiting for ui url")), 10_000);
      ui.stdout.on("data", (d) => {
        buf += String(d || "");
        const m = buf.match(/dagain ui listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      ui.on("error", reject);
    });

    const home = await httpGetText(`${baseUrl}/`);
    const token = extractUiToken(home);
    assert.ok(token, "expected UI token");

    const { req: sseReq, res: sseRes } = await openSse(baseUrl);
    const sse = createSseReader(sseRes);
    try {
      const first = await sse.waitFor((s) => nodeStatus(s, "plan-000") === "open");
      assert.equal(nodeStatus(first, "plan-000"), "open");

      const start = await httpPostJson(`${baseUrl}/api/control/start`, {}, { token });
      assert.ok(start && start.ok, "expected start ok");

      const doneSnap = await sse.waitFor((s) => nodeStatus(s, "plan-000") === "done", { timeoutMs: 15_000 });
      assert.equal(nodeStatus(doneSnap, "plan-000"), "done");
    } finally {
      try {
        sseReq.destroy();
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      ui.kill("SIGTERM");
    } catch {
      // ignore
    }
    await new Promise((resolve) => ui.on("close", () => resolve()));
    // Best-effort cleanup: stop any supervisor that might still be running.
    await runCli({ binPath, cwd: tmpDir, args: ["stop", "--no-color"] }).catch(() => {});
  }
});
