// Input — DOM elements from index.html, SSE events from /events, REST APIs from server.js
// Output — live DAG visualization, chat interface, controls, runs panel
// Position — client-side runtime for the dagain web dashboard

const token = (window.__DAGAIN && window.__DAGAIN.token) ? window.__DAGAIN.token : "";

const elNow = document.getElementById("nowIso");
const elNext = document.getElementById("next");
const elCounts = document.getElementById("counts");
const elSupervisor = document.getElementById("supervisor");
const elToastContainer = document.getElementById("toastContainer");
const elConfirmBackdrop = document.getElementById("confirmBackdrop");
const elConfirmMessage = document.getElementById("confirmMessage");
const elConfirmCancel = document.getElementById("confirmCancel");
const elConfirmOk = document.getElementById("confirmOk");
const elGraphWrap = document.getElementById("graphWrap");
const elGraph = document.getElementById("graph");
const elLog = document.getElementById("log");
const elZoomPct = document.getElementById("zoomPct");
const elChatStatus = document.getElementById("chatStatus");
const elChatLog = document.getElementById("chatLog");
const elNewMsgPill = document.getElementById("newMsgPill");
const inpChat = document.getElementById("chatInput");
const btnChatSend = document.getElementById("chatSend");

const elSelId = document.getElementById("selId");
const elSelType = document.getElementById("selType");
const elSelStatus = document.getElementById("selStatus");
const elSelDot = document.getElementById("selDot");
const elSelAttempts = document.getElementById("selAttempts");
const elSelRunner = document.getElementById("selRunner");
const elSelDeps = document.getElementById("selDeps");
const elSelParent = document.getElementById("selParent");
const elSelLogPath = document.getElementById("selLogPath");

const elStatusStrip = document.getElementById("statusStrip");
const elTimingInfo = document.getElementById("timingInfo");
const elInfoToggle = document.getElementById("infoToggle");
const elInfoBody = document.getElementById("infoBody");
const elLogToggle = document.getElementById("logToggle");
const elLogBody = document.getElementById("logBody");
const elLogSearch = document.getElementById("logSearch");
const elLogSearchClear = document.getElementById("logSearchClear");
const btnRetry = document.getElementById("retry");

const btnPause = document.getElementById("pause");
const btnResume = document.getElementById("resume");
const btnReplan = document.getElementById("replan");
const inpWorkers = document.getElementById("workers");
const btnSetWorkers = document.getElementById("setWorkers");
const btnCancel = document.getElementById("cancel");
const btnFit = document.getElementById("fit");
const btnZoomOut = document.getElementById("zoomOut");
const btnZoomIn = document.getElementById("zoomIn");
const btnToggleRuns = document.getElementById("toggleRuns");
const btnToggleChat = document.getElementById("toggleChat");
const btnToggleSelection = document.getElementById("toggleSelection");

const elRunsPanel = document.getElementById("runsPanel");
const btnMobileGraph = document.getElementById("mobileGraph");
const btnMobileChat = document.getElementById("mobileChat");
const btnMobileDetails = document.getElementById("mobileDetails");
const elRunsList = document.getElementById("runsList");
const elRunMeta = document.getElementById("runMeta");
const elRunLog = document.getElementById("runLog");
const btnDeleteRun = document.getElementById("deleteRun");
const btnStartRun = document.getElementById("startRun");
const btnClearChat = document.getElementById("clearChat");
const elNodeTooltip = document.getElementById("nodeTooltip");
const elConnDot = document.getElementById("connDot");
const elNodeSearch = document.getElementById("nodeSearch");
const elFilterChips = document.getElementById("filterChips");
const elMinimap = document.getElementById("minimap");
const elZoomSlider = document.getElementById("zoomSlider");
const elZoomPill = document.getElementById("zoomPill");
const btnHideDone = document.getElementById("hideDone");

const btnToggleConfig = document.getElementById("toggleConfig");
const elConfigBackdrop = document.getElementById("configBackdrop");
const btnConfigSave = document.getElementById("configSave");
const btnConfigClose = document.getElementById("configClose");
const elConfigRoles = document.getElementById("configRoles");
const elConfigSupervisor = document.getElementById("configSupervisor");
const elConfigRunners = document.getElementById("configRunners");
const elConfigDefaults = document.getElementById("configDefaults");

let currentConfig = null;

const ns = "http://www.w3.org/2000/svg";
let svgReady = false;
let edgesLayer = null;
let nodesLayer = null;
let viewportLayer = null;
const nodeElById = new Map();
const edgeElByKey = new Map();
let lastGraph = null;
let lastAutoScrollId = "";
let fitView = null;
let viewBox = null;
let userMovedView = false;
let keyboardFocusId = "";
let nodeSearchQuery = "";
let activeStatusFilters = new Set();
let hideDoneActive = false;

function fmtSupervisor(s) {
  if (!s || !s.pid) return "(none)";
  return "pid=" + s.pid + (s.host ? " host=" + s.host : "");
}

function fmtNext(n) {
  if (!n || !n.id) return "(none)";
  return n.id + " [" + (n.type || "?") + "] (" + (n.status || "?") + ")";
}

function toast(msg, type) {
  if (!elToastContainer) return;
  const kind = type || "info";
  const el = document.createElement("div");
  el.className = "toastItem " + kind;
  el.textContent = msg || "";
  const bar = document.createElement("div");
  bar.className = "toastProgress";
  el.appendChild(bar);
  elToastContainer.appendChild(el);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add("show"));
  });
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { try { el.remove(); } catch {} }, 220);
  }, 3000);
}

function showConfirm(message) {
  return new Promise((resolve) => {
    if (!elConfirmBackdrop || !elConfirmMessage) { resolve(confirm(message)); return; }
    elConfirmMessage.textContent = message;
    elConfirmBackdrop.classList.add("visible");
    function cleanup(result) {
      elConfirmBackdrop.classList.remove("visible");
      if (elConfirmOk) elConfirmOk.onclick = null;
      if (elConfirmCancel) elConfirmCancel.onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onKey(ev) {
      if (ev.key === "Escape") cleanup(false);
    }
    document.addEventListener("keydown", onKey);
    if (elConfirmOk) elConfirmOk.onclick = () => cleanup(true);
    if (elConfirmCancel) elConfirmCancel.onclick = () => cleanup(false);
    elConfirmBackdrop.onclick = (ev) => { if (ev.target === elConfirmBackdrop) cleanup(false); };
  });
}

async function withLoading(btn, asyncFn) {
  if (!btn) return asyncFn();
  btn.classList.add("loading");
  btn.disabled = true;
  try {
    return await asyncFn();
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
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

async function fetchChatHistory() {
  const res = await fetch("/api/chat/history", { headers: { "x-dagain-token": token } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) ? data.error : ("HTTP " + res.status));
  return data;
}

/* ── Markdown renderer (basic) ─────────────────────────────────────── */

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMarkdown(text) {
  const lines = String(text || "").split("\n");
  let html = "";
  let inCodeBlock = false;
  let codeLines = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("```")) {
      if (inCodeBlock) {
        html += "<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>";
        codeLines = [];
        inCodeBlock = false;
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) { codeLines.push(line); continue; }

    // List items
    if (/^[-*]\s/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + inlineMarkdown(line.replace(/^[-*]\s/, "")) + "</li>";
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }

    // Empty lines
    if (!line.trim()) { html += "<br>"; continue; }

    // Regular text
    html += inlineMarkdown(line) + "\n";
  }
  if (inCodeBlock) html += "<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>";
  if (inList) html += "</ul>";
  return html;
}

function inlineMarkdown(text) {
  let s = escapeHtml(text);
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Inline code
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

/* ── Relative timestamps ──────────────────────────────────────────────── */

function relativeTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return String(isoStr);
  const diff = Date.now() - d.getTime();
  if (diff < 10000) return "just now";
  if (diff < 60000) return Math.floor(diff / 1000) + "s ago";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  return Math.floor(diff / 86400000) + "d ago";
}

/* ── Smart scroll ─────────────────────────────────────────────────────── */

let chatScrollPinned = true;
let lastChatFingerprint = "";

function isChatAtBottom() {
  if (!elChatLog) return true;
  return elChatLog.scrollHeight - elChatLog.scrollTop - elChatLog.clientHeight < 40;
}

function showNewMsgPill(show) {
  if (!elNewMsgPill) return;
  elNewMsgPill.classList.toggle("visible", show);
}

if (elChatLog) {
  elChatLog.addEventListener("scroll", () => {
    chatScrollPinned = isChatAtBottom();
    if (chatScrollPinned) showNewMsgPill(false);
  });
}
if (elNewMsgPill) {
  elNewMsgPill.addEventListener("click", () => {
    if (elChatLog) { elChatLog.scrollTop = elChatLog.scrollHeight; }
    chatScrollPinned = true;
    showNewMsgPill(false);
  });
}

/* ── Typing indicator ─────────────────────────────────────────────────── */

function showTypingIndicator() {
  if (!elChatLog) return;
  let existing = elChatLog.querySelector(".typingIndicator");
  if (existing) return;
  const el = document.createElement("div");
  el.className = "typingIndicator";
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "typingDot";
    el.appendChild(dot);
  }
  elChatLog.appendChild(el);
  if (chatScrollPinned) elChatLog.scrollTop = elChatLog.scrollHeight;
}

function hideTypingIndicator() {
  if (!elChatLog) return;
  const existing = elChatLog.querySelector(".typingIndicator");
  if (existing) existing.remove();
}

/* ── Streaming effect ─────────────────────────────────────────────────── */

function streamText(textEl, fullText, onDone) {
  const reduceMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !fullText) {
    textEl.innerHTML = renderMarkdown(fullText);
    if (onDone) onDone();
    return;
  }
  let idx = 0;
  const charsPerFrame = 30;
  const cursor = document.createElement("span");
  cursor.className = "streamCursor";

  function tick() {
    idx = Math.min(idx + charsPerFrame, fullText.length);
    textEl.innerHTML = renderMarkdown(fullText.slice(0, idx));
    if (idx < fullText.length) {
      textEl.appendChild(cursor);
      requestAnimationFrame(tick);
    } else {
      if (onDone) onDone();
    }
    if (chatScrollPinned && elChatLog) elChatLog.scrollTop = elChatLog.scrollHeight;
  }
  requestAnimationFrame(tick);
}

