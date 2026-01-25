import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("templates sync: overwrites only with --force", async () => {
  const choreoRoot = fileURLToPath(new URL("..", import.meta.url));
  const binPath = path.join(choreoRoot, "bin", "choreo.js");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "choreo-templates-sync-"));
  const initRes = await runCli({
    binPath,
    cwd: tmpDir,
    args: ["init", "--goal", "Template sync test", "--no-refine", "--force", "--no-color"],
  });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);

  const target = path.join(tmpDir, ".taskgraph", "templates", "integrator-analysis.md");
  const original = await readFile(target, "utf8");
  assert.match(original, /Integrator\s*\(Analysis\)/i);

  await writeFile(target, "CUSTOM TEMPLATE\n", "utf8");

  const syncRes = await runCli({ binPath, cwd: tmpDir, args: ["templates", "sync", "--no-color"] });
  assert.equal(syncRes.code, 0, syncRes.stderr || syncRes.stdout);
  const afterNoForce = await readFile(target, "utf8");
  assert.equal(afterNoForce, "CUSTOM TEMPLATE\n");

  const syncForceRes = await runCli({ binPath, cwd: tmpDir, args: ["templates", "sync", "--force", "--no-color"] });
  assert.equal(syncForceRes.code, 0, syncForceRes.stderr || syncForceRes.stdout);
  const afterForce = await readFile(target, "utf8");
  assert.match(afterForce, /#\s*Choreo Packet — Integrator \(Analysis\)/i);
  assert.ok(!afterForce.includes("CUSTOM TEMPLATE"));
});
