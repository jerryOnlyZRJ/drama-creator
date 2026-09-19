import { buildPromptBestPracticeContext, buildPromptGuidanceSummary } from '../prompting/bestPractices.mjs';

// Map asset node type -> generate reference kind (contract §2.1: image | video | audio).
const KIND_BY_NODE_TYPE = {
  image_asset: 'image',
  video_output: 'video',
  audio_asset: 'audio'
};

// Edge types that connect a prompt/script to a referenceable asset for generation.
const REFERENCE_EDGE_TYPES = new Set(['uses_reference', 'script_uses_asset']);

// Resolve the param defaults declared by the chosen model.
function defaultParamsFor(model) {
  const params = {};
  for (const [key, spec] of Object.entries(model.params || {})) {
    if (spec.default !== undefined) params[key] = spec.default;
  }
  return params;
}

// Build a contract-compliant generate input object for a single task (contract §2.1).
// Pure function: no IO, no mutation of doc.
export function buildGenerateInput(doc, taskId, adapterRef, { capability, model, outputDir, userParams = {}, credential = null } = {}) {
  const task = (doc.tasks || []).find((item) => item.id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const capabilityDecl = (adapterRef.manifest.capabilities || []).find((c) => c.type === capability);
  if (!capabilityDecl) throw new Error(`capability not found in adapter: ${capability}`);
  // OpenAI 兼容类适配器需要 acceptsAnyModel 开关：下游各平台模型名（deepseek-chat / glm-4-plus / qwen-turbo ...）
  // 千差万别，无法在 manifest 里穷举。开启该开关时仅用首个声明的 model 作为参数模板，
  // model id 本身透传给下游 API。
  let modelDecl = capabilityDecl.models?.find((m) => m.id === model);
  if (!modelDecl) {
    if (capabilityDecl.acceptsAnyModel) {
      modelDecl = capabilityDecl.models?.[0] || { params: {} };
    } else {
      throw new Error(`model not found in adapter: ${capability}/${model}`);
    }
  }

  const promptNode = (doc.nodes || []).find((n) => n.id === task.promptNodeId);
  const prompt = promptNode?.metadata?.prompt || '';

  // Derive references from the canvas closure: prompt --(uses_reference|script_uses_asset)--> asset.
  const nodeById = new Map((doc.nodes || []).map((n) => [n.id, n]));
  const references = [];
  for (const edge of doc.edges || []) {
    if (edge.from !== task.promptNodeId) continue;
    if (!REFERENCE_EDGE_TYPES.has(edge.type)) continue;
    // 显式废弃的引用边只作为诊断证据保留，不能继续进入任何生成输入。
    if (!isActiveReferenceEdge(edge)) continue;
    const asset = nodeById.get(edge.to);
    if (!asset || !asset.path) continue;
    const kind = KIND_BY_NODE_TYPE[asset.type];
    if (!kind) continue;
    // role: prefer the edge's semantic role, else the asset's declared role, else generic.
    const role = edge.role || asset.metadata?.role || 'generic';
    references.push({ path: asset.path, role, kind });
  }

  return {
    action: 'generate',
    capability,
    model,
    prompt,
    // 文本模型负责把故事/剧本转成更好的提示词或分镜文本，需要显式注入应用内置创作规范。
    systemPrompt: buildPromptBestPracticeContext({ capability }).systemPrompt,
    promptGuidance: buildPromptGuidanceSummary({ capability }),
    references,
    outputDir,
    params: { ...defaultParamsFor(modelDecl), ...userParams },
    credential
  };
}

function isActiveReferenceEdge(edge) {
  // 生成输入是最终会触发外部模型的合同，必须排除所有历史停用边。
  if (edge.active === false) return false;
  if (edge.status && edge.status !== 'active') return false;
  return !(edge.metadata?.disabledAt || edge.metadata?.inactiveAt || edge.metadata?.inactiveReason);
}
