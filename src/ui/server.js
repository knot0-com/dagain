// Input — node:http/crypto/fs/path + dagain DB snapshot/control helpers. If this file changes, update this header and the folder Markdown.
// Output — `serveDashboard()` local HTTP dashboard server (HTML+SSE+control API). If this file changes, update this header and the folder Markdown.
// Position — Minimal web UI for live DAG viewing and safe controls. If this file changes, update this header and the folder Markdown.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";

import { loadDashboardSnapshot } from "../lib/dashboard.js";
import { kvGet } from "../lib/db/kv.js";
import { mailboxEnqueue } from "../lib/db/mailbox.js";
import { ensureMailboxTable } from "../lib/db/migrate.js";

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

function safeJsonParse(text, fallback = null) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function readJsonBody(req, { maxBytes = 64_000 } = {}) {
  const limitRaw = Number(maxBytes);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 64_000;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(new Error(`Request body too large (>${limit} bytes).`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const parsed = safeJsonParse(bodyText, null);
      if (!parsed || typeof parsed !== "object") {
        reject(new Error("Invalid JSON body."));
        return;
      }
      resolve(parsed);
    });
    req.on("error", reject);
  });
}

async function readTailText(filePath, maxBytes) {
  const nRaw = Number(maxBytes);
  const n = Number.isFinite(nRaw) && nRaw > 0 ? Math.floor(nRaw) : 10_000;
  try {
    const fh = await open(filePath, "r");
    try {
      const stat = await fh.stat();
      const size = Number(stat.size || 0);
      const start = Math.max(0, size - n);
      const len = Math.max(0, size - start);
      if (!len) return "";
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

function safeResolveUnderRoot(rootDir, relPath) {
  const root = path.resolve(String(rootDir || "."));
  const rel = String(relPath || "").trim();
  if (!rel) return null;
  if (path.isAbsolute(rel)) return null;
  const resolved = path.resolve(root, rel);
  if (resolved === root) return null;
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function homeHtml({ token }) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>dagain</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0b0e14;
        --panel: rgba(255,255,255,0.06);
        --panel2: rgba(255,255,255,0.09);
        --border: rgba(255,255,255,0.12);
        --muted: rgba(255,255,255,0.7);
        --text: rgba(255,255,255,0.92);
        --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
        --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        --green: #2ecc71;
        --red: #ff5c7c;
        --yellow: #f2c94c;
        --blue: #4ea1ff;
        --magenta: #c36bff;
      }

      @media (prefers-color-scheme: light) {
        :root {
          --bg: #fbfbfc;
          --panel: rgba(0,0,0,0.04);
          --panel2: rgba(0,0,0,0.06);
          --border: rgba(0,0,0,0.12);
          --muted: rgba(0,0,0,0.65);
          --text: rgba(0,0,0,0.9);
        }
      }

      * { box-sizing: border-box; }
      body { margin: 0; font-family: var(--sans); background: var(--bg); color: var(--text); }
      header { padding: 12px 14px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(10px); }
      .top { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: space-between; }
      .brand { display: flex; gap: 10px; align-items: center; }
      .brand h1 { margin: 0; font-size: 14px; letter-spacing: .02em; }
      .pills { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .pill { padding: 5px 10px; border: 1px solid var(--border); border-radius: 999px; font-size: 12px; background: var(--panel); }
      .pill code { font-family: var(--mono); font-size: 12px; }
      .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
      .btn {
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: var(--panel);
        color: var(--text);
        cursor: pointer;
      }
      .btn:hover { background: var(--panel2); }
      .btn:disabled { opacity: .5; cursor: not-allowed; }
      .btn.primary { border-color: color-mix(in srgb, var(--blue) 60%, var(--border)); }
      .btn.danger { border-color: color-mix(in srgb, var(--red) 60%, var(--border)); }
      .input {
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: var(--panel);
        color: var(--text);
        width: 88px;
      }
      main { display: grid; grid-template-columns: 1.35fr 1fr; gap: 12px; padding: 12px; }
      .card { border: 1px solid var(--border); border-radius: 14px; background: var(--panel); overflow: hidden; min-height: 120px; }
      .cardHeader { padding: 10px 12px; border-bottom: 1px solid var(--border); display: flex; gap: 10px; justify-content: space-between; align-items: center; }
      .cardHeader h2 { margin: 0; font-size: 12px; letter-spacing: .03em; text-transform: uppercase; color: var(--muted); }
      .cardBody { padding: 12px; }
      .mono { font-family: var(--mono); font-size: 12px; }
      .muted { color: var(--muted); }
      .status { display: inline-flex; align-items: center; gap: 6px; }
      .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--muted); }
      .dot.open { background: var(--yellow); }
      .dot.in_progress { background: var(--blue); }
      .dot.done { background: var(--green); }
      .dot.failed { background: var(--red); }
      .dot.needs_human { background: var(--magenta); }
      #graphWrap { height: 540px; overflow: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--panel2); }
      #graph { display: block; }
      .node { cursor: pointer; }
      .node rect { fill: color-mix(in srgb, var(--panel2) 80%, transparent); stroke: var(--border); stroke-width: 1; }
      .node:hover rect { stroke: color-mix(in srgb, var(--blue) 55%, var(--border)); }
      .node.selected rect { stroke: var(--blue); stroke-width: 2; }
      .node.st-open rect { stroke: color-mix(in srgb, var(--yellow) 60%, var(--border)); }
      .node.st-in_progress rect { stroke: color-mix(in srgb, var(--blue) 60%, var(--border)); }
      .node.st-done rect { stroke: color-mix(in srgb, var(--green) 60%, var(--border)); }
      .node.st-failed rect { stroke: color-mix(in srgb, var(--red) 60%, var(--border)); }
      .node.st-needs_human rect { stroke: color-mix(in srgb, var(--magenta) 60%, var(--border)); }
      .node text { font-family: var(--mono); font-size: 12px; fill: var(--text); dominant-baseline: middle; }
      .edge { stroke: color-mix(in srgb, var(--muted) 55%, transparent); stroke-width: 1.25; fill: none; }
      .edge.dep { stroke: color-mix(in srgb, var(--muted) 70%, transparent); }
      .edge.parent { stroke-dasharray: 4 4; opacity: .6; }
      .edge.active { stroke: var(--blue); }
      .log { height: 280px; overflow: auto; background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 12px; padding: 10px; white-space: pre-wrap; }
      @media (prefers-color-scheme: light) {
        .log { background: rgba(0,0,0,0.04); }
      }
      .toast { font-size: 12px; padding-top: 8px; min-height: 18px; color: var(--muted); }
    </style>
  </head>
  <body>
    <script>window.__DAGAIN = { token: ${JSON.stringify(String(token || ""))} };</script>
    <header>
      <div class="top">
        <div class="brand">
          <h1>dagain</h1>
          <div class="pills">
            <span class="pill">now: <code id="nowIso">…</code></span>
            <span class="pill">next: <code id="next">…</code></span>
            <span class="pill">supervisor: <code id="supervisor">…</code></span>
          </div>
        </div>
        <div class="controls">
          <button class="btn" id="pause">Pause</button>
          <button class="btn" id="resume">Resume</button>
          <button class="btn primary" id="replan">Replan</button>
          <input class="input" id="workers" placeholder="workers" inputmode="numeric" />
          <button class="btn" id="setWorkers">Set</button>
        </div>
      </div>
      <div class="toast" id="toast"></div>
    </header>

    <main>
      <section class="card">
        <div class="cardHeader">
          <h2>DAG</h2>
          <div class="muted mono" id="counts"></div>
        </div>
        <div class="cardBody">
          <div id="graphWrap">
            <svg id="graph" role="img" aria-label="dag graph"></svg>
          </div>
        </div>
      </section>
      <aside class="card">
        <div class="cardHeader">
          <h2>Selection</h2>
          <button class="btn danger" id="cancel" disabled>Cancel node</button>
        </div>
        <div class="cardBody">
          <div class="mono">
            <div><span class="muted">id:</span> <span id="selId">—</span></div>
            <div><span class="muted">type:</span> <span id="selType">—</span></div>
            <div><span class="muted">status:</span> <span class="status"><span class="dot" id="selDot"></span><span id="selStatus">—</span></span></div>
            <div><span class="muted">attempts:</span> <span id="selAttempts">—</span></div>
            <div><span class="muted">runner:</span> <span id="selRunner">—</span></div>
            <div><span class="muted">deps:</span> <span id="selDeps">—</span></div>
            <div><span class="muted">parent:</span> <span id="selParent">—</span></div>
            <div><span class="muted">log:</span> <span id="selLogPath">—</span></div>
          </div>
          <div style="height:10px"></div>
          <div class="log mono" id="log">(select a node)</div>
        </div>
      </aside>
    </main>
    <script>
      const token = (window.__DAGAIN && window.__DAGAIN.token) ? window.__DAGAIN.token : "";

      const elNow = document.getElementById("nowIso");
      const elNext = document.getElementById("next");
      const elCounts = document.getElementById("counts");
      const elSupervisor = document.getElementById("supervisor");
      const elToast = document.getElementById("toast");
      const elGraph = document.getElementById("graph");
      const elLog = document.getElementById("log");

      const elSelId = document.getElementById("selId");
      const elSelType = document.getElementById("selType");
      const elSelStatus = document.getElementById("selStatus");
      const elSelDot = document.getElementById("selDot");
      const elSelAttempts = document.getElementById("selAttempts");
      const elSelRunner = document.getElementById("selRunner");
      const elSelDeps = document.getElementById("selDeps");
      const elSelParent = document.getElementById("selParent");
      const elSelLogPath = document.getElementById("selLogPath");

      const btnPause = document.getElementById("pause");
      const btnResume = document.getElementById("resume");
      const btnReplan = document.getElementById("replan");
      const inpWorkers = document.getElementById("workers");
      const btnSetWorkers = document.getElementById("setWorkers");
      const btnCancel = document.getElementById("cancel");

      function fmtSupervisor(s) {
        if (!s || !s.pid) return "(none)";
        return "pid=" + s.pid + (s.host ? " host=" + s.host : "");
      }

      function fmtNext(n) {
        if (!n || !n.id) return "(none)";
        return n.id + " [" + (n.type || "?") + "] (" + (n.status || "?") + ")";
      }

      function toast(msg) {
        elToast.textContent = msg || "";
      }

      async function postJson(url, body) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-dagain-token": token },
          body: JSON.stringify(body || {}),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.error) ? data.error : ("HTTP " + res.status));
        return data;
      }

      async function fetchLog(nodeId) {
        const id = nodeId || "";
        if (!id) return { path: "", text: "" };
        const res = await fetch("/api/node/log?id=" + encodeURIComponent(id) + "&tail=10000");
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.error) ? data.error : ("HTTP " + res.status));
        return data;
      }

      function layerDag(nodes) {
        const byId = new Map();
        for (const n of nodes) if (n && n.id) byId.set(n.id, n);

        const indeg = new Map();
        const out = new Map();
        for (const id of byId.keys()) {
          indeg.set(id, 0);
          out.set(id, []);
        }
        for (const n of nodes) {
          const to = n && n.id ? n.id : "";
          if (!to) continue;
          const deps = Array.isArray(n.dependsOn) ? n.dependsOn : [];
          for (const from of deps) {
            if (!byId.has(from)) continue;
            out.get(from).push(to);
            indeg.set(to, (indeg.get(to) || 0) + 1);
          }
        }

        const q = [];
        for (const [id, d] of indeg.entries()) if (d === 0) q.push(id);
        q.sort();
        const order = [];
        while (q.length) {
          const id = q.shift();
          order.push(id);
          for (const nxt of out.get(id) || []) {
            indeg.set(nxt, (indeg.get(nxt) || 0) - 1);
            if (indeg.get(nxt) === 0) q.push(nxt);
          }
          q.sort();
        }

        const layer = new Map();
        for (const id of byId.keys()) layer.set(id, 0);
        for (const id of order) {
          const n = byId.get(id);
          const deps = Array.isArray(n.dependsOn) ? n.dependsOn : [];
          let best = 0;
          for (const dep of deps) best = Math.max(best, (layer.get(dep) || 0) + 1);
          layer.set(id, best);
        }
        return { byId, layer };
      }

      function statusKey(n) {
        const s = (n && n.status) ? String(n.status) : "";
        return s.toLowerCase();
      }

      function statusDotClass(n) {
        const s = statusKey(n);
        if (s === "in_progress") return "in_progress";
        if (s === "done") return "done";
        if (s === "failed") return "failed";
        if (s === "needs_human") return "needs_human";
        return "open";
      }

      function nodeLabel(n) {
        const id = (n && n.id) ? String(n.id) : "";
        const type = (n && n.type) ? String(n.type) : "";
        const status = statusKey(n) || "open";
        return id + (type ? (" [" + type + "]") : "") + " (" + status + ")";
      }

      function buildGraph(snapshot, selectedId) {
        const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
        const { layer } = layerDag(nodes);
        const maxLayer = Math.max(0, ...Array.from(layer.values()));
        const layers = Array.from({ length: maxLayer + 1 }, () => []);
        for (const n of nodes) {
          if (!n || !n.id) continue;
          layers[layer.get(n.id) || 0].push(n);
        }
        for (const col of layers) col.sort((a, b) => String(a.id).localeCompare(String(b.id)));

        const nodeW = 220;
        const nodeH = 44;
        const colGap = 70;
        const rowGap = 18;
        const pad = 20;

        const pos = new Map();
        const colHeights = [];
        for (let c = 0; c < layers.length; c++) {
          const col = layers[c];
          colHeights[c] = pad + col.length * (nodeH + rowGap) - rowGap + pad;
        }
        const h = Math.max(320, ...colHeights);
        const w = pad + layers.length * (nodeW + colGap) - colGap + pad;
        for (let c = 0; c < layers.length; c++) {
          const col = layers[c];
          for (let r = 0; r < col.length; r++) {
            const n = col[r];
            const x = pad + c * (nodeW + colGap);
            const y = pad + r * (nodeH + rowGap);
            pos.set(n.id, { x, y, w: nodeW, h: nodeH });
          }
        }

        const edges = [];
        for (const n of nodes) {
          if (!n || !n.id) continue;
          const deps = Array.isArray(n.dependsOn) ? n.dependsOn : [];
          for (const from of deps) {
            if (!pos.has(from) || !pos.has(n.id)) continue;
            edges.push({ from, to: n.id, kind: "dep" });
          }
          if (n.parentId && pos.has(n.parentId)) edges.push({ from: n.parentId, to: n.id, kind: "parent" });
        }
        return { nodes, pos, edges, w, h, selectedId };
      }

      function renderGraph(graph) {
        elGraph.setAttribute("width", String(graph.w));
        elGraph.setAttribute("height", String(graph.h));
        elGraph.setAttribute("viewBox", "0 0 " + graph.w + " " + graph.h);
        elGraph.setAttribute("preserveAspectRatio", "xMinYMin meet");
        elGraph.innerHTML = "";

        const ns = "http://www.w3.org/2000/svg";
        const defs = document.createElementNS(ns, "defs");
        const marker = document.createElementNS(ns, "marker");
        marker.setAttribute("id", "arrow");
        marker.setAttribute("markerWidth", "10");
        marker.setAttribute("markerHeight", "10");
        marker.setAttribute("refX", "9");
        marker.setAttribute("refY", "5");
        marker.setAttribute("orient", "auto");
        const arrow = document.createElementNS(ns, "path");
        arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
        arrow.setAttribute("fill", "currentColor");
        marker.appendChild(arrow);
        defs.appendChild(marker);
        elGraph.appendChild(defs);

        for (const e of graph.edges) {
          const a = graph.pos.get(e.from);
          const b = graph.pos.get(e.to);
          if (!a || !b) continue;
          const x1 = a.x + a.w;
          const y1 = a.y + a.h / 2;
          const x2 = b.x;
          const y2 = b.y + b.h / 2;
          const midX = (x1 + x2) / 2;
          const p = document.createElementNS(ns, "path");
          p.setAttribute(
            "class",
            "edge " + e.kind + ((graph.selectedId && (e.from === graph.selectedId || e.to === graph.selectedId)) ? " active" : ""),
          );
          p.setAttribute("d", "M " + x1 + " " + y1 + " C " + midX + " " + y1 + ", " + midX + " " + y2 + ", " + x2 + " " + y2);
          if (e.kind === "dep") p.setAttribute("marker-end", "url(#arrow)");
          elGraph.appendChild(p);
        }

        for (const n of graph.nodes) {
          const p = graph.pos.get(n.id);
          if (!p) continue;
          const g = document.createElementNS(ns, "g");
          const st = statusDotClass(n);
          g.setAttribute("class", "node st-" + st + (graph.selectedId === n.id ? " selected" : ""));
          g.dataset.nodeId = n.id;

          const r = document.createElementNS(ns, "rect");
          r.setAttribute("x", p.x);
          r.setAttribute("y", p.y);
          r.setAttribute("rx", "10");
          r.setAttribute("ry", "10");
          r.setAttribute("width", p.w);
          r.setAttribute("height", p.h);
          g.appendChild(r);

          const t = document.createElementNS(ns, "text");
          t.setAttribute("x", p.x + 12);
          t.setAttribute("y", p.y + p.h / 2);
          t.textContent = nodeLabel(n);
          g.appendChild(t);

          g.addEventListener("click", () => {
            selectNode(n.id);
          });
          elGraph.appendChild(g);
        }
      }

      let lastSnapshot = null;
      let selectedNodeId = "";
      let logPollTimer = null;

      async function updateSelection() {
        const snap = lastSnapshot;
        if (!snap) return;
        const nodes = Array.isArray(snap.nodes) ? snap.nodes : [];
        const node = selectedNodeId ? nodes.find((n) => n && n.id === selectedNodeId) : null;
        if (!node) {
          elSelId.textContent = "—";
          elSelType.textContent = "—";
          elSelStatus.textContent = "—";
          elSelDot.className = "dot";
          elSelAttempts.textContent = "—";
          elSelRunner.textContent = "—";
          elSelDeps.textContent = "—";
          elSelParent.textContent = "—";
          elSelLogPath.textContent = "—";
          elLog.textContent = "(select a node)";
          btnCancel.disabled = true;
          return;
        }
        elSelId.textContent = node.id || "";
        elSelType.textContent = node.type || "";
        elSelStatus.textContent = node.status || "open";
        elSelDot.className = "dot " + statusDotClass(node);
        elSelAttempts.textContent = String(node.attempts ?? 0);
        elSelRunner.textContent = node.runner || "";
        elSelDeps.textContent = (Array.isArray(node.dependsOn) && node.dependsOn.length) ? node.dependsOn.join(", ") : "(none)";
        elSelParent.textContent = node.parentId || "(none)";
        btnCancel.disabled = !(node.lock && node.lock.runId);

        try {
          const logData = await fetchLog(node.id);
          elSelLogPath.textContent = logData.path || "(none)";
          elLog.textContent = logData.text || "(empty)";
          elLog.scrollTop = elLog.scrollHeight;
        } catch (e) {
          elSelLogPath.textContent = "(error)";
          elLog.textContent = String((e && e.message) ? e.message : e);
        }
      }

      function selectNode(id) {
        selectedNodeId = id || "";
        if (lastSnapshot) render(lastSnapshot);
      }

      function render(snapshot) {
        lastSnapshot = snapshot;
        elNow.textContent = snapshot.nowIso || "";
        elNext.textContent = fmtNext(snapshot.next);
        elSupervisor.textContent = fmtSupervisor(snapshot.supervisor);
        const counts = snapshot.counts || {};
        elCounts.textContent = Object.keys(counts).sort().map((k) => k + "=" + counts[k]).join("  ");

        const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
        if (!selectedNodeId) {
          selectedNodeId = (snapshot.next && snapshot.next.id) ? snapshot.next.id : ((nodes[0] && nodes[0].id) ? nodes[0].id : "");
        }
        const graph = buildGraph(snapshot, selectedNodeId);
        renderGraph(graph);
        updateSelection();
      }

      btnPause.onclick = async () => {
        try {
          const res = await postJson("/api/control/pause", {});
          toast(res.message || "Enqueued pause.");
        } catch (e) {
          toast("pause failed: " + String((e && e.message) ? e.message : e));
        }
      };
      btnResume.onclick = async () => {
        try {
          const res = await postJson("/api/control/resume", {});
          toast(res.message || "Enqueued resume.");
        } catch (e) {
          toast("resume failed: " + String((e && e.message) ? e.message : e));
        }
      };
      btnReplan.onclick = async () => {
        try {
          const res = await postJson("/api/control/replan", {});
          toast(res.message || "Enqueued replan.");
        } catch (e) {
          toast("replan failed: " + String((e && e.message) ? e.message : e));
        }
      };
      btnSetWorkers.onclick = async () => {
        const n = Number(inpWorkers.value);
        if (!Number.isFinite(n) || n <= 0) return toast("workers must be a positive number");
        try {
          const res = await postJson("/api/control/set-workers", { workers: Math.floor(n) });
          toast(res.message || "Enqueued set-workers.");
        } catch (e) {
          toast("set-workers failed: " + String((e && e.message) ? e.message : e));
        }
      };
      btnCancel.onclick = async () => {
        const id = selectedNodeId;
        if (!id) return;
        if (!confirm("Cancel running node " + id + "?")) return;
        try {
          const res = await postJson("/api/control/cancel", { nodeId: id });
          toast(res.message || ("Enqueued cancel " + id + "."));
        } catch (e) {
          toast("cancel failed: " + String((e && e.message) ? e.message : e));
        }
      };

      function startLogPolling() {
        if (logPollTimer) clearInterval(logPollTimer);
        logPollTimer = setInterval(() => {
          const snap = lastSnapshot;
          const nodes = snap && Array.isArray(snap.nodes) ? snap.nodes : [];
          const node = selectedNodeId ? nodes.find((n) => n && n.id === selectedNodeId) : null;
          if (node && node.lock && node.lock.runId) updateSelection();
        }, 1200);
      }
      startLogPolling();

      const es = new EventSource("/events");
      es.onmessage = (ev) => {
        try { render(JSON.parse(ev.data)); } catch {}
      };
      es.onerror = () => {
        // browser will reconnect
      };
    </script>
  </body>
