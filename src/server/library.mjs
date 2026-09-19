import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseVoiceIndex } from '../import/markdownParsers.mjs';

// 项目级公共资源库：把 项目根/scripts/assets/{characters,locations,props,voices,style-refs}/
// 下的可复用素材拍成 { category, items: [{ id, title, path, version, kind }] } 让 L2 的"公共资源"
// tab 直接渲染，path 字段保持相对项目根，方便 /api/asset 复用现有解析链。

const CATEGORY_LABELS = {
  characters: { label: '角色', kind: 'image' },
  locations: { label: '场景', kind: 'image' },
  props: { label: '道具', kind: 'image' },
  voices: { label: '配音', kind: 'audio' },
  'style-refs': { label: '风格参考', kind: 'image' }
};

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const AUDIO_EXT = new Set(['.m4a', '.mp3', '.wav']);

const PROJECT_STYLE_REFERENCE_PATTERNS = [
  /(?:^|[-_])style[-_]?anchor(?:[-_]|$)/i,
  /(?:^|[-_])visual[-_]?style(?:[-_]|$)/i,
  /(?:^|[-_])overall[-_]?style(?:[-_]|$)/i,
  /(?:^|[-_])lookbook(?:[-_]|$)/i,
  /^STYLE[-_]/i,
  /^LOOK[-_]/i,
  /^REF[-_]/i
];

export async function listProjectLibrary(projectRoot) {
  const assetsRoot = join(projectRoot, 'scripts', 'assets');
  const categories = [];
  for (const [dirName, meta] of Object.entries(CATEGORY_LABELS)) {
    const categoryRoot = join(assetsRoot, dirName);
    // 音色目录会保留 WAV 转码和历史候选；公共资产页只读取 voice-index.md
    // 中登记的 canonical 参考音频，避免同一音色因格式或候选版本重复展示。
    const discoveredItems = dirName === 'voices'
      ? await collectIndexedVoiceFiles(projectRoot, categoryRoot)
      : await collectMediaFiles(categoryRoot, meta.kind);
    const items = discoveredItems
      .filter((item) => isPublicLibraryItem(dirName, item));
    if (!items.length) continue;
    categories.push({
      category: dirName,
      label: meta.label,
      kind: meta.kind,
      items: items.map((item) => ({
        id: relative(projectRoot, item.absolutePath).split(sep).join('/'),
        title: item.title || deriveTitle(item.basename),
        path: relative(projectRoot, item.absolutePath).split(sep).join('/'),
        version: item.version || parseVersion(item.basename),
        kind: meta.kind,
        ...(item.voiceId ? { voiceId: item.voiceId } : {}),
        ...(item.cardPath ? { cardPath: item.cardPath } : {}),
        ...(item.status ? { status: item.status } : {})
      }))
    });
  }
  return categories;
}

async function collectIndexedVoiceFiles(projectRoot, fallbackRoot) {
  const indexPath = join(projectRoot, 'scripts', 'assets', 'voices', 'voice-index.md');
  let rows = [];
  try {
    rows = parseVoiceIndex(await readFile(indexPath, 'utf8'));
  } catch {
    // 旧项目可能还没有音色索引；这时保留原有目录扫描行为，避免公共资产突然消失。
    return collectMediaFiles(fallbackRoot, 'audio');
  }

  const items = [];
  const seenPaths = new Set();
  for (const row of rows) {
    if (!row.referencePath) continue;
    const absolutePath = resolve(projectRoot, row.referencePath);
    const relativePath = relative(projectRoot, absolutePath);
    // voice-index 是项目数据，但仍限制引用不能逃出项目根，保持 /api/asset 的安全边界一致。
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) continue;
    if (!AUDIO_EXT.has(extensionOf(absolutePath)) || seenPaths.has(relativePath)) continue;
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    seenPaths.add(relativePath);
    items.push({
      absolutePath,
      basename: absolutePath.split(sep).pop() || row.voiceId,
      title: row.role || row.voiceId,
      version: parseVoiceVersion(row.voiceId),
      voiceId: row.voiceId,
      cardPath: row.cardPath,
      status: row.status
    });
  }

  // 索引存在时以索引为唯一公共入口；即使某个历史文件仍在 references 目录，
  // 也不会重新漏回公共资产页。索引完全为空时才兼容旧目录扫描。
  return rows.length ? items : collectMediaFiles(fallbackRoot, 'audio');
}

function isPublicLibraryItem(category, item) {
  if (category !== 'style-refs') return true;
  return isProjectLevelStyleReference(item.basename);
}

function isProjectLevelStyleReference(basename) {
  const dot = basename.lastIndexOf('.');
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  // legacy style-refs 目录里同时混有单镜头关键帧、尾帧、标题图和 UI 截图；
  // 公共资产库只自动收录显式项目级风格锚点，其余仍在分镜页/单分镜画布管理。
  return PROJECT_STYLE_REFERENCE_PATTERNS.some((pattern) => pattern.test(stem));
}

async function collectMediaFiles(root, kind) {
  const allowed = kind === 'audio' ? AUDIO_EXT : IMAGE_EXT;
  const out = [];
  await walk(root, (absolutePath, basename) => {
    const dot = basename.lastIndexOf('.');
    if (dot < 0) return;
    if (!allowed.has(basename.slice(dot).toLowerCase())) return;
    out.push({ absolutePath, basename });
  });
  out.sort((a, b) => a.basename.localeCompare(b.basename));
  return out;
}

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

function parseVoiceVersion(voiceId) {
  const match = String(voiceId || '').match(/_v(\d+)$/i);
  return match ? `v${match[1]}` : '';
}

async function walk(root, visit) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(full, visit);
      continue;
    }
    if (!entry.isFile()) {
      // 跟随符号链接但只在文件指向真实文件时纳入
      try {
        const info = await stat(full);
        if (info.isFile()) visit(full, entry.name);
      } catch { /* skip */ }
      continue;
    }
    visit(full, entry.name);
  }
}

function deriveTitle(basename) {
  const dot = basename.lastIndexOf('.');
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  return stem.replace(/_v\d+$/, '');
}

function parseVersion(basename) {
  const match = basename.match(/_v(\d+)\.[a-z0-9]+$/i);
  return match ? `v${match[1]}` : '';
}
