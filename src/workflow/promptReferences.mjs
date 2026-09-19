export const PROMPT_REFERENCE_EDGE_TYPES = new Set(['uses_reference', 'script_uses_asset']);

export function buildPromptReferences({ nodes = [], edges = [], promptId, edgeTypes = PROMPT_REFERENCE_EDGE_TYPES } = {}) {
  if (!promptId) return [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return edges
    .filter((edge) => edge.from === promptId && edgeTypes.has(edge.type))
    // 旧引用边会被标记为 inactive/diagnostic 保留证据，阅读态和上传顺序必须只展示当前 active 合同。
    .filter(isActivePromptReferenceEdge)
    .map((edge, index) => {
      const asset = nodeById.get(edge.to) || null;
      return {
        edgeId: edge.id,
        assetId: edge.to,
        order: index + 1,
        role: edge.role || asset?.metadata?.role || '',
        placeholder: referencePlaceholderFor(asset, index),
        displayName: referenceDisplayName(asset, index),
        mentionName: referenceMentionName(asset, index)
      };
    });
}

function isActivePromptReferenceEdge(edge) {
  // 同一镜头可能保留多轮诊断引用；UI 阅读态必须和实际投喂包使用同一套 active 过滤规则。
  if (edge.active === false) return false;
  if (edge.status && edge.status !== 'active') return false;
  return !(edge.metadata?.disabledAt || edge.metadata?.inactiveAt || edge.metadata?.inactiveReason);
}

export function referencePlaceholderFor(asset, index) {
  if (asset?.type === 'audio_asset') return `@音频${index + 1}`;
  if (asset?.type === 'video_output') return `@视频${index + 1}`;
  return `@图片${index + 1}`;
}

export function referenceDisplayName(asset, index) {
  const shotNo = shotNoFromNode(asset);
  const title = stringValue(asset?.title);
  if (shotNo && title) return `镜头 ${shotNo} · ${title}`;
  if (shotNo) return `镜头 ${shotNo}`;
  if (title) return title;
  return `参考资源 ${index + 1}`;
}

export function referenceMentionName(asset, index) {
  const shotNo = shotNoFromNode(asset);
  if (shotNo) return `镜头 ${shotNo}`;
  return stringValue(asset?.title) || `参考资源 ${index + 1}`;
}

export function formatPromptDisplayText(promptText, references = []) {
  const raw = String(promptText || '').trim();
  if (!raw) return '当前镜头还没有提示词内容。';
  let rendered = raw;
  // 这里仅生成“阅读态”文本：原始 prompt 仍保留 @图片N，投喂包和即梦自动化继续按原始占位符绑定资源。
  for (const reference of references) {
    const mention = referenceMentionToken(reference.mentionName || reference.displayName);
    rendered = rendered.split(reference.placeholder).join(mention);
  }
  return rendered;
}

export function referenceMentionToken(displayName) {
  return `@${String(displayName || '').replace(/^@+/u, '').trim()}`;
}

export function shotNoFromNode(node) {
  if (!node) return '';
  const shotId = stringValue(node.shotId);
  if (shotId) return shotId.replace(/^shot:/u, '');
  const nodeId = stringValue(node.id);
  const match = nodeId.match(/(?:^|[:_-])(s\d+[a-z]?)(?:[:_-]|$)/iu);
  return match?.[1] || '';
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}
