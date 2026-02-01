import test from "node:test";
import assert from "node:assert/strict";
import { selectNextNode } from "../src/lib/select.js";

test("selectNextNode picks first runnable node deterministically", () => {
  const graph = {
    nodes: [
      { id: "b", type: "task", status: "open", dependsOn: ["a"] },
      { id: "a", type: "task", status: "done" },
      { id: "c", type: "verify", status: "open" },
    ],
  };
  const next = selectNextNode(graph);
  assert.equal(next.id, "c"); // type sorts before task
});