function renderChatTurns(turns, { streaming = false } = {}) {
  if (!elChatLog) return;
  hideTypingIndicator();
  elChatLog.innerHTML = "";

  const list = Array.isArray(turns) ? turns : [];
  if (!list.length) {
    elChatLog.innerHTML = "";
    const emptyChat = document.createElement("div");
    emptyChat.className = "emptyState";
    emptyChat.innerHTML = '<div class="emptyIcon">\u2709</div><div class="emptyText">Ask about your DAG run</div><div class="emptyHint">Try: &quot;What\'s the current status?&quot;</div>';
    elChatLog.appendChild(emptyChat);
    return;
  }

  for (let ti = 0; ti < list.length; ti++) {
    const t = list[ti];
    const at = t && t.at ? String(t.at) : "";
    const userText = t && t.user ? String(t.user) : "";
    const replyText = t && t.reply ? String(t.reply) : "";
    const ops = Array.isArray(t && t.ops) ? t.ops.map((x) => String(x)) : [];
    const isLast = ti === list.length - 1;

    if (userText) {
      const user = document.createElement("div");
      user.className = "chatMsg user";
      const meta = document.createElement("div");
      meta.className = "chatMeta";
      meta.dataset.at = at;
      meta.textContent = "you" + (at ? " \u2022 " + relativeTime(at) : "");
      const text = document.createElement("div");
      text.className = "chatText";
      text.textContent = userText;
      user.appendChild(meta);
      user.appendChild(text);
      elChatLog.appendChild(user);
    }

    const assistant = document.createElement("div");
    assistant.className = "chatMsg assistant";
    const meta = document.createElement("div");
    meta.className = "chatMeta";
    meta.dataset.at = at;
    meta.textContent = "assistant" + (at ? " \u2022 " + relativeTime(at) : "");
    const text = document.createElement("div");
    text.className = "chatText";

    if (isLast && streaming && replyText) {
      assistant.appendChild(meta);
      assistant.appendChild(text);
      if (ops.length) {
        const opsEl = document.createElement("div");
        opsEl.className = "chatMeta";
        opsEl.textContent = "ops: " + ops.join(", ");
        assistant.appendChild(opsEl);
      }
      elChatLog.appendChild(assistant);
      streamText(text, replyText);
    } else {
      text.innerHTML = replyText ? renderMarkdown(replyText) : "(no reply)";
      assistant.appendChild(meta);
      assistant.appendChild(text);
      if (ops.length) {
        const opsEl = document.createElement("div");
        opsEl.className = "chatMeta";
        opsEl.textContent = "ops: " + ops.join(", ");
        assistant.appendChild(opsEl);
      }
      elChatLog.appendChild(assistant);
    }
  }

  if (chatScrollPinned) {
    elChatLog.scrollTop = elChatLog.scrollHeight;
  } else {
    showNewMsgPill(true);
  }
}

async function refreshChat() {
  try {
    const data = await fetchChatHistory();
    const turns = Array.isArray(data && data.turns) ? data.turns : [];
    const rollup = typeof data?.rollup === "string" ? data.rollup.trim() : "";
    // Skip re-render if content hasn't changed (prevents blinking)
    const fp = JSON.stringify(turns) + "||" + rollup;
    if (fp === lastChatFingerprint) return;
    lastChatFingerprint = fp;
    renderChatTurns(turns);
    if (elChatStatus) {
      elChatStatus.textContent = rollup ? truncateText(rollup, 120) : "";
    }
  } catch (e) {
    if (elChatLog) elChatLog.textContent = String((e && e.message) ? e.message : e);
  }
}

async function sendChat() {
  if (!inpChat || !btnChatSend) return;
  const msg = String(inpChat.value || "").trim();
  if (!msg) return;
  inpChat.value = "";
  showTypingIndicator();
  chatScrollPinned = true;
  await withLoading(btnChatSend, async () => {
    try {
      const res = await postJson("/api/chat/send", { message: msg });
      hideTypingIndicator();
      const turns = res?.chat && Array.isArray(res.chat.turns) ? res.chat.turns : [];
      if (turns.length) renderChatTurns(turns, { streaming: true });
      else await refreshChat();
    } catch (e) {
      hideTypingIndicator();
      toast("chat failed: " + String((e && e.message) ? e.message : e), "error");
    }
  });
  inpChat.focus();
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
  return s.slice(0, Math.max(0, limit - 1)) + "\u2026";
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

  viewportLayer = document.createElementNS(ns, "g");
  viewportLayer.setAttribute("data-layer", "viewport");
  elGraph.appendChild(viewportLayer);

  edgesLayer = document.createElementNS(ns, "g");
  edgesLayer.setAttribute("data-layer", "edges");
  nodesLayer = document.createElementNS(ns, "g");
  nodesLayer.setAttribute("data-layer", "nodes");
  viewportLayer.appendChild(edgesLayer);
  viewportLayer.appendChild(nodesLayer);
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

function viewBoxString(vb) {
  if (!vb) return "0 0 1 1";
  return [vb.x, vb.y, vb.w, vb.h].map((n) => String(Number(n))).join(" ");
}

function updateZoomPct() {
  if (!elZoomPct) return;
  if (!fitView || !viewBox) return (elZoomPct.textContent = "\u2014");
  const z = fitView.w > 0 && viewBox.w > 0 ? fitView.w / viewBox.w : 1;
  const pct = Math.round(z * 100);
  elZoomPct.textContent = String(pct) + "%";
  if (elZoomSlider) elZoomSlider.value = String(Math.max(25, Math.min(400, pct)));
}

function clampViewBox(vb) {
  if (!vb) return vb;
  if (!fitView) return vb;
  const minW = fitView.w / 6;
  const maxW = fitView.w * 6;
  const minH = fitView.h / 6;
  const maxH = fitView.h * 6;

  const cx = vb.x + vb.w / 2;
  const cy = vb.y + vb.h / 2;
  const w = Math.max(minW, Math.min(maxW, vb.w));
  const h = Math.max(minH, Math.min(maxH, vb.h));
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function setViewBox(next, { animate = false } = {}) {
  if (!next) return;
  const vb = clampViewBox(next);
  if (!elGraph) return;

  const prev = viewBox ? { ...viewBox } : null;
  viewBox = vb;

  if (!animate || !prev) {
    elGraph.setAttribute("viewBox", viewBoxString(vb));
    updateZoomPct();
    return;
  }

  const to = { ...vb };
  const from = prev;

  const reduceMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    elGraph.setAttribute("viewBox", viewBoxString(vb));
    updateZoomPct();
    return;
  }

  const t0 = performance.now();
  const dur = 180;
  function ease(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }
  function tick(now) {
    const raw = (now - t0) / dur;
    const t = Math.max(0, Math.min(1, raw));
    const e = ease(t);
    const cur = {
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e,
      w: from.w + (to.w - from.w) * e,
      h: from.h + (to.h - from.h) * e,
    };
    elGraph.setAttribute("viewBox", viewBoxString(cur));
    if (t < 1) requestAnimationFrame(tick);
    else updateZoomPct();
  }
  requestAnimationFrame(tick);
}

function computeFitView(graph) {
  if (!graph || !elGraphWrap) return { x: 0, y: 0, w: 1, h: 1 };
  const rect = elGraphWrap.getBoundingClientRect();
  const cw = Math.max(1, rect.width || 1);
  const ch = Math.max(1, rect.height || 1);
  const pad = 48;
  const worldW = Math.max(1, Number(graph.w) || 1);
  const worldH = Math.max(1, Number(graph.h) || 1);
  const baseW = worldW + pad * 2;
  const baseH = worldH + pad * 2;
  const aspectWorld = baseW / baseH;
  const aspectCont = cw / ch;
  let vw = baseW;
  let vh = baseH;
  if (Number.isFinite(aspectCont) && aspectCont > 0) {
    if (aspectWorld > aspectCont) vh = vw / aspectCont;
    else vw = vh * aspectCont;
  }
  const cx = worldW / 2;
  const cy = worldH / 2;
  return { x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh };
}

function fitToGraph({ animate = true } = {}) {
  if (!lastGraph) return;
  fitView = computeFitView(lastGraph);
  setViewBox(fitView, { animate });
}

function zoomAtClientPoint({ clientX, clientY, factor }) {
  if (!viewBox || !elGraph) return;
  const rect = elGraph.getBoundingClientRect();
  const px = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  const py = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  const pxc = Math.max(0, Math.min(1, px));
  const pyc = Math.max(0, Math.min(1, py));
  const wx = viewBox.x + pxc * viewBox.w;
  const wy = viewBox.y + pyc * viewBox.h;
  const nextW = viewBox.w * factor;
  const nextH = viewBox.h * factor;
  const next = {
    x: wx - pxc * nextW,
    y: wy - pyc * nextH,
    w: nextW,
    h: nextH,
  };
  userMovedView = true;
  setViewBox(next, { animate: false });
}

function zoomAtCenter(factor) {
  const rect = elGraph.getBoundingClientRect();
  zoomAtClientPoint({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, factor });
}

function centerNodeIfOffscreen(nodeId) {
  if (!nodeId || !lastGraph || !viewBox) return;
  const p = lastGraph.pos.get(nodeId);
  if (!p) return;
  const pad = 40;
  const inView =
    p.x >= viewBox.x + pad &&
    p.y >= viewBox.y + pad &&
    p.x + p.w <= viewBox.x + viewBox.w - pad &&
    p.y + p.h <= viewBox.y + viewBox.h - pad;
  if (inView) return;
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  const next = { x: cx - viewBox.w / 2, y: cy - viewBox.h / 2, w: viewBox.w, h: viewBox.h };
  setViewBox(next, { animate: true });
}

function renderGraph(graph) {
  ensureSvg();
  elGraph.setAttribute("preserveAspectRatio", "xMidYMid meet");
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

    const targetNode = graph.byId.get(e.to);
    const targetInProgress = targetNode && statusKey(targetNode) === "in_progress";
    const cls =
      "edge " +
      e.kind +
      ((graph.selectedId && (e.from === graph.selectedId || e.to === graph.selectedId)) ? " active" : "") +
      ((graph.nextId && e.to === graph.nextId) ? " next" : "") +
      (targetInProgress ? " flowing" : "");
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

      g.addEventListener("mouseenter", (ev) => showNodeTooltip(id, ev));
      g.addEventListener("mousemove", (ev) => moveNodeTooltip(ev));
      g.addEventListener("mouseleave", () => hideNodeTooltip());

      view = { g, r, dot, t1, t2 };
      nodeElById.set(id, view);
    }

    const st = statusDotClass(n);
    view.g.setAttribute(
      "class",
      "node st-" + st +
      (graph.selectedId === id ? " selected" : "") +
      (graph.nextId === id ? " next" : "") +
      (keyboardFocusId === id ? " keyboard-focus" : ""),
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
let runs = [];
let selectedRunId = "";
let needsHumanNotified = new Set();

function readViewPrefs() {
  try {
    const raw = localStorage.getItem("dagain.ui.view");
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeViewPrefs(next) {
  try {
    localStorage.setItem("dagain.ui.view", JSON.stringify(next));
  } catch {
    // ignore
  }
}

function applyViewPrefs(prefs) {
  const chatVisible = prefs && Object.prototype.hasOwnProperty.call(prefs, "chat") ? Boolean(prefs.chat) : true;
  const selectionVisible =
    prefs && Object.prototype.hasOwnProperty.call(prefs, "selection") ? Boolean(prefs.selection) : true;
  const runsVisible = prefs && Object.prototype.hasOwnProperty.call(prefs, "runs") ? Boolean(prefs.runs) : true;
  document.body.classList.toggle("hideChat", !chatVisible);
  document.body.classList.toggle("hideSelection", !selectionVisible);
  document.body.classList.toggle("hideRuns", !runsVisible);
  if (btnToggleChat) {
    btnToggleChat.classList.toggle("panel-active", chatVisible);
  }
  if (btnToggleSelection) {
    btnToggleSelection.classList.toggle("panel-active", selectionVisible);
  }
  if (btnToggleRuns) {
    btnToggleRuns.classList.toggle("panel-active", runsVisible);
  }
}

function animatedPanelCollapse(card, bodyClass, thenApply) {
  if (!card) { thenApply(); return; }
  card.classList.add("panel-collapsing");
  setTimeout(() => {
    thenApply();
    card.classList.remove("panel-collapsing");
  }, 180);
}

function animatedPanelExpand(card, thenApply) {
  if (!card) { thenApply(); return; }
  thenApply();
  card.classList.add("panel-collapsing");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      card.classList.remove("panel-collapsing");
    });
  });
}

