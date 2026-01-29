// Input — node:http/crypto/fs/path + dagain DB snapshot/control helpers. If this file changes, update this header and the folder Markdown.
// Output — `serveDashboard()` local HTTP dashboard server (HTML+SSE+control/log API). If this file changes, update this header and the folder Markdown.
// Position — Minimal web UI for live DAG viewing (animated layout) and safe controls. If this file changes, update this header and the folder Markdown.

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
        color-scheme: dark;

        /* Knot0 theme (knot0-www/app/globals.css) */
        --black: #0a0a0a;
        --blackLight: #141414;
        --blackBorder: #1f1f1f;
        --amber: #ffb000;
        --amberDim: #b37a00;
        --cyan: #4ecdc4;
        --cyanDim: #2a9d8f;
        --white: #e8e8e8;
        --whiteDim: #a8a8a8;
        --whiteMuted: #555555;
        --green: #39ff14;
        --red: #ff4444;
        --purple: #a855f7;

        --bg: var(--black);
        --panel: var(--blackLight);
        --panel2: rgba(255, 255, 255, 0.03);
        --border: var(--blackBorder);
        --muted: var(--whiteDim);
        --muted2: var(--whiteMuted);
        --text: var(--white);
        --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        --sans: var(--mono);
      }

      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body { margin: 0; font-family: var(--mono); background: var(--bg); color: var(--text); }

      /* subtle grain + scanlines (CSS-only) */
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
        opacity: 0.03;
        pointer-events: none;
        z-index: 0;
      }
      body::after {
        content: "";
        position: fixed;
        inset: 0;
        background: repeating-linear-gradient(
          0deg,
          transparent,
          transparent 2px,
          rgba(0, 0, 0, 0.18) 2px,
          rgba(0, 0, 0, 0.18) 4px
        );
        opacity: 0.02;
        pointer-events: none;
        z-index: 0;
      }
      header, main { position: relative; z-index: 1; }

      header { padding: 12px 14px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: rgba(10, 10, 10, 0.95); backdrop-filter: blur(10px); }
      .top { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: space-between; }
      .brand { display: flex; gap: 10px; align-items: center; }
      .brand h1 { margin: 0; font-size: 14px; letter-spacing: .02em; color: var(--amber); }
      .pills { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .pill { padding: 5px 10px; border: 1px solid var(--border); border-radius: 999px; font-size: 12px; background: var(--panel); color: var(--muted); }
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
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
      }
      .btn:hover { background: rgba(255, 255, 255, 0.04); border-color: rgba(78, 205, 196, 0.35); }
      .btn:disabled { opacity: .5; cursor: not-allowed; }
      .btn.primary { border-color: rgba(255, 176, 0, 0.55); color: var(--amber); }
      .btn.primary:hover { background: rgba(255, 176, 0, 0.08); border-color: rgba(255, 176, 0, 0.75); }
      .btn.danger { border-color: rgba(255, 68, 68, 0.55); color: var(--red); }
      .btn.danger:hover { background: rgba(255, 68, 68, 0.08); border-color: rgba(255, 68, 68, 0.75); }
      .input {
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: var(--panel);
        color: var(--text);
        width: 88px;
      }
      .input:focus { outline: none; border-color: rgba(255, 176, 0, 0.55); }
      main { display: grid; grid-template-columns: 1.35fr 1fr; gap: 12px; padding: 12px; }
      .card { border: 1px solid var(--border); border-radius: 14px; background: var(--panel); overflow: hidden; min-height: 120px; }
      .cardHeader { padding: 10px 12px; border-bottom: 1px solid var(--border); display: flex; gap: 10px; justify-content: space-between; align-items: center; }
      .cardHeader h2 { margin: 0; font-size: 12px; letter-spacing: .03em; text-transform: uppercase; color: var(--muted2); }
      .cardBody { padding: 12px; }
      .mono { font-family: var(--mono); font-size: 12px; }
      .muted { color: var(--muted); }
      .status { display: inline-flex; align-items: center; gap: 6px; }
      .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--muted); }
      .dot.open { background: var(--whiteMuted); }
      .dot.in_progress { background: var(--amber); }
      .dot.done { background: var(--green); }
      .dot.failed { background: var(--red); }
      .dot.needs_human { background: var(--purple); }

      #graphWrap {
        height: 540px;
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--bg);
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.18) transparent;
      }
      #graphWrap::-webkit-scrollbar { width: 8px; height: 8px; }
      #graphWrap::-webkit-scrollbar-track { background: transparent; }
      #graphWrap::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 999px; }
      #graphWrap::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.28); }
      #graph { display: block; }
      .node { cursor: pointer; }
      .node { transition: filter 160ms ease; }
      .node rect { fill: var(--blackLight); stroke: rgba(255,255,255,0.14); stroke-width: 1; }
      .node:hover rect { stroke: rgba(78, 205, 196, 0.55); }
      .node.selected rect { stroke: var(--cyan); stroke-width: 2; }
      .node.next rect { stroke: rgba(78, 205, 196, 0.85); }

      .node.st-open rect { stroke: rgba(255,255,255,0.16); }
      .node.st-in_progress rect { stroke: rgba(255,176,0,0.85); stroke-width: 2; fill: rgba(255,176,0,0.08); }
      .node.st-done rect { stroke: rgba(57,255,20,0.6); fill: rgba(57,255,20,0.05); }
      .node.st-failed rect { stroke: rgba(255,68,68,0.75); fill: rgba(255,68,68,0.08); }
      .node.st-needs_human rect { stroke: rgba(168,85,247,0.75); fill: rgba(168,85,247,0.08); }

      @keyframes glowAmber {
        0%, 100% { filter: drop-shadow(0 0 6px rgba(255, 176, 0, 0.18)); }
        50% { filter: drop-shadow(0 0 16px rgba(255, 176, 0, 0.33)); }
      }
      @keyframes glowPurple {
        0%, 100% { filter: drop-shadow(0 0 6px rgba(168, 85, 247, 0.18)); }
        50% { filter: drop-shadow(0 0 16px rgba(168, 85, 247, 0.33)); }
      }
      .node.st-in_progress { animation: glowAmber 1.4s ease-in-out infinite; }
      .node.st-needs_human { animation: glowPurple 1.6s ease-in-out infinite; }

      .node text { font-family: var(--mono); fill: var(--text); }
      .nodeDot { fill: var(--whiteMuted); }
      .node.st-open .nodeDot { fill: var(--whiteMuted); }
      .node.st-in_progress .nodeDot { fill: var(--amber); }
      .node.st-done .nodeDot { fill: var(--green); }
      .node.st-failed .nodeDot { fill: var(--red); }
      .node.st-needs_human .nodeDot { fill: var(--purple); }
      .nodeId { font-size: 12px; dominant-baseline: middle; }
      .nodeSub { font-size: 11px; dominant-baseline: middle; fill: var(--muted); }

      .edge { stroke: var(--blackBorder); stroke-width: 1.25; fill: none; opacity: 0.85; transition: stroke 160ms ease, stroke-width 160ms ease, opacity 160ms ease; }
      .edge.dep { stroke: var(--blackBorder); }
      .edge.parent { stroke-dasharray: 6 6; opacity: 0.5; }
      .edge.active { stroke: var(--cyan); stroke-width: 2; opacity: 1; }
      .edge.next { stroke: rgba(255,176,0,0.75); opacity: 0.95; }

      .log { height: 280px; overflow: auto; background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 12px; padding: 10px; white-space: pre-wrap; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
      .log::-webkit-scrollbar { width: 8px; height: 8px; }
      .log::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 999px; }
      .log::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.28); }
      .toast { font-size: 12px; padding-top: 8px; min-height: 18px; color: var(--muted); }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
      }
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
      const elGraphWrap = document.getElementById("graphWrap");
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

      const ns = "http://www.w3.org/2000/svg";
      let svgReady = false;
      let edgesLayer = null;
      let nodesLayer = null;
      const nodeElById = new Map();
      const edgeElByKey = new Map();
      let lastGraph = null;
      let lastAutoScrollId = "";

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
          const deps = new Set(Array.isArray(n.dependsOn) ? n.dependsOn : []);
          if (n && n.parentId) deps.add(n.parentId);
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
          const deps = new Set(Array.isArray(n.dependsOn) ? n.dependsOn : []);
          if (n && n.parentId) deps.add(n.parentId);
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

      function truncateText(value, maxLen) {
        const s = String(value || "");
        const n = Number(maxLen);
        const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
        if (!limit) return "";
        if (s.length <= limit) return s;
        return s.slice(0, Math.max(0, limit - 1)) + "…";
      }

      function nodeLines(n) {
        const id = (n && n.id) ? String(n.id) : "";
        const type = (n && n.type) ? String(n.type) : "";
        const title = (n && n.title) ? String(n.title) : "";
        const top = type ? (id + " [" + type + "]") : id;
        const bottom = title ? title : "(" + (statusKey(n) || "open") + ")";
        return { top: truncateText(top, 30), bottom: truncateText(bottom, 36) };
      }

      function buildAdjacency({ nodes, byId }) {
        const preds = new Map();
        const succs = new Map();
        for (const n of nodes) {
          if (!n || !n.id) continue;
          preds.set(n.id, []);
          succs.set(n.id, []);
        }
        for (const n of nodes) {
          const to = n && n.id ? n.id : "";
          if (!to || !preds.has(to)) continue;
          const deps = new Set(Array.isArray(n.dependsOn) ? n.dependsOn : []);
          if (n && n.parentId) deps.add(n.parentId);
          for (const from of deps) {
            if (!byId.has(from) || !succs.has(from)) continue;
            preds.get(to).push(from);
            succs.get(from).push(to);
          }
        }
        return { preds, succs };
      }

      function orderLayers({ layers, adjacency, layerById }) {
        const rowById = new Map();
        for (let i = 0; i < layers.length; i++) {
          const col = layers[i];
          for (let r = 0; r < col.length; r++) rowById.set(col[r].id, r);
        }

        function scoreFor(id, neighborIds, currentLayer) {
          const neigh = Array.isArray(neighborIds) ? neighborIds : [];
          let sum = 0;
          let wsum = 0;
          for (const nb of neigh) {
            const nbLayer = layerById.get(nb);
            if (typeof nbLayer !== "number") continue;
            const nbRow = rowById.get(nb);
            if (typeof nbRow !== "number") continue;
            const dist = Math.abs(currentLayer - nbLayer);
            const w = 1 / Math.max(1, dist);
            sum += nbRow * w;
            wsum += w;
          }
          if (wsum) return sum / wsum;
          return rowById.get(id) || 0;
        }

        function reorderLayer(layerIndex, dir) {
          const col = layers[layerIndex];
          if (!Array.isArray(col) || col.length <= 1) return;
          const scored = col.map((n) => {
            const neighbors = dir === "down" ? adjacency.preds.get(n.id) : adjacency.succs.get(n.id);
            return { n, s: scoreFor(n.id, neighbors, layerIndex), t: String(n.id || "") };
          });
          scored.sort((a, b) => (a.s - b.s) || a.t.localeCompare(b.t));
          layers[layerIndex] = scored.map((x) => x.n);
          for (let r = 0; r < layers[layerIndex].length; r++) rowById.set(layers[layerIndex][r].id, r);
        }

        const iters = 4;
        for (let k = 0; k < iters; k++) {
          for (let i = 1; i < layers.length; i++) reorderLayer(i, "down");
          for (let i = layers.length - 2; i >= 0; i--) reorderLayer(i, "up");
        }
      }

      function assignEdgeSlots(edges) {
        const outgoing = new Map();
        const incoming = new Map();
        for (const e of edges) {
          if (!e || !e.from || !e.to) continue;
          const out = outgoing.get(e.from) || [];
          out.push(e);
          outgoing.set(e.from, out);
          const inc = incoming.get(e.to) || [];
          inc.push(e);
          incoming.set(e.to, inc);
        }
        for (const list of outgoing.values()) {
          list.sort((a, b) => String(a.kind || "").localeCompare(String(b.kind || "")) || String(a.to).localeCompare(String(b.to)));
          const n = list.length;
          for (let i = 0; i < n; i++) {
            list[i].fromSlot = i;
            list[i].fromSlots = n;
          }
        }
        for (const list of incoming.values()) {
          list.sort(
            (a, b) => String(a.kind || "").localeCompare(String(b.kind || "")) || String(a.from).localeCompare(String(b.from)),
          );
          const n = list.length;
          for (let i = 0; i < n; i++) {
            list[i].toSlot = i;
            list[i].toSlots = n;
          }
        }
        for (const e of edges) {
          if (typeof e.fromSlots !== "number") {
            e.fromSlot = 0;
            e.fromSlots = 1;
          }
          if (typeof e.toSlots !== "number") {
            e.toSlot = 0;
            e.toSlots = 1;
          }
        }
      }

      function buildGraph(snapshot, selectedId) {
        const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
        const nextId = snapshot && snapshot.next && snapshot.next.id ? snapshot.next.id : "";
        const { byId, layer } = layerDag(nodes);
        const maxLayer = Math.max(0, ...Array.from(layer.values()));
        const layers = Array.from({ length: maxLayer + 1 }, () => []);
        for (const n of nodes) {
          if (!n || !n.id) continue;
          layers[layer.get(n.id) || 0].push(n);
        }
        for (const col of layers) col.sort((a, b) => String(a.id).localeCompare(String(b.id)));

        const layerById = new Map();
        for (let c = 0; c < layers.length; c++) for (const n of layers[c]) layerById.set(n.id, c);
        const adjacency = buildAdjacency({ nodes, byId });
        orderLayers({ layers, adjacency, layerById });

        const nodeW = 240;
        const nodeH = 54;
        const colGap = 90;
        const rowGap = 22;
        const pad = 24;

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
          if (n.parentId && pos.has(n.parentId) && !deps.includes(n.parentId))
            edges.push({ from: n.parentId, to: n.id, kind: "parent" });
        }

        assignEdgeSlots(edges);
        return { nodes, byId, pos, edges, w, h, selectedId, nextId };
      }

      function ensureSvg() {
        if (svgReady) return;
        svgReady = true;

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
        arrow.setAttribute("fill", "context-stroke");
        marker.appendChild(arrow);
        defs.appendChild(marker);
        elGraph.appendChild(defs);

        edgesLayer = document.createElementNS(ns, "g");
        edgesLayer.setAttribute("data-layer", "edges");
        nodesLayer = document.createElementNS(ns, "g");
        nodesLayer.setAttribute("data-layer", "nodes");
        elGraph.appendChild(edgesLayer);
        elGraph.appendChild(nodesLayer);
      }

      function animateEdgeDraw(pathEl) {
        if (!pathEl) return;
        const reduceMotion =
          typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduceMotion) return;
        try {
          const len = pathEl.getTotalLength();
          pathEl.style.strokeDasharray = String(len);
          pathEl.style.strokeDashoffset = String(len);
          if (typeof pathEl.animate === "function") {
            pathEl.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 420, easing: "ease-out", fill: "forwards" });
          } else {
            requestAnimationFrame(() => {
              pathEl.style.strokeDashoffset = "0";
            });
          }
        } catch {
          // ignore
        }
      }

      function scrollNodeIntoView(nodeId, behavior = "smooth") {
        if (!elGraphWrap || !lastGraph || !nodeId) return;
        const p = lastGraph.pos.get(nodeId);
        if (!p) return;
        const pad = 36;
        const left = Math.max(0, p.x - pad);
        const top = Math.max(0, p.y - pad);
        try {
          elGraphWrap.scrollTo({ left, top, behavior });
        } catch {
          elGraphWrap.scrollLeft = left;
          elGraphWrap.scrollTop = top;
        }
      }

      function renderGraph(graph) {
        ensureSvg();
        elGraph.setAttribute("width", String(graph.w));
        elGraph.setAttribute("height", String(graph.h));
        elGraph.setAttribute("viewBox", "0 0 " + graph.w + " " + graph.h);
        elGraph.setAttribute("preserveAspectRatio", "xMinYMin meet");
        if (!edgesLayer || !nodesLayer) return;

        const seenEdges = new Set();
        for (const e of graph.edges) {
          const key = String(e.kind) + ":" + String(e.from) + "->" + String(e.to);
          seenEdges.add(key);
          let pathEl = edgeElByKey.get(key);
          const isNew = !pathEl;
          if (!pathEl) {
            pathEl = document.createElementNS(ns, "path");
            edgeElByKey.set(key, pathEl);
            edgesLayer.appendChild(pathEl);
            if (e.kind === "dep") pathEl.setAttribute("marker-end", "url(#arrow)");
          }

          const a = graph.pos.get(e.from);
          const b = graph.pos.get(e.to);
          if (!a || !b) {
            pathEl.setAttribute("d", "");
            continue;
          }

          const fromSlot = Number.isFinite(Number(e.fromSlot)) ? Number(e.fromSlot) : 0;
          const fromSlots = Number.isFinite(Number(e.fromSlots)) ? Math.max(1, Number(e.fromSlots)) : 1;
          const toSlot = Number.isFinite(Number(e.toSlot)) ? Number(e.toSlot) : 0;
          const toSlots = Number.isFinite(Number(e.toSlots)) ? Math.max(1, Number(e.toSlots)) : 1;

          const x1 = a.x + a.w;
          const y1 = a.y + ((fromSlot + 1) / (fromSlots + 1)) * a.h;
          const x2 = b.x;
          const y2 = b.y + ((toSlot + 1) / (toSlots + 1)) * b.h;
          const midX = (x1 + x2) / 2;
          pathEl.setAttribute("d", "M " + x1 + " " + y1 + " C " + midX + " " + y1 + ", " + midX + " " + y2 + ", " + x2 + " " + y2);

          const cls =
            "edge " +
            e.kind +
            ((graph.selectedId && (e.from === graph.selectedId || e.to === graph.selectedId)) ? " active" : "") +
            ((graph.nextId && e.to === graph.nextId) ? " next" : "");
          pathEl.setAttribute("class", cls);

          if (isNew && e.kind === "dep") animateEdgeDraw(pathEl);
        }
        for (const [key, el] of edgeElByKey.entries()) {
          if (seenEdges.has(key)) continue;
          try {
            el.remove();
          } catch {
            // ignore
          }
          edgeElByKey.delete(key);
        }

        const seenNodes = new Set();
        for (const n of graph.nodes) {
          if (!n || !n.id) continue;
          const p = graph.pos.get(n.id);
          if (!p) continue;
          const id = n.id;
          seenNodes.add(id);
          let view = nodeElById.get(id);
          if (!view) {
            const g = document.createElementNS(ns, "g");
            g.dataset.nodeId = id;
            g.addEventListener("click", () => selectNode(id));

            const r = document.createElementNS(ns, "rect");
            r.setAttribute("x", "0");
            r.setAttribute("y", "0");
            r.setAttribute("rx", "10");
            r.setAttribute("ry", "10");
            r.setAttribute("width", String(p.w));
            r.setAttribute("height", String(p.h));

            const dot = document.createElementNS(ns, "circle");
            dot.setAttribute("cx", "12");
            dot.setAttribute("cy", "16");
            dot.setAttribute("r", "4");
            dot.setAttribute("class", "nodeDot");

            const t1 = document.createElementNS(ns, "text");
            t1.setAttribute("x", "22");
            t1.setAttribute("y", "18");
            t1.setAttribute("class", "nodeId");
            t1.setAttribute("font-weight", "600");

            const t2 = document.createElementNS(ns, "text");
            t2.setAttribute("x", "12");
            t2.setAttribute("y", "38");
            t2.setAttribute("class", "nodeSub");

            g.appendChild(r);
            g.appendChild(dot);
            g.appendChild(t1);
            g.appendChild(t2);
            nodesLayer.appendChild(g);
            view = { g, r, dot, t1, t2 };
            nodeElById.set(id, view);
          }

          const st = statusDotClass(n);
          view.g.setAttribute(
            "class",
            "node st-" + st + (graph.selectedId === id ? " selected" : "") + (graph.nextId === id ? " next" : ""),
          );
          view.g.setAttribute("transform", "translate(" + p.x + " " + p.y + ")");

          const lines = nodeLines(n);
          view.t1.textContent = lines.top;
          view.t2.textContent = lines.bottom;
        }
        for (const [id, view] of nodeElById.entries()) {
          if (seenNodes.has(id)) continue;
          try {
            view.g.remove();
          } catch {
            // ignore
          }
          nodeElById.delete(id);
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
        if (selectedNodeId) {
          lastAutoScrollId = selectedNodeId;
          scrollNodeIntoView(selectedNodeId, "smooth");
        }
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
        lastGraph = graph;
        renderGraph(graph);
        updateSelection();

        if (selectedNodeId && selectedNodeId !== lastAutoScrollId) {
          lastAutoScrollId = selectedNodeId;
          scrollNodeIntoView(selectedNodeId, "auto");
        }
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
