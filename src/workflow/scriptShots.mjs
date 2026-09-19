import { createEdge, createNode, createTask, normalizeIdPart } from '../schema/dramaCreatorSchema.mjs';
import { createBestPracticeVideoPrompt, PROMPT_BEST_PRACTICES_VERSION } from '../prompting/bestPractices.mjs';

const GENERATED_SOURCE = 'local_rule';
const MANUAL_STORYBOARD_SOURCE = 'manual_storyboard';
const MAX_SHOTS = 24;
const SCREENPLAY_SCENE_SIZE = 3;

export function createScriptDraftFromSource(sourceText, { now = new Date().toISOString() } = {}) {
  const text = String(sourceText || '').trim();
  const beats = splitStoryNarrative(text).slice(0, MAX_SHOTS);
  const draftText = beats.length
    ? formatScreenplayDraft(beats)
    : '';
  return {
    text: draftText,
    source: GENERATED_SOURCE,
    updatedAt: now
  };
}

export function applyStoryboardSplit(doc, { scriptText = doc?.scriptDraft?.text || '', now = new Date().toISOString() } = {}) {
  const units = splitScriptTextUnits(scriptText).slice(0, MAX_SHOTS);
  removeGeneratedStoryboard(doc);
  const preservedShotCount = (doc.shots || []).length;
  if (!Array.isArray(doc.nodes)) doc.nodes = [];
  if (!Array.isArray(doc.edges)) doc.edges = [];
  if (!Array.isArray(doc.tasks)) doc.tasks = [];
  // 当前 V1 没有独立“确认剧本”按钮；进入拆分时即表示用户确认当前剧本可作为默认输入。
  doc.scriptDraft = {
    ...(doc.scriptDraft || {}),
    text: String(scriptText || '').trim(),
    source: doc.scriptDraft?.source || GENERATED_SOURCE,
    updatedAt: now,
    status: 'confirmed',
    confirmedAt: doc.scriptDraft?.confirmedAt || now
  };

  units.forEach((unit, index) => {
    const shotNo = `s${String(preservedShotCount + index + 1).padStart(3, '0')}`;
    const shotId = `shot:${shotNo}`;
    const title = createShotTitle(unit, shotNo);
    doc.shots.push({
      id: shotId,
      shotNo,
      title,
      summary: unit,
      // 分镜是最小生产单元，shot 本身保留剧本片段；script_segment 节点保留图谱版本，供画布和导出链路引用。
      scriptText: unit,
      status: 'draft',
      durationSec: estimateDuration(unit),
      metadata: {
        source: GENERATED_SOURCE,
        generatedAt: now
      }
    });

    const scriptNodeId = `node:script:${shotNo}`;
    const promptNodeId = `node:prompt:video:${shotNo}:v001`;
    doc.nodes.push(createNode({
      id: scriptNodeId,
      type: 'script_segment',
      title,
      shotId,
      status: 'draft',
      metadata: {
        text: unit,
        source: GENERATED_SOURCE,
        generatedAt: now
      }
    }));
    doc.nodes.push(createNode({
      id: promptNodeId,
      type: 'video_prompt',
      title: `${shotNo} 视频提示词`,
      shotId,
      status: 'draft',
      metadata: {
        prompt: createVideoPrompt(unit, { ratio: doc.config?.defaultRatio || '9:16', duration: estimateDuration(unit) }),
        source: GENERATED_SOURCE,
        promptPolicyVersion: PROMPT_BEST_PRACTICES_VERSION,
        generatedAt: now
      }
    }));
    doc.edges.push(createEdge({
      id: `edge:${normalizeIdPart(scriptNodeId)}:derived:${normalizeIdPart(promptNodeId)}`,
      from: scriptNodeId,
      to: promptNodeId,
      type: 'derived_from',
      role: 'script_to_video_prompt',
      note: '由本地规则从剧本文本生成分镜视频提示词'
    }));
    doc.tasks.push(createTask({
      id: `task:video:${shotNo}:v001`,
      shotId,
      type: 'video',
      title: `${shotNo} 分镜视频生成`,
      status: 'draft',
      promptNodeId,
      outputNodeIds: [],
      fields: {
        ratio: doc.config?.defaultRatio || '9:16',
        duration: estimateDuration(unit),
        providerMode: 'external_automation',
        provider: 'jimeng'
      }
    }));
  });

  doc.publicAssets = mergePublicAssets(doc.publicAssets, extractPublicAssetCandidates(units, now));
  doc.workflow = normalizeWorkflowForStoryboard(doc.workflow);
  appendActivity(doc, {
    id: `activity:storyboard-split:${now.replace(/[-:.TZ]/g, '')}`,
    type: 'storyboard_split',
    at: now,
    message: `已拆分 ${units.length} 个分镜`
  });
  return { shotCount: units.length };
}

