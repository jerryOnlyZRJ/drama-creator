const LEGACY_REQUIREMENT_MARKER = `【分镜${'执行要求'}】`;
const LEGACY_CONTEXT_MARKER = `【完整剧本${'上下文'}】`;

const DROPPED_PRODUCTION_LABELS = new Set([
  '正式分镜',
  '正片时间',
  '覆盖细分镜',
  '场景/节点',
  '场景节点',
  '依赖资源',
  '生成备注'
]);

const CONTENT_LABELS = new Set([
  '画面',
  '动作',
  '镜头',
  '镜头调度',
  '对白',
  '台词',
  '旁白',
  '声音',
  '音效',
  '屏幕文字',
  '字幕'
]);

export function formatStoryboardShotHeading({ shotNo, title, durationSec, index = 0 } = {}) {
  const label = `${formatStoryboardShotLabel(shotNo, index)} 分镜`;
  const duration = `${normalizeDurationForDisplay(durationSec)}s`;
  const normalizedTitle = normalizeSingleLine(title || '');
  return [label, duration, normalizedTitle].filter(Boolean).join('｜');
}

export function formatStoryboardShotLabel(shotNo, index = 0) {
  const match = String(shotNo || '').match(/(\d+)/u);
  const value = match ? Number(match[1]) : Number(index) + 1;
  return `S${String(Number.isFinite(value) && value > 0 ? value : 1).padStart(3, '0')}`;
}

export function formatReadableStoryboardScriptText(text, { fallback = '' } = {}) {
  const source = extractStoryboardSource(text);
  const lines = source.split('\n');
  const output = [];

  for (const line of lines) {
    const normalized = normalizeStoryboardLine(line);
    if (!normalized) continue;
    if (isDroppedStoryboardLine(normalized)) continue;

    const labeled = parseLabeledLine(normalized);
    if (labeled) {
      const labelKey = normalizeLabelKey(labeled.label);
      if (DROPPED_PRODUCTION_LABELS.has(labelKey)) continue;
      if (labelKey === '景别与运动') {
        output.push(`镜头：${labeled.value}`);
        continue;
      }
      if (CONTENT_LABELS.has(labelKey) || labelKey.startsWith('对白')) {
        output.push(`${labeled.label}：${labeled.value}`);
        continue;
      }
      // 角色表、场景表、资产依赖等全局或生产信息不进入逐镜剧本正文。
      continue;
    }

    output.push(normalized);
  }

  const result = uniqueAdjacentLines(output).join('\n').trim();
  return result || String(fallback || '').trim();
}

function extractStoryboardSource(text) {
  let value = String(text || '').replace(/\r\n/g, '\n').trim();
  const requirementIndex = value.indexOf(LEGACY_REQUIREMENT_MARKER);
  if (requirementIndex >= 0) {
    value = value.slice(requirementIndex + LEGACY_REQUIREMENT_MARKER.length);
  }
  return value
    .replaceAll(LEGACY_CONTEXT_MARKER, '')
    .replaceAll(LEGACY_REQUIREMENT_MARKER, '')
    .trim();
}

function normalizeDurationForDisplay(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return 5;
  return Number.isInteger(duration) ? String(duration) : duration.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
}

function normalizeSingleLine(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function normalizeStoryboardLine(line) {
  return String(line || '')
    .trim()
    .replace(/^[-•]\s+/u, '')
    .replace(/^\*\s+/u, '')
    .replace(/^△\s*/u, '')
    .replace(/\*\*/gu, '')
    .replace(/`/gu, '')
    .trim();
}

function isDroppedStoryboardLine(line) {
  const value = String(line || '').trim();
  if (!value || /^---+$/u.test(value)) return true;
  if (/^#{1,6}\s*(?:主要人物|人物|角色|角色设定|主要场景|场景清单|重要道具|道具|资产清单)\b/u.test(value)) return true;
  if (/^(?:CHAR|SCENE|PROP|RULE|SRC|BGM|VO|STYLE|POST|KEYFRAME)-[A-Z0-9_-]+/u.test(value)) return true;
  return false;
}

function parseLabeledLine(line) {
  const match = String(line || '').match(/^([^：:]{1,24})[：:]\s*(.*)$/u);
  if (!match) return null;
  const label = match[1].trim();
  const value = match[2].trim();
  if (!value) return null;
  return { label, value };
}

function normalizeLabelKey(label) {
  return String(label || '')
    .replace(/\s+/gu, '')
    .replace(/[／/｜|]/gu, '')
    .trim();
}

function uniqueAdjacentLines(lines) {
  const output = [];
  for (const line of lines) {
    if (output[output.length - 1] === line) continue;
    output.push(line);
  }
  return output;
}
