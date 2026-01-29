// Input — `blessed`, dagain DB helpers, and subprocess CLI calls. If this file changes, update this header and the folder Markdown.
// Output — `runChatTui()` terminal UI for live DAG + chat. If this file changes, update this header and the folder Markdown.
// Position — TUI layer (interactive-only) for `dagain chat` and `dagain tui`. If this file changes, update this header and the folder Markdown.

import blessed from "blessed";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { dagainPaths, loadConfig } from "../lib/config.js";
import { pathExists } from "../lib/fs.js";
import { loadDashboardSnapshot } from "../lib/dashboard.js";
import { kvGet, kvPut } from "../lib/db/kv.js";
import { readSupervisorLock } from "../lib/lock.js";

function truncateText(value, maxLen) {
  const s = String(value || "");
  const n = Number(maxLen);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (!limit) return "";
  if (s.length <= limit) return s;
  return s.slice(0, Math.max(0, limit - 1)) + "…";
}

async function readTextTruncated(filePath, maxChars) {
  try {
    const text = await readFile(filePath, "utf8");
    if (text.length <= maxChars) return text;
    return text.slice(text.length - maxChars);
  } catch {
    return "";
  }
}

function safeJsonParse(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function formatNodeLine(node) {
  const id = node?.id || "(missing-id)";
  const title = node?.title || "(untitled)";
  const type = node?.type || "(type?)";
  const status = node?.status || "(status?)";
  return `${id} [${type}] (${status}) — ${title}`;
}

function nowIso() {
  return new Date().toISOString();
}

function dagainBinPath() {
  return fileURLToPath(new URL("../../bin/dagain.js", import.meta.url));
}

function runCliCapture({ cwd, args }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [dagainBinPath(), ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => resolve({ code: code ?? 0, signal: signal ?? null, stdout, stderr }));
    child.on("error", (err) =>
      resolve({ code: 1, signal: null, stdout: "", stderr: String(err?.message || err || "spawn error") }),
    );
  });
}

