export function buildSrt(doc) {
  const shots = Array.isArray(doc?.shots) ? doc.shots : [];
  let cursor = 0;
  const entries = [];
  for (const shot of shots) {
    const duration = Math.max(1, Number(shot.durationSec || 5));
    const start = cursor;
    const end = cursor + duration;
    cursor = end;
    const subtitleText = extractSubtitleForShot(doc, shot);
    if (!subtitleText) continue;
    entries.push([
      String(entries.length + 1),
      `${formatSrtTime(start)} --> ${formatSrtTime(end)}`,
      subtitleText,
      ''
    ].join('\n'));
  }
  return entries.join('\n');
}

export function extractFirstSubtitleLine(doc, shot) {
  const lines = extractSubtitleLines(resolveShotScriptText(doc, shot));
  return lines[0] || '';
}

export function extractSubtitleForShot(doc, shot) {
  return extractSubtitleLines(resolveShotScriptText(doc, shot)).join('\n');
}

export function extractSubtitleLines(rawText) {
  const lines = String(rawText || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const subtitles = [];
  for (const line of lines) {
    const subtitle = extractSubtitleLine(line);
    if (subtitle) subtitles.push(subtitle);
  }
  return subtitles;
}

function resolveShotScriptText(doc, shot) {
  const script = (doc?.nodes || []).find((node) => node.type === 'script_segment' && node.shotId === shot.id);
  return script?.metadata?.text || shot?.subtitle || '';
}

function extractSubtitleLine(line) {
  const directSpeech = line.match(/^(旁白|对白|台词|字幕|on_screen_text)(?:（[^）]*）)?\s*[：:]\s*(.+)$/iu);
  if (directSpeech) {
    const spokenText = cleanSpokenText(directSpeech[2]);
    // 分镜剧本会写“对白：无，本镜以动作...”这类制作说明；它不是字幕，不能进入预览或 SRT。
    if (isNoSpokenLine(spokenText)) return '';
    return spokenText;
  }

  // 旧项目里部分分镜把音频/台词要求写在提示词同一行；只抽取被明确标成台词/对白/旁白的引号内容。
  const inlineSpeech = line.match(/(?:旁白|对白|台词)\s*[：:]\s*[“"'](.+?)[”"']/u);
  if (inlineSpeech) return cleanSpokenText(inlineSpeech[1]);
  return '';
}

function cleanSpokenText(value) {
  return String(value || '')
    .trim()
    .replace(/^[“"']+|[”"']+$/g, '')
    .trim();
}

function isNoSpokenLine(value) {
  const normalized = String(value || '').trim();
  return /^无(?:新增台词|对白|旁白|台词|字幕)?(?:[，,。；;]|$)/u.test(normalized);
}

function formatSrtTime(totalSeconds) {
  const ms = Math.round((totalSeconds % 1) * 1000);
  const total = Math.floor(totalSeconds);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${String(ms).padStart(3, '0')}`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}