function currentViewState() {
  return {
    chat: !document.body.classList.contains("hideChat"),
    selection: !document.body.classList.contains("hideSelection"),
    runs: !document.body.classList.contains("hideRuns"),
  };
}

function toggleChatPane() {
  const chatHidden = document.body.classList.contains("hideChat");
  const next = { ...currentViewState(), chat: chatHidden };
  const chatCard = document.getElementById("chatCard");
  if (chatHidden) {
    animatedPanelExpand(chatCard, () => { applyViewPrefs(next); writeViewPrefs(next); });
  } else {
    animatedPanelCollapse(chatCard, "hideChat", () => { applyViewPrefs(next); writeViewPrefs(next); });
  }
}

function toggleSelectionPane() {
  const selectionHidden = document.body.classList.contains("hideSelection");
  const next = { ...currentViewState(), selection: selectionHidden };
  const selCard = document.getElementById("selectionCard");
  if (selectionHidden) {
    animatedPanelExpand(selCard, () => { applyViewPrefs(next); writeViewPrefs(next); });
  } else {
    animatedPanelCollapse(selCard, "hideSelection", () => { applyViewPrefs(next); writeViewPrefs(next); });
  }
}

function toggleRunsPane() {
  const hidden = document.body.classList.contains("hideRuns");
  const next = { ...currentViewState(), runs: hidden };
  applyViewPrefs(next);
  writeViewPrefs(next);
  if (hidden) refreshRuns();
}

/* ── Mobile tabs ──────────────────────────────────────────────────────── */

function setMobileTab(tab) {
  document.body.classList.remove("mobileTab-chat", "mobileTab-selection");
  if (tab === "chat") document.body.classList.add("mobileTab-chat");
  else if (tab === "selection") document.body.classList.add("mobileTab-selection");
  if (btnMobileGraph) btnMobileGraph.classList.toggle("panel-active", !tab || tab === "graph");
  if (btnMobileChat) btnMobileChat.classList.toggle("panel-active", tab === "chat");
  if (btnMobileDetails) btnMobileDetails.classList.toggle("panel-active", tab === "selection");
}

if (btnMobileGraph) btnMobileGraph.onclick = () => setMobileTab("graph");
if (btnMobileChat) btnMobileChat.onclick = () => setMobileTab("chat");
if (btnMobileDetails) btnMobileDetails.onclick = () => setMobileTab("selection");

/* ── Collapsible sections ──────────────────────────────────────────────── */

function initCollapsible(toggleEl, bodyEl, storageKey) {
  if (!toggleEl || !bodyEl) return;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "collapsed") {
      toggleEl.classList.add("collapsed");
      bodyEl.classList.add("collapsed");
    }
  } catch {}
  toggleEl.addEventListener("click", () => {
    const isCollapsed = bodyEl.classList.contains("collapsed");
    if (isCollapsed) {
      toggleEl.classList.remove("collapsed");
      bodyEl.classList.remove("collapsed");
      try { localStorage.setItem(storageKey, "expanded"); } catch {}
    } else {
      toggleEl.classList.add("collapsed");
      bodyEl.classList.add("collapsed");
      try { localStorage.setItem(storageKey, "collapsed"); } catch {}
    }
  });
}

initCollapsible(elInfoToggle, elInfoBody, "dagain.ui.infoCollapsed");
initCollapsible(elLogToggle, elLogBody, "dagain.ui.logCollapsed");

/* ── Timing info ──────────────────────────────────────────────────────── */

let selectedNodeStartedAt = null;
let timingTimer = null;

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return secs + "s";
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return mins + "m " + String(remSecs).padStart(2, "0") + "s";
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return hrs + "h " + String(remMins).padStart(2, "0") + "m";
}

function updateTimingDisplay() {
  if (!elTimingInfo) return;
  if (!selectedNodeStartedAt) { elTimingInfo.textContent = ""; return; }
  const elapsed = Date.now() - selectedNodeStartedAt.getTime();
  elTimingInfo.innerHTML = "<span class=\"muted\">started:</span> " + selectedNodeStartedAt.toISOString().slice(11, 19) + "  <span class=\"muted\">elapsed:</span> <span class=\"elapsed\">" + formatElapsed(elapsed) + "</span>";
}

function startTimingUpdates(startedAt) {
  if (timingTimer) { clearInterval(timingTimer); timingTimer = null; }
  if (!startedAt) { selectedNodeStartedAt = null; updateTimingDisplay(); return; }
  const d = new Date(startedAt);
  if (isNaN(d.getTime())) { selectedNodeStartedAt = null; updateTimingDisplay(); return; }
  selectedNodeStartedAt = d;
  updateTimingDisplay();
  timingTimer = setInterval(updateTimingDisplay, 1000);
}

/* ── Log search ──────────────────────────────────────────────────────── */

let lastLogText = "";

