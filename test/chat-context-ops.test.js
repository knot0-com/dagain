// Input — node:test/assert/http plus `dagain ui` subprocess and mock chat runner. If this file changes, update this header and the folder Markdown.
// Output — ensures chat router can request allowlisted ctx.* ops and receive results in a follow-up microcall. If this file changes, update this header and the folder Markdown.
// Position — prevents chat router from being context-blind without enabling arbitrary tool execution. If this file changes, update this header and the folder Markdown.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

function httpPostJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const reqUrl = new URL(url);
    const data = JSON.stringify(body);
    const postReq = http.request(
      reqUrl,
      { method: "POST", headers: { "content-type": "application/json", ...headers } },
      (postRes) => {
        let buf = "";
        postRes.setEncoding("utf8");
        postRes.on("data", (d) => (buf += d));
        postRes.on("end", () => {
          try {
            resolve({ status: postRes.statusCode || 0, json: JSON.parse(buf) });
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

test("ui chat: ctx.readFile op is executed and injected into follow-up prompt", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(repoRoot, "bin", "dagain.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-chat-ctxops-"));

  const marker = "CTXOPS-MARKER-123";

  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  await writeFile(path.join(tmpDir, "README.md"), `${marker}\n`, "utf8");

  const mockChatPath = path.join(tmpDir, "mock-chat-ctxops.js");
  await writeFile(
    mockChatPath,
    [
      'import fs from "node:fs/promises";',
      "function result(obj) { process.stdout.write(`<result>${JSON.stringify(obj)}</result>\\n`); }",
      'const packetPath = process.argv.slice(2).find((p) => p && p.endsWith(".md")) || "";',
      'const packet = packetPath ? await fs.readFile(packetPath, "utf8") : "";',
      'const hasCtx = packet.includes("Context ops results");',
      `const hasMarker = packet.includes(${JSON.stringify(marker)});`,
      "if (!hasCtx) {",
      "  result({ status: 'success', summary: 'need ctx', data: { reply: 'fetching', rollup: 'r', ops: [{ type: 'ctx.readFile', path: 'README.md', maxBytes: 2000 }] } });",
      "} else {",
      "  result({ status: 'success', summary: 'ok', data: { reply: JSON.stringify({ hasMarker }), rollup: 'r', ops: [] } });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(tmpDir, ".dagain", "config.json"),
    JSON.stringify(
      {
        version: 1,
        runners: { mockChat: { cmd: `node ${mockChatPath} {packet}` } },
        roles: {
          main: "mockChat",
          planner: "mockChat",
          executor: "mockChat",
          verifier: "mockChat",
          integrator: "mockChat",
          finalVerifier: "mockChat",
          researcher: "mockChat",
        },
        supervisor: { workers: 1, idleSleepMs: 50, staleLockSeconds: 3600, mailboxPollMs: 50 },
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
    const m = await waitForMatch(child.stdout, /dagain ui listening on (http:\/\/127\.0\.0\.1:\d+)/);
    const baseUrl = m[1];
    const home = await httpGetText(`${baseUrl}/`);
    const tokenMatch = home.match(/__DAGAIN_TOKEN__/) ? null : home.match(/token:\s*"([^"]+)"/);
    const uiToken = tokenMatch ? tokenMatch[1] : "";
    assert.ok(uiToken, "expected UI token");

    const postRes = await httpPostJson(
      `${baseUrl}/api/chat/send`,
      { message: "help", runner: "mockChat", role: "planner" },
      { "x-dagain-token": uiToken },
    );
    assert.equal(postRes.status, 200);
    const replyText = String(postRes.json?.reply || "");
    let parsed = null;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(replyText);
    }, "expected final reply to be JSON after ctx ops are executed");
    assert.equal(parsed?.hasMarker, true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("close", () => resolve()));
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
