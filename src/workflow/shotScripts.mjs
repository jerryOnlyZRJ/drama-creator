import { splitScriptTextUnits } from './scriptShots.mjs';

const SCRIPT_BACKFILL_SOURCE = 'legacy_shot_script_backfill';

export function normalizeShotScriptTexts(doc, { now = new Date().toISOString() } = {}) {
  if (!doc || !Array.isArray(doc.shots) || !doc.shots.length) return false;
  if (!Array.isArray(doc.nodes)) doc.nodes = [];
  let changed = false;

  const draftUnits = splitScriptTextUnits(doc.scriptDraft?.text || '');
  for (const [index, shot] of doc.shots.entries()) {
    const scriptNode = findScriptNode(doc.nodes, shot);
    const existingText = readShotScriptText(doc, shot, { includeWeakText: false });
    const promptNode = findVideoPrompt(doc, shot);
    const derivedText = existingText
      // 旧数据可能把图像提示词写进分镜剧本；有中文草稿时按镜头序号优先恢复可读剧本文本。
      || readableDraftUnit(draftUnits[index])
      || (shouldDeriveScriptFromPrompt(promptNode) ? promptToScriptText(promptNode.metadata?.prompt || promptNode.prompt || '') : '')
      || fallbackShotText(shot);
    if (!derivedText) continue;

    if (shot.scriptText !== derivedText) {
      // shot.scriptText 让分镜作为最小生产单元独立携带剧本；图谱节点则服务画布和导出链路。
      shot.scriptText = derivedText;
      changed = true;
    }

    if (scriptNode) {
      const nodeText = String(scriptNode.metadata?.text || '').trim();
      if (isWeakScriptText(nodeText, shot) || isGeneratedPromptText(nodeText)) {
        scriptNode.metadata = {
          ...(scriptNode.metadata || {}),
          text: derivedText,
          source: scriptNode.metadata?.source || SCRIPT_BACKFILL_SOURCE,
          updatedAt: scriptNode.metadata?.updatedAt || now
        };
        changed = true;
      }
    } else {
      doc.nodes.push({
        id: `node:script:${shotNoOf(shot) || doc.nodes.length + 1}`,
        type: 'script_segment',
        title: `${shotNoOf(shot) || '分镜'} 剧本片段`,
        shotId: shot.id,
        status: shot.status || 'draft',
        metadata: {
          text: derivedText,
          source: SCRIPT_BACKFILL_SOURCE,
          updatedAt: now
        }
      });
      changed = true;
    }
  }

  return changed;
}

export function readShotScriptText(doc, shot, { includeWeakText = true } = {}) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const scriptNode = findScriptNode(nodes, shot);
  const fallbackText = fallbackShotText(shot);
  const candidates = [
    // 分镜编辑后的权威文本写在 shot.scriptText；graph 节点仅作为旧文档或画布侧读取的兜底来源。
    shot?.scriptText,
    shot?.script,
    scriptNode?.metadata?.text,
    scriptNode?.text
  ];
  if (includeWeakText) {
    candidates.push(shot?.summary, shot?.description, scriptNode?.title);
  }
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (!text) continue;
    if (fallbackText && isGeneratedPromptText(text)) continue;
    if (!includeWeakText && isWeakScriptText(text, shot)) continue;
    return text;
  }
  return '';
}

export function deriveShotScriptFromPrompt(doc, shot) {
  const prompt = findVideoPrompt(doc, shot);
  return promptToScriptText(prompt?.metadata?.prompt || prompt?.prompt || '');
}

export function promptToScriptText(promptText) {
  const text = String(promptText || '').trim();
  if (!text) return '';
  const withoutMarkdown = text.replace(/\*\*/g, '').replace(/`/g, '');
  const main = withoutMarkdown
    .split(/\n\s*转场到\s+/u)[0]
    .split(/(?:^|\n)\s*(?:镜头特异)?禁止[：:]/u)[0]
    .trim();
  const [actionBlock, rest = ''] = main.split(/镜头语言[：:]/u);
  const dialogue = extractDialogueLikeText(main);
  const action = actionBlock
    .replace(/^\s*[-*]\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const textParts = [action, dialogue].filter(Boolean);
  return uniqueLines(textParts.join('\n').replace(rest, '').trim());
}

function extractDialogueLikeText(text) {
  const matches = text.match(/(?:台词建议后期配音|后期画外音建议|对白)[：:][\s\S]*?(?=(?:镜头语言|音效|禁止|转场到)[：:]|$)/u);
  return matches ? matches[0].trim() : '';
}

function uniqueLines(text) {
  const seen = new Set();
  return String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .join('\n');
}

function findScriptNode(nodes, shot) {
  const shotId = shot?.id || null;
  const shotNo = shotNoOf(shot);
  return nodes.find((node) => {
    if (node.type !== 'script_segment') return false;
    return node.shotId === shotId || node.shotNo === shotNo;
  }) || null;
}

function findVideoPrompt(doc, shot) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const shotId = shot?.id || null;
  return nodes.find((node) => node.type === 'video_prompt' && node.shotId === shotId) || null;
}

function shouldDeriveScriptFromPrompt(promptNode) {
  if (!promptNode) return false;
  // 新版本地规则生成的投喂模板已有独立 prompt 节点；反向写回会污染“剧本与分镜”的可编辑文本。
  if (promptNode.metadata?.promptPolicyVersion) return false;
  const prompt = String(promptNode.metadata?.prompt || promptNode.prompt || '');
  return Boolean(prompt.trim()) && !isGeneratedPromptText(prompt);
}

function isGeneratedPromptText(text) {
  return /Seedance\s*2\.0|即梦视频生成|导演判断[：:]|投喂检查[：:]|prompt-best-practices/u.test(String(text || ''))
    || /(?:^|\n)\s*(?:Use case|Asset type|Style\/medium|Composition\/framing|Lighting\/mood|Color and mood|Primary request|Negative prompt|Avoid)\s*:/iu.test(String(text || ''));
}

function isWeakScriptText(text, shot) {
  const clean = compact(text);
  if (!clean) return true;
  const shotNo = compact(shotNoOf(shot));
  const title = compact(shot?.title);
  const summary = compact(shot?.summary);
  return clean === shotNo
    || clean === title
    || clean === summary
    || clean === compact(`${shotNo} ${title}`)
    || clean === compact(`镜头 ${shotNo}`);
}

function fallbackShotText(shot) {
  const candidates = [shot?.summary, shot?.title];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text && !isGeneratedPromptText(text)) return text;
  }
  return '';
}

function readableDraftUnit(text) {
  const value = String(text || '').trim();
  if (!value || isGeneratedPromptText(value)) return '';
  return value;
}

function shotNoOf(shot) {
  return shot?.shotNo || String(shot?.id || '').replace(/^shot:/, '');
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
