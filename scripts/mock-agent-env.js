import fs from "node:fs/promises";

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

const marker = String(process.argv[2] || "").trim() || "env";
const payload = {
  marker,
  DAGAIN_DB: String(process.env.DAGAIN_DB || ""),
  DAGAIN_NODE_ID: String(process.env.DAGAIN_NODE_ID || ""),
  DAGAIN_RUN_ID: String(process.env.DAGAIN_RUN_ID || ""),
  DAGAIN_PARENT_NODE_ID: String(process.env.DAGAIN_PARENT_NODE_ID || ""),
  DAGAIN_ARTIFACTS_DIR: String(process.env.DAGAIN_ARTIFACTS_DIR || ""),
  DAGAIN_CHECKPOINTS_DIR: String(process.env.DAGAIN_CHECKPOINTS_DIR || ""),
  DAGAIN_RUNS_DIR: String(process.env.DAGAIN_RUNS_DIR || ""),
  DAGAIN_BIN: String(process.env.DAGAIN_BIN || ""),
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
