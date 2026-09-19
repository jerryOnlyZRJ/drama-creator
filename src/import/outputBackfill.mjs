import {
  createEdge,
  normalizeIdPart
} from '../schema/dramaCreatorSchema.mjs';

// Idempotent node insert: skip if a node with the same id already exists.
// Shared by importer (file scan) and executor (adapter output backfill).
export function ensureNode(doc, node) {
  if (!doc.nodes.some((item) => item.id === node.id)) {
    doc.nodes.push(node);
  }
}

// Idempotent edge insert: skip if an edge with the same id already exists.
export function ensureEdge(doc, edge) {
  if (!doc.edges.some((item) => item.id === edge.id)) {
    doc.edges.push(edge);
  }
}

// Link a generated output node back to its shot's task and prompt graph.
// Used both when importing existing files and when an adapter produces new outputs.
export function linkOutputToTask(doc, shotId, outputNodeId, { taskType = 'video', role = 'video_generation' } = {}) {
  const task = doc.tasks.find((item) => item.type === taskType && item.shotId === shotId);
  if (!task) return;

  // Generated artifacts belong to the prompt task, so keep task and graph in sync.
  if (!task.outputNodeIds.includes(outputNodeId)) {
    task.outputNodeIds.push(outputNodeId);
  }
  ensureEdge(doc, createEdge({
    id: `edge:${normalizeIdPart(task.promptNodeId)}:generates:${normalizeIdPart(outputNodeId)}`,
    from: task.promptNodeId,
    to: outputNodeId,
    type: 'generates',
    role
  }));
}