</html>`;
}

export async function serveDashboard({ paths, host = "127.0.0.1", port = 3876 }) {
  const token = randomBytes(18).toString("hex");
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

  async function requireToken(req) {
    const got = String(req.headers["x-dagain-token"] || "").trim();
    if (!got || got !== token) throw new Error("Unauthorized");
  }

  async function enqueueControl({ command, args }) {
    await ensureMailboxTable({ dbPath: paths.dbPath });
    const res = await mailboxEnqueue({ dbPath: paths.dbPath, command, args: args ?? {}, nowIso: new Date().toISOString() });
    return res.id;
  }

  function respondError(res, error) {
    const message = error?.message || String(error);
    const code = error?.code || "";
    if (message === "Unauthorized") return json(res, 401, { error: "Unauthorized" });
    if (message.startsWith("Request body too large")) return json(res, 413, { error: message });
    if (message === "Invalid JSON body.") return json(res, 400, { error: message });
    if (code === "ENOENT") return json(res, 404, { error: message });
    return json(res, 500, { error: message });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/") {
        const html = homeHtml({ token });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const snapshot = await getSnapshot();
        json(res, 200, snapshot);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/node/log") {
        const nodeId = String(url.searchParams.get("id") || "").trim();
        if (!nodeId) return json(res, 400, { error: "Missing ?id=<nodeId>." });
        const tail = Number(url.searchParams.get("tail") || 10_000);

        const snapshot = await getSnapshot();
        const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
        const node = nodes.find((n) => n?.id === nodeId) || null;
        if (!node) return json(res, 404, { error: `Node not found: ${nodeId}` });

        const lockRunId = typeof node?.lock?.runId === "string" ? node.lock.runId : "";
        let stdoutRel = "";
        if (lockRunId) {
          stdoutRel = path.relative(paths.rootDir, path.join(paths.runsDir, lockRunId, "stdout.log"));
        } else {
          const stdoutRow = await kvGet({ dbPath: paths.dbPath, nodeId, key: "out.last_stdout_path" }).catch(() => null);
          stdoutRel = typeof stdoutRow?.value_text === "string" ? stdoutRow.value_text.trim() : "";
        }

        const stdoutAbs = stdoutRel ? safeResolveUnderRoot(paths.rootDir, stdoutRel) : null;
        const text = stdoutAbs ? await readTailText(stdoutAbs, tail) : "";
        json(res, 200, { nodeId, path: stdoutRel || "", text });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/control/pause") {
        await requireToken(req);
        const id = await enqueueControl({ command: "pause", args: {} });
        json(res, 200, { ok: true, id, message: `Enqueued pause (id=${id}).` });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/control/resume") {
        await requireToken(req);
        const id = await enqueueControl({ command: "resume", args: {} });
        json(res, 200, { ok: true, id, message: `Enqueued resume (id=${id}).` });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/control/replan") {
        await requireToken(req);
        const id = await enqueueControl({ command: "replan_now", args: {} });
        json(res, 200, { ok: true, id, message: `Enqueued replan (id=${id}).` });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/control/set-workers") {
        await requireToken(req);
        const body = await readJsonBody(req);
        const n = Number(body?.workers);
        const workers = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
        if (workers == null) return json(res, 400, { error: "Invalid workers; expected {workers:number>0}." });
        const id = await enqueueControl({ command: "set_workers", args: { workers } });
        json(res, 200, { ok: true, id, message: `Enqueued set-workers=${workers} (id=${id}).` });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/control/cancel") {
        await requireToken(req);
        const body = await readJsonBody(req);
        const nodeId = typeof body?.nodeId === "string" ? body.nodeId.trim() : "";
        if (!nodeId) return json(res, 400, { error: "Missing nodeId." });
        const id = await enqueueControl({ command: "cancel", args: { nodeId } });
        json(res, 200, { ok: true, id, message: `Enqueued cancel node=${nodeId} (id=${id}).` });
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
      respondError(res, error);
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
