import fs from "node:fs/promises";

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

const marker = String(process.argv[2] || "").trim() || "fail";

await fs.writeFile("runner_marker.txt", `${marker}\n`, "utf8");
await fs.appendFile("invocations.log", `${marker}\n`, "utf8");

result({
  version: 1,
  role: "executor",
  status: "fail",
  summary: `fail marker=${marker}`,
  next: { addNodes: [], setStatus: [] },
  checkpoint: null,
  errors: [`fail marker=${marker}`],
  confidence: 0,
});