function applyLogSearch() {
  if (!elLog || !elLogSearch) return;
  const query = elLogSearch.value.trim();
  if (!query || !lastLogText) {
    elLog.textContent = lastLogText || "(select a node)";
    return;
  }
  // Escape regex special chars
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(" + escaped + ")", "gi");
  const parts = lastLogText.split(re);
  elLog.innerHTML = "";
  for (const part of parts) {
    if (re.test(part)) {
      const mark = document.createElement("mark");
      mark.textContent = part;
      elLog.appendChild(mark);
      re.lastIndex = 0;
    } else {
      elLog.appendChild(document.createTextNode(part));
    }
  }
}

if (elLogSearch) {
  elLogSearch.addEventListener("input", applyLogSearch);
  elLogSearch.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { elLogSearch.value = ""; applyLogSearch(); }
  });
}
if (elLogSearchClear) {
  elLogSearchClear.addEventListener("click", () => {
    if (elLogSearch) elLogSearch.value = "";
    applyLogSearch();
  });
}

/* ── Retry button ─────────────────────────────────────────────────────── */

if (btnRetry) {
  btnRetry.onclick = async () => {
    const id = selectedNodeId;
    if (!id) return;
    const ok = await showConfirm("Retry failed node " + id + "?");
    if (!ok) return;
    await withLoading(btnRetry, async () => {
      try {
        const res = await postJson("/api/control/cancel", { nodeId: id });
        toast(res.message || ("Enqueued retry for " + id + "."), "success");
      } catch (e) {
        toast("retry failed: " + String((e && e.message) ? e.message : e), "error");
      }
    });
  };
}

async function updateSelection() {
  const snap = lastSnapshot;
  if (!snap) return;
  const nodes = Array.isArray(snap.nodes) ? snap.nodes : [];
  const node = selectedNodeId ? nodes.find((n) => n && n.id === selectedNodeId) : null;
  if (!node) {
    elSelId.textContent = "\u2014";
    elSelType.textContent = "\u2014";
    elSelStatus.textContent = "\u2014";
    elSelDot.className = "dot";
    elSelAttempts.textContent = "\u2014";
    elSelRunner.textContent = "\u2014";
    elSelDeps.textContent = "\u2014";
    elSelParent.textContent = "\u2014";
    elSelLogPath.textContent = "\u2014";
    lastLogText = "";
    elLog.innerHTML = "";
    const emptyEl = document.createElement("div");
    emptyEl.className = "emptyState";
    emptyEl.innerHTML = '<div class="emptyIcon">\u25C9</div><div class="emptyText">Select a node in the graph to view its details and logs</div><div class="emptyHint">Click a node or use arrow keys</div>';
    elLog.appendChild(emptyEl);
    btnCancel.disabled = true;
    if (btnRetry) btnRetry.disabled = true;
    if (elStatusStrip) elStatusStrip.className = "statusStrip";
    startTimingUpdates(null);
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
  if (btnRetry) btnRetry.disabled = statusKey(node) !== "failed";

  // Status strip
  if (elStatusStrip) elStatusStrip.className = "statusStrip st-" + statusDotClass(node);

  // Timing
  const startedAt = node.lock && node.lock.startedAt ? node.lock.startedAt : null;
  if (statusKey(node) === "in_progress" && startedAt) {
    startTimingUpdates(startedAt);
  } else {
    startTimingUpdates(null);
  }

  try {
    const logData = await fetchLog(node.id);
    elSelLogPath.textContent = logData.path || "(none)";
    lastLogText = logData.text || "(empty)";
    applyLogSearch();
    elLog.scrollTop = elLog.scrollHeight;
  } catch (e) {
    elSelLogPath.textContent = "(error)";
    lastLogText = String((e && e.message) ? e.message : e);
    applyLogSearch();
  }
}

function selectNode(id) {
  selectedNodeId = id || "";
  if (lastSnapshot) render(lastSnapshot);
  if (selectedNodeId) {
    centerNodeIfOffscreen(selectedNodeId);
    // Pulse animation
    const view = nodeElById.get(selectedNodeId);
    if (view && view.g) {
      view.g.classList.remove("select-pulse");
      requestAnimationFrame(() => view.g.classList.add("select-pulse"));
      setTimeout(() => view.g.classList.remove("select-pulse"), 250);
    }
  }
}

function applyVisualOverlays() {
  applyNodeSearch();
  applyStatusFilter();
  applyHideDone();
  drawMinimap();
}

function render(snapshot) {
  lastSnapshot = snapshot;
  elNow.textContent = snapshot.nowIso || "";
  elNext.textContent = fmtNext(snapshot.next);
  elSupervisor.textContent = fmtSupervisor(snapshot.supervisor);
  const counts = snapshot.counts || {};
  elCounts.textContent = Object.keys(counts).sort().map((k) => k + "=" + counts[k]).join("  ");

  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  try {
    const current = new Set();
    for (const n of nodes) {
      if (!n || !n.id) continue;
      if (statusKey(n) !== "needs_human") continue;
      current.add(n.id);
      if (needsHumanNotified.has(n.id)) continue;
      const q = n.checkpoint && n.checkpoint.question ? String(n.checkpoint.question) : "";
      toast("Needs human input: " + n.id + (q ? (" — " + truncateText(q, 120)) : ""), "warn");
    }
    needsHumanNotified = current;
  } catch {
    // ignore
  }
  if (!selectedNodeId) {
    selectedNodeId = (snapshot.next && snapshot.next.id) ? snapshot.next.id : ((nodes[0] && nodes[0].id) ? nodes[0].id : "");
  }
  const graph = buildGraph(snapshot, selectedNodeId);
  lastGraph = graph;
  renderGraph(graph);
  updateSelection();
  fitView = computeFitView(graph);
  if (!viewBox || !userMovedView) setViewBox(fitView, { animate: false });
  else setViewBox(viewBox, { animate: false });
  applyVisualOverlays();
  if (selectedNodeId && selectedNodeId !== lastAutoScrollId) {
    lastAutoScrollId = selectedNodeId;
    centerNodeIfOffscreen(selectedNodeId);
  }
}

btnPause.onclick = () => withLoading(btnPause, async () => {
  try {
    const res = await postJson("/api/control/pause", {});
    toast(res.message || "Enqueued pause.", "success");
  } catch (e) {
    toast("pause failed: " + String((e && e.message) ? e.message : e), "error");
  }
});
btnResume.onclick = () => withLoading(btnResume, async () => {
  try {
    const res = await postJson("/api/control/resume", {});
    toast(res.message || "Enqueued resume.", "success");
  } catch (e) {
    toast("resume failed: " + String((e && e.message) ? e.message : e), "error");
  }
});
btnReplan.onclick = () => withLoading(btnReplan, async () => {
  try {
    const res = await postJson("/api/control/replan", {});
    toast(res.message || "Enqueued replan.", "success");
  } catch (e) {
    toast("replan failed: " + String((e && e.message) ? e.message : e), "error");
  }
});
btnSetWorkers.onclick = () => withLoading(btnSetWorkers, async () => {
  const n = Number(inpWorkers.value);
  if (!Number.isFinite(n) || n <= 0) return toast("workers must be a positive number", "error");
  try {
    const res = await postJson("/api/control/set-workers", { workers: Math.floor(n) });
    toast(res.message || "Enqueued set-workers.", "success");
  } catch (e) {
    toast("set-workers failed: " + String((e && e.message) ? e.message : e), "error");
  }
});
btnCancel.onclick = async () => {
  const id = selectedNodeId;
  if (!id) return;
  const ok = await showConfirm("Cancel running node " + id + "?");
  if (!ok) return;
  await withLoading(btnCancel, async () => {
    try {
      const res = await postJson("/api/control/cancel", { nodeId: id });
      toast(res.message || ("Enqueued cancel " + id + "."), "success");
    } catch (e) {
      toast("cancel failed: " + String((e && e.message) ? e.message : e), "error");
    }
  });
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

applyViewPrefs(readViewPrefs());
if (btnToggleChat) btnToggleChat.onclick = () => toggleChatPane();
if (btnToggleSelection) btnToggleSelection.onclick = () => toggleSelectionPane();

async function fetchRuns() {
  const res = await fetch("/api/runs?limit=80");
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) ? data.error : ("HTTP " + res.status));
  return data;
}

async function fetchRunLog(runId) {
  const id = String(runId || "").trim();
  if (!id) return { runId: "", path: "", text: "" };
  const res = await fetch("/api/run/log?runId=" + encodeURIComponent(id) + "&tail=10000");
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) ? data.error : ("HTTP " + res.status));
  return data;
}

function renderRunsList() {
  if (!elRunsList) return;
  const list = Array.isArray(runs) ? runs : [];
  if (!list.length) {
    elRunsList.innerHTML = "";
    const emptyRuns = document.createElement("div");
    emptyRuns.className = "emptyState";
    emptyRuns.innerHTML = '<div class="emptyIcon">\u25B6</div><div class="emptyText">No runs yet</div><div class="emptyHint">Start a run to see history here</div>';
    elRunsList.appendChild(emptyRuns);
    return;
  }
  elRunsList.innerHTML = "";
  let staggerIdx = 0;
  for (const r of list) {
    const id = r && r.runId ? String(r.runId) : "";
    if (!id) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "runItem stagger" + (id === selectedRunId ? " active" : "");
    btn.style.animationDelay = (staggerIdx * 30) + "ms";
    staggerIdx++;
    const nodeId = typeof r?.nodeId === "string" ? r.nodeId : "";
    const status = typeof r?.status === "string" ? r.status : "";
    btn.textContent = truncateText(id + (nodeId ? "  " + nodeId : "") + (status ? "  [" + status + "]" : ""), 72);
    btn.onclick = () => selectRun(id);
    elRunsList.appendChild(btn);
  }
}

