import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function sha256File(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

