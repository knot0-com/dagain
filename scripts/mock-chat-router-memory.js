import fs from "node:fs/promises";

function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

const packetPath = String(process.argv[2] || "").trim();
const packet = packetPath ? await fs.readFile(packetPath, "utf8") : "";
const hasMemory = /\nChat memory \(kv __run__\):/i.test(packet);

result({
  status: "success",
  summary: "mock chat router memory",
  data: {
    reply: hasMemory ? "memory-seen" : "no-memory",
    ops: [],
  },
});