async function selectRun(runId) {
  const id = String(runId || "").trim();
  if (!id) return;
  selectedRunId = id;
  renderRunsList();
  updateDeleteButton();
  try {
    const log = await fetchRunLog(id);
    if (elRunMeta) elRunMeta.textContent = (log.path ? ("log: " + log.path) : ("run: " + id));
    if (elRunLog) {
      elRunLog.textContent = log.text || "(empty)";
      elRunLog.scrollTop = elRunLog.scrollHeight;
    }
  } catch (e) {
    if (elRunMeta) elRunMeta.textContent = "run: " + id;
    if (elRunLog) elRunLog.textContent = String((e && e.message) ? e.message : e);
  }
}

async function refreshRuns() {
  try {
    const data = await fetchRuns();
    runs = Array.isArray(data && data.runs) ? data.runs : [];
    if (!selectedRunId && runs[0] && runs[0].runId) selectedRunId = String(runs[0].runId);
    renderRunsList();
    if (selectedRunId) await selectRun(selectedRunId);
  } catch (e) {
    runs = [];
    const msg = String((e && e.message) ? e.message : e);
    const friendly = msg === "Failed to fetch" ? "Could not connect to server" : msg;
    if (elRunsList) {
      elRunsList.innerHTML = "";
      const emptyEl = document.createElement("div");
      emptyEl.className = "emptyState";
      emptyEl.innerHTML = '<div class="emptyIcon">\u26A0</div><div class="emptyText">' + escapeHtml(friendly) + '</div><div class="emptyHint">Check that the server is running</div>';
      elRunsList.appendChild(emptyEl);
    }
  }
}

async function deleteRun(runId) {
  const id = String(runId || "").trim();
  if (!id) return;
  const ok = await showConfirm("Delete run " + truncateText(id, 48) + "?");
  if (!ok) return;
  const doDelete = async () => {
    const res = await fetch("/api/run/delete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dagain-token": token },
      body: JSON.stringify({ runId: id }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) ? data.error : ("HTTP " + res.status));
    if (selectedRunId === id) {
      selectedRunId = "";
      if (elRunMeta) elRunMeta.textContent = "select a run to view its log";
      if (elRunLog) elRunLog.textContent = "(empty)";
    }
    await refreshRuns();
    toast("Run deleted", "success");
  };
  try {
    if (btnDeleteRun) {
      await withLoading(btnDeleteRun, doDelete);
    } else {
      await doDelete();
    }
  } catch (err) {
    toast(String(err?.message || err || "Failed to delete run"), "error");
  }
}

function updateDeleteButton() {
  if (btnDeleteRun) btnDeleteRun.disabled = !selectedRunId;
}

async function clearChat() {
  const ok = await showConfirm("Clear all chat history?");
  if (!ok) return;
  const doClear = async () => {
    const res = await fetch("/api/chat/clear", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dagain-token": token },
      body: "{}",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast((data && data.error) || ("HTTP " + res.status), "error");
      return;
    }
    await refreshChat();
    toast("Chat cleared", "success");
  };
  try {
    if (btnClearChat) {
      await withLoading(btnClearChat, doClear);
    } else {
      await doClear();
    }
  } catch (err) {
    toast(String(err?.message || err || "Failed to clear chat"), "error");
  }
}

async function startRun() {
  const doStart = async () => {
    const res = await fetch("/api/control/start", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dagain-token": token },
      body: "{}",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast((data && data.error) || ("HTTP " + res.status), "error");
      return;
    }
    if (data && data.alreadyRunning) {
      toast("Supervisor already running", "info");
    } else {
      // Clear chat history for the new run
      await fetch("/api/chat/clear", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dagain-token": token },
        body: "{}",
      }).catch(() => {});
      lastChatFingerprint = "";
      await refreshChat();
      toast(data?.message || "Supervisor started", "success");
    }
    await refreshRuns();
  };
  try {
    if (btnStartRun) {
      await withLoading(btnStartRun, doStart);
    } else {
      await doStart();
    }
  } catch (err) {
    toast(String(err?.message || err || "Failed to start"), "error");
  }
}

if (btnDeleteRun) btnDeleteRun.onclick = () => deleteRun(selectedRunId);
if (btnClearChat) btnClearChat.onclick = () => clearChat();
if (btnStartRun) btnStartRun.onclick = () => startRun();
if (btnToggleRuns) btnToggleRuns.onclick = () => toggleRunsPane();

btnFit.onclick = () => fitToGraph({ animate: true });
btnZoomOut.onclick = () => zoomAtCenter(1.25);
btnZoomIn.onclick = () => zoomAtCenter(0.8);

/* ── Zoom slider ──────────────────────────────────────────────────────── */

if (elZoomSlider) {
  elZoomSlider.addEventListener("input", () => {
    if (!fitView || !viewBox) return;
    const targetPct = Number(elZoomSlider.value) || 100;
    const currentPct = fitView.w > 0 && viewBox.w > 0 ? (fitView.w / viewBox.w) * 100 : 100;
    if (Math.abs(targetPct - currentPct) < 1) return;
    const factor = currentPct / targetPct;
    zoomAtCenter(factor);
  });
}

if (elZoomPill) {
  elZoomPill.addEventListener("click", () => {
    const current = elZoomPct ? elZoomPct.textContent.replace("%", "") : "100";
    const input = prompt("Zoom level (25-400%):", current);
    if (!input) return;
    const targetPct = Number(input);
    if (!Number.isFinite(targetPct) || targetPct < 25 || targetPct > 400) return;
    if (!fitView || !viewBox) return;
    const currentPct = fitView.w > 0 && viewBox.w > 0 ? (fitView.w / viewBox.w) * 100 : 100;
    const factor = currentPct / targetPct;
    zoomAtCenter(factor);
  });
}

/* ── Node search ──────────────────────────────────────────────────────── */

function applyNodeSearch() {
  if (!lastGraph) return;
  const q = nodeSearchQuery.toLowerCase();
  for (const n of lastGraph.nodes) {
    if (!n || !n.id) continue;
    const view = nodeElById.get(n.id);
    if (!view) continue;
    if (!q) {
      view.g.classList.remove("search-dimmed");
      continue;
    }
    const haystack = ((n.id || "") + " " + (n.type || "") + " " + (n.title || "")).toLowerCase();
    const match = haystack.includes(q);
    view.g.classList.toggle("search-dimmed", !match);
  }
  // Dim edges connected to dimmed nodes
  for (const [key, pathEl] of edgeElByKey.entries()) {
    if (!q) { pathEl.classList.remove("search-dimmed"); continue; }
    const parts = key.split("->");
    const kindAndFrom = parts[0] || "";
    const to = parts[1] || "";
    const kindEnd = kindAndFrom.indexOf(":");
    const from = kindEnd >= 0 ? kindAndFrom.slice(kindEnd + 1) : "";
    const fromView = nodeElById.get(from);
    const toView = nodeElById.get(to);
    const fromDimmed = fromView && fromView.g.classList.contains("search-dimmed");
    const toDimmed = toView && toView.g.classList.contains("search-dimmed");
    pathEl.classList.toggle("search-dimmed", Boolean(fromDimmed && toDimmed));
  }
}

if (elNodeSearch) {
  elNodeSearch.addEventListener("input", () => {
    nodeSearchQuery = elNodeSearch.value.trim();
    applyNodeSearch();
  });
  elNodeSearch.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      elNodeSearch.value = "";
      nodeSearchQuery = "";
      applyNodeSearch();
      elNodeSearch.blur();
    }
  });
}

/* ── Status filter chips ──────────────────────────────────────────────── */

function applyStatusFilter() {
  if (!lastGraph) return;
  const hasFilter = activeStatusFilters.size > 0;
  for (const n of lastGraph.nodes) {
    if (!n || !n.id) continue;
    const view = nodeElById.get(n.id);
    if (!view) continue;
    if (!hasFilter) { view.g.classList.remove("filter-dimmed"); continue; }
    const st = statusKey(n);
    const match = activeStatusFilters.has(st);
    view.g.classList.toggle("filter-dimmed", !match);
  }
  for (const [key, pathEl] of edgeElByKey.entries()) {
    if (!hasFilter) { pathEl.classList.remove("filter-dimmed"); continue; }
    const parts = key.split("->");
    const kindAndFrom = parts[0] || "";
    const to = parts[1] || "";
    const kindEnd = kindAndFrom.indexOf(":");
    const from = kindEnd >= 0 ? kindAndFrom.slice(kindEnd + 1) : "";
    const fromView = nodeElById.get(from);
    const toView = nodeElById.get(to);
    const fromDimmed = fromView && fromView.g.classList.contains("filter-dimmed");
    const toDimmed = toView && toView.g.classList.contains("filter-dimmed");
    pathEl.classList.toggle("filter-dimmed", Boolean(fromDimmed && toDimmed));
  }
}

if (elFilterChips) {
  elFilterChips.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".filterChip");
    if (!chip) return;
    const status = chip.dataset.status || "";
    if (!status) return;
    if (activeStatusFilters.has(status)) {
      activeStatusFilters.delete(status);
      chip.classList.remove("active");
    } else {
      activeStatusFilters.add(status);
      chip.classList.add("active");
    }
    applyStatusFilter();
  });
}

