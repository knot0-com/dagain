import fs from "node:fs/promises";

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

const packetPath = String(process.argv[2] || "").trim();
const packet = packetPath ? await fs.readFile(packetPath, "utf8") : "";

const m = packet.match(/\nUser:\s*(.+)\s*$/im);
const user = m ? String(m[1] || "").trim() : "";

if (user === "graph-ops-1") {
  result({
    status: "success",
    summary: "graph ops: add nodes + deps",
    data: {
      reply: "",
      ops: [
        {
          type: "node.add",
          id: "task-001",
          title: "Task 1",
          nodeType: "task",
          parentId: "plan-000",
          status: "open",
          runner: null,
          inputs: [{ nodeId: "__run__", key: "chat.rollup" }],
          ownership: [{ resources: ["__global__"], mode: "read" }],
          acceptance: ["draft"],
          verify: ["unit"],
          retryPolicy: { maxAttempts: 1 },
        },
        {
          type: "node.add",
          id: "task-002",
          title: "Task 2",
          nodeType: "task",
          parentId: "plan-000",
          status: "open",
          runner: null,
          retryPolicy: { maxAttempts: 2 },
          dependsOn: ["task-001"],
        },
        {
          type: "dep.add",
          nodeId: "task-002",
          dependsOnId: "task-001",
          requiredStatus: "terminal",
        },
      ],
    },
  });
  process.exit(0);
}

if (user === "graph-ops-2") {
  result({
    status: "success",
    summary: "graph ops: update node metadata",
    data: {
      reply: "",
      ops: [
        {
          type: "node.update",
          id: "task-001",
          title: "Task 1 updated",
          acceptance: ["has-spec"],
          retryPolicy: { maxAttempts: 3 },
        },
      ],
    },
  });
  process.exit(0);
}

result({
  status: "success",
  summary: "graph ops: noop",
  data: { reply: "noop", ops: [] },
});

