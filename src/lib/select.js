function normalizeStatus(value) {
  if (!value) return "open";
  return String(value).toLowerCase().trim();
}

export function isNodeDone(node) {
  return normalizeStatus(node?.status) === "done";
}

export function isNodeRunnable(node, graph, now = new Date()) {
  const status = normalizeStatus(node?.status);
  if (status !== "open") return false;
  if (node?.blockedUntil) {
    const until = new Date(node.blockedUntil);
    if (!Number.isNaN(until.getTime()) && until > now) return false;
  }
  if (node?.lock?.runId) {
    // Locked by another run; supervisor should clear stale locks separately.
    return false;
  }

  const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
  if (deps.length === 0) return true;
  const index = new Map((graph?.nodes || []).map((n) => [n.id, n]));
  return deps.every((id) => isNodeDone(index.get(id)));
}

export function selectNextNode(graph, now = new Date()) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const runnable = nodes.filter((n) => isNodeRunnable(n, graph, now));
  const typePriority = {
    verify: 0,
    task: 1,
    plan: 2,
    epic: 2,
    integrate: 3,
    final_verify: 4,
    "final-verify": 4,
  };
  runnable.sort((a, b) => {
    const ta = String(a.type || "").toLowerCase();
    const tb = String(b.type || "").toLowerCase();
    const pa = typePriority[ta] ?? 100;
    const pb = typePriority[tb] ?? 100;
    if (pa !== pb) return pa - pb;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
  return runnable[0] || null;
}