/* ── Hide done toggle ─────────────────────────────────────────────────── */

if (btnHideDone) {
  btnHideDone.addEventListener("click", () => {
    hideDoneActive = !hideDoneActive;
    btnHideDone.classList.toggle("hide-done-active", hideDoneActive);
    applyHideDone();
  });
}

function applyHideDone() {
  if (!lastGraph) return;
  for (const n of lastGraph.nodes) {
    if (!n || !n.id) continue;
    const view = nodeElById.get(n.id);
    if (!view) continue;
    const isDone = statusKey(n) === "done";
    const shouldHide = hideDoneActive && isDone && selectedNodeId !== n.id;
    view.g.style.display = shouldHide ? "none" : "";
  }
  for (const [key, pathEl] of edgeElByKey.entries()) {
    if (!hideDoneActive) { pathEl.style.display = ""; continue; }
    const parts = key.split("->");
    const to = parts[1] || "";
    const kindAndFrom = parts[0] || "";
    const kindEnd = kindAndFrom.indexOf(":");
    const from = kindEnd >= 0 ? kindAndFrom.slice(kindEnd + 1) : "";
    const fromNode = lastGraph.byId.get(from);
    const toNode = lastGraph.byId.get(to);
    const fromDone = fromNode && statusKey(fromNode) === "done" && selectedNodeId !== from;
    const toDone = toNode && statusKey(toNode) === "done" && selectedNodeId !== to;
    pathEl.style.display = (fromDone && toDone) ? "none" : "";
  }
}

/* ── Minimap ──────────────────────────────────────────────────────────── */

const minimapColors = {
  open: "#555555",
  in_progress: "#ffb000",
  done: "#22c55e",
  failed: "#ff4444",
  needs_human: "#a855f7",
};

function drawMinimap() {
  if (!elMinimap || !lastGraph || !lastGraph.pos.size) return;
  const ctx = elMinimap.getContext("2d");
  if (!ctx) return;
  const cw = elMinimap.width;
  const ch = elMinimap.height;
  ctx.clearRect(0, 0, cw, ch);

  const gw = Math.max(1, lastGraph.w);
  const gh = Math.max(1, lastGraph.h);
  const pad = 6;
  const scaleX = (cw - pad * 2) / gw;
  const scaleY = (ch - pad * 2) / gh;
  const scale = Math.min(scaleX, scaleY);

  const offsetX = pad + (cw - pad * 2 - gw * scale) / 2;
  const offsetY = pad + (ch - pad * 2 - gh * scale) / 2;

  // Draw edges
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 0.5;
  for (const e of lastGraph.edges) {
    const a = lastGraph.pos.get(e.from);
    const b = lastGraph.pos.get(e.to);
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(offsetX + (a.x + a.w) * scale, offsetY + (a.y + a.h / 2) * scale);
    ctx.lineTo(offsetX + b.x * scale, offsetY + (b.y + b.h / 2) * scale);
    ctx.stroke();
  }

  // Draw nodes as dots
  for (const n of lastGraph.nodes) {
    if (!n || !n.id) continue;
    const p = lastGraph.pos.get(n.id);
    if (!p) continue;
    const st = statusKey(n);
    ctx.fillStyle = minimapColors[st] || "#555555";
    const cx = offsetX + (p.x + p.w / 2) * scale;
    const cy = offsetY + (p.y + p.h / 2) * scale;
    const r = Math.max(2, Math.min(4, p.w * scale * 0.15));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw viewport rectangle
  if (viewBox) {
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    const vx = offsetX + viewBox.x * scale;
    const vy = offsetY + viewBox.y * scale;
    const vw = viewBox.w * scale;
    const vh = viewBox.h * scale;
    ctx.strokeRect(vx, vy, vw, vh);
  }
}

// Minimap click/drag navigation
if (elMinimap) {
  let minimapDragging = false;

  function minimapNavigate(ev) {
    if (!lastGraph || !viewBox) return;
    const rect = elMinimap.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const cw = elMinimap.width;
    const ch = elMinimap.height;
    const gw = Math.max(1, lastGraph.w);
    const gh = Math.max(1, lastGraph.h);
    const pad = 6;
    const scaleX = (cw - pad * 2) / gw;
    const scaleY = (ch - pad * 2) / gh;
    const scale = Math.min(scaleX, scaleY);
    const offsetX = pad + (cw - pad * 2 - gw * scale) / 2;
    const offsetY = pad + (ch - pad * 2 - gh * scale) / 2;
    const worldX = (mx - offsetX) / scale;
    const worldY = (my - offsetY) / scale;
    userMovedView = true;
    setViewBox({
      x: worldX - viewBox.w / 2,
      y: worldY - viewBox.h / 2,
      w: viewBox.w,
      h: viewBox.h,
    }, { animate: false });
  }

  elMinimap.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    minimapDragging = true;
    minimapNavigate(ev);
    try { elMinimap.setPointerCapture(ev.pointerId); } catch {}
  });
  elMinimap.addEventListener("pointermove", (ev) => {
    if (minimapDragging) minimapNavigate(ev);
  });
  elMinimap.addEventListener("pointerup", () => { minimapDragging = false; });
  elMinimap.addEventListener("pointercancel", () => { minimapDragging = false; });
}

// Redraw minimap whenever viewBox changes
const _origSetViewBox = setViewBox;
setViewBox = function(next, opts) {
  _origSetViewBox(next, opts);
  drawMinimap();
};

let panning = false;
let panStart = null;
elGraphWrap.addEventListener("pointerdown", (ev) => {
  if (!viewBox) return;
  if (ev.button !== 0) return;
  const target = ev.target;
  if (target && typeof target.closest === "function" && target.closest(".node")) return;
  panning = true;
  panStart = { x: ev.clientX, y: ev.clientY, vb: { ...viewBox } };
  userMovedView = true;
  try {
    elGraphWrap.setPointerCapture(ev.pointerId);
  } catch {
    // ignore
  }
  elGraphWrap.classList.add("grabbing");
});
elGraphWrap.addEventListener("pointermove", (ev) => {
  if (!panning || !panStart || !viewBox || !elGraph) return;
  const rect = elGraph.getBoundingClientRect();
  const dx = ev.clientX - panStart.x;
  const dy = ev.clientY - panStart.y;
  const dw = rect.width > 0 ? (dx / rect.width) * panStart.vb.w : 0;
  const dh = rect.height > 0 ? (dy / rect.height) * panStart.vb.h : 0;
  setViewBox(
    {
      x: panStart.vb.x - dw,
      y: panStart.vb.y - dh,
      w: panStart.vb.w,
      h: panStart.vb.h,
    },
    { animate: false },
  );
});
function endPan() {
  panning = false;
  panStart = null;
  elGraphWrap.classList.remove("grabbing");
}
elGraphWrap.addEventListener("pointerup", endPan);
elGraphWrap.addEventListener("pointercancel", endPan);
elGraphWrap.addEventListener(
  "wheel",
  (ev) => {
    if (!viewBox) return;
    ev.preventDefault();
    const dy = Number(ev.deltaY || 0);
    const factor = Math.pow(1.0016, dy);
    zoomAtClientPoint({ clientX: ev.clientX, clientY: ev.clientY, factor });
  },
  { passive: false },
);

if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => {
    if (!lastGraph) return;
    fitView = computeFitView(lastGraph);
    if (!viewBox || !userMovedView) setViewBox(fitView, { animate: false });
    updateZoomPct();
  });
  ro.observe(elGraphWrap);
}

if (btnChatSend) btnChatSend.onclick = () => sendChat();
if (inpChat) {
  inpChat.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      sendChat();
    }
  });
}
refreshChat();
setInterval(refreshChat, 2000);

// Load runs on startup (visible by default)
if (!document.body.classList.contains("hideRuns")) refreshRuns();

// Update relative timestamps in chat every 30s
setInterval(() => {
  if (!elChatLog) return;
  const metas = elChatLog.querySelectorAll(".chatMeta[data-at]");
  for (const m of metas) {
    const at = m.dataset.at || "";
    if (!at) continue;
    const role = m.textContent.startsWith("you") ? "you" : "assistant";
    m.textContent = role + " \u2022 " + relativeTime(at);
  }
}, 30000);

/* ── Tooltip ──────────────────────────────────────────────────────────── */

function showNodeTooltip(nodeId, ev) {
  if (!elNodeTooltip || !lastSnapshot) return;
  const nodes = Array.isArray(lastSnapshot.nodes) ? lastSnapshot.nodes : [];
  const node = nodes.find((n) => n && n.id === nodeId);
  if (!node) return;
  const lines = [];
  lines.push("id: " + (node.id || ""));
  lines.push("status: " + (node.status || "open"));
  if (node.type) lines.push("type: " + node.type);
  if (node.title) lines.push("title: " + node.title);
  lines.push("attempts: " + (node.attempts ?? 0));
  elNodeTooltip.textContent = lines.join("\n");
  elNodeTooltip.classList.add("visible");
  moveNodeTooltip(ev);
}

function moveNodeTooltip(ev) {
  if (!elNodeTooltip) return;
  const x = ev.clientX + 12;
  const y = ev.clientY + 12;
  elNodeTooltip.style.left = x + "px";
  elNodeTooltip.style.top = y + "px";
}

function hideNodeTooltip() {
  if (!elNodeTooltip) return;
  elNodeTooltip.classList.remove("visible");
}

