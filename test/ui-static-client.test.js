// Input — filesystem read of `src/ui/static/client.js`. If this file changes, update this header and the folder Markdown.
// Output — regression assertions for web UI client wiring. If this file changes, update this header and the folder Markdown.
// Position — guards against breaking the Cytoscape render path during SSE updates. If this file changes, update this header and the folder Markdown.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("ui static client: SSE onmessage calls render()", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const clientPath = path.join(repoRoot, "src", "ui", "static", "client.js");
  const text = await readFile(clientPath, "utf8");

  assert.ok(text.includes('const es = new EventSource("/events");'), "expected EventSource(/events) in client.js");

  const start = text.indexOf("es.onmessage");
  assert.ok(start >= 0, "expected es.onmessage in client.js");
  const end = text.indexOf("es.onerror", start);
  assert.ok(end > start, "expected es.onerror after es.onmessage");
  const handler = text.slice(start, end);

  assert.ok(handler.includes("render("), `expected SSE handler to call render(...), got:\n${handler}`);
  assert.equal(handler.includes("renderIncremental("), false, `expected SSE handler not to call renderIncremental(...), got:\n${handler}`);
});
