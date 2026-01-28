import fs from "node:fs/promises";

const marker = String(process.argv[2] || "").trim() || "noresult";

await fs.writeFile("runner_marker.txt", `${marker}\n`, "utf8");
await fs.appendFile("invocations.log", `${marker}\n`, "utf8");

process.stdout.write(`mock-agent-noresult marker=${marker}\n`);
