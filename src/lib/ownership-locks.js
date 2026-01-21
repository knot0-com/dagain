function normalizeMode(value) {
  const mode = String(value || "").toLowerCase().trim();
  return mode === "read" ? "read" : "write";
}

export class OwnershipLockManager {
  constructor() {
    this._locksByNodeId = new Map();
    this._resourceState = new Map();
  }

  normalizeResources(ownership) {
    const raw = Array.isArray(ownership) ? ownership : [];
    const resources = [];
    const seen = new Set();
    for (const item of raw) {
      const v = String(item || "").trim();
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      resources.push(v);
    }
    return resources.length > 0 ? resources : ["__global__"];
  }

  modeForRole(role) {
    const r = String(role || "").trim();
    if (r === "verifier" || r === "researcher") return "read";
    return "write";
  }

  acquire(nodeId, { resources, mode }) {
    const id = String(nodeId || "").trim();
    if (!id) return false;

    const nextMode = normalizeMode(mode);
    let nextResources = this.normalizeResources(resources);
    const wantsGlobal = nextResources.includes("__global__");
    if (wantsGlobal) nextResources = ["__global__"];

    if (this._locksByNodeId.has(id)) this.release(id);

    if (wantsGlobal) {
      for (const state of this._resourceState.values()) {
        if (state.writer && state.writer !== id) return false;
        if (nextMode === "write" && state.readers.size > 0) return false;
      }
    } else {
      const globalState = this._resourceState.get("__global__") || { readers: new Set(), writer: null };
      if (globalState.writer && globalState.writer !== id) return false;
      if (nextMode === "write" && globalState.readers.size > 0) return false;
    }

    for (const resource of nextResources) {
      const state = this._resourceState.get(resource) || { readers: new Set(), writer: null };
      if (nextMode === "read") {
        if (state.writer && state.writer !== id) return false;
        continue;
      }

      if (state.writer && state.writer !== id) return false;
      if (state.readers.size > 0) return false;
    }

    for (const resource of nextResources) {
      const state = this._resourceState.get(resource) || { readers: new Set(), writer: null };
      if (nextMode === "read") state.readers.add(id);
      else state.writer = id;
      this._resourceState.set(resource, state);
    }

    this._locksByNodeId.set(id, { resources: nextResources, mode: nextMode });
    return true;
  }

  release(nodeId) {
    const id = String(nodeId || "").trim();
    if (!id) return;
    const current = this._locksByNodeId.get(id);
    if (!current) return;

    for (const resource of current.resources) {
      const state = this._resourceState.get(resource);
      if (!state) continue;
      if (current.mode === "read") state.readers.delete(id);
      else if (state.writer === id) state.writer = null;

      const hasWriter = Boolean(state.writer);
      const hasReaders = state.readers.size > 0;
      if (!hasWriter && !hasReaders) this._resourceState.delete(resource);
      else this._resourceState.set(resource, state);
    }

    this._locksByNodeId.delete(id);
  }
}
