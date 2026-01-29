// Input — node:http and `loadDashboardSnapshot()`. If this file changes, update this header and the folder Markdown.
// Output — `serveDashboard()` local HTTP dashboard server. If this file changes, update this header and the folder Markdown.
// Position — Minimal web UI (HTML + JSON + SSE) for live DAG viewing. If this file changes, update this header and the folder Markdown.

import http from "node:http";

import { loadDashboardSnapshot } from "../lib/dashboard.js";

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2) + "\n";
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
}

function homeHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>dagain</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 16px; }
      header { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; }
      .pill { padding: 4px 8px; border: 1px solid rgba(127,127,127,.4); border-radius: 999px; font-size: 12px; }
      table { border-collapse: collapse; width: 100%; margin-top: 12px; }
      th, td { border-bottom: 1px solid rgba(127,127,127,.2); padding: 6px 8px; text-align: left; font-size: 13px; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      .muted { opacity: .75; }
    </style>
  </head>
  <body>
    <header>
      <h1 style="margin:0;font-size:18px;">dagain</h1>
      <span class="pill">now: <code id="nowIso">…</code></span>
      <span class="pill">next: <code id="next">…</code></span>
      <span class="pill">supervisor: <code id="supervisor">…</code></span>
    </header>
    <div id="counts" class="muted" style="margin-top:8px;"></div>
    <table>
      <thead>
        <tr>
          <th>id</th>
          <th>type</th>
          <th>status</th>
          <th>attempts</th>
          <th>runner</th>
          <th>title</th>
        </tr>
      </thead>
      <tbody id="nodes"></tbody>
    </table>
    <script>
      const elNow = document.getElementById("nowIso");
      const elNext = document.getElementById("next");
      const elCounts = document.getElementById("counts");
      const elSupervisor = document.getElementById("supervisor");
      const elNodes = document.getElementById("nodes");

      function fmtSupervisor(s) {
        if (!s || !s.pid) return "(none)";
        return "pid=" + s.pid + (s.host ? " host=" + s.host : "");
      }

      function fmtNext(n) {
        if (!n || !n.id) return "(none)";
        return n.id + " [" + (n.type || "?") + "] (" + (n.status || "?") + ")";
      }

      function render(snapshot) {
        elNow.textContent = snapshot.nowIso || "";
        elNext.textContent = fmtNext(snapshot.next);
        elSupervisor.textContent = fmtSupervisor(snapshot.supervisor);
        const counts = snapshot.counts || {};
        elCounts.textContent = Object.keys(counts).sort().map(k => k + "=" + counts[k]).join("  ");

        const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
        elNodes.textContent = "";
        for (const n of nodes) {
          const tr = document.createElement("tr");
          tr.innerHTML =
            "<td><code>" + (n.id || "") + "</code></td>" +
            "<td>" + (n.type || "") + "</td>" +
            "<td>" + (n.status || "") + "</td>" +
            "<td>" + (n.attempts ?? 0) + "</td>" +
            "<td>" + (n.runner || "") + "</td>" +
            "<td class='muted'>" + (n.title || "") + "</td>";
          elNodes.appendChild(tr);
        }
      }

      const es = new EventSource("/events");
      es.onmessage = (ev) => {
        try { render(JSON.parse(ev.data)); } catch {}
      };
      es.onerror = () => {
        // keep trying; browser will reconnect
      };
    </script>
  </body>
</html>`;
}

export async function serveDashboard({ paths, host = "127.0.0.1", port = 3876 }) {
  let lastSnapshot = null;
  let lastSnapshotAt = 0;
  const snapshotTtlMs = 200;

  async function getSnapshot() {
    const now = Date.now();
    if (lastSnapshot && now - lastSnapshotAt < snapshotTtlMs) return lastSnapshot;
    lastSnapshot = await loadDashboardSnapshot({ paths });
    lastSnapshotAt = now;
    return lastSnapshot;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/") {
        const html = homeHtml();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const snapshot = await getSnapshot();
        json(res, 200, snapshot);
        return;
      }
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        res.write("\n");

        let closed = false;
        req.on("close", () => {
          closed = true;
        });

        while (!closed) {
          const snapshot = await getSnapshot();
          res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
          await new Promise((r) => setTimeout(r, 500));
        }
        return;
      }

      notFound(res);
    } catch (error) {
      json(res, 500, { error: error?.message || String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
