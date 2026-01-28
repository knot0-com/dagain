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

const marker = String(process.argv[2] || "").trim() || "dump";
const packetPath = String(process.argv[3] || "").trim();

const packet = packetPath ? await fs.readFile(packetPath, "utf8") : await readAllStdin();
const nodeId = extract(packet, /^- ID:\s*(.+)\s*$/m);
const nodeType = extract(packet, /^- Type:\s*(.+)\s*$/m);

await fs.writeFile("packet_seen.md", packet, "utf8");
await fs.writeFile(
  "packet_meta.json",
  JSON.stringify({ marker, nodeId, nodeType, length: packet.length, runMode: process.env.DAGAIN_RUN_MODE || "" }, null, 2) + "\n",
  "utf8",
);

result({
  version: 1,
  role: marker,
  nodeId,
  status: "success",
  summary: `wrote packet_seen.md (${packet.length} chars)`,
  filesChanged: ["packet_seen.md", "packet_meta.json"],
  commandsRun: [],
  commits: [],
  next: { addNodes: [], setStatus: [] },
  checkpoint: null,
  errors: [],
  confidence: 1,
});
