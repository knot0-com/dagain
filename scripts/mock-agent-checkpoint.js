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

function extractResumeAnswer(packet) {
  const m = String(packet || "").match(/^- answer:\s*(.+)\s*$/m);
  return m ? m[1].trim() : "";
}

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

const role = String(process.argv[2] || "").trim();
const packetPath = String(process.argv[3] || "").trim();

const packet = packetPath ? await fs.readFile(packetPath, "utf8") : await readAllStdin();
const nodeId = extractNodeId(packet);
const resumeAnswer = extractResumeAnswer(packet);
const cwd = process.cwd();

if (role === "planner") {
  result({
    version: 1,
    role: "planner",
    status: "success",
    summary: "Created a task that requires a checkpoint, plus a verifier",
    next: {
      addNodes: [
        {
          id: "task-confirm",
          title: "Create confirmed.txt (requires human confirmation once)",
          type: "task",
          status: "open",
          dependsOn: [],
          ownership: ["confirmed.txt"],
          acceptance: ["Creates confirmed.txt containing exactly: confirmed"],
          verify: ["cat confirmed.txt"],
          retryPolicy: { maxAttempts: 1 },
        },
        {
          id: "verify-confirm",
          title: "Verify confirmed.txt exists and is correct",
          type: "verify",
          status: "open",
          dependsOn: ["task-confirm"],
          ownership: ["confirmed.txt"],
          acceptance: ["confirmed.txt exists and contains the expected content"],
          verify: ["test -f confirmed.txt", "cat confirmed.txt"],
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
  if (!resumeAnswer) {
    result({
      version: 1,
      role: "executor",
      nodeId,
      status: "checkpoint",
      summary: "Waiting for confirmation before creating confirmed.txt",
      filesChanged: [],
      commandsRun: [],
      commits: [],
      next: { addNodes: [], setStatus: [] },
      checkpoint: {
        type: "approval",
        question: "Type yes to proceed with creating confirmed.txt",
        context: "",
        options: ["yes", "no"],
        resumeSignal: "Answer in plain text",
      },
      errors: [],
      confidence: 1,
    });
  } else {
    const target = path.join(cwd, "confirmed.txt");
    await fs.writeFile(target, "confirmed\n", "utf8");
    result({
      version: 1,
      role: "executor",
      nodeId,
      status: "success",
      summary: "Created confirmed.txt",
      filesChanged: ["confirmed.txt"],
      commandsRun: [],
      commits: [],
      next: { addNodes: [], setStatus: [] },
      checkpoint: null,
      errors: [],
      confidence: 1,
    });
  }
} else if (role === "verifier") {
  const target = path.join(cwd, "confirmed.txt");
  let ok = false;
  let content = "";
  try {
    content = await fs.readFile(target, "utf8");
    ok = content.trimEnd() === "confirmed";
  } catch {
    ok = false;
  }
  result({
    version: 1,
    role: "verifier",
    nodeId,
    status: ok ? "success" : "fail",
    summary: ok ? "Verified confirmed.txt content" : `confirmed.txt invalid or missing (got: ${JSON.stringify(content)})`,
    next: { addNodes: [], setStatus: [] },
    checkpoint: null,
    errors: ok ? [] : ["confirmed.txt missing/invalid"],
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