async function startSupervisorDetached({ rootDir, log }) {
  const paths = dagainPaths(rootDir);
  const lock = await readSupervisorLock(paths.lockPath).catch(() => null);
  if (lock?.pid && String(lock.host || "").trim() === os.hostname()) {
    log(`Supervisor already running pid=${lock.pid}.`);
    return;
  }

  const child = spawn(process.execPath, [dagainBinPath(), "run", "--no-live", "--no-color"], {
    cwd: paths.rootDir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.unref?.();
  log(`Started supervisor pid=${child.pid}`);
}

async function stopSupervisor({ rootDir, flags, log }) {
  const args = ["stop"];
  if (typeof flags.signal === "string" && flags.signal.trim()) {
    args.push("--signal", flags.signal.trim());
  }
  const res = await runCliCapture({ cwd: rootDir, args });
  const text = String(res.stdout || res.stderr || "").trim();
  if (text) log(text);
  else log(res.code === 0 ? "Stopped." : `stop failed (exit ${res.code})`);
}

async function enqueueControl({ rootDir, sub, extraArgs, log }) {
  const res = await runCliCapture({ cwd: rootDir, args: ["control", sub, ...extraArgs] });
  const text = String(res.stdout || res.stderr || "").trim();
  if (text) log(text);
  else log(res.code === 0 ? `control ${sub}: ok` : `control ${sub}: failed (exit ${res.code})`);
}

export async function runChatTui(rootDir, flags) {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error("TUI requires a TTY (interactive terminal). Use `dagain chat --plain` instead.");
  }

  const paths = dagainPaths(rootDir);
  if (!(await pathExists(paths.dbPath))) throw new Error("Missing .dagain/state.sqlite. Run `dagain init`.");
  const config = await loadConfig(paths.configPath);
  if (!config) throw new Error("Missing .dagain/config.json. Run `dagain init`.");

  const noLlm = Boolean(flags["no-llm"]) || Boolean(flags.noLlm);
  const runnerOverride = typeof flags.runner === "string" ? flags.runner.trim() : "";
  const roleOverride = typeof flags.role === "string" ? flags.role.trim() : "planner";

  const headerHeight = 5;
  const inputHeight = 3;
  const guiUrl = "http://127.0.0.1:3876";

  const screenOptions = { smartCSR: true, title: "dagain" };
  const explicitTerminal =
    typeof process.env.DAGAIN_TUI_TERMINAL === "string" ? process.env.DAGAIN_TUI_TERMINAL.trim() : "";
  if (explicitTerminal) screenOptions.terminal = explicitTerminal;
  else if (process.env.TERM === "screen-256color") screenOptions.terminal = "xterm-256color";

  const screen = blessed.screen(screenOptions);
  const header = blessed.box({
    top: 0,
    left: 0,
    height: headerHeight,
    width: "100%",
    tags: true,
    border: "line",
    label: "dagain",
  });
  const logBox = blessed.log({
    top: headerHeight,
    left: 0,
    bottom: inputHeight,
    width: "55%",
    border: "line",
    label: "chat",
    keys: true,
    mouse: true,
    tags: true,
    vi: true,
    scrollback: 10_000,
    alwaysScroll: true,
    scrollbar: { ch: " ", inverse: true },
  });
  const rightPane = blessed.box({
    top: headerHeight,
    left: "55%",
    bottom: inputHeight,
    width: "45%",
  });
  const dagList = blessed.list({
    top: 0,
    left: 0,
    height: "55%",
    width: "100%",
    border: "line",
    label: "dag",
    keys: true,
    mouse: true,
    tags: true,
    vi: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: " ", inverse: true },
    style: { selected: { bg: "blue" } },
  });
  const nodeLogBox = blessed.box({
    top: "55%",
    left: 0,
    bottom: 0,
    width: "100%",
    border: "line",
    label: "node log",
    tags: true,
    keys: true,
    mouse: true,
    vi: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: " ", inverse: true },
  });
  const input = blessed.textbox({
    bottom: 0,
    left: 0,
    height: inputHeight,
    width: "100%",
    border: "line",
    label: "input",
    inputOnFocus: true,
  });

  screen.append(header);
  screen.append(logBox);
  screen.append(rightPane);
  rightPane.append(dagList);
  rightPane.append(nodeLogBox);
  screen.append(input);

  function log(line) {
    logBox.log(String(line || ""));
    screen.render();
  }

  log("dagain tui chat (type /help, tab to cycle focus, Ctrl+C to quit)");

  let dagListNodeIds = [];
  let selectedNodeId = "";
  let lastLogAtMs = 0;

  function statusBadge(node) {
    if (node?.lock?.runId) return "RUN ";
    const s = String(node?.status || "").toLowerCase();
    if (s === "done") return "DONE";
    if (s === "failed") return "FAIL";
    if (s === "needs_human") return "HUMN";
    return "OPEN";
  }

  function formatDagLine({ node, depth, nextId }) {
    const badge = statusBadge(node);
    const id = node?.id || "(missing-id)";
    const type = node?.type ? truncateText(node.type, 10) : "";
    const title = node?.title ? truncateText(node.title, 34) : "";
    const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
    const depsText = deps.length > 0 ? ` <- ${truncateText(deps.join(","), 44)}` : "";
    const idText = nextId && id === nextId ? `{bold}${id}{/bold}` : id;
    const indent = "  ".repeat(Math.max(0, depth));
    return `${indent}${badge} ${idText}${type ? ` [${type}]` : ""}${title ? ` ${title}` : ""}${depsText}`;
  }

  function buildDagItems(nodes, nextId) {
    const nodesById = new Map();
    for (const n of nodes) nodesById.set(n.id, n);

    const childrenByParent = new Map();
    for (const n of nodes) {
      const parentKey = n.parentId ?? "__root__";
      const arr = childrenByParent.get(parentKey) || [];
      arr.push(n);
      childrenByParent.set(parentKey, arr);
    }
    for (const arr of childrenByParent.values()) arr.sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || "")));

    const seen = new Set();
    const items = [];

    function walk(node, depth) {
      if (!node?.id) return;
      if (seen.has(node.id)) return;
      seen.add(node.id);
      items.push({ nodeId: node.id, label: formatDagLine({ node, depth, nextId }) });
      const children = childrenByParent.get(node.id) || [];
      for (const child of children) walk(child, depth + 1);
    }

    const roots = childrenByParent.get("__root__") || [];
    for (const r of roots) walk(r, 0);
    for (const n of nodes) walk(n, 0);

    return items;
  }

  async function refreshNodeLog({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastLogAtMs < 1000) return;
    lastLogAtMs = now;

    const nodeId = String(selectedNodeId || "").trim();
    const nodes = Array.isArray(lastSnapshot?.nodes) ? lastSnapshot.nodes : [];
    const node = nodeId ? nodes.find((n) => n.id === nodeId) : null;
    if (!node) {
      nodeLogBox.setContent("Select a node in the dag panel to view its log.");
      return;
    }

    const lockRunId = typeof node?.lock?.runId === "string" ? node.lock.runId : "";
    let stdoutRel = "";
    if (lockRunId) {
      const stdoutPathAbs = path.join(paths.runsDir, lockRunId, "stdout.log");
      stdoutRel = path.relative(paths.rootDir, stdoutPathAbs);
    } else {
      const stdoutRow = await kvGet({ dbPath: paths.dbPath, nodeId, key: "out.last_stdout_path" }).catch(() => null);
      stdoutRel = typeof stdoutRow?.value_text === "string" ? stdoutRow.value_text.trim() : "";
    }
    const stdoutPathAbs = stdoutRel ? path.join(paths.rootDir, stdoutRel) : "";
    const stdout = stdoutPathAbs ? await readTextTruncated(stdoutPathAbs, 10_000) : "";
    const status = node.lock?.runId ? "running" : String(node.status || "open");
    const meta = `${node.id} [${node.type || "?"}] (${status}) attempts=${node.attempts ?? 0}`;
    const logLine = stdoutRel ? `log: ${stdoutRel}` : "log: (none)";
    nodeLogBox.setContent(`${meta}\n${logLine}\n\n${stdout || "(empty)"}`);
    nodeLogBox.setScrollPerc(100);
  }

  function renderSnapshot(snapshot) {
    const counts = snapshot?.counts && typeof snapshot.counts === "object" ? snapshot.counts : {};
    const countsText = Object.keys(counts)
      .sort()
      .map((k) => `${k}:${counts[k]}`)
      .join(" ");
    const nextText = snapshot?.next?.id ? `${snapshot.next.id} (${snapshot.next.type || "?"})` : "(none)";
    const sup = snapshot?.supervisor?.pid ? `pid=${snapshot.supervisor.pid} host=${snapshot.supervisor.host || "?"}` : "(none)";
    const line1 = `counts: ${truncateText(countsText, 80)}  next: ${truncateText(nextText, 60)}`;
    const line2 = `supervisor: ${truncateText(sup, 80)}`;
    const line3 = `gui: ${guiUrl}`;
    header.setContent(`${line1}\n${line2}\n${line3}`);

    const list = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
    const nextId = typeof snapshot?.next?.id === "string" ? snapshot.next.id : "";
    const items = buildDagItems(list, nextId);
    const prevScroll = typeof dagList.getScroll === "function" ? dagList.getScroll() : 0;
    dagListNodeIds = items.map((i) => i.nodeId);
    dagList.setItems(items.map((i) => i.label));

    const desiredSelected =
      selectedNodeId && dagListNodeIds.includes(selectedNodeId)
        ? selectedNodeId
        : nextId && dagListNodeIds.includes(nextId)
          ? nextId
          : dagListNodeIds[0] || "";
    selectedNodeId = desiredSelected;
    const idx = selectedNodeId ? dagListNodeIds.indexOf(selectedNodeId) : -1;
    if (idx >= 0) dagList.select(idx);
    if (typeof dagList.setScroll === "function") dagList.setScroll(prevScroll);
  }

  let lastSnapshot = null;
  let pollTimer = null;
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const snap = await loadDashboardSnapshot({ paths });
      lastSnapshot = snap;
      renderSnapshot(snap);
      await refreshNodeLog();
      screen.render();
    } catch (error) {
      log(`snapshot error: ${error?.message || String(error)}`);
    } finally {
      polling = false;
    }
  }

  pollTimer = setInterval(poll, 500);
  await poll();

  dagList.on("select", async (_item, index) => {
    const i = Number(index);
    const next = Number.isFinite(i) ? dagListNodeIds[i] : "";
    if (next) selectedNodeId = next;
    await refreshNodeLog({ force: true });
    screen.render();
  });

  dagList.on("keypress", async () => {
    const idx = typeof dagList.selected === "number" ? dagList.selected : -1;
    const next = idx >= 0 ? dagListNodeIds[idx] : "";
    if (!next || next === selectedNodeId) return;
    selectedNodeId = next;
    await refreshNodeLog({ force: true });
    screen.render();
  });

  async function showMemory() {
    const chatNodeId = "__run__";
    const chatRollupRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.rollup" }).catch(() => null);
    const chatSummaryRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.summary" }).catch(() => null);
    const chatLastOpsRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.last_ops" }).catch(() => null);
    const chatTurnsRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.turns" }).catch(() => null);
    const rollup = typeof chatRollupRow?.value_text === "string" ? chatRollupRow.value_text.trim() : "";
    const summary = typeof chatSummaryRow?.value_text === "string" ? chatSummaryRow.value_text.trim() : "";
    const lastOpsTextRaw = typeof chatLastOpsRow?.value_text === "string" ? chatLastOpsRow.value_text.trim() : "";
    const lastOpsText = lastOpsTextRaw === "[]" ? "" : lastOpsTextRaw;
    const turnsText = typeof chatTurnsRow?.value_text === "string" ? chatTurnsRow.value_text.trim() : "";
    const turnsParsed = safeJsonParse(turnsText);
    const turns = Array.isArray(turnsParsed) ? turnsParsed : [];
    const hasTurns = turns.length > 0;

    if (!rollup && !summary && !lastOpsText && !hasTurns) {
      log("Chat memory: (empty)");
      return;
    }
    if (rollup) log(`rolling_summary: ${rollup}`);
    if (summary) log(`summary: ${summary}`);
    if (lastOpsText) log(`last_ops: ${lastOpsText}`);
    if (hasTurns) log(`turns: ${turns.length}`);
  }

  async function forgetMemory() {
    const chatNodeId = "__run__";
    const now = nowIso();
    await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.rollup", valueText: "", nowIso: now });
    await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.summary", valueText: "", nowIso: now });
    await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.last_ops", valueText: "", nowIso: now });
    await kvPut({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.turns", valueText: "[]", nowIso: now });
    log("Cleared chat memory.");
  }

  async function runRouter(line) {
    const counts = lastSnapshot?.counts || {};
    const next = lastSnapshot?.next || null;
    const nodeLines = (Array.isArray(lastSnapshot?.nodes) ? lastSnapshot.nodes : [])
      .map((n) => formatNodeLine(n))
      .slice(0, 40)
      .join("\n");

    const activityPath = path.join(paths.memoryDir, "activity.log");
    const recent = await readTextTruncated(activityPath, 4_000);

    const chatNodeId = "__run__";
    const chatRollupRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.rollup" }).catch(() => null);
    const chatSummaryRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.summary" }).catch(() => null);
    const chatLastOpsRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.last_ops" }).catch(() => null);
    const chatTurnsRow = await kvGet({ dbPath: paths.dbPath, nodeId: chatNodeId, key: "chat.turns" }).catch(() => null);

    const chatRollup = typeof chatRollupRow?.value_text === "string" ? chatRollupRow.value_text.trim() : "";
    const chatSummary = typeof chatSummaryRow?.value_text === "string" ? chatSummaryRow.value_text.trim() : "";
    const chatLastOpsText = typeof chatLastOpsRow?.value_text === "string" ? chatLastOpsRow.value_text.trim() : "";
    const chatTurnsParsed = safeJsonParse(typeof chatTurnsRow?.value_text === "string" ? chatTurnsRow.value_text : "");
    const chatTurns = Array.isArray(chatTurnsParsed) ? chatTurnsParsed : [];

    let memorySection = "";
    if (chatRollup || chatSummary || chatLastOpsText || chatTurns.length > 0) {
      const lines = [];
      lines.push("Chat memory (kv __run__):");
      if (chatRollup) lines.push(`- rolling_summary: ${truncateText(chatRollup, 800)}`);
      if (chatSummary) lines.push(`- summary: ${truncateText(chatSummary, 400)}`);
      if (chatLastOpsText) lines.push(`- last_ops: ${truncateText(chatLastOpsText, 800)}`);
      if (chatTurns.length > 0) {
        lines.push("- recent turns:");
        const recentTurns = chatTurns.slice(Math.max(0, chatTurns.length - 6));
        for (const t of recentTurns) {
          const u = truncateText(t?.user || "", 200);
          const a = truncateText(t?.reply || "", 200);
          if (u) lines.push(`  - user: ${u}`);
          if (a) lines.push(`    assistant: ${a}`);
        }
      }
      memorySection = lines.join("\n");
    }

    const prompt =
      `You are Dagain Chat Router.\n` +
      `Return JSON in <result> with {status, summary, data:{reply, ops, rollup}}.\n` +
      `Allowed ops:\n` +
      `- {"type":"status"}\n` +
      `- {"type":"control.pause"}\n` +
      `- {"type":"control.resume"}\n` +
      `- {"type":"control.setWorkers","workers":3}\n` +
      `- {"type":"control.replan"}\n` +
      `- {"type":"control.cancel","nodeId":"task-001"}\n` +
      `- {"type":"node.add","id":"task-001","title":"...","nodeType":"task","parentId":"plan-000","status":"open","runner":null,"inputs":[{"nodeId":"task-000","key":"out.summary"}],"ownership":[{"resources":["__global__"],"mode":"read"}],"acceptance":["..."],"verify":["..."],"retryPolicy":{"maxAttempts":2},"dependsOn":["task-000"]}\n` +
      `- {"type":"node.update","id":"task-001","title":"...","runner":null,"inputs":[],"ownership":[],"acceptance":[],"verify":[],"retryPolicy":{"maxAttempts":2},"force":false}\n` +
      `- {"type":"node.setStatus","id":"task-001","status":"open|done|failed|needs_human","force":false}\n` +
      `- {"type":"dep.add","nodeId":"task-002","dependsOnId":"task-001","requiredStatus":"done|terminal"}\n` +
      `- {"type":"dep.remove","nodeId":"task-002","dependsOnId":"task-001"}\n` +
      `- {"type":"run.start"}\n` +
      `- {"type":"run.stop","signal":"SIGTERM"}\n` +
      `Rules:\n` +
      `- Do not tell the user to run CLI commands; emit ops and Dagain will execute them.\n` +
      `- Use control.* ops for supervisor controls (pause/resume/workers/replan/cancel).\n` +
      `- Always include data.rollup as an updated rolling summary (<= 800 chars). If Chat memory includes rolling_summary, update it.\n` +
      `- Prefer ops for status checks and simple replanning.\n` +
      `- If unclear, ask one clarifying question in reply and ops=[].\n` +
      (memorySection ? `\n${memorySection}\n` : "\n") +
      `\n` +
      `State counts: ${JSON.stringify(counts)}\n` +
      `Next runnable: ${next ? formatNodeLine(next) : "(none)"}\n` +
      `Nodes (first 40):\n${nodeLines}\n` +
      (recent ? `\nRecent activity (tail):\n${recent}\n` : "") +
      `\nUser: ${line}\n`;

    const args = ["microcall", "--prompt", prompt, "--role", roleOverride];
    if (runnerOverride) args.push("--runner", runnerOverride);

    const res = await runCliCapture({ cwd: rootDir, args });
    if (res.code !== 0) throw new Error(String(res.stderr || res.stdout || `microcall failed (exit ${res.code})`));
    const parsed = safeJsonParse(String(res.stdout || ""));
    if (!parsed) throw new Error("Router returned invalid JSON.");

    return { parsed, chatTurns };
  }

  async function applyOp(op) {
    const type = typeof op?.type === "string" ? op.type.trim() : "";
    if (!type) return;

    if (type === "status") {
      const res = await runCliCapture({ cwd: rootDir, args: ["status"] });
      const text = String(res.stdout || res.stderr || "").trim();
      if (text) log(text);
      return;
    }

    if (type === "control.pause") return enqueueControl({ rootDir, sub: "pause", extraArgs: [], log });
    if (type === "control.resume") return enqueueControl({ rootDir, sub: "resume", extraArgs: [], log });
    if (type === "control.setWorkers")
      return enqueueControl({ rootDir, sub: "set-workers", extraArgs: ["--workers", String(op?.workers ?? "")], log });
    if (type === "control.replan") return enqueueControl({ rootDir, sub: "replan", extraArgs: [], log });
    if (type === "control.cancel")
      return enqueueControl({
        rootDir,
        sub: "cancel",
        extraArgs: ["--node", typeof op?.nodeId === "string" ? op.nodeId : ""],
        log,
      });

    if (type === "node.add") {
      const args = ["node", "add", "--id", typeof op?.id === "string" ? op.id : ""];
      if (typeof op?.title === "string") args.push("--title", op.title);
      if (typeof op?.nodeType === "string") args.push("--type", op.nodeType);
      if (typeof op?.status === "string") args.push("--status", op.status);
      if (typeof op?.parentId === "string") args.push("--parent", op.parentId);
      if (typeof op?.runner === "string" && op.runner.trim()) args.push("--runner", op.runner.trim());
      if (Object.prototype.hasOwnProperty.call(op, "inputs")) args.push("--inputs", JSON.stringify(op.inputs ?? []));
      if (Object.prototype.hasOwnProperty.call(op, "ownership")) args.push("--ownership", JSON.stringify(op.ownership ?? []));
      if (Object.prototype.hasOwnProperty.call(op, "acceptance")) args.push("--acceptance", JSON.stringify(op.acceptance ?? []));
      if (Object.prototype.hasOwnProperty.call(op, "verify")) args.push("--verify", JSON.stringify(op.verify ?? []));
      if (Object.prototype.hasOwnProperty.call(op, "retryPolicy")) args.push("--retry-policy", JSON.stringify(op.retryPolicy ?? null));
      if (Object.prototype.hasOwnProperty.call(op, "dependsOn")) args.push("--depends-on", JSON.stringify(op.dependsOn ?? []));
      const res = await runCliCapture({ cwd: rootDir, args });
      const text = String(res.stdout || res.stderr || "").trim();
      if (text) log(text);
      else log("node.add ok");
      return;
    }

    if (type === "node.update") {
      const args = ["node", "update", "--id", typeof op?.id === "string" ? op.id : ""];
      if (Object.prototype.hasOwnProperty.call(op, "title") && typeof op.title === "string") args.push("--title", op.title);
      if (Object.prototype.hasOwnProperty.call(op, "nodeType") && typeof op.nodeType === "string") args.push("--type", op.nodeType);
      if (Object.prototype.hasOwnProperty.call(op, "parentId") && typeof op.parentId === "string") args.push("--parent", op.parentId);
      if (Object.prototype.hasOwnProperty.call(op, "runner")) {
        const r = typeof op.runner === "string" ? op.runner.trim() : "";
        args.push("--runner", r);
      }
      if (Object.prototype.hasOwnProperty.call(op, "inputs")) args.push("--inputs", JSON.stringify(op.inputs ?? []));
      if (Object.prototype.hasOwnProperty.call(op, "ownership")) args.push("--ownership", JSON.stringify(op.ownership ?? []));
      if (Object.prototype.hasOwnProperty.call(op, "acceptance")) args.push("--acceptance", JSON.stringify(op.acceptance ?? []));
      if (Object.prototype.hasOwnProperty.call(op, "verify")) args.push("--verify", JSON.stringify(op.verify ?? []));
      if (Object.prototype.hasOwnProperty.call(op, "retryPolicy")) args.push("--retry-policy", JSON.stringify(op.retryPolicy ?? null));
      if (op?.force) args.push("--force");
      const res = await runCliCapture({ cwd: rootDir, args });
      const text = String(res.stdout || res.stderr || "").trim();
      if (text) log(text);
      else log("node.update ok");
      return;
    }

    if (type === "node.setStatus") {
      const args = ["node", "set-status", "--id", typeof op?.id === "string" ? op.id : "", "--status", typeof op?.status === "string" ? op.status : ""];
      if (op?.force) args.push("--force");
      const res = await runCliCapture({ cwd: rootDir, args });
      const text = String(res.stdout || res.stderr || "").trim();
      if (text) log(text);
      else log("node.setStatus ok");
      return;
    }

    if (type === "dep.add") {
      const args = ["dep", "add", "--node", typeof op?.nodeId === "string" ? op.nodeId : "", "--depends-on", typeof op?.dependsOnId === "string" ? op.dependsOnId : ""];
      if (typeof op?.requiredStatus === "string" && op.requiredStatus.trim()) args.push("--required-status", op.requiredStatus.trim());
      const res = await runCliCapture({ cwd: rootDir, args });
      const text = String(res.stdout || res.stderr || "").trim();
      if (text) log(text);
      else log("dep.add ok");
      return;
    }

    if (type === "dep.remove") {
      const args = ["dep", "remove", "--node", typeof op?.nodeId === "string" ? op.nodeId : "", "--depends-on", typeof op?.dependsOnId === "string" ? op.dependsOnId : ""];
      const res = await runCliCapture({ cwd: rootDir, args });
      const text = String(res.stdout || res.stderr || "").trim();
      if (text) log(text);
      else log("dep.remove ok");
      return;
    }

    if (type === "run.start") return startSupervisorDetached({ rootDir, log });
    if (type === "run.stop") return stopSupervisor({ rootDir, flags: { signal: op?.signal }, log });
  }

  async function handleLine(lineRaw) {
    const line = String(lineRaw || "").trim();
    if (!line) return false;
    if (line === "/exit" || line === "/quit") return true;

    if (line === "/help") {
      log(
        [
          "Commands:",
          "- /status",
          "- /run",
          "- /stop",
          "- /pause",
          "- /resume",
          "- /workers <n>",
          "- /replan",
          "- /cancel <nodeId>",
          "- /artifacts [nodeId]",
          "- /memory",
          "- /forget",
          "- /exit",
        ].join("\n"),
      );
      return false;
    }

    if (line === "/status") {
      const res = await runCliCapture({ cwd: rootDir, args: ["status"] });
      const text = String(res.stdout || res.stderr || "").trim();
      if (text) log(text);
      return false;
    }

    if (line.startsWith("/artifacts")) {
      const parts = line.split(/\s+/).filter(Boolean);
      const nodeId = parts[1] || "";
      const runsRel = path.relative(paths.rootDir, paths.runsDir) || ".dagain/runs";
      const activityRel = path.relative(paths.rootDir, path.join(paths.memoryDir, "activity.log")) || ".dagain/memory/activity.log";
      log(`runs: ${runsRel}`);
      log(`activity: ${activityRel}`);

      if (nodeId) {
        const stdoutRow = await kvGet({ dbPath: paths.dbPath, nodeId, key: "out.last_stdout_path" }).catch(() => null);
        const resultRow = await kvGet({ dbPath: paths.dbPath, nodeId, key: "out.last_result_path" }).catch(() => null);
        const stdoutPath = typeof stdoutRow?.value_text === "string" ? stdoutRow.value_text.trim() : "";
        const resultPath = typeof resultRow?.value_text === "string" ? resultRow.value_text.trim() : "";
        if (!stdoutPath && !resultPath) {
          log(`No recorded artifacts for node: ${nodeId}`);
        } else {
          if (stdoutPath) log(`last stdout: ${stdoutPath}`);
          if (resultPath) log(`last result: ${resultPath}`);
        }
      } else {
        const runIds = (await readdir(paths.runsDir).catch(() => [])).filter(Boolean).sort();
        const recent = runIds.slice(-5);
        if (recent.length > 0) {
          log("recent runs:");
          for (const id of recent) log(`- ${id}`);
        }
      }
      return false;
    }

    if (line === "/run" || line === "/run.start") {
      await startSupervisorDetached({ rootDir, log });
      return false;
    }

    if (line === "/stop" || line === "/run.stop") {
      await stopSupervisor({ rootDir, flags, log });
      return false;
    }

    if (line === "/run.status") {
      const lock = await readSupervisorLock(paths.lockPath);
      if (!lock) log("No supervisor lock found.");
      else log(`Supervisor lock pid=${lock.pid || "?"} host=${lock.host || "?"}`);
      return false;
    }

    if (line === "/pause") {
      await enqueueControl({ rootDir, sub: "pause", extraArgs: [], log });
      return false;
    }

    if (line === "/resume") {
      await enqueueControl({ rootDir, sub: "resume", extraArgs: [], log });
      return false;
    }

    if (line.startsWith("/workers")) {
      const parts = line.split(/\s+/).filter(Boolean);
      const n = parts[1] || "";
      await enqueueControl({ rootDir, sub: "set-workers", extraArgs: ["--workers", n], log });
      return false;
    }

    if (line === "/replan") {
      await enqueueControl({ rootDir, sub: "replan", extraArgs: [], log });
      return false;
    }

    if (line.startsWith("/cancel")) {
      const parts = line.split(/\s+/).filter(Boolean);
      const nodeId = parts[1] || "";
      await enqueueControl({ rootDir, sub: "cancel", extraArgs: ["--node", nodeId], log });
      return false;
    }

    if (line === "/memory") {
      await showMemory();
      return false;
    }

    if (line === "/forget") {
      await forgetMemory();
      return false;
    }

    if (line === "/node.add") {
      log('Tip: use natural language, or run `dagain node add --id=... --title="..." --parent=plan-000`.');
      return false;
    }

    if (line === "/node.set-status") {
      log("Tip: run `dagain node set-status --id=<id> --status=<open|done|failed|needs_human>`.");
      return false;
    }

    if (!line.startsWith("/") && /^pause(\\s+launching)?$/i.test(line)) {
      await enqueueControl({ rootDir, sub: "pause", extraArgs: [], log });
      return false;
    }

    if (!line.startsWith("/") && noLlm) {
      log("LLM disabled. Use /help or /status.");
      return false;
    }

    try {
      const { parsed, chatTurns } = await runRouter(line);
      const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : null;
      const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
      if (reply) log(reply);

      const opsRaw = data?.ops;
      const ops = Array.isArray(opsRaw) ? opsRaw : [];
      for (const op of ops) {
        try {
          await applyOp(op);
        } catch (error) {
          log(`op error: ${error?.message || String(error)}`);
        }
      }

      try {
        const now = nowIso();
        const storedOpsText = JSON.stringify(ops);
        const turn = {
          at: now,
          user: truncateText(line, 800),
          reply: truncateText(reply, 1200),
          ops: ops.map((o) => (typeof o?.type === "string" ? o.type : null)).filter(Boolean),
        };
        const nextTurns = chatTurns.concat([turn]).slice(-10);

        const rollup = typeof data?.rollup === "string" ? data.rollup.trim() : "";
        if (rollup) {
          await kvPut({ dbPath: paths.dbPath, nodeId: "__run__", key: "chat.rollup", valueText: truncateText(rollup, 4000), nowIso: now });
        }
        await kvPut({ dbPath: paths.dbPath, nodeId: "__run__", key: "chat.summary", valueText: truncateText(reply, 400), nowIso: now });
        await kvPut({ dbPath: paths.dbPath, nodeId: "__run__", key: "chat.last_ops", valueText: truncateText(storedOpsText, 4000), nowIso: now });
        await kvPut({ dbPath: paths.dbPath, nodeId: "__run__", key: "chat.turns", valueText: JSON.stringify(nextTurns), nowIso: now });
      } catch (error) {
        log(`Chat memory error: ${error?.message || String(error)}`);
      }
    } catch (error) {
      log(`Chat error: ${error?.message || String(error)}`);
    }

    return false;
  }

  function cleanupAndExit() {
    if (pollTimer) clearInterval(pollTimer);
    try {
      screen.destroy();
    } catch {
      // ignore
    }
  }

  let exiting = false;
  function exitNow() {
    if (exiting) return;
    exiting = true;
    cleanupAndExit();
    process.exit(0);
  }

  const focusOrder = [input, dagList, nodeLogBox];
  function cycleFocus(delta) {
    const focused = screen.focused;
    const idx = focusOrder.indexOf(focused);
    const nextIdx = idx === -1 ? 0 : (idx + delta + focusOrder.length) % focusOrder.length;
    focusOrder[nextIdx]?.focus?.();
    screen.render();
  }

  screen.key(["tab"], () => cycleFocus(1));
  screen.key(["S-tab"], () => cycleFocus(-1));
  screen.key(["escape"], () => {
    input.focus();
    screen.render();
  });

  screen.key(["C-c"], exitNow);
  screen.program.key(["C-c"], exitNow);
  process.on("SIGINT", exitNow);

  input.on("submit", async (value) => {
    const line = String(value || "").trim();
    input.clearValue();
    screen.render();
    if (!line) return input.focus();
    log(`> ${line}`);
    const shouldExit = await handleLine(line);
    if (shouldExit) {
      cleanupAndExit();
      process.exit(0);
    }
    input.focus();
  });

  input.key(["enter"], () => {
    input.submit();
  });

  input.focus();
  screen.render();
}
