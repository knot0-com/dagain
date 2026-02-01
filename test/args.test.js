import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/lib/args.js";

test("parseArgs supports --key=value and positional command", () => {
  const { command, positional, flags } = parseArgs(["node", "cli", "init", "--main=claude", "x"]);
  assert.equal(command, "init");
  assert.deepEqual(positional, ["x"]);
  assert.equal(flags.main, "claude");
});

test("parseArgs supports --key value", () => {
  const { flags } = parseArgs(["node", "cli", "run", "--interval-ms", "500"]);
  assert.equal(flags["interval-ms"], "500");
});

