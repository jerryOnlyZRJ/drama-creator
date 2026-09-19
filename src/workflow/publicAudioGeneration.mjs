import { normalizeIdPart } from '../schema/dramaCreatorSchema.mjs';

// 公共音色资产是跨分镜复用的一等资源；这里把编辑卡片稳定转换成
// audio_prompt + audio task，避免前端或一次性脚本各自拼不同的即梦输入。
export function ensurePublicAudioGenerationTask(doc, assetId, { now = new Date().toISOString() } = {}) {
  if (!Array.isArray(doc.nodes)) doc.nodes = [];
  if (!Array.isArray(doc.tasks)) doc.tasks = [];
  const asset = (doc.publicAssets || []).find((item) => item.id === assetId);
  if (!asset) throw new Error(`public audio asset not found: ${assetId}`);
  if (asset.category !== 'voices' || asset.kind !== 'audio') {
    throw new Error('只有公共资产库中的音色参考才能启动即梦配音生成');
  }

  const metadata = asset.metadata && typeof asset.metadata === 'object' ? asset.metadata : {};
  const spokenText = String(asset.spokenText || metadata.spokenText || '').trim();
  const voiceName = String(asset.voiceName || metadata.voiceName || '').trim();
  const outputTarget = String(asset.outputTarget || metadata.outputTarget || '').trim();
  if (!spokenText) throw new Error('请先为该音色资产填写独立的试听台词');
  if (!voiceName) throw new Error('请先为该音色资产选定即梦内置音色名');

  const slug = normalizeIdPart(asset.id.replace(/^public:/, '')) || normalizeIdPart(asset.title) || 'voice';
  const promptNodeId = `node:prompt:audio:${slug}:v001`;
  const taskId = `task:audio:${slug}:v001`;
  const listeningTarget = String(asset.prompt || asset.description || asset.notes || '').trim();

  upsertById(doc.nodes, {
    id: promptNodeId,
    type: 'audio_prompt',
    title: `${asset.title} 配音提示`,
    shotId: null,
    path: null,
    status: 'active',
    metadata: {
      prompt: listeningTarget,
      listeningTarget,
      spokenText,
      voiceName,
      assetId: asset.id,
      outputTarget,
      updatedAt: now
    },
    ui: { cluster: 'script' }
  });
  upsertById(doc.tasks, {
    id: taskId,
    shotId: null,
    type: 'audio',
    title: `生成 ${asset.title}`,
    status: 'ready_to_feed',
    promptNodeId,
    outputNodeIds: [],
    fields: {
      assetId: asset.id,
      assetTitle: asset.title,
      spokenText,
      voiceName,
      duration: normalizeAudioDuration(asset.duration || metadata.duration),
      outputTarget
    }
  });

  asset.status = 'pending';
  asset.metadata = {
    ...metadata,
    spokenText,
    voiceName,
    outputTarget,
    generationTaskId: taskId,
    updatedAt: now
  };
  asset.updatedAt = now;
  appendActivity(doc, asset, taskId, now);

  return { asset, promptNodeId, taskId };
}

function upsertById(collection, record) {
  const index = collection.findIndex((item) => item.id === record.id);
  if (index >= 0) collection[index] = { ...collection[index], ...record };
  else collection.push(record);
}

function normalizeAudioDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.min(60, Math.round(number))) : 8;
}

function appendActivity(doc, asset, taskId, at) {
  if (!Array.isArray(doc.activityLog)) doc.activityLog = [];
  const id = `activity:audio-feed-prepared:${normalizeIdPart(asset.id)}:${at.replace(/[-:.TZ]/g, '')}`;
  doc.activityLog.push({
    id,
    type: 'audio_feed_prepared',
    at,
    assetId: asset.id,
    taskId,
    message: `${asset.title} 已准备即梦配音任务，等待提交前确认`
  });
}
