import test from "node:test";
import assert from "node:assert/strict";

import { OwnershipLockManager } from "../src/lib/ownership-locks.js";

test("OwnershipLockManager: empty ownership defaults to __global__", () => {
  const locks = new OwnershipLockManager();
  assert.deepEqual(locks.normalizeResources([]), ["__global__"]);
  assert.deepEqual(locks.normalizeResources(null), ["__global__"]);
  assert.deepEqual(locks.normalizeResources(["", "   "]), ["__global__"]);
});

test("OwnershipLockManager: read/read on same resource allowed", () => {
  const locks = new OwnershipLockManager();
  assert.equal(locks.acquire("n1", { resources: ["x"], mode: "read" }), true);
  assert.equal(locks.acquire("n2", { resources: ["x"], mode: "read" }), true);
});

test("OwnershipLockManager: write/write on same resource blocked", () => {
  const locks = new OwnershipLockManager();
  assert.equal(locks.acquire("n1", { resources: ["x"], mode: "write" }), true);
  assert.equal(locks.acquire("n2", { resources: ["x"], mode: "write" }), false);
});

test("OwnershipLockManager: read/write on same resource blocked", () => {
  const locks = new OwnershipLockManager();
  assert.equal(locks.acquire("n1", { resources: ["x"], mode: "read" }), true);
  assert.equal(locks.acquire("n2", { resources: ["x"], mode: "write" }), false);
});

test("OwnershipLockManager: disjoint resources allowed", () => {
  const locks = new OwnershipLockManager();
  assert.equal(locks.acquire("n1", { resources: ["a"], mode: "write" }), true);
  assert.equal(locks.acquire("n2", { resources: ["b"], mode: "write" }), true);
});

