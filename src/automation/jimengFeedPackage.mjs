import { isAbsolute, resolve } from 'node:path';
import { buildPromptGuidanceSummary } from '../prompting/bestPractices.mjs';
import { resolveJimengModel } from './jimengModels.mjs';

export const JIMENG_TARGET_URL = 'https://jimeng.jianying.com/ai-tool/generate?enter_from=ai_feature&from_page=explore&ai_feature_name=video';
export const JIMENG_AUDIO_TARGET_URL = 'https://jimeng.jianying.com/ai-tool/generate?enter_from=ai_feature&from_page=explore&ai_feature_name=audio&type=audio';

const REFERENCE_EDGE_TYPES = new Set(['uses_reference', 'script_uses_asset']);
const JIMENG_REFERENCE_NODE_TYPES = new Map([
  ['image_asset', { kind: 'image', token: '图片', rank: 0 }],
  ['audio_asset', { kind: 'audio', token: '音频', rank: 1 }]
]);
const APP_CACHE_PREFIX = 'app-cache/';

const REQUIRED_GATES = [
  'reference_asset_gate',
  'resource_mention_binding_gate',
  'pre_submit_confirmation',
  'submission_success_gate',
  'download_validation'
];

// 生成给即梦浏览器自动化执行器消费的只读投喂包。它不执行上传、不点击生成，
// 只把当前视频或音频任务的输入、参考资源顺序和人工确认门禁固化成稳定 JSON。
export function createJimengFeedPackage(doc, taskId, {
  episodeRoot = doc?.episode?.path || '',
  projectRoot = inferProjectRootFromEpisodeRoot(episodeRoot),
  resourceCacheDir = '',
  modelDefault = null,
  jimengSpaceName = ''
} = {}) {
  const task = (doc.tasks || []).find((item) => item.id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (!['video', 'audio'].includes(task.type)) {
    throw new Error('Jimeng browser automation only supports video or audio tasks');
  }

  const promptNode = (doc.nodes || []).find((node) => node.id === task.promptNodeId);
  if (!promptNode) throw new Error(`prompt node not found: ${task.promptNodeId}`);

  const isAudio = task.type === 'audio';
  // 配音生成输入框只能放要说出的台词；音色描述、角色边界和 QC 要求保留在项目卡片中。
  const rawPrompt = isAudio
    ? resolveAudioSpokenText(task, promptNode)
    : (typeof promptNode.metadata?.prompt === 'string' ? promptNode.metadata.prompt : '');
  const { prompt, ...promptSanitization } = isAudio
    ? sanitizeJimengAudioPrompt(rawPrompt)
    : sanitizeJimengPrompt(rawPrompt);
  const linkedVoiceAssetId = isAudio ? resolveLinkedVoiceAssetId(task, promptNode) : '';
  const audioVoiceReference = linkedVoiceAssetId
    ? resolveApprovedPublicVoiceReference(doc, linkedVoiceAssetId, { episodeRoot, projectRoot, resourceCacheDir })
    : null;
  const references = isAudio
    ? (audioVoiceReference ? [audioVoiceReference] : [])
    : collectJimengReferences(doc, promptNode.id, { episodeRoot, projectRoot, resourceCacheDir });
  const warnings = isAudio ? [] : collectWarnings(prompt, references);
  const forcedAudioLock = isAudio ? false : requiresForcedAudioLock(task, promptNode, references);
  // 只有无法靠后期配音解决的可见角色对白才升级普通 2.0；BGM、画外音和可替换音轨继续走默认模型。
  const jimengModel = isAudio
    ? null
    : resolveJimengModel(forcedAudioLock ? 'seedance-2.0' : modelDefault?.modelId);
  const requestedVoiceName = isAudio ? resolveAudioVoiceName(task, promptNode) : '';
  const cloneVoiceName = audioVoiceReference?.cloneVoiceName || '';

  return {
    schemaVersion: 'jimeng-feed-package.v1',
    platform: 'jimeng',
    automationType: 'browser',
    capability: isAudio ? 'audio' : 'video',
    targetUrl: isAudio ? JIMENG_AUDIO_TARGET_URL : JIMENG_TARGET_URL,
    workspace: {
      mode: isAudio ? '配音生成' : '视频生成',
      modelId: isAudio ? (modelDefault?.modelId || 'jimeng-audio') : jimengModel.id,
      model: isAudio ? '即梦音频生成' : jimengModel.jimengLabel,
      modelPolicy: isAudio
        ? 'configured_audio_default'
        : (forcedAudioLock ? 'forced_audio_lock_prefers_seedance_2_0' : 'configured_video_default'),
      referenceMode: isAudio ? null : '全能参考',
      // 下游对白若已绑定项目公共音色，页面必须选中对应的“我的音色”；
      // 没有映射时保持为空并由页面门禁阻断，绝不静默退回内置音色。
      voiceName: isAudio ? (cloneVoiceName || (audioVoiceReference ? '' : requestedVoiceName)) : '',
      spaceName: normalizeJimengSpaceName(jimengSpaceName)
    },
    taskId,
    shot: buildShotSummary(doc, task),
    promptNodeId: promptNode.id,
    prompt,
    promptSanitization,
    promptGuidance: buildPromptGuidanceSummary({ capability: isAudio ? 'audio' : 'video' }),
    params: isAudio
      ? { duration: normalizeDuration(task.fields?.duration) }
      : {
        ratio: task.fields?.ratio || '9:16',
        duration: normalizeDuration(task.fields?.duration)
      },
    audio: isAudio
      ? {
        voiceName: requestedVoiceName,
        voiceSource: audioVoiceReference ? 'public_reference' : 'built_in',
        cloneVoiceName,
        linkedVoiceAssetId,
        referenceSourceNodeId: audioVoiceReference?.sourceNodeId || '',
        spokenText: prompt,
        listeningTarget: String(promptNode.metadata?.listeningTarget || promptNode.metadata?.prompt || '').trim(),
        assetId: task.fields?.assetId || promptNode.metadata?.assetId || '',
        outputTarget: task.fields?.outputTarget || promptNode.metadata?.outputTarget || ''
      }
      : null,
    references,
    gates: [...REQUIRED_GATES],
    warnings,
    submitPolicy: {
      requireExplicitUserConfirmation: true,
      allowAutoSubmit: false
    }
  };
}

function requiresForcedAudioLock(task, promptNode, references) {
  const hasAudioReference = references.some((reference) => reference.kind === 'audio');
  if (!hasAudioReference) return false;

  // “可后期解决”是高优先级门禁，防止旧任务残留的锁定标记让 BGM、画外音或替换配音误用普通 2.0。
  const postDubbingAllowed = task.fields?.postDubbingAllowed === true
    || task.metadata?.postDubbingAllowed === true
    || promptNode.metadata?.postDubbingAllowed === true;
  if (postDubbingAllowed) return false;

  // audioLockRequired 只表示“可见角色对白无法后期替换且必须逐字口型同步”；旧 modelPolicy 仅作兼容。
  return task.fields?.audioLockRequired === true
    || task.metadata?.audioLockRequired === true
    || promptNode.metadata?.audioLockRequired === true
    || task.metadata?.modelPolicy === 'audio_reference_uses_seedance_2_0';
}

function resolveAudioSpokenText(task, promptNode) {
  const value = task.fields?.spokenText ?? promptNode.metadata?.spokenText ?? promptNode.metadata?.prompt ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

function resolveAudioVoiceName(task, promptNode) {
  const value = task.fields?.voiceName ?? promptNode.metadata?.voiceName ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

function resolveLinkedVoiceAssetId(task, promptNode) {
  const value = task.fields?.linkedVoiceAssetId
    ?? task.metadata?.linkedVoiceAssetId
    ?? promptNode.metadata?.linkedVoiceAssetId
    ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

function resolveApprovedPublicVoiceReference(doc, linkedVoiceAssetId, { episodeRoot, projectRoot, resourceCacheDir }) {
  const candidates = (doc.nodes || [])
    .filter((node) => node.type === 'audio_asset' && node.path)
    .filter((node) => node.metadata?.publicAssetId === linkedVoiceAssetId || node.metadata?.assetId === linkedVoiceAssetId)
    .sort((a, b) => publicVoiceReferenceScore(b) - publicVoiceReferenceScore(a));
  const asset = candidates[0];
  if (!asset || publicVoiceReferenceScore(asset) <= 0) {
    throw new Error(`approved public voice reference not found: ${linkedVoiceAssetId}`);
  }

  return {
    order: 1,
    placeholder: '@音频1',
    kind: 'audio',
    role: 'public_voice_reference',
    title: asset.title || asset.id,
    sourceNodeId: asset.id,
    linkedVoiceAssetId,
    cloneVoiceName: String(asset.metadata?.jimengCustomVoiceName || '').trim(),
    path: asset.path,
    uploadPath: resolveUploadPath(asset.path, { episodeRoot, projectRoot, resourceCacheDir })
  };
}

function publicVoiceReferenceScore(node) {
  const metadata = node?.metadata || {};
  const approved = /approved/i.test(String(node?.status || '')) || metadata.qualityStatus === 'approved_by_user_audio_qc';
  if (!approved && !metadata.selected && !metadata.canonicalCharacterVoice) return 0;
  return (metadata.canonicalCharacterVoice ? 16 : 0)
    + (metadata.selected ? 8 : 0)
    + (approved ? 4 : 0)
    + (metadata.jimengCustomVoiceName ? 2 : 0);
}

function sanitizeJimengAudioPrompt(rawPrompt) {
  return {
    applied: false,
    removedMetadata: [],
    removedReferenceInventory: [],
    prompt: String(rawPrompt || '').trim(),
    policy: 'spoken_text_only'
  };
}

function sanitizeJimengPrompt(rawPrompt) {
  const prompt = typeof rawPrompt === 'string' ? rawPrompt : '';
  const removedMetadata = [];
  const removedReferenceInventory = [];
  const lines = prompt.split(/\r?\n/);
  const keptLines = [];
  let insideReferenceInventory = false;

  for (const line of lines) {
    if (isReferenceInventoryHeading(line)) {
      removedReferenceInventory.push(line.trim());
      insideReferenceInventory = true;
      continue;
    }

    if (insideReferenceInventory) {
      if (isSingleShotPromptHeading(line)) {
        insideReferenceInventory = false;
        const inlinePrompt = line.replace(/^单镜头提示词\s*[:：]\s*/i, '').trim();
        if (inlinePrompt) keptLines.push(inlinePrompt);
        continue;
      }
      if (!String(line || '').trim() || isReferenceInventoryLine(line)) {
        removedReferenceInventory.push(line.trim());
        continue;
      }
      insideReferenceInventory = false;
    }

    if (isTransitionMetadataLine(line)) {
      removedMetadata.push(line.trim());
      continue;
    }
    keptLines.push(line);
  }

  // 即梦的 @图片N 会被自动化当成可执行绑定锚点；资源清单只是应用内说明，
  // 发给即梦会制造重复 chip 绑定，因此仅在只读投喂包里移除，不改项目源数据。
  const wasSanitized = removedMetadata.length > 0 || removedReferenceInventory.length > 0;
  const cleanedPrompt = wasSanitized
    ? keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    : prompt;

  return {
    applied: wasSanitized,
    removedMetadata,
    removedReferenceInventory: removedReferenceInventory.filter(Boolean),
    prompt: cleanedPrompt,
    policy: 'remove_non_shot_transition_metadata_and_reference_inventory'
  };
}

function isTransitionMetadataLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  return /^(转场到|转场至|转场为|转场[:：]|Transition\s+to\b|Cut\s+to\b)/i.test(text);
}

function isReferenceInventoryHeading(line) {
  return /^引用资源\s*[:：]\s*$/i.test(String(line || '').trim());
}

function isReferenceInventoryLine(line) {
  const text = String(line || '').trim();
  return /^[-*]?\s*`?@(?:图片|视频|音频)\d+`?\s*[:：]/.test(text);
}

function isSingleShotPromptHeading(line) {
  return /^单镜头提示词\s*[:：]/i.test(String(line || '').trim());
}

function collectJimengReferences(doc, promptNodeId, { episodeRoot, projectRoot, resourceCacheDir }) {
  const nodeById = new Map((doc.nodes || []).map((node) => [node.id, node]));
  const candidates = [];

  for (const [edgeIndex, edge] of (doc.edges || []).entries()) {
    if (edge.from !== promptNodeId || !REFERENCE_EDGE_TYPES.has(edge.type)) continue;
    if (!isActiveReferenceEdge(edge)) continue;
    const asset = nodeById.get(edge.to);
    const typeConfig = JIMENG_REFERENCE_NODE_TYPES.get(asset?.type);
    if (!asset || !asset.path || !typeConfig) continue;

    candidates.push({
      edge,
      asset,
      typeConfig,
      edgeIndex,
      placeholderIndex: getReferencePlaceholderIndex(edge, typeConfig.token)
    });
  }

  candidates.sort(compareReferenceCandidates);

  const mediaCounters = new Map();
  return candidates.map(({ edge, asset, typeConfig }, referenceIndex) => {
    const nextIndex = (mediaCounters.get(typeConfig.kind) || 0) + 1;
    mediaCounters.set(typeConfig.kind, nextIndex);
    // 图片和音频使用独立编号空间，避免新增 @音频1 后扰动既有 @图片1-5 连续性合同。
    const index = getReferencePlaceholderIndex(edge, typeConfig.token) || nextIndex;
    return {
      order: referenceIndex + 1,
      placeholder: `@${typeConfig.token}${index}`,
      kind: typeConfig.kind,
      role: edge.role || asset.metadata?.role || 'generic',
      title: asset.title || asset.id,
      sourceNodeId: asset.id,
      path: asset.path,
      uploadPath: resolveUploadPath(asset.path, { episodeRoot, projectRoot, resourceCacheDir })
    };
  });
}

function compareReferenceCandidates(a, b) {
  // Shot data may append a corrected @图片1 edge after older refs. Jimeng binding must follow
  // explicit media placeholders first, then fall back to graph order for legacy non-numbered edges.
  if (a.typeConfig.rank !== b.typeConfig.rank) return a.typeConfig.rank - b.typeConfig.rank;
  if (a.placeholderIndex !== null && b.placeholderIndex !== null && a.placeholderIndex !== b.placeholderIndex) {
    return a.placeholderIndex - b.placeholderIndex;
  }
  if (a.placeholderIndex !== null && b.placeholderIndex === null) return -1;
  if (a.placeholderIndex === null && b.placeholderIndex !== null) return 1;
  return a.edgeIndex - b.edgeIndex;
}

function getReferencePlaceholderIndex(edge, token = '图片') {
  const candidates = [
    edge.role,
    edge.placeholder,
    edge.metadata?.placeholder,
    edge.metadata?.referencePlaceholder
  ];

  for (const candidate of candidates) {
    const match = String(candidate || '').trim().match(new RegExp(`^@?${token}(\\d+)$`));
    if (match) return Number(match[1]);
  }

  return null;
}

function isActiveReferenceEdge(edge) {
  // 旧项目可能没有给边写 status；为了兼容历史数据，缺省视为可用。
  // 但被显式标记为 diagnostic/rejected/inactive 的边必须从上传清单排除，
  // 否则修复过的参考顺序会被旧诊断素材重新污染。
  if (edge.active === false) return false;
  if (edge.status) return edge.status === 'active';
  // 早期修复脚本只会在 metadata 里写 disabledAt/inactiveAt/inactiveReason，
  // 未必同步 status 或 active；这里统一排除，避免旧参考再次进入即梦投喂包。
  if (edge.metadata?.disabledAt || edge.metadata?.inactiveAt || edge.metadata?.inactiveReason) return false;
  return true;
}

function resolveUploadPath(assetPath, { episodeRoot, projectRoot, resourceCacheDir }) {
  if (/^(https?:\/\/|data:)/i.test(assetPath)) return assetPath;
  if (isAbsolute(assetPath)) return assetPath;
  if (assetPath.startsWith(APP_CACHE_PREFIX)) {
    const cacheRelative = assetPath.slice(APP_CACHE_PREFIX.length);
    return resourceCacheDir ? resolve(resourceCacheDir, cacheRelative) : assetPath;
  }
  if (assetPath.startsWith('scripts/') && projectRoot) {
    // App-owned projects store shared/script assets at the project root, while the current
    // episode document lives under projects/<id>/episodes/<ep>. Jimeng needs a real upload path.
    return resolve(projectRoot, assetPath);
  }
  return episodeRoot ? resolve(episodeRoot, assetPath) : assetPath;
}

function inferProjectRootFromEpisodeRoot(episodeRoot) {
  if (!episodeRoot) return '';
  const normalized = episodeRoot.replace(/\\/g, '/');
  for (const marker of ['/scripts/episodes/', '/episodes/']) {
    const index = normalized.indexOf(marker);
    if (index >= 0) return episodeRoot.slice(0, index);
  }
  return '';
}

function collectWarnings(prompt, references) {
  const warnings = [];
  for (const ref of references) {
    // 即梦/ProseMirror 的 @ 资源芯片需要在提示词里逐一绑定；这里仅提示，不替用户改写原文。
    if (!prompt.includes(ref.placeholder)) {
      warnings.push({
        code: 'missing_prompt_binding',
        placeholder: ref.placeholder,
        message: `提示词未包含 ${ref.placeholder}，自动化执行器提交前需要人工确认资源绑定。`
      });
    }
  }
  return warnings;
}

function buildShotSummary(doc, task) {
  const shot = (doc.shots || []).find((item) => item.id === task.shotId || item.shotNo === task.shotNo) || null;
  return {
    id: task.shotId || shot?.id || task.fields?.assetId || '',
    shotNo: shot?.shotNo || task.shotNo || String(task.shotId || '').replace(/^shot:/, ''),
    title: shot?.title || shot?.summary || task.fields?.assetTitle || task.title || ''
  };
}

function normalizeDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 5;
}

function normalizeJimengSpaceName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 80);
}