export function replaceStoryboardShots(doc, { shots, now = new Date().toISOString() } = {}) {
  const incomingRows = normalizeStoryboardRows(shots).slice(0, MAX_SHOTS);
  if (!doc || typeof doc !== 'object') throw new Error('Episode document is required');
  if (!Array.isArray(doc.shots)) doc.shots = [];
  if (!Array.isArray(doc.nodes)) doc.nodes = [];
  if (!Array.isArray(doc.edges)) doc.edges = [];
  if (!Array.isArray(doc.tasks)) doc.tasks = [];

  const existingShots = doc.shots;
  const oldShotIds = new Set(existingShots.map((shot) => shot.id).filter(Boolean));
  const existingByShotNo = new Map(existingShots.map((shot) => [shot.shotNo, shot]).filter(([shotNo]) => shotNo));
  const rowPlans = incomingRows.map((row, index) => {
    const shotNo = formatStoryboardShotNo(index + 1);
    const sourceShotNo = row.sourceShotNo || row.shotNo || '';
    const existing = sourceShotNo ? (existingByShotNo.get(sourceShotNo) || null) : null;
    return {
      row,
      shotNo,
      shotId: `shot:${shotNo}`,
      sourceShotNo,
      sourceShotId: existing?.id || null,
      existing
    };
  });
  const keptSourceShotIds = new Set(rowPlans.map((plan) => plan.sourceShotId).filter(Boolean));
  const deletedShotIds = new Set([...oldShotIds].filter((shotId) => !keptSourceShotIds.has(shotId)));

  removeShotGraphRecords(doc, deletedShotIds);
  const nodeIdMap = remapShotGraphRecords(
    doc,
    rowPlans.filter((plan) => plan.sourceShotId && plan.sourceShotId !== plan.shotId)
  );

  let createdCount = 0;
  let updatedCount = 0;

  const nextShots = rowPlans.map((plan) => {
    const { row, shotNo, shotId, existing } = plan;
    if (existing) updatedCount += 1;
    if (!existing) createdCount += 1;

    const scriptText = row.scriptText || row.summary || row.title || `镜头 ${shotNo}`;
    const title = row.title || createShotTitle(scriptText, shotNo);
    const durationSec = clampShotDuration(row.durationSec || estimateDuration(scriptText));
    const nextShot = {
      ...(existing || {}),
      id: shotId,
      shotNo,
      title,
      summary: scriptText,
      scriptText,
      status: existing?.status || 'draft',
      durationSec,
      metadata: {
        ...(existing?.metadata || {}),
        source: MANUAL_STORYBOARD_SOURCE,
        updatedAt: now
      }
    };
    return remapShotLocalReferences(nextShot, nodeIdMap);
  });

  doc.shots = nextShots;
  for (const shot of nextShots) {
    syncStoryboardShotGraph(doc, shot, { now });
  }
  doc.edges = filterEdgesWithExistingNodes(doc);
  doc.workflow = normalizeWorkflowForStoryboardEdit(doc.workflow);
  appendActivity(doc, {
    id: `activity:storyboard-edit:${now.replace(/[-:.TZ]/g, '')}`,
    type: 'storyboard_edit',
    at: now,
    message: `已保存 ${nextShots.length} 个分镜`
  });

  return {
    shotCount: nextShots.length,
    createdCount,
    updatedCount,
    deletedCount: deletedShotIds.size
  };
}

export function generatePublicAssetsFromScript(doc, { scriptText, now = new Date().toISOString() } = {}) {
  const sourceText = normalizePublicAssetSourceText(scriptText ?? collectPublicAssetSourceText(doc));
  const beforeKeys = new Set((Array.isArray(doc?.publicAssets) ? doc.publicAssets : [])
    .filter((asset) => asset?.category && asset?.title)
    .map((asset) => `${asset.category}:${asset.title}`));
  if (!sourceText) {
    return {
      createdCount: 0,
      totalCount: Array.isArray(doc?.publicAssets) ? doc.publicAssets.length : 0,
      assets: [],
      reason: 'missing_script'
    };
  }

  const generated = extractPublicAssetCandidates([sourceText], now);
  doc.publicAssets = mergePublicAssets(doc.publicAssets, generated);
  const generatedKeys = new Set(generated.map((asset) => `${asset.category}:${asset.title}`));
  const createdAssets = doc.publicAssets.filter((asset) => {
    const key = `${asset.category}:${asset.title}`;
    return generatedKeys.has(key) && !beforeKeys.has(key);
  });

  appendActivity(doc, {
    id: `activity:public-assets-from-script:${now.replace(/[-:.TZ]/g, '')}`,
    type: 'public_assets_generated',
    at: now,
    message: createdAssets.length
      ? `已从剧本生成 ${createdAssets.length} 个公共资产候选`
      : '剧本中的公共资产候选已存在'
  });

  return {
    createdCount: createdAssets.length,
    totalCount: doc.publicAssets.length,
    assets: createdAssets
  };
}

