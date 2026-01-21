import fs from "node:fs/promises";
import path from "node:path";

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

function sleep(ms) {
  const n = Number(ms);
  const duration = Number.isFinite(n) && n >= 0 ? n : 0;
  return new Promise((resolve) => setTimeout(resolve, duration));
}

const role = String(process.argv[2] || "").trim();
const packetPath = String(process.argv[3] || "").trim();
const packet = packetPath ? await fs.readFile(packetPath, "utf8") : await readAllStdin();
const nodeId = extractNodeId(packet);
const cwd = process.cwd();

const sleepMsEnv = Number(process.env.MOCK_SLEEP_MS || "");
const sleepMs = Number.isFinite(sleepMsEnv) && sleepMsEnv >= 0 ? sleepMsEnv : 400;

if (role === "planner") {
  result({
    version: 1,
    role: "planner",
    status: "success",
    summary: "Seeded two independent sleep tasks",
    next: {
      addNodes: [
        {
          id: "task-a",
          title: "Write a.txt",
          type: "task",
          status: "open",
          dependsOn: [],
          ownership: ["a.txt"],
          acceptance: ["Creates a.txt with known content"],
          verify: ["cat a.txt"],
          retryPolicy: { maxAttempts: 1 },
        },
        {
          id: "task-b",
          title: "Write b.txt",
          type: "task",
          status: "open",
          dependsOn: [],
          ownership: ["b.txt"],
          acceptance: ["Creates b.txt with known content"],
          verify: ["cat b.txt"],
          retryPolicy: { maxAttempts: 1 },
        },
      ],
      setStatus: [],
    },
    checkpoint: null,
    errors: [],
    confidence: 1,
  });
} else if (role === "executor") {
  await sleep(sleepMs);
  if (nodeId === "task-a") await fs.writeFile(path.join(cwd, "a.txt"), "a\n", "utf8");
  else if (nodeId === "task-b") await fs.writeFile(path.join(cwd, "b.txt"), "b\n", "utf8");
  else await fs.writeFile(path.join(cwd, `${nodeId}.txt`), `${nodeId}\n`, "utf8");

  result({
    version: 1,
    role: "executor",
    nodeId,
    status: "success",
    summary: `Wrote ${nodeId}`,
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: [],
    confidence: 1,
  });
} else if (role === "verifier") {
  await sleep(sleepMs);
  result({
    version: 1,
    role: "verifier",
    nodeId,
    status: "success",
    summary: `Verified ${nodeId}`,
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: [],
    confidence: 1,
  });
} else if (role === "integrator" || role === "finalVerifier") {
  result({
    version: 1,
    role,
    nodeId,
    status: "success",
    summary: `OK (${role})`,
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: [],
    confidence: 1,
  });
} else {
  result({
    version: 1,
    role,
    nodeId,
    status: "fail",
    summary: `Unknown mock role: ${role}`,
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: [`Unknown mock role: ${role}`],
    confidence: 0,
  });
}