/* ── Keyboard navigation ──────────────────────────────────────────────── */

function getNodeIdList() {
  if (!lastGraph) return [];
  return lastGraph.nodes.filter((n) => n && n.id).map((n) => n.id);
}

function focusNodeById(id) {
  keyboardFocusId = id || "";
  if (lastSnapshot) {
    const graph = buildGraph(lastSnapshot, selectedNodeId);
    lastGraph = graph;
    renderGraph(graph);
  }
  if (keyboardFocusId) centerNodeIfOffscreen(keyboardFocusId);
}

/* ── Help overlay ──────────────────────────────────────────────────────── */

let helpVisible = false;

function toggleHelp() {
  helpVisible = !helpVisible;
  if (helpVisible) {
    if (!elConfirmBackdrop || !elConfirmMessage) return;
    elConfirmMessage.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "helpOverlay";
    const h = document.createElement("h3");
    h.textContent = "Keyboard Shortcuts";
    wrap.appendChild(h);
    const tbl = document.createElement("table");
    const shortcuts = [
      ["?", "Toggle this help"],
      ["/", "Search nodes"],
      ["f", "Fit graph to view"],
      ["+", "Zoom in"],
      ["-", "Zoom out"],
      ["\u2190 \u2192 \u2191 \u2193", "Navigate nodes"],
      ["Enter", "Select focused node"],
      ["Esc", "Close overlays / deselect"],
    ];
    for (const [key, desc] of shortcuts) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = key;
      const td2 = document.createElement("td");
      td2.textContent = desc;
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbl.appendChild(tr);
    }
    wrap.appendChild(tbl);
    elConfirmMessage.appendChild(wrap);
    elConfirmBackdrop.classList.add("visible");
    // hide confirm buttons
    if (elConfirmOk) elConfirmOk.style.display = "none";
    if (elConfirmCancel) elConfirmCancel.textContent = "Close";
    const closeHelp = () => {
      helpVisible = false;
      elConfirmBackdrop.classList.remove("visible");
      if (elConfirmOk) elConfirmOk.style.display = "";
      if (elConfirmCancel) elConfirmCancel.textContent = "Cancel";
      if (elConfirmCancel) elConfirmCancel.onclick = null;
      elConfirmBackdrop.onclick = null;
    };
    if (elConfirmCancel) elConfirmCancel.onclick = closeHelp;
    elConfirmBackdrop.onclick = (ev) => { if (ev.target === elConfirmBackdrop) closeHelp(); };
  } else {
    if (elConfirmBackdrop) elConfirmBackdrop.classList.remove("visible");
    if (elConfirmOk) elConfirmOk.style.display = "";
    if (elConfirmCancel) elConfirmCancel.textContent = "Cancel";
  }
}

/* ── Global keyboard shortcuts ────────────────────────────────────────── */

document.addEventListener("keydown", (ev) => {
  const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select") return;

  // Escape: close overlays in priority order
  if (ev.key === "Escape") {
    if (elConfigBackdrop && elConfigBackdrop.classList.contains("open")) { closeConfig(); return; }
    if (helpVisible) { toggleHelp(); return; }
    if (elConfirmBackdrop && elConfirmBackdrop.classList.contains("visible")) return; // let confirm handler deal with it
    if (selectedNodeId) { selectNode(""); return; }
    return;
  }

  if (ev.key === "?" || (ev.key === "/" && ev.shiftKey)) {
    ev.preventDefault();
    toggleHelp();
    return;
  }

  if (ev.key === "/" && !ev.shiftKey) {
    ev.preventDefault();
    if (elNodeSearch) elNodeSearch.focus();
    return;
  }

  if (ev.key === "f") {
    ev.preventDefault();
    fitToGraph({ animate: true });
    return;
  }

  if (ev.key === "+" || ev.key === "=") {
    ev.preventDefault();
    zoomAtCenter(0.8);
    return;
  }

  if (ev.key === "-") {
    ev.preventDefault();
    zoomAtCenter(1.25);
    return;
  }

  if (ev.key === ",") {
    ev.preventDefault();
    openConfig();
    return;
  }

  // Arrow key node navigation
  if (ev.key === "ArrowRight" || ev.key === "ArrowDown" || ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const ids = getNodeIdList();
    if (!ids.length) return;
    const cur = keyboardFocusId || selectedNodeId || "";
    const idx = cur ? ids.indexOf(cur) : -1;
    let next;
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") {
      next = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : ids[0];
    } else {
      next = idx > 0 ? ids[idx - 1] : ids[ids.length - 1];
    }
    focusNodeById(next);
  }

  if (ev.key === "Enter" && keyboardFocusId) {
    ev.preventDefault();
    selectNode(keyboardFocusId);
    keyboardFocusId = "";
  }
});

/* ── Config panel ─────────────────────────────────────────────────────── */

function renderConfigForm(config) {
  if (!config) return;

  // Roles section
  if (elConfigRoles) {
    elConfigRoles.innerHTML = "";
    const roles = config.roles || {};
    const runnerNames = config.runners ? Object.keys(config.runners) : [];
    const roleKeys = ["main", "planner", "executor", "verifier", "integrator", "finalVerifier", "researcher"];
    for (const key of roleKeys) {
      const label = document.createElement("label");
      label.textContent = key;
      const select = document.createElement("select");
      select.dataset.roleKey = key;
      for (const rn of runnerNames) {
        const opt = document.createElement("option");
        opt.value = rn;
        opt.textContent = rn;
        if (roles[key] === rn) opt.selected = true;
        select.appendChild(opt);
      }
      elConfigRoles.appendChild(label);
      elConfigRoles.appendChild(select);
    }
  }

  // Supervisor section
  if (elConfigSupervisor) {
    elConfigSupervisor.innerHTML = "";
    const sup = config.supervisor || {};

    const numFields = [
      ["workers", sup.workers ?? 1],
      ["idleSleepMs", sup.idleSleepMs ?? 2000],
      ["staleLockSeconds", sup.staleLockSeconds ?? 3600],
      ["autoResetFailedMax", sup.autoResetFailedMax ?? 1],
    ];
    for (const [key, val] of numFields) {
      const label = document.createElement("label");
      label.textContent = key;
      const input = document.createElement("input");
      input.type = "number";
      input.dataset.supKey = key;
      input.value = String(val);
      elConfigSupervisor.appendChild(label);
      elConfigSupervisor.appendChild(input);
    }

    // multiVerifier select
    const mvLabel = document.createElement("label");
    mvLabel.textContent = "multiVerifier";
    const mvSelect = document.createElement("select");
    mvSelect.dataset.supKey = "multiVerifier";
    for (const v of ["one", "all"]) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      if ((sup.multiVerifier || "one") === v) opt.selected = true;
      mvSelect.appendChild(opt);
    }
    elConfigSupervisor.appendChild(mvLabel);
    elConfigSupervisor.appendChild(mvSelect);

    // worktrees.mode select
    const wtLabel = document.createElement("label");
    wtLabel.textContent = "worktrees.mode";
    const wtSelect = document.createElement("select");
    wtSelect.dataset.supKey = "worktrees.mode";
    for (const v of ["off", "always", "conflict"]) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      const curMode = sup.worktrees && sup.worktrees.mode ? sup.worktrees.mode : "off";
      if (curMode === v) opt.selected = true;
      wtSelect.appendChild(opt);
    }
    elConfigSupervisor.appendChild(wtLabel);
    elConfigSupervisor.appendChild(wtSelect);
  }

  // Runners section
  if (elConfigRunners) {
    elConfigRunners.innerHTML = "";
    const runners = config.runners || {};
    for (const [name, runner] of Object.entries(runners)) {
      const row = document.createElement("div");
      row.className = "configRunnerRow";
      const nameEl = document.createElement("span");
      nameEl.className = "configRunnerName";
      nameEl.textContent = name;
      const cmdInput = document.createElement("input");
      cmdInput.type = "text";
      cmdInput.dataset.runnerName = name;
      cmdInput.value = runner && runner.cmd ? String(runner.cmd) : "";
      row.appendChild(nameEl);
      row.appendChild(cmdInput);
      elConfigRunners.appendChild(row);
    }
  }

  // Defaults section
  if (elConfigDefaults) {
    elConfigDefaults.innerHTML = "";
    const defaults = config.defaults || {};

    const maxLabel = document.createElement("label");
    maxLabel.textContent = "maxAttempts";
    const maxInput = document.createElement("input");
    maxInput.type = "number";
    maxInput.dataset.defaultKey = "retryPolicy.maxAttempts";
    maxInput.value = String(defaults.retryPolicy && defaults.retryPolicy.maxAttempts != null ? defaults.retryPolicy.maxAttempts : 1);
    elConfigDefaults.appendChild(maxLabel);
    elConfigDefaults.appendChild(maxInput);

    const vrLabel = document.createElement("label");
    vrLabel.textContent = "verifyRunner";
    const vrInput = document.createElement("input");
    vrInput.type = "text";
    vrInput.dataset.defaultKey = "verifyRunner";
    vrInput.value = defaults.verifyRunner || "";
    elConfigDefaults.appendChild(vrLabel);
    elConfigDefaults.appendChild(vrInput);

    const mrLabel = document.createElement("label");
    mrLabel.textContent = "mergeRunner";
    const mrInput = document.createElement("input");
    mrInput.type = "text";
    mrInput.dataset.defaultKey = "mergeRunner";
    mrInput.value = defaults.mergeRunner || "";
    elConfigDefaults.appendChild(mrLabel);
    elConfigDefaults.appendChild(mrInput);
  }
}

