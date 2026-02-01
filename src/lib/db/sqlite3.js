import { spawn } from "node:child_process";

function readAll(stream) {
  return new Promise((resolve) => {
    let out = "";
    stream.setEncoding("utf8");
    stream.on("data", (d) => (out += d));
    stream.on("end", () => resolve(out));
    stream.on("error", () => resolve(out));
  });
}

export async function sqliteExec(dbPath, sql) {
  const args = ["-bail", "-cmd", ".timeout 5000", dbPath];
  const child = spawn("sqlite3", args, { stdio: ["pipe", "pipe", "pipe"] });
  const stdoutP = readAll(child.stdout);
  const stderrP = readAll(child.stderr);
  child.stdin.end(String(sql || ""));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 0));
  });
  if (code !== 0) {
    const stderr = await stderrP;
    const stdout = await stdoutP;
    throw new Error(stderr.trim() || stdout.trim() || `sqlite3 exited ${code}`);
  }
}

export async function sqliteQueryJson(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", ["-bail", "-cmd", ".timeout 5000", "-json", dbPath, String(sql || "")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `sqlite3 exited ${code}`));
      resolve(out.trim() ? JSON.parse(out) : []);
    });
  });
}
