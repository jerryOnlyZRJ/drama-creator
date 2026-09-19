const BANNED_PROMPT_WORDS = ['popup', '弹窗', '按钮', '输入框', 'dialog', 'modal'];
const ALLOWED_VIDEO_RATIOS = new Set(['9:16', '16:9', '1:1', '21:9']);
const MIN_VIDEO_DURATION_SECONDS = 1;
const MAX_VIDEO_DURATION_SECONDS = 15;
const NEGATIVE_PROMPT_MARKERS = ['禁止', '不要', '不能', '不出现', '不显示', '避免', 'no ', 'without '];
const NEGATIVE_NO_ALLOWED_PARTS = new Set(BANNED_PROMPT_WORDS.concat(['和', '、', '/', '']));

export function runPreFeedChecks(doc) {
  return [
    runPromptSafetyCheck(doc),
    runGraphIntegrityCheck(doc),
    runVideoAspectDurationCheck(doc)
  ];
}

function runPromptSafetyCheck(doc) {
  const items = (doc.nodes || [])
    .filter((node) => node.type?.includes('prompt'))
    .flatMap((node) => {
      const prompt = node.metadata?.prompt || '';
      return BANNED_PROMPT_WORDS
        .filter((word) => hasUnsafePromptWord(prompt, word))
        .map((word) => ({
          label: `${node.title || node.id} 命中 ${word}`,
          status: 'warning'
        }));
    });

  return createCheck({
    id: 'check:prompt:safety',
    type: 'prompt_safety',
    items
  });
}

function hasUnsafePromptWord(prompt, word) {
  if (isNarrativeUiPrompt(prompt)) {
    return false;
  }

  let index = prompt.indexOf(word);
  while (index >= 0) {
    if (!isNegativePromptConstraint(prompt, index)) {
      return true;
    }
    index = prompt.indexOf(word, index + word.length);
  }
  return false;
}

function isNarrativeUiPrompt(prompt) {
  // Short-drama prompts may intentionally visualize app notices as cinematic AR/HUD overlays.
  return prompt.includes('AR/HUD') || prompt.includes('浮空 UI') || prompt.includes('短剧叙事约定');
}

function isNegativePromptConstraint(prompt, wordIndex) {
  const phraseStart = Math.max(
    prompt.lastIndexOf('，', wordIndex),
    prompt.lastIndexOf(',', wordIndex),
    prompt.lastIndexOf('。', wordIndex),
    prompt.lastIndexOf(';', wordIndex),
    prompt.lastIndexOf('；', wordIndex)
  ) + 1;
  const beforeWord = prompt.slice(phraseStart, wordIndex).toLowerCase();

  // Negative constraints such as "禁止弹窗和按钮" should pass because they prevent UI artifacts.
  if (NEGATIVE_PROMPT_MARKERS.some((marker) => beforeWord.includes(marker))) {
    return true;
  }
  return hasNoPrefixedUnsafeList(beforeWord);
}

function hasNoPrefixedUnsafeList(beforeWord) {
  const matches = [...beforeWord.matchAll(/无\s*(?:任何|任意|新生成的|UI\s*)?/gi)];
  const match = matches.at(-1);
  if (!match) return false;

  // Only treat "无" as a negator when it scopes over known unsafe UI words, not words like "无数".
  return beforeWord.slice(match.index + match[0].length)
    .split(/(和|、|\/|\s+)/)
    .every((part) => NEGATIVE_NO_ALLOWED_PARTS.has(part.trim()));
}

function runGraphIntegrityCheck(doc) {
  const nodeIds = new Set((doc.nodes || []).map((node) => node.id));
  const items = (doc.edges || [])
    .filter((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
    .map((edge) => ({
      label: `${edge.id} 存在断边`,
      status: 'warning'
    }));

  return createCheck({
    id: 'check:graph:integrity:runtime',
    type: 'graph_integrity',
    items
  });
}

function runVideoAspectDurationCheck(doc) {
  const items = (doc.tasks || [])
    .filter((task) => task.type === 'video')
    .flatMap((task) => {
      const warnings = [];
      const duration = Number(task.fields?.duration);
      if (!ALLOWED_VIDEO_RATIOS.has(task.fields?.ratio)) {
        warnings.push({ label: `${task.id} 比例无效`, status: 'warning' });
      }
      // 分镜编辑器和剧本拆分规则约束的是“单镜头不超过 15 秒”，不是固定档位。
      // 即梦页面是否能自动选中某个档位由自动化层处理，投喂包入口不应误拦合法短镜头。
      if (!Number.isInteger(duration) || duration < MIN_VIDEO_DURATION_SECONDS || duration > MAX_VIDEO_DURATION_SECONDS) {
        warnings.push({ label: `${task.id} 时长无效`, status: 'warning' });
      }
      return warnings;
    });

  return createCheck({
    id: 'check:aspect-duration',
    type: 'pre_feed',
    items
  });
}

function createCheck({ id, type, items }) {
  // Keep the check envelope schema-compatible so results can be persisted into drama-creator.json.
  return {
    id,
    type,
    status: items.length ? 'warning' : 'pass',
    items
  };
}
