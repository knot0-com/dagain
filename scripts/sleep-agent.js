function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const msRaw = process.argv[2] || "600000";
const ms = Math.max(0, Number(msRaw) || 0);

process.stderr.write(`[sleep-agent] pid=${process.pid} sleeping ${ms}ms\n`);
await sleep(ms);