export function splitScriptTextUnits(text) {
  const value = String(text || '').trim();
  if (!value) return [];
  const storyboardSource = extractStoryboardBody(value);
  const items = looksLikeScreenplayDraft(storyboardSource)
    ? splitScreenplayDraft(storyboardSource)
    : splitStoryNarrative(storyboardSource);
  return items
    .map((item) => normalizeShotUnit(item))
    .filter(Boolean)
    .map((item) => item.length > 120 ? item.slice(0, 120) : item);
}

function extractStoryboardBody(text) {
  const lines = String(text || '')
    .split(/\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const formalScriptIndex = lines.findIndex((line) => isFormalScriptHeading(line));
  if (formalScriptIndex >= 0) {
    return collectFormalScriptLines(lines, formalScriptIndex + 1).join('\n');
  }

  const bodyLines = [];
  let inMetadataSection = false;
  for (const line of lines) {
    if (isMetadataSectionHeading(line)) {
      inMetadataSection = true;
      continue;
    }
    if (isSceneHeadingLine(line)) {
      inMetadataSection = false;
      bodyLines.push(line);
      continue;
    }
    if (isMarkdownHeading(line)) {
      inMetadataSection = false;
      continue;
    }
    if (inMetadataSection) continue;
    bodyLines.push(line);
  }
  return bodyLines.join('\n');
}

function collectFormalScriptLines(lines, startIndex) {
  const collected = [];
  for (const line of lines.slice(startIndex)) {
    // “正式剧本”之后如果再次出现二级元信息标题，通常已经进入资产建议/备注等非可拍资料。
    if (isMarkdownHeading(line) && !isSceneHeadingLine(line) && headingLevel(line) <= 2) break;
    collected.push(line);
  }
  return collected;
}

function isFormalScriptHeading(line) {
  const title = normalizeHeadingTitle(line);
  return /^(?:正式剧本|剧本正文|正文剧本|分镜脚本|分镜正文)$/u.test(title);
}

function isMetadataSectionHeading(line) {
  const title = normalizeHeadingTitle(line);
  return /^(?:分集剧本草稿|标题|故事概述|故事梗概|剧情概述|主要人物|人物|角色|角色设定|主要场景|场景清单|重要道具|道具|资产清单|基本信息|核心立意)$/u.test(title);
}

function isMarkdownHeading(line) {
  return /^#{1,6}\s+/u.test(String(line || '').trim());
}

function headingLevel(line) {
  const match = String(line || '').trim().match(/^(#{1,6})\s+/u);
  return match ? match[1].length : 0;
}

function normalizeHeadingTitle(line) {
  return String(line || '')
    .trim()
    .replace(/^#{1,6}\s*/u, '')
    .replace(/\*\*/gu, '')
    .replace(/[：:]\s*.*$/u, '')
    .replace(/\s+/gu, '')
    .trim();
}

function isSceneHeadingLine(line) {
  const normalized = stripMarkdownListMarker(line);
  return /^(?:#{1,6}\s*)?(?:场景|场次|镜头)\s*[\d一二三四五六七八九十百]+(?:[：:｜|]|\s*$)/u.test(normalized)
    || /^场景[一二三四五六七八九十百\d]+[｜|]/u.test(normalized);
}

function stripMarkdownListMarker(line) {
  // 文本模型的正式剧本经常写成 “- 动作：...” 列表；先剥离列表符，避免把 Markdown 语法当作镜头内容。
  return String(line || '')
    .trim()
    .replace(/^[-•]\s+/u, '')
    .replace(/^\*\s+/u, '')
    .trim();
}

function splitStoryNarrative(text) {
  return String(text || '')
    .split(/\n+|(?<=[。！？!?])\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatScreenplayDraft(beats) {
  const scenes = [];
  for (let index = 0; index < beats.length; index += SCREENPLAY_SCENE_SIZE) {
    scenes.push(beats.slice(index, index + SCREENPLAY_SCENE_SIZE));
  }
  const lines = [
    '《分集剧本草稿》',
    '说明：以下内容根据故事源整理为可继续润色的可拍剧本。',
    ''
  ];
  scenes.forEach((sceneBeats, index) => {
    lines.push(`场景${toChineseNumber(index + 1)}｜${createSceneTitle(sceneBeats[0], index + 1)}`);
    sceneBeats.forEach((beat, beatIndex) => {
      lines.push(formatScreenplayBeat(beat, beatIndex));
    });
    lines.push('');
  });
  return lines.join('\n').trim();
}

function createSceneTitle(text, sceneIndex) {
  const clean = normalizeShotUnit(text).replace(/[。！？!?，,]/g, ' ').trim();
  const title = clean.slice(0, 14).trim();
  return title || `第 ${sceneIndex} 场`;
}

function formatScreenplayBeat(beat, beatIndex) {
  if (isDialogueBeat(beat)) return `对白：${normalizeDialogueBeat(beat)}`;
  if (isSoundBeat(beat)) return `声音：${beat}`;
  return `${beatIndex === 0 ? '画面' : '动作'}：${beat}`;
}

function isDialogueBeat(text) {
  return /[“”"「」]/u.test(text) || /(问|说|答|喊|低声|轻声|旁白)/u.test(text);
}

function isSoundBeat(text) {
  return /(声音|音效|警铃|风声|雨声|蝉鸣|脚步|低语|音乐|水流声)/u.test(text);
}

function normalizeDialogueBeat(text) {
  return String(text || '')
    .replace(/^\*\*(.+?)\*\*/u, '$1')
    .replace(/\*\*/gu, '')
    .trim();
}

function looksLikeScreenplayDraft(text) {
  const lines = String(text || '')
    .split(/\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const screenplayLineCount = lines.filter((line) => {
    const normalizedLine = stripMarkdownListMarker(line);
    return (
      /^(?:《.+》|说明：|场景[一二三四五六七八九十百\d]+[｜|])/u.test(normalizedLine)
    || isSceneHeadingLine(normalizedLine)
    || /^(?:画面|动作|对白|台词|旁白|声音|音效|推进|场景)\s*[：:]/u.test(normalizedLine)
    || /^[△♪]/u.test(line)
    );
  }).length;
  return screenplayLineCount >= 3;
}

function splitScreenplayDraft(text) {
  return String(text || '')
    .split(/\n+/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !isScreenplayMetaLine(item));
}

function isScreenplayMetaLine(text) {
  const normalized = stripMarkdownListMarker(text);
  return /^(?:《.+》|说明：)/u.test(normalized)
    || /^#+\s*/u.test(normalized)
    || /^(?:---+|>)/u.test(normalized)
    || /^\|.+\|$/u.test(normalized)
    || /^\|[-\s|]+\|$/u.test(normalized)
    || /^(?:基础信息|角色)\s*$/u.test(normalized)
    || /^(?:项目|内容|目标片长|画幅|风格|字幕策略|声音策略|年龄|表演方向)\s*\|/u.test(normalized)
    || /^场景[一二三四五六七八九十百\d]+[｜|]/u.test(normalized)
    || /^\*\*(?:场景|出场人物|时间|声音|场景描述)：\*\*/u.test(normalized)
    || isSceneHeadingLine(normalized)
    // 片名卡、屏幕文字、字幕提示是后期备注，不应生成独立分镜视频。
    || /^(?:屏幕文字|字幕|标题卡|片名)(?:（.*?）)?\s*[：:]/u.test(normalized)
    || /^(?:画面|动作|对白|台词|旁白|声音|音效|推进|场景)\s*[：:]\s*$/u.test(normalized);
}

function normalizeShotUnit(text) {
  return String(text || '')
    .replace(/^[-•]\s+/u, '')
    .replace(/^\*\s+/u, '')
    .replace(/^\*\*(.+?)\*\*/u, '$1')
    .replace(/\*\*/gu, '')
    .replace(/^[△♪]\s*/u, '')
    .replace(/^(旁白|动作|对白|台词|场景|镜头|画面|声音|音效|推进)\s*[：:]\s*/u, '')
    // 文本模型偶尔把中文后引号单独换行；这不是可拍内容，归一化为空后会被过滤。
    .replace(/^[”」』"')）]+$/u, '')
    .trim();
}

function toChineseNumber(value) {
  const mapping = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value <= 10) return value === 10 ? '十' : mapping[value];
  if (value < 20) return `十${mapping[value % 10] || ''}`;
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${mapping[tens]}十${ones ? mapping[ones] : ''}`;
}

function createShotTitle(unit, shotNo) {
  const clean = unit.replace(/[。！？!?，,]/g, ' ').trim();
  const title = clean.slice(0, 18).trim() || `镜头 ${shotNo}`;
  return title.length < clean.length ? `${title}…` : title;
}

function estimateDuration(unit) {
  // Seedance 主流单镜头在 5-10 秒之间，V1 先按文本长度估算并强制小于 15 秒。
  const length = String(unit || '').length;
  if (length <= 24) return 5;
  if (length <= 48) return 8;
  return 12;
}

function normalizeStoryboardRows(shots) {
  return (Array.isArray(shots) ? shots : [])
    .map((shot) => {
      const scriptText = String(shot?.scriptText || shot?.summary || '').trim();
      const title = String(shot?.title || '').trim();
      return {
        shotNo: normalizeStoryboardShotNo(shot?.shotNo || shot?.id),
        sourceShotNo: normalizeStoryboardShotNo(shot?.sourceShotNo || shot?.shotNo || shot?.id),
        title,
        scriptText,
        summary: scriptText,
        durationSec: Number(shot?.durationSec)
      };
    })
    // 空白行是用户新增后还没填写的占位，不写入正式分镜，避免下游出现不可生产镜头。
    .filter((shot) => shot.title || shot.scriptText);
}

function formatStoryboardShotNo(index) {
  return `s${String(index).padStart(3, '0')}`;
}

function normalizeStoryboardShotNo(value) {
  const text = String(value || '').replace(/^shot:/u, '').trim().toLowerCase();
  return /^s\d{1,4}[a-z]?$/u.test(text) ? text.replace(/^s(\d+)/u, (_match, digits) => `s${String(Number(digits)).padStart(3, '0')}`) : '';
}

function nextStoryboardShotIndex(shots) {
  const numbers = (Array.isArray(shots) ? shots : [])
    .map((shot) => String(shot?.shotNo || shot?.id || '').match(/s(\d+)/iu))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}

function clampShotDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return 5;
  // 单个分镜必须服务 15 秒内视频生产；手工编辑时也在数据层兜底收紧。
  return Math.min(15, Math.max(1, Math.round(duration)));
}

function removeShotGraphRecords(doc, deletedShotIds) {
  if (!deletedShotIds.size) return;
  doc.nodes = (doc.nodes || []).filter((node) => !deletedShotIds.has(node.shotId));
  doc.tasks = (doc.tasks || []).filter((task) => !deletedShotIds.has(task.shotId));
  doc.edges = filterEdgesWithExistingNodes(doc);
}

function remapShotGraphRecords(doc, plans) {
  const nodeIdMap = new Map();
  if (!plans.length) return nodeIdMap;

  for (const plan of plans) {
    for (const node of doc.nodes || []) {
      if (node.shotId !== plan.sourceShotId) continue;
      const oldId = node.id;
      node.shotId = plan.shotId;
      node.id = rewriteShotNoToken(node.id, plan.sourceShotNo, plan.shotNo);
      node.title = rewriteShotNoToken(node.title, plan.sourceShotNo, plan.shotNo);
      if (oldId && node.id && oldId !== node.id) nodeIdMap.set(oldId, node.id);
    }

    for (const task of doc.tasks || []) {
      if (task.shotId !== plan.sourceShotId) continue;
      task.shotId = plan.shotId;
      task.id = rewriteShotNoToken(task.id, plan.sourceShotNo, plan.shotNo);
      task.title = rewriteShotNoToken(task.title, plan.sourceShotNo, plan.shotNo);
    }
  }

  // 分镜删除后的重编号会改写节点 ID；边和任务里的引用必须同步重指向，避免留下旧 s003 等孤儿引用。
  for (const edge of doc.edges || []) {
    edge.from = nodeIdMap.get(edge.from) || edge.from;
    edge.to = nodeIdMap.get(edge.to) || edge.to;
    edge.id = rewriteKnownNodeIds(edge.id, nodeIdMap);
  }
  for (const task of doc.tasks || []) {
    task.promptNodeId = nodeIdMap.get(task.promptNodeId) || task.promptNodeId;
    task.outputNodeIds = Array.isArray(task.outputNodeIds)
      ? task.outputNodeIds.map((nodeId) => nodeIdMap.get(nodeId) || nodeId)
      : [];
  }
  return nodeIdMap;
}

function remapShotLocalReferences(shot, nodeIdMap) {
  if (!shot.videoVersions || !nodeIdMap.size) return shot;
  return {
    ...shot,
    videoVersions: {
      ...shot.videoVersions,
      current: nodeIdMap.get(shot.videoVersions.current) || shot.videoVersions.current,
      candidate: nodeIdMap.get(shot.videoVersions.candidate) || shot.videoVersions.candidate
    }
  };
}

function rewriteShotNoToken(value, sourceShotNo, targetShotNo) {
  if (!value || !sourceShotNo || !targetShotNo || sourceShotNo === targetShotNo) return value;
  return String(value).replaceAll(sourceShotNo, targetShotNo);
}

function rewriteKnownNodeIds(value, nodeIdMap) {
  if (!value || !nodeIdMap.size) return value;
  let next = String(value);
  for (const [from, to] of nodeIdMap.entries()) {
    next = next.replaceAll(normalizeIdPart(from), normalizeIdPart(to));
    next = next.replaceAll(from, to);
  }
  return next;
}

function syncStoryboardShotGraph(doc, shot, { now }) {
  const scriptNode = upsertScriptSegmentNode(doc, shot, { now });
  const promptNode = upsertVideoPromptNode(doc, shot, { now });
  upsertVideoTask(doc, shot, promptNode, { now });
  ensureDerivedEdge(doc, scriptNode.id, promptNode.id);
}

function upsertScriptSegmentNode(doc, shot, { now }) {
  const id = `node:script:${shot.shotNo}`;
  let node = findNodeForShot(doc, shot, 'script_segment');
  if (!node) {
    node = createNode({
      id,
      type: 'script_segment',
      title: shot.title,
      shotId: shot.id,
      status: shot.status || 'draft',
      metadata: {}
    });
    doc.nodes.push(node);
  }
  node.id = node.id || id;
  node.title = shot.title;
  node.shotId = shot.id;
  node.status = shot.status || node.status || 'draft';
  node.metadata = {
    ...(node.metadata || {}),
    text: shot.scriptText || shot.summary || '',
    source: MANUAL_STORYBOARD_SOURCE,
    updatedAt: now
  };
  return node;
}

function upsertVideoPromptNode(doc, shot, { now }) {
  const id = `node:prompt:video:${shot.shotNo}:v001`;
  let node = findNodeForShot(doc, shot, 'video_prompt');
  if (!node) {
    node = createNode({
      id,
      type: 'video_prompt',
      title: `${shot.shotNo} 视频提示词`,
      shotId: shot.id,
      status: shot.status || 'draft',
      metadata: {}
    });
    doc.nodes.push(node);
  }
  node.id = node.id || id;
  node.title = node.title || `${shot.shotNo} 视频提示词`;
  node.shotId = shot.id;
  node.status = node.status || shot.status || 'draft';
  if (shouldRegeneratePrompt(node)) {
    const duration = clampShotDuration(shot.durationSec || estimateDuration(shot.scriptText));
    node.metadata = {
      ...(node.metadata || {}),
      prompt: createVideoPrompt(shot.scriptText || shot.summary || shot.title, {
        ratio: doc.config?.defaultRatio || '9:16',
        duration
      }),
      source: MANUAL_STORYBOARD_SOURCE,
      promptPolicyVersion: PROMPT_BEST_PRACTICES_VERSION,
      updatedAt: now
    };
  }
  return node;
}

function shouldRegeneratePrompt(node) {
  const source = node?.metadata?.source;
  // 只刷新本地规则/手工分镜派生出来的提示词；用户在 shot canvas 里手动精修过的提示词不能被 Step 1 覆盖。
  return !node?.metadata?.prompt || !source || source === GENERATED_SOURCE || source === MANUAL_STORYBOARD_SOURCE;
}

function upsertVideoTask(doc, shot, promptNode, { now }) {
  let task = (doc.tasks || []).find((item) => item.type === 'video' && item.shotId === shot.id);
  if (!task) {
    task = createTask({
      id: `task:video:${shot.shotNo}:v001`,
      shotId: shot.id,
      type: 'video',
      title: `${shot.shotNo} 分镜视频生成`,
      status: shot.status || 'draft',
      promptNodeId: promptNode.id,
      outputNodeIds: [],
      fields: {}
    });
    doc.tasks.push(task);
  }
  task.shotId = shot.id;
  task.type = 'video';
  task.title = task.title || `${shot.shotNo} 分镜视频生成`;
  task.promptNodeId = promptNode.id;
  task.outputNodeIds = Array.isArray(task.outputNodeIds) ? task.outputNodeIds : [];
  task.fields = {
    ...(task.fields || {}),
    ratio: task.fields?.ratio || doc.config?.defaultRatio || '9:16',
    duration: clampShotDuration(shot.durationSec || estimateDuration(shot.scriptText)),
    providerMode: task.fields?.providerMode || 'external_automation',
    provider: task.fields?.provider || 'jimeng',
    updatedAt: now
  };
  return task;
}

function ensureDerivedEdge(doc, scriptNodeId, promptNodeId) {
  if ((doc.edges || []).some((edge) => edge.from === scriptNodeId && edge.to === promptNodeId && edge.type === 'derived_from')) return;
  doc.edges.push(createEdge({
    id: `edge:${normalizeIdPart(scriptNodeId)}:derived:${normalizeIdPart(promptNodeId)}`,
    from: scriptNodeId,
    to: promptNodeId,
    type: 'derived_from',
    role: 'script_to_video_prompt',
    note: '由分镜剧本文本同步生成分镜视频提示词'
  }));
}

function findNodeForShot(doc, shot, type) {
  return (doc.nodes || []).find((node) => node.type === type && node.shotId === shot.id)
    || (doc.nodes || []).find((node) => node.type === type && node.id?.includes(`:${shot.shotNo}`))
    || null;
}

function filterEdgesWithExistingNodes(doc) {
  const keptNodeIds = new Set((doc.nodes || []).map((node) => node.id));
  return (doc.edges || []).filter((edge) => keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to));
}

function normalizeWorkflowForStoryboardEdit(workflow) {
  // 手工增删改分镜后仍停留在 Step 1，让用户继续检查列表，而不是被自动带到视频生产页。
  const steps = [
    { key: 'script_shots', title: '剧本与分镜', status: 'active' },
    { key: 'asset_library', title: '公共资产', status: 'available' },
    { key: 'shot_videos', title: '分镜视频', status: 'available' },
    { key: 'export', title: '成片导出', status: 'available' }
  ];
  if (!workflow || typeof workflow !== 'object') return { currentStep: 'script_shots', steps };
  return {
    currentStep: 'script_shots',
    steps
  };
}

function createVideoPrompt(unit, { ratio, duration }) {
  return createBestPracticeVideoPrompt(unit, { ratio, duration });
}

function collectPublicAssetSourceText(doc) {
  const draftText = normalizePublicAssetSourceText(doc?.scriptDraft?.text);
  if (draftText) return draftText;
  return normalizePublicAssetSourceText((doc?.shots || [])
    .map((shot) => shot?.scriptText || shot?.summary || '')
    .join('\n'));
}

function normalizePublicAssetSourceText(value) {
  return String(value || '').trim();
}

function extractPublicAssetCandidates(units, now) {
  const text = units.join('\n');
  const candidates = [];
  for (const title of extractCharacterTitles(text)) {
    candidates.push(createPublicAsset('characters', title, '从剧本中识别的角色候选', now));
  }

  const locationRules = [
    ['小学音乐教室', /小学音乐教室|音乐教室/u],
    ['学校楼梯间', /学校楼梯间|楼梯间|走廊/u],
    ['城市商业区大屏', /城市商业区|商业区|大屏/u],
    ['剧场舞台', /剧场|舞台|后台|观众席|追光/u],
    ['楼顶天台', /楼顶|天台/u],
    ['河边练声角落', /河边|练声/u],
    ['机房', /机房|服务器|数据中心/u],
    ['公司办公室', /公司|办公室|会议室/u],
    ['街道', /街道|路边|巷子/u],
    ['房间', /房间|卧室|客厅/u]
  ];
  for (const [title, pattern] of locationRules) {
    if (pattern.test(text)) candidates.push(createPublicAsset('locations', title, '从分镜文本中识别的场景候选', now));
  }
  if (!candidates.some((item) => item.category === 'locations')) {
    candidates.push(createPublicAsset('locations', '主要场景', '待用户补充或替换的场景候选', now));
  }

  const propRules = [
    ['胸针', /胸针/u],
    ['旧钢琴', /旧钢琴|钢琴/u],
    ['节目单', /节目单/u],
    ['旧练声本', /旧练声本|练声本/u],
    ['旧校服', /旧校服|校服/u],
    ['书包', /书包/u],
    ['小首饰盒', /首饰盒/u],
    ['证据', /证据|资料|文件/u],
    ['手机', /手机|短信|电话/u],
    ['门禁卡', /门禁|工牌|卡/u],
    ['钥匙', /钥匙/u]
  ];
  for (const [title, pattern] of propRules) {
    if (pattern.test(text)) candidates.push(createPublicAsset('props', title, '从分镜文本中识别的道具候选', now));
  }
  // 通用规则只提取物品类别；特定作品的颜色和主题由用户自行填写。
  return candidates;
}

function extractCharacterTitles(text) {
  const titles = new Set();
  const roleRules = [
    ['主角', /主角/u],
    ['奶奶', /奶奶|祖母|外婆/u],
    ['母亲', /母亲|妈妈/u],
    ['父亲', /父亲|爸爸/u],
    ['女儿', /女儿/u]
  ];
  for (const [title, pattern] of roleRules) {
    if (pattern.test(text)) titles.add(title);
  }

  for (const title of extractDeclaredCharacterTitles(text)) {
    titles.add(title);
  }
  for (const title of extractDialogueSpeakerTitles(text)) {
    titles.add(title);
  }

  if (!titles.size) titles.add('主角');
  return [...titles].slice(0, 8);
}

function extractDeclaredCharacterTitles(text) {
  const titles = new Set();
  const lines = String(text || '').split(/\n+/u).map((line) => line.trim()).filter(Boolean);
  let inCharacterSection = false;
  for (const line of lines) {
    if (/^(?:#+\s*)?(?:主要人物|人物|角色|角色设定)\s*[:：]?\s*$/u.test(line)) {
      inCharacterSection = true;
      continue;
    }
    if (inCharacterSection && /^(?:#+\s*)?(?:主要场景|场景|重要道具|道具|正式剧本|故事概述|剧情|梗概)\s*[:：]?\s*$/u.test(line)) {
      inCharacterSection = false;
    }
    if (!inCharacterSection) continue;

    // 人物段落一般是“小邮：小学音乐老师”或“- 小邮（女主）”；只取冒号/括号前的短名称。
    const normalized = line.replace(/^[-*•]\s*/u, '').replace(/\*\*/gu, '').trim();
    const match = normalized.match(/^([\u4e00-\u9fa5][\u4e00-\u9fa5·]{1,5})(?:\s*[：:(（\-]|$)/u);
    if (match) titles.add(match[1].trim());
  }
  return [...titles];
}

function extractDialogueSpeakerTitles(text) {
  const titles = new Set();
  const stopWords = new Set([
    '画面', '动作', '对白', '旁白', '场景', '声音', '音效', '镜头', '正式剧本',
    '城市', '学校', '小学', '音乐教室', '楼梯间', '商业区', '剧场', '舞台'
  ]);
  const speakerPattern = /(?:^|\n)\s*(?:[-*•]\s*)?(?:对白|台词)?\s*[\(（]?([\u4e00-\u9fa5·]{2,6})[\)）]?\s*[：:]/gu;
  for (const match of String(text || '').matchAll(speakerPattern)) {
    const title = match[1].trim();
    if (stopWords.has(title)) continue;
    if (/^(?:这|那|一个|一张|成年|旧|小|大|后期|覆盖)/u.test(title)) continue;
    if (/(?:胸针|节目单|钢琴|校服|书包|楼梯|教室|舞台)$/u.test(title)) continue;
    if (/^奶(?!奶$)/u.test(title)) continue;
    titles.add(title);
  }
  return [...titles];
}

function createPublicAsset(category, title, notes, now) {
  return {
    id: `asset:${category}:${normalizeIdPart(title) || 'item'}`,
    category,
    title,
    status: 'pending',
    required: false,
    source: GENERATED_SOURCE,
    notes,
    prompt: createPublicAssetPrompt(category, title, notes),
    // 公共资产候选通常先于真实素材生成；引用资源先保留为用户可编辑的名称列表，而不是提前写入图谱边。
    referenceAssets: [],
    createdAt: now,
    updatedAt: now
  };
}

function createPublicAssetPrompt(category, title, notes) {
  const label = {
    characters: '角色',
    locations: '场景',
    props: '道具',
    'style-refs': '风格参考',
    voices: '音频参考',
    videos: '视频参考'
  }[category] || '公共资产';
  const guidance = {
    characters: '保持稳定外貌、年龄、服装气质、表情范围和多分镜连续性，适合作为后续角色图或视频参考。',
    locations: '明确空间布局、时代质感、光线氛围和可复用机位，适合作为多分镜场景锚点。',
    props: '突出材质、尺寸、磨损痕迹和叙事用途，保证后续镜头里同一物件可识别。',
    'style-refs': '描述整体色彩、材质、光线、镜头气质和情绪基调，作为全片视觉统一参考。'
  }[category] || '描述该资产的可复用特征和生成边界。';
  return `生成${label}公共资产「${title}」：${guidance}${notes ? `\n补充：${notes}` : ''}`;
}

function mergePublicAssets(existing, generated) {
  const byKey = new Map();
  for (const asset of Array.isArray(existing) ? existing : []) {
    if (!asset?.category || !asset?.title) continue;
    byKey.set(`${asset.category}:${asset.title}`, asset);
  }
  for (const asset of generated) {
    const key = `${asset.category}:${asset.title}`;
    if (!byKey.has(key)) byKey.set(key, asset);
  }
  return [...byKey.values()];
}

function removeGeneratedStoryboard(doc) {
  const generatedShotIds = new Set((doc.shots || [])
    .filter((shot) => shot.metadata?.source === GENERATED_SOURCE)
    .map((shot) => shot.id));
  doc.shots = (doc.shots || []).filter((shot) => !generatedShotIds.has(shot.id));
  doc.nodes = (doc.nodes || []).filter((node) => node.metadata?.source !== GENERATED_SOURCE && !generatedShotIds.has(node.shotId));
  const keptNodeIds = new Set(doc.nodes.map((node) => node.id));
  doc.edges = (doc.edges || []).filter((edge) => keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to));
  doc.tasks = (doc.tasks || []).filter((task) => !generatedShotIds.has(task.shotId));
}

function normalizeWorkflowForStoryboard(workflow) {
  // 分镜拆分后刷新 step 状态时同样使用面向用户的短文案，避免旧项目显示过期阶段名。
  const steps = [
    { key: 'script_shots', title: '剧本与分镜', status: 'completed' },
    { key: 'asset_library', title: '公共资产', status: 'available' },
    { key: 'shot_videos', title: '分镜视频', status: 'active' },
    { key: 'export', title: '成片导出', status: 'available' }
  ];
  if (!workflow || typeof workflow !== 'object') return { currentStep: 'shot_videos', steps };
  return {
    currentStep: 'shot_videos',
    steps
  };
}

function appendActivity(doc, item) {
  if (!Array.isArray(doc.activityLog)) doc.activityLog = [];
  doc.activityLog.push(item);
}