function readConfigForm(config) {
  if (!config) return;

  // Roles
  if (elConfigRoles) {
    if (!config.roles) config.roles = {};
    const selects = elConfigRoles.querySelectorAll("select[data-role-key]");
    for (const sel of selects) {
      config.roles[sel.dataset.roleKey] = sel.value;
    }
  }

  // Supervisor
  if (elConfigSupervisor) {
    if (!config.supervisor) config.supervisor = {};
    const inputs = elConfigSupervisor.querySelectorAll("input[data-sup-key]");
    for (const inp of inputs) {
      const val = Number(inp.value);
      if (Number.isFinite(val)) config.supervisor[inp.dataset.supKey] = val;
    }
    const selects = elConfigSupervisor.querySelectorAll("select[data-sup-key]");
    for (const sel of selects) {
      const key = sel.dataset.supKey;
      if (key === "worktrees.mode") {
        if (!config.supervisor.worktrees) config.supervisor.worktrees = {};
        config.supervisor.worktrees.mode = sel.value;
      } else {
        config.supervisor[key] = sel.value;
      }
    }
  }

  // Runners
  if (elConfigRunners) {
    if (!config.runners) config.runners = {};
    const inputs = elConfigRunners.querySelectorAll("input[data-runner-name]");
    for (const inp of inputs) {
      const name = inp.dataset.runnerName;
      if (!config.runners[name]) config.runners[name] = {};
      config.runners[name].cmd = inp.value;
    }
  }

  // Defaults
  if (elConfigDefaults) {
    if (!config.defaults) config.defaults = {};
    const inputs = elConfigDefaults.querySelectorAll("input[data-default-key]");
    for (const inp of inputs) {
      const key = inp.dataset.defaultKey;
      if (key === "retryPolicy.maxAttempts") {
        if (!config.defaults.retryPolicy) config.defaults.retryPolicy = {};
        const val = Number(inp.value);
        if (Number.isFinite(val)) config.defaults.retryPolicy.maxAttempts = val;
      } else {
        config.defaults[key] = inp.value;
      }
    }
  }
}

async function openConfig() {
  try {
    const res = await fetch("/api/config", { headers: { "x-dagain-token": token } });
    const data = await res.json().catch(() => null);
    if (!res.ok) { toast((data?.error) || "Failed to load config", "error"); return; }
    currentConfig = data.config;
    renderConfigForm(currentConfig);
    if (elConfigBackdrop) elConfigBackdrop.classList.add("open");
  } catch (e) {
    toast("Failed to load config: " + String(e?.message || e), "error");
  }
}

function closeConfig() {
  if (elConfigBackdrop) elConfigBackdrop.classList.remove("open");
}

async function saveConfigAction() {
  if (!currentConfig) return;
  readConfigForm(currentConfig);
  try {
    await postJson("/api/config", { config: currentConfig });
    toast("Config saved", "success");
    closeConfig();
  } catch (e) {
    toast("Save failed: " + String(e?.message || e), "error");
  }
}

if (btnToggleConfig) btnToggleConfig.onclick = () => openConfig();
if (btnConfigSave) btnConfigSave.onclick = () => saveConfigAction();
if (btnConfigClose) btnConfigClose.onclick = () => closeConfig();
if (elConfigBackdrop) elConfigBackdrop.onclick = (e) => { if (e.target === elConfigBackdrop) closeConfig(); };

/* ── SSE diffing + connection indicator ──────────────────────────────── */

const lastRenderedState = new Map(); // nodeId -> {status, title, lockRunId}
let lastNodeIds = "";

function snapshotNodeKey(n) {
  return (n.status || "") + "|" + (n.title || "") + "|" + (n.lock && n.lock.runId ? n.lock.runId : "");
}

function hasStructuralChange(snapshot) {
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const ids = nodes.map((n) => n && n.id ? n.id : "").sort().join(",");
  if (ids !== lastNodeIds) return true;
  // Check if any dependency edges changed
  for (const n of nodes) {
    if (!n || !n.id) continue;
    const prev = lastRenderedState.get(n.id);
    if (!prev) return true;
    const prevDeps = prev.deps || "";
    const curDeps = Array.isArray(n.dependsOn) ? n.dependsOn.sort().join(",") : "";
    if (prevDeps !== curDeps) return true;
    const prevParent = prev.parentId || "";
    const curParent = n.parentId || "";
    if (prevParent !== curParent) return true;
  }
  return false;
}

function renderIncremental(snapshot) {
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

  const structural = hasStructuralChange(snapshot);

  if (structural) {
    // Full re-render
    const graph = buildGraph(snapshot, selectedNodeId);
    lastGraph = graph;
    renderGraph(graph);
    fitView = computeFitView(graph);
    if (!viewBox || !userMovedView) setViewBox(fitView, { animate: false });
    else setViewBox(viewBox, { animate: false });
  } else {
    // Incremental: only update changed nodes
    const byId = new Map();
    for (const n of nodes) if (n && n.id) byId.set(n.id, n);
    const nextId = snapshot.next && snapshot.next.id ? snapshot.next.id : "";

    for (const n of nodes) {
      if (!n || !n.id) continue;
      const prev = lastRenderedState.get(n.id);
      const curKey = snapshotNodeKey(n);
      const prevKey = prev ? prev.key : "";
      const needsUpdate = curKey !== prevKey || (selectedNodeId === n.id) !== (prev && prev.wasSelected) || (nextId === n.id) !== (prev && prev.wasNext);
      if (!needsUpdate) continue;

      const view = nodeElById.get(n.id);
      if (!view) continue;

      const statusChanged = prev && prev.key && curKey !== prevKey;
      const st = statusDotClass(n);
      view.g.setAttribute(
        "class",
        "node st-" + st +
        (selectedNodeId === n.id ? " selected" : "") +
        (nextId === n.id ? " next" : "") +
        (keyboardFocusId === n.id ? " keyboard-focus" : "") +
        (statusChanged ? " status-changed" : ""),
      );
      if (statusChanged) {
        setTimeout(() => view.g.classList.remove("status-changed"), 450);
      }
      const lines = nodeLines(n);
      view.t1.textContent = lines.top;
      view.t2.textContent = lines.bottom;
    }

    // Update edge classes (flowing state may change)
    for (const [key, pathEl] of edgeElByKey.entries()) {
      const parts = key.split("->");
      if (parts.length < 2) continue;
      const kindAndFrom = parts[0];
      const to = parts[1];
      const kindEnd = kindAndFrom.indexOf(":");
      const kind = kindEnd >= 0 ? kindAndFrom.slice(0, kindEnd) : "";
      const from = kindEnd >= 0 ? kindAndFrom.slice(kindEnd + 1) : "";
      const targetNode = byId.get(to);
      const targetInProgress = targetNode && statusKey(targetNode) === "in_progress";
      const cls =
        "edge " + kind +
        ((selectedNodeId && (from === selectedNodeId || to === selectedNodeId)) ? " active" : "") +
        ((nextId && to === nextId) ? " next" : "") +
        (targetInProgress ? " flowing" : "");
      pathEl.setAttribute("class", cls);
    }

    if (lastGraph) {
      lastGraph.selectedId = selectedNodeId;
      lastGraph.nextId = nextId;
    }
  }

  // Update cached state
  lastNodeIds = nodes.map((n) => n && n.id ? n.id : "").sort().join(",");
  const nextId2 = snapshot.next && snapshot.next.id ? snapshot.next.id : "";
  for (const n of nodes) {
    if (!n || !n.id) continue;
    lastRenderedState.set(n.id, {
      key: snapshotNodeKey(n),
      deps: Array.isArray(n.dependsOn) ? n.dependsOn.sort().join(",") : "",
      parentId: n.parentId || "",
      wasSelected: selectedNodeId === n.id,
      wasNext: nextId2 === n.id,
    });
  }
  // Remove stale entries
  const currentIds = new Set(nodes.map((n) => n && n.id ? n.id : "").filter(Boolean));
  for (const id of lastRenderedState.keys()) {
    if (!currentIds.has(id)) lastRenderedState.delete(id);
  }

  updateSelection();
  applyVisualOverlays();
  if (selectedNodeId && selectedNodeId !== lastAutoScrollId) {
    lastAutoScrollId = selectedNodeId;
    centerNodeIfOffscreen(selectedNodeId);
  }
}

/* ── Connection state ─────────────────────────────────────────────────── */

let connErrors = 0;

function setConnState(state) {
  if (!elConnDot) return;
  elConnDot.classList.remove("connected", "reconnecting", "disconnected");
  elConnDot.classList.add(state);
  const titles = { connected: "SSE connected", reconnecting: "Reconnecting...", disconnected: "Disconnected" };
  elConnDot.title = titles[state] || "";
}

const es = new EventSource("/events");
es.addEventListener("open", () => {
  connErrors = 0;
  setConnState("connected");
});
es.onmessage = (ev) => {
  connErrors = 0;
  setConnState("connected");
  try { renderIncremental(JSON.parse(ev.data)); } catch {}
};
es.onerror = () => {
  connErrors++;
  setConnState(connErrors >= 5 ? "disconnected" : "reconnecting");
};
