import { pathExists, readJson, writeJsonAtomic } from "./fs.js";

export function defaultWorkgraph(goalPath, goalHash) {
  const now = new Date().toISOString();
  return {
    version: 1,
    goal: { path: goalPath, hash: goalHash },
    qualityGates: [],
    nodes: [
      {
        id: "plan-000",
        title: "Expand GOAL.md into an executable workgraph",
        type: "plan",
        status: "open",
        dependsOn: [],
        ownership: [],
        acceptance: [
          "Adds 3–10 small, verifiable task/verify nodes",
          "Each node includes ownership, acceptance, and verify steps",
        ],
        verify: [],
        attempts: 0,
        retryPolicy: { maxAttempts: 3 },
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

export async function loadWorkgraph(graphPath) {
  if (!(await pathExists(graphPath))) return null;
  const graph = await readJson(graphPath);
  if (!graph || typeof graph !== "object") throw new Error("Invalid workgraph.json: not an object");
  if (!Array.isArray(graph.nodes)) graph.nodes = [];
  if (!Array.isArray(graph.qualityGates)) graph.qualityGates = [];
  return graph;
}

export async function saveWorkgraph(graphPath, graph) {
  graph.updatedAt = new Date().toISOString();
  await writeJsonAtomic(graphPath, graph);
}

export function countByStatus(nodes) {
  const out = {};
  for (const node of nodes) {
    const s = node?.status || "unknown";
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}
