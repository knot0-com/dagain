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

const role = String(process.argv[2] || "").trim();
const packetPath = String(process.argv[3] || "").trim();

const packet = packetPath ? await fs.readFile(packetPath, "utf8") : await readAllStdin();
const nodeId = extractNodeId(packet);
const cwd = process.cwd();

if (role === "planner") {
  result({
    version: 1,
    role: "planner",
    status: "success",
    summary: "Seeded a tiny hello.txt task + verifier",
    next: {
      addNodes: [
        {
          id: "task-hello",
          title: "Create hello.txt with a known string",
          type: "task",
          status: "open",
          dependsOn: [],
          ownership: ["hello.txt"],
          acceptance: ["Creates hello.txt containing exactly: hello from dagain"],
          verify: ["cat hello.txt"],
          retryPolicy: { maxAttempts: 1 },
        },
        {
          id: "verify-hello",
          title: "Verify hello.txt exists and is correct",
          type: "verify",
          status: "open",
          dependsOn: ["task-hello"],
          ownership: ["hello.txt"],
          acceptance: ["hello.txt exists and contains the expected content"],
          verify: ["test -f hello.txt", "cat hello.txt"],
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
  const target = path.join(cwd, "hello.txt");
  await fs.writeFile(target, "hello from dagain\n", "utf8");
  result({
    version: 1,
    role: "executor",
    nodeId,
    status: "success",
    summary: "Wrote hello.txt",
    filesChanged: ["hello.txt"],
    commandsRun: [],
    commits: [],
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: [],
    confidence: 1,
  });
} else if (role === "verifier") {
  const target = path.join(cwd, "hello.txt");
  let ok = false;
  let content = "";
  try {
    content = await fs.readFile(target, "utf8");
    ok = content.trimEnd() === "hello from dagain";
  } catch {
    ok = false;
  }
  result({
    version: 1,
    role: "verifier",
    nodeId,
    status: ok ? "success" : "fail",
    summary: ok ? "Verified hello.txt content" : `hello.txt invalid or missing (got: ${JSON.stringify(content)})`,
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: ok ? [] : ["hello.txt missing/invalid"],
    confidence: ok ? 1 : 0,
  });
} else if (role === "integrator") {
  result({
    version: 1,
    role: "integrator",
    nodeId,
    status: "success",
    summary: "Integrated (mock)",
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: [],
    confidence: 1,
  });
} else if (role === "finalVerifier") {
  result({
    version: 1,
    role: "finalVerifier",
    nodeId,
    status: "success",
    summary: "Final verified (mock)",
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
