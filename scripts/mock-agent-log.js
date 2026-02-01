import fs from "node:fs/promises";

async function readAllStdin() {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let out = "";
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

function extract(packet, re) {
  const m = String(packet || "").match(re);
  return m ? String(m[1] || "").trim() : "";
}

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

const marker = String(process.argv[2] || "").trim() || "marker";
const packetPath = String(process.argv[3] || "").trim();

const packet = packetPath ? await fs.readFile(packetPath, "utf8") : await readAllStdin();
const nodeId = extract(packet, /^- ID:\s*(.+)\s*$/m);
const nodeType = extract(packet, /^- Type:\s*(.+)\s*$/m);

await fs.appendFile("invocations.log", `${marker}\tnode=${nodeId || "?"}\ttype=${nodeType || "?"}\n`, "utf8");

result({
  version: 1,
  role: marker,
  nodeId,
  status: "success",
  summary: `ok (${marker})`,
  filesChanged: ["invocations.log"],
  commandsRun: [],
  commits: [],
  next: { addNodes: [], setStatus: [] },
  checkpoint: null,
  errors: [],
  confidence: 1,
});

