import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import {
  createEdge,
  createEmptyDramaCreatorDocument,
  createNode,
  createTask,
  normalizeIdPart,
  validateDramaCreatorDocument
} from '../schema/dramaCreatorSchema.mjs';
// LEGACY (Phase 3 removal target): SOP markdown parsers. Kept until native CRUD + bulk import land,
// otherwise EP001 loses its only ingestion path. See specs/2026-06-10-open-source-redesign-design.md §7.
import {
  extractFirstTextBlock,
  parseBoundAssets,
  parseFilePathLine,
  parseMarkdownSectionsByHeading,
  parseShotSections,
  parseVideoFileName,
  parseVoiceIndex
} from './markdownParsers.mjs';
import { ensureNode, ensureEdge, linkOutputToTask } from './outputBackfill.mjs';

const REQUIRED_FILES = [
  'script.md',
  '02-image-prompts.md',
  '03-shot-list.md',
  '04-video-prompts.md',
  '06-qc-checklist.md',
  'feeding-log.md'
];

export async function importEpisode({ episodePath, write = false }) {
  const episodeId = basename(episodePath);
  const doc = createEmptyDramaCreatorDocument({
    projectName: inferProjectName(episodePath),
    episodeId,
    episodePath
  });

  const files = await readKnownFiles(episodePath);
  addFileChecks(doc, files);
  addShotsFromVideoPrompts(doc, files['04-video-prompts.md'] || '');
  addImagePromptNodes(doc, files['02-image-prompts.md'] || '', episodePath);
  addVideoPromptTasks(doc, files['04-video-prompts.md'] || '');
  await addVideoOutputs(doc, episodePath);
  addQcRecord(doc, files['06-qc-checklist.md'] || '', episodeId);
  addPerOutputQcPlaceholders(doc, files['06-qc-checklist.md'] || '');
  await addAudioAssetsFromVoiceIndex(doc, episodePath);
  linkScriptsToAudioAssets(doc, files['04-video-prompts.md'] || '');
  addActivityLog(doc, files['feeding-log.md'] || '');
  addGraphIntegrityCheck(doc);

  const errors = validateDramaCreatorDocument(doc);
  if (errors.length > 0) {
    throw new Error(`Generated invalid drama-creator document:\n${errors.join('\n')}`);
  }

  if (write) {
    await writeFile(join(episodePath, 'drama-creator.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }

  return doc;
}

async function readKnownFiles(episodePath) {
  const result = {};
  for (const file of REQUIRED_FILES) {
    try {
      result[file] = await readFile(join(episodePath, file), 'utf8');
    } catch {
      result[file] = null;
    }
  }
  return result;
}

function addFileChecks(doc, files) {
  const items = REQUIRED_FILES.map((file) => ({
    label: file,
    status: files[file] === null ? 'warning' : 'pass'
  }));
  doc.checks.push({
    id: 'check:episode:required-files',
    type: 'asset_integrity',
    status: items.some((item) => item.status === 'warning') ? 'warning' : 'pass',
    items
  });
}

function addShotsFromVideoPrompts(doc, markdown) {
  for (const section of parseShotSections(markdown)) {
    const shotId = `shot:${section.shotNo}`;
    if (doc.shots.some((shot) => shot.id === shotId)) continue;

    // Shot records are the bridge between Markdown sections and graph resources.
    doc.shots.push({
      id: shotId,
      shotNo: section.shotNo,
      title: section.title,
      status: 'ready_to_feed',
      summary: section.title,
      taskIds: []
    });
    doc.nodes.push(createNode({
      id: `node:script:${section.shotNo}`,
      type: 'script_segment',
      title: `${section.shotNo} ${section.title}`,
      shotId,
      status: 'active'
    }));
  }
}

function addImagePromptNodes(doc, markdown, episodePath) {
  for (const section of parseMarkdownSectionsByHeading(markdown, 3)) {
    const filePath = section.body.split('\n').map(parseFilePathLine).find(Boolean);
    const idPart = normalizeIdPart(filePath || section.title);
    const promptNodeId = `node:prompt:image:${idPart}`;
    const assetNodeId = `node:image:${idPart}`;
    const prompt = extractFirstTextBlock(section.body);

    ensureNode(doc, createNode({
      id: promptNodeId,
      type: 'image_prompt',
      title: section.title,
      status: prompt ? 'active' : 'needs_review',
      metadata: { prompt }
    }));
    ensureNode(doc, createNode({
      id: assetNodeId,
      type: 'image_asset',
      title: section.title,
      path: filePath,
      status: filePath ? 'active' : 'missing',
      metadata: { source: filePath ? relative(episodePath, join(episodePath, filePath)) : null }
    }));
    ensureEdge(doc, createEdge({
      id: `edge:${normalizeIdPart(promptNodeId)}:generates:${normalizeIdPart(assetNodeId)}`,
      from: promptNodeId,
      to: assetNodeId,
      type: 'generates',
      role: 'image_generation'
    }));
  }
}

function addVideoPromptTasks(doc, markdown) {
  for (const section of parseShotSections(markdown)) {
    const shotId = `shot:${section.shotNo}`;
    const promptNodeId = `node:prompt:video:${section.shotNo}:v001`;
    const taskId = `task:video:${section.shotNo}:v001`;
    const prompt = extractFirstTextBlock(section.body);

    ensureNode(doc, createNode({
      id: promptNodeId,
      type: 'video_prompt',
      title: `${section.shotNo} ${section.title} 视频提示词`,
      shotId,
      status: prompt ? 'active' : 'needs_review',
      metadata: { prompt }
    }));
    doc.tasks.push(createTask({
      id: taskId,
      shotId,
      type: 'video',
      title: `${section.shotNo} 视频生成`,
      status: 'ready_to_feed',
      promptNodeId,
      fields: parseVideoTaskFields(section.body)
    }));

    const shot = doc.shots.find((item) => item.id === shotId);
    if (shot && !shot.taskIds.includes(taskId)) shot.taskIds.push(taskId);

    for (const asset of parseBoundAssets(section.body)) {
      const assetNodeId = `node:image:${normalizeIdPart(asset.path)}`;
      ensureNode(doc, createNode({
        id: assetNodeId,
        type: 'image_asset',
        title: asset.name,
        path: asset.path,
        status: 'active',
        metadata: { chip: asset.chip, note: asset.note }
      }));
      ensureEdge(doc, createEdge({
        id: `edge:${normalizeIdPart(promptNodeId)}:uses:${normalizeIdPart(assetNodeId)}`,
        from: promptNodeId,
        to: assetNodeId,
        type: 'uses_reference',
        role: asset.note || 'reference_image',
        note: `${asset.chip} ${asset.name}`
      }));
      // 把同 shot 的剧本片段也连到这些素材，方便在画布上一眼看到该剧本依赖了哪些资源。
      // 边方向 script → asset 与 schema 约定一致，buildLinks 不会再翻转。
      const scriptNodeId = `node:script:${section.shotNo}`;
      if (doc.nodes.some((node) => node.id === scriptNodeId)) {
        ensureEdge(doc, createEdge({
          id: `edge:${normalizeIdPart(scriptNodeId)}:script-uses:${normalizeIdPart(assetNodeId)}`,
          from: scriptNodeId,
          to: assetNodeId,
          type: 'script_uses_asset',
          role: asset.note || asset.chip || 'reference_image',
          note: `${asset.chip} ${asset.name}`
        }));
      }
    }
  }
}

async function addVideoOutputs(doc, episodePath) {
  const rawDir = join(episodePath, 'raw-videos');
  let files = [];
  try {
    files = await readdir(rawDir);
  } catch {
    return;
  }

  for (const file of files.filter((name) => name.endsWith('.mp4'))) {
    const parsed = parseVideoFileName(file);
    if (!parsed) continue;
    const outputNodeId = `node:video:${parsed.shotNo}:${parsed.version}`;
    const shotId = `shot:${parsed.shotNo}`;

    ensureNode(doc, createNode({
      id: outputNodeId,
      type: 'video_output',
      title: file,
      shotId,
      path: `raw-videos/${file}`,
      status: 'reviewing',
      metadata: { version: parsed.version }
    }));
    linkOutputToTask(doc, shotId, outputNodeId);
  }
}

function parseVideoTaskFields(markdown) {
  const prompt = extractFirstTextBlock(markdown) || markdown;
  const ratio = prompt.match(/\b(\d{1,2}\s*[:：]\s*\d{1,2})\b/)?.[1]?.replace(/\s/g, '').replace('：', ':');
  const feedSlotDuration = markdown.match(/投喂.{0,12}?(?:按|为)?\s*(\d{1,3})\s*(?:秒|s)\s*(?:档|生成|版)?/i)?.[1];
  const duration = feedSlotDuration || prompt.match(/(?:时长[：:]\s*)?(\d{1,3})\s*(?:秒|s)/i)?.[1];

  // Feed-gate fields are imported from prompt text so freshly imported episodes can be previewed immediately.
  return {
    ...(ratio ? { ratio } : {}),
    ...(duration ? { duration: Number(duration) } : {})
  };
}

function addQcRecord(doc, markdown, episodeId) {
  if (!markdown.trim()) return;
  doc.nodes.push(createNode({
    id: `node:qc:${episodeId}:imported`,
    type: 'qc_record',
    title: '导入的 QC 记录',
    status: markdown.includes('不建议') || markdown.includes('需重跑') ? 'rerun_needed' : 'reviewing',
    metadata: { text: markdown.slice(0, 2000) }
  }));
}

// 工作台 cluster.qc 通过 qc_for 边反查关联 qc_record；如果只导入 episode 级
// 全局 qc_record（无 qc_for 边），所有产物的 QC 编辑器都会保持 disabled。
// 因此每个 video_output 都需要一条占位 qc_record + qc_for 边，以便用户在
// 工作台逐个写结论。已存在 qc_for 边的产物不重复创建，保证可重复导入幂等。
//
// 同时尽量从 06-qc-checklist.md 中提取与该镜头相关的内容回灌到 qcNote：
// 1) 镜头级验收表中"shotNo 开头"的行 → 取出"备注"字段；
// 2) 形如 `## s001b 即梦生成验收记录` 等小节的全部 markdown body。
function addPerOutputQcPlaceholders(doc, qcMarkdown = '') {
  const existingQcForTargets = new Set(
    doc.edges.filter((edge) => edge.type === 'qc_for').map((edge) => edge.to)
  );
  const summariesByShot = parseQcChecklistByShot(qcMarkdown);

  for (const output of doc.nodes.filter((node) => node.type === 'video_output')) {
    if (existingQcForTargets.has(output.id)) continue;

    const shotNo = (output.shotId || '').replace(/^shot:/, '') || normalizeIdPart(output.id);
    const version = output.metadata?.version || output.id.match(/:(v\d+)$/)?.[1] || 'v001';
    const qcNodeId = `node:qc:${shotNo}:${version}`;
    const edgeId = `edge:qcfor:${shotNo}:${version}`;
    const summary = summariesByShot.get(shotNo) || summariesByShot.get(stripShotSuffix(shotNo)) || null;

    ensureNode(doc, createNode({
      id: qcNodeId,
      type: 'qc_record',
      title: `${shotNo} 视频产物 QC`,
      shotId: output.shotId,
      status: summary?.status || 'reviewing',
      metadata: {
        qcNote: summary?.qcNote || '',
        origin: 'placeholder-on-import'
      }
    }));
    ensureEdge(doc, createEdge({
      id: edgeId,
      from: qcNodeId,
      to: output.id,
      type: 'qc_for',
      role: 'placeholder'
    }));
  }
}

// 解析 06-qc-checklist.md，返回 shotNo -> { qcNote, status } 映射。
// shotNo 既支持精确编号（如 s001b），也支持父镜头编号（s001）。
function parseQcChecklistByShot(markdown) {
  const result = new Map();
  if (!markdown.trim()) return result;

  // (1) 镜头级验收表：每行 `| s001 | ... | 结论 | 备注 |`，备注是最后一列。
  const tableRowRegex = /^\|\s*(s\d+[a-z]?)\s*\|([^\n]*)\|/gim;
  for (const match of markdown.matchAll(tableRowRegex)) {
    const shotNo = match[1].toLowerCase();
    const cells = match[2].split('|').map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const conclusion = cells[cells.length - 2];
    const note = cells[cells.length - 1];
    if (/^[-:\s]+$/.test(conclusion)) continue; // 跳过表头分隔行
    const lines = [];
    if (note) lines.push(`备注：${note}`);
    if (conclusion && conclusion !== '待定') lines.push(`结论：${conclusion}`);
    if (!lines.length) continue;
    mergeSummary(result, shotNo, { qcNote: lines.join('\n'), status: deriveQcStatus(conclusion) });
  }

  // (2) 详细验收小节：parseShotSections 已经按 `## sNNN ...` 抓段。
  for (const section of parseShotSections(markdown)) {
    const shotNo = section.shotNo.toLowerCase();
    // 把段落原文整段写入 qcNote 之后，让用户在画布上一眼看到详细验收记录。
    mergeSummary(result, shotNo, {
      qcNote: section.body,
      status: deriveQcStatus(section.body)
    });
  }

  return result;
}

// 把同一 shot 多次抽取到的内容合并：备注表行 + 详细段落都保留。
function mergeSummary(map, shotNo, addition) {
  const existing = map.get(shotNo);
  if (!existing) {
    map.set(shotNo, { ...addition });
    return;
  }
  const merged = {
    qcNote: [existing.qcNote, addition.qcNote].filter(Boolean).join('\n\n'),
    // status 优先取更"重"的：rerun_needed > reviewing。
    status: existing.status === 'rerun_needed' || addition.status === 'rerun_needed'
      ? 'rerun_needed'
      : existing.status || addition.status || 'reviewing'
  };
  map.set(shotNo, merged);
}

// 简单的关键词识别：出现"不建议"/"需重跑"/"重跑"判定为 rerun_needed，否则保持 reviewing。
function deriveQcStatus(text) {
  if (!text) return 'reviewing';
  return /不建议|需重跑|建议重跑|废弃/.test(text) ? 'rerun_needed' : 'reviewing';
}

// shot 编号去掉尾部字母后缀：s001b -> s001，便于回退到父镜头级表行。
function stripShotSuffix(shotNo) {
  return String(shotNo).replace(/[a-z]$/i, '');
}

// 项目级 voice-index.md 是音色资产的唯一可信来源。导入器从 episodePath 上溯
// 找到包含 `scripts/assets/voices/voice-index.md` 的项目根，把每条 voice_id
// 落成 audio_asset 节点，path 指向参考音频，metadata 中保留音色卡 / 模型权重 /
// 状态等关键字段，方便 L3 画布直接展示与外链。
//
// 节点 id 约定 `node:audio:<voice_id>`，幂等：再次导入不会重复入图。
// 音频资产是项目级共享资源，因此不绑定到具体 shot；与具体台词的关联交给
// 后续解析剧本台词或语音任务时再连边，此处只保证资产先入图。
async function addAudioAssetsFromVoiceIndex(doc, episodePath) {
  const projectRoot = await findProjectRootWithVoices(episodePath);
  if (!projectRoot) return;

  const voiceIndexPath = join(projectRoot, 'scripts/assets/voices/voice-index.md');
  let markdown;
  try {
    markdown = await readFile(voiceIndexPath, 'utf8');
  } catch {
    return;
  }

  for (const row of parseVoiceIndex(markdown)) {
    const idPart = normalizeIdPart(row.voiceId);
    const assetNodeId = `node:audio:${idPart}`;
    const status = inferVoiceAssetStatus(row.status);

    ensureNode(doc, createNode({
      id: assetNodeId,
      type: 'audio_asset',
      title: row.role ? `${row.role} 音色（${row.voiceId}）` : row.voiceId,
      // path 指向参考音频，便于 shot.js 直接 <audio controls> 试听。
      path: row.referencePath || null,
      status,
      metadata: {
        voiceId: row.voiceId,
        role: row.role || null,
        cardPath: row.cardPath || null,
        referencePath: row.referencePath || null,
        modelPath: row.modelPath || null,
        statusText: row.status || null,
        // source 与 image_asset 命名风格保持一致，便于 /api/asset 解析展示。
        source: row.referencePath || null
      }
    }));
  }
}

// 状态文本里出现"已录入参考音频"等积极字样时视为可用资产，否则标记为待录入。
function inferVoiceAssetStatus(statusText) {
  if (!statusText) return 'missing';
  if (/已录入|已验收|已生成|已发布/.test(statusText)) return 'active';
  if (/待录入|待训练|缺失|未/.test(statusText)) return 'missing';
  return 'reviewing';
}

// 从 episodePath 上溯查找 `scripts/assets/voices/voice-index.md` 所在的项目根。
// 旧导入目录通常是 `<projectRoot>/scripts/episodes/<epId>`，episodePath 上溯
// 到 projectRoot 后即可拼出 voices 资产路径。返回 null 表示该 episode 不挂在
// 标准项目树下（例如测试 fixture 不带 voices 目录），调用方可静默跳过。
async function findProjectRootWithVoices(episodePath) {
  let current = episodePath;
  // 限制最多上溯 6 层，避免在意外的临时目录中无限循环。
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(current, 'scripts/assets/voices/voice-index.md');
    try {
      const info = await stat(candidate);
      if (info.isFile()) return current;
    } catch {
      // 继续上溯。
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// 从 04-video-prompts.md 中按 shot 抓取所有出现的 voice_id（形如 `voice: char_xxx_voice_v001`），
// 把对应 shot 的 script_segment 节点向已存在的 audio_asset 节点连一条 script_uses_asset 边。
// 这样 L3 单镜头闭包就能把音色资产拉入画布，shot.js 升级后的 <audio> 卡片可以直接试听。
//
// 仅当 voice_id 对应的 audio_asset 已经入图（即 voice-index.md 已登记）时才连边，
// 缺漏的 voice_id 不会创建占位资产，由用户在 voice-index.md 中显式补登。
function linkScriptsToAudioAssets(doc, videoPromptsMarkdown) {
  if (!videoPromptsMarkdown.trim()) return;

  // 预先建索引，避免每个 shot 都遍历一次 doc.nodes。
  const audioAssetIds = new Set(
    doc.nodes.filter((node) => node.type === 'audio_asset').map((node) => node.id)
  );
  if (audioAssetIds.size === 0) return;

  const voiceIdRegex = /voice:\s*(char_[a-z0-9]+_voice_v\d+)/gi;

  for (const section of parseShotSections(videoPromptsMarkdown)) {
    const scriptNodeId = `node:script:${section.shotNo}`;
    if (!doc.nodes.some((node) => node.id === scriptNodeId)) continue;

    // 用 Set 去重：同一 shot 内多次出现同一 voice_id 只建一条边。
    const seen = new Set();
    for (const match of section.body.matchAll(voiceIdRegex)) {
      const voiceId = match[1];
      if (seen.has(voiceId)) continue;
      seen.add(voiceId);

      const assetNodeId = `node:audio:${normalizeIdPart(voiceId)}`;
      if (!audioAssetIds.has(assetNodeId)) continue;

      ensureEdge(doc, createEdge({
        id: `edge:${normalizeIdPart(scriptNodeId)}:script-uses:${normalizeIdPart(assetNodeId)}`,
        from: scriptNodeId,
        to: assetNodeId,
        type: 'script_uses_asset',
        role: 'voice_reference',
        note: voiceId
      }));
    }
  }
}


function addActivityLog(doc, markdown) {
  if (!markdown.trim()) return;
  doc.activityLog.push({
    id: 'activity:feeding-log:imported',
    type: 'feeding_log_import',
    createdAt: new Date().toISOString(),
    summary: 'Imported feeding-log.md',
    metadata: { text: markdown.slice(0, 2000) }
  });
}

function addGraphIntegrityCheck(doc) {
  const nodeIds = new Set(doc.nodes.map((node) => node.id));
  const brokenEdges = doc.edges.filter((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to));
  doc.checks.push({
    id: 'check:graph:integrity',
    type: 'graph_integrity',
    status: brokenEdges.length > 0 ? 'warning' : 'pass',
    items: brokenEdges.map((edge) => ({
      label: edge.id,
      status: 'warning'
    }))
  });
}

function inferProjectName(episodePath) {
  const parts = episodePath.split(/[\\/]/);
  const dramaIndex = parts.lastIndexOf('短剧');
  return dramaIndex >= 0 && parts[dramaIndex + 1] ? parts[dramaIndex + 1] : 'Local Drama Project';
}
