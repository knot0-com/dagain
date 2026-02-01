import fs from "node:fs/promises";

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

const packetPath = String(process.argv[2] || "").trim();
const packet = packetPath ? await fs.readFile(packetPath, "utf8") : "";

const m = packet.match(/\n- rolling_summary:\s*(.+)\s*$/im);
const prior = m ? String(m[1] || "").trim() : "";

if (!prior) {
  result({
    status: "success",
    summary: "first turn",
    data: { reply: "no-rollup", ops: [], rollup: "S1" },
  });
} else {
  result({
    status: "success",
    summary: "second turn",
    data: { reply: prior === "S1" ? "rollup-seen" : "rollup-seen-other", ops: [], rollup: "S2" },
  });
}

