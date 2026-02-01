import fs from "node:fs/promises";

async function readAllStdin() {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let out = "";
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

function extractNodeId(packet) {
  const m = String(packet || "").match(/^- ID:\s*(.+)\s*$/m);
  return m ? m[1].trim() : "";
}

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

const packetPath = String(process.argv[2] || "").trim();
const packet = packetPath ? await fs.readFile(packetPath, "utf8") : await readAllStdin();
const nodeId = extractNodeId(packet);

result({
  version: 1,
  role: "planner",
  nodeId,
  status: "success",
  summary: "Planner emitted tasks only (no verify/integrate/final nodes)",
  next: {
    addNodes: [
      {
        id: "task-hello",
        title: "Do a small task",
        type: "task",
        status: "open",
        dependsOn: [],
        ownership: ["hello.txt"],
        acceptance: ["A task exists and can be verified"],
        verify: ["echo ok"],
        retryPolicy: { maxAttempts: 1 },
      },
    ],
    setStatus: [],
  },
  checkpoint: null,
  errors: [],
  confidence: 1,
});

