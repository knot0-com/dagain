import { spawn } from "node:child_process";

export function sqliteExec(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", ["-bail", dbPath], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err || `sqlite3 exited ${code}`));
      resolve();
    });
    child.stdin.end(String(sql || ""));
  });
}

export function sqliteJson(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", ["-json", dbPath, sql], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err || `sqlite3 exited ${code}`));
      resolve(out.trim() ? JSON.parse(out) : []);
    });
  });
}
