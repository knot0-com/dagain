import fs from "node:fs/promises";

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

const marker = String(process.argv[2] || "").trim() || "env";
const payload = {
  marker,
  CHOREO_DB: String(process.env.CHOREO_DB || ""),
  CHOREO_NODE_ID: String(process.env.CHOREO_NODE_ID || ""),
  CHOREO_RUN_ID: String(process.env.CHOREO_RUN_ID || ""),
  CHOREO_PARENT_NODE_ID: String(process.env.CHOREO_PARENT_NODE_ID || ""),
  CHOREO_ARTIFACTS_DIR: String(process.env.CHOREO_ARTIFACTS_DIR || ""),
  CHOREO_CHECKPOINTS_DIR: String(process.env.CHOREO_CHECKPOINTS_DIR || ""),
  CHOREO_RUNS_DIR: String(process.env.CHOREO_RUNS_DIR || ""),
  CHOREO_BIN: String(process.env.CHOREO_BIN || ""),
};

await fs.writeFile("runner_env.json", JSON.stringify(payload, null, 2) + "\n", "utf8");

result({
  version: 1,
  role: marker,
  status: "success",
  summary: `ok (${marker})`,
  filesChanged: ["runner_env.json"],
  commandsRun: [],
  commits: [],
  next: { addNodes: [], setStatus: [] },
  checkpoint: null,
  errors: [],
  confidence: 1,
});

