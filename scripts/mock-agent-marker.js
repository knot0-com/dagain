import fs from "node:fs/promises";

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

const marker = String(process.argv[2] || "").trim() || "unknown";

await fs.writeFile("runner_marker.txt", `${marker}\n`, "utf8");

result({
  version: 1,
  role: "executor",
  status: "success",
  summary: `marker=${marker}`,
  filesChanged: ["runner_marker.txt"],
  commandsRun: [],
  commits: [],
  next: { addNodes: [], setStatus: [] },
  checkpoint: null,
  errors: [],
  confidence: 1,
});

