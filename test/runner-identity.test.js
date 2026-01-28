import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";

import { runRunnerCommand } from "../src/lib/runner.js";

const canSetIds = typeof process.getuid === "function" && process.getuid() === 0 && process.platform !== "win32";

async function setupTmp() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dagain-runner-"));
  const packetPath = path.join(tmpDir, "packet.md");
  await writeFile(packetPath, "packet", "utf8");
  return { tmpDir, packetPath };
}

test("runRunnerCommand: uid/gid executes as requested user", { skip: !canSetIds, timeout: 10_000 }, async () => {
  const { tmpDir, packetPath } = await setupTmp();
  const logPath = path.join(tmpDir, "stdout.log");

  const res = await runRunnerCommand({
    cmd: "id -u",
    packetPath,
    cwd: tmpDir,
    logPath,
    uid: 65534,
    gid: 65534,
  });

  assert.equal(res.code, 0);
  const log = await readFile(logPath, "utf8");
  assert.match(log, /\n65534\n/);
});

test(
  "runRunnerCommand: keeps Claude dangerous flag when uid is non-root, strips when root",
  { skip: !canSetIds, timeout: 10_000 },
  async () => {
    const { tmpDir, packetPath } = await setupTmp();

    const rootLogPath = path.join(tmpDir, "root.log");
    await runRunnerCommand({
      cmd: "echo hi --dangerously-skip-permissions",
      packetPath,
      cwd: tmpDir,
      logPath: rootLogPath,
      uid: 0,
      gid: 0,
    });
    const rootLog = await readFile(rootLogPath, "utf8");
    assert.match(rootLog, /\[dagain\] cmd: echo hi(\n|$)/);
    assert.doesNotMatch(rootLog, /--dangerously-skip-permissions/);

    const userLogPath = path.join(tmpDir, "user.log");
    await runRunnerCommand({
      cmd: "echo hi --dangerously-skip-permissions",
      packetPath,
      cwd: tmpDir,
      logPath: userLogPath,
      uid: 65534,
      gid: 65534,
    });
    const userLog = await readFile(userLogPath, "utf8");
    assert.match(userLog, /--dangerously-skip-permissions/);
  },
);
