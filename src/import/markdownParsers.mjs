import { extname } from 'node:path';

// Parse video prompt documents into per-shot sections keyed by shot number.
export function parseShotSections(markdown) {
  const text = String(markdown);
  const headingRegex = /^##\s+(.+)$/gim;
  const headings = [...text.matchAll(headingRegex)];

  return headings.flatMap((match, index) => {
    const shotMatch = match[1].match(/^(s\d+[a-z]?)\s+(.+)$/i);
    if (!shotMatch) return [];

    const next = headings[index + 1];
    const end = next ? next.index : text.length;
    return {
      shotNo: shotMatch[1],
      title: shotMatch[2].trim(),
      // Stop at any level-2 heading so summary sections cannot leak into the final shot.
      body: text.slice(match.index, end).trim()
    };
  });
}

// Parse bound image chips into deterministic references for graph edges.
export function parseBoundAssets(markdown) {
  const text = String(markdown);
  // Bound assets use Chinese full-width punctuation from the prompt SOP.
  const lineRegex = /^-\s+(@图片\d+)：(.+?)\s*→\s*`([^`]+)`(?:（(.+?)）)?/gim;
  return [...text.matchAll(lineRegex)].map((match) => ({
    chip: match[1],
    name: match[2].trim(),
    path: match[3].trim(),
    note: (match[4] || '').trim()
  }));
}

// Extract the first fenced prompt block, preserving internal line breaks.
export function extractFirstTextBlock(markdown) {
  // Episode docs may be authored on Windows, so both LF and CRLF fences are valid.
  const match = String(markdown).match(/```(?:text)?\r?\n([\s\S]*?)\r?\n```/i);
  return match ? match[1].trim() : '';
}

// Read the canonical backticked asset path from image prompt metadata lines.
export function parseFilePathLine(line) {
  const match = String(line).match(/文件路径[:：]\s*`([^`]+)`/);
  return match ? match[1].trim() : null;
}

// Split generated video names into importable episode, shot, and version parts.
export function parseVideoFileName(fileName) {
  const match = String(fileName).match(/^(ep\d+)_(s\d+[a-z]?)_(v\d+)(\.[a-z0-9]+)$/i);
  if (!match) return null;
  return {
    episodeId: match[1],
    shotNo: match[2],
    version: match[3],
    extension: extname(fileName)
  };
}

// 解析 voice-index.md 中"## 核心角色"表格，抽取每行音色资产元数据。
// 表格列约定（与 voice-bible 对齐）：voice_id | 角色 | 音色卡 | 参考音频 | 模型权重 | 状态。
// 任何行如果 voice_id 不符合 char_*_voice_v\d+ 规则会被跳过，避免把表头分隔行也吃进来。
export function parseVoiceIndex(markdown) {
  const text = String(markdown);
  if (!text.trim()) return [];

  const rowRegex = /^\|\s*(char_[a-z0-9]+_voice_v\d+)\s*\|([^\n]*)\|\s*$/gim;
  const rows = [];
  for (const match of text.matchAll(rowRegex)) {
    const voiceId = match[1].trim();
    const cells = match[2].split('|').map((cell) => cell.trim());
    // 期望剩余 5 列（角色/音色卡/参考音频/模型权重/状态）；少于 4 列说明不是完整数据行。
    if (cells.length < 4) continue;

    const [role, cardCell, referenceCell, modelCell, statusCell = ''] = cells;
    rows.push({
      voiceId,
      role,
      cardPath: extractBacktickedPath(cardCell),
      referencePath: extractBacktickedPath(referenceCell),
      modelPath: extractBacktickedPath(modelCell),
      status: statusCell
    });
  }
  return rows;
}

// 从形如 `` `scripts/.../foo.wav` `` 的单元格抽取真实路径，没有反引号则原样返回。
function extractBacktickedPath(cell) {
  if (!cell) return null;
  const match = cell.match(/`([^`]+)`/);
  return match ? match[1].trim() : cell.trim() || null;
}

// Split arbitrary Markdown documents by a fixed heading level for import passes.
export function parseMarkdownSectionsByHeading(markdown, level = 3) {
  const text = String(markdown);
  const marks = '#'.repeat(level);
  const headingRegex = new RegExp(`^${marks}\\s+(.+)$`, 'gim');
  const matches = [...text.matchAll(headingRegex)];

  return matches.map((match, index) => {
    const start = match.index;
    const next = matches[index + 1];
    const end = next ? next.index : text.length;
    return {
      title: match[1].trim(),
      body: text.slice(start, end).trim()
    };
  });
}
