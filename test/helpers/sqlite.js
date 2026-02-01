// Input — `sqlite3` CLI via child_process spawn. If this file changes, update this header and the folder Markdown.
// Output — `sqliteExec()` and `sqliteJson()` helpers for tests. If this file changes, update this header and the folder Markdown.
// Position — Test-only SQLite wrapper with busy-timeout to avoid flake locks. If this file changes, update this header and the folder Markdown.

import { spawn } from "node:child_process";

const SQLITE_TIMEOUT_MS = 5000;

export function sqliteExec(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", ["-bail", "-cmd", `.timeout ${SQLITE_TIMEOUT_MS}`, dbPath], { stdio: ["pipe", "pipe", "pipe"] });
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
    const child = spawn("sqlite3", ["-json", "-cmd", `.timeout ${SQLITE_TIMEOUT_MS}`, dbPath, sql], { stdio: ["ignore", "pipe", "pipe"] });
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
