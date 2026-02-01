import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(jsonPath) {
  const text = await readFile(jsonPath, "utf8");
  return JSON.parse(text);
}

export async function writeJsonAtomic(jsonPath, value) {
  const dir = path.dirname(jsonPath);
  const tmpPath = path.join(dir, `.${path.basename(jsonPath)}.${Date.now()}.tmp`);
  const text = JSON.stringify(value, null, 2) + "\n";
  await ensureDir(dir);
  await writeFile(tmpPath, text, "utf8");
  await rename(tmpPath, jsonPath);
}

export async function appendLine(filePath, line) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await writeFile(filePath, line.endsWith("\n") ? line : line + "\n", {
    encoding: "utf8",
    flag: "a",
  });
}

