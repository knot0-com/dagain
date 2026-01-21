import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sqliteExec } from "./helpers/sqlite.js";

function runCli({ binPath, cwd, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
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

test("packet: renders Node Inputs from inputs_json refs", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");
  const packetDumpPath = fileURLToPath(new URL("../scripts/mock-agent-packet-dump.js", import.meta.url));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-node-inputs-"));
  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "X", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const dbPath = path.join(tmpDir, ".choreo", "state.sqlite");
  const now = new Date().toISOString().replace(/'/g, "''");
  const inputsJson = JSON.stringify([{ nodeId: "__run__", key: "ctx.foo", as: "foo" }]).replace(/'/g, "''");
  await sqliteExec(
    dbPath,
    `INSERT OR REPLACE INTO kv_latest(node_id, key, value_text, updated_at)\n` +
      `VALUES('__run__', 'ctx.foo', 'bar', '${now}');\n` +
      `UPDATE nodes SET inputs_json='${inputsJson}' WHERE id='plan-000';\n`,
  );

  const configPath = path.join(tmpDir, ".choreo", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        runners: {
          dump: { cmd: `node ${packetDumpPath} dump {packet}` },
        },
        roles: {
          main: "dump",
          planner: "dump",
          executor: "dump",
          verifier: "dump",
          integrator: "dump",
          finalVerifier: "dump",
          researcher: "dump",
        },
        supervisor: {
          idleSleepMs: 0,
          staleLockSeconds: 3600,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const runRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["run", "--max-iterations", "1", "--interval-ms", "0", "--no-live", "--no-color"],
  });
  assert.equal(runRes.code, 0, runRes.stderr || runRes.stdout);

  const packetSeen = await readFile(path.join(tmpDir, "packet_seen.md"), "utf8");
  assert.match(packetSeen, /## Node Inputs\b/);
  assert.match(packetSeen, /__run__:ctx\.foo/);
  assert.match(packetSeen, /\bbar\b/);
});

