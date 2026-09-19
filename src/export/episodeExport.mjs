import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { selectExportVideoNode, selectPreviewVideoNode } from '../workflow/videoVersions.mjs';
import { buildSrt } from './subtitles.mjs';

const SHOT_PREVIEW_SUFFIX = '分镜拼接预览';

export async function exportEpisodeVideo({
  doc,
  episodePath,
  ffmpegPath = 'ffmpeg',
  outputDir = join(episodePath, 'exports'),
  status = inferExportStatus(doc),
  signal
} = {}) {
  throwIfAborted(signal);
  const shots = Array.isArray(doc?.shots) ? doc.shots : [];
  if (!shots.length) throw publicError(409, '当前分集还没有分镜，无法导出成片');
  const videoEntries = await collectShotVideos({ doc, episodePath, shots });
  const missing = videoEntries.filter((entry) => !entry.path);
  if (missing.length) throw publicError(409, `缺少 ${missing.length} 个分镜视频，补齐后才能导出成片`);

  throwIfAborted(signal);
  await mkdir(outputDir, { recursive: true });
  const baseName = buildExportBaseName(doc, status);
  const concatListPath = join(outputDir, `${baseName}.concat.txt`);
  const originalPath = join(outputDir, `${baseName}.mp4`);
  const srtPath = join(outputDir, `${baseName}.srt`);
  const subtitledPath = join(outputDir, `${baseName}_字幕版.mp4`);
  const warnings = [];

  await writeFile(concatListPath, buildConcatList(videoEntries), 'utf8');
  throwIfAborted(signal);
  await runConcatExport({ ffmpegPath, videoEntries, doc, originalPath, warnings, signal });
  throwIfAborted(signal);
  await writeFile(srtPath, buildSrt(doc), 'utf8');
  try {
    await runFfmpeg(ffmpegPath, [
      '-y',
      '-i', originalPath,
      '-vf', `subtitles=filename=${escapeSubtitlePath(srtPath)}`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      subtitledPath
    ], { signal });
  } catch (error) {
    await rm(subtitledPath, { force: true });
    warnings.push({
      code: 'subtitle_burn_failed',
      message: buildSubtitleBurnWarningMessage(error)
    });
  }

  return {
    status,
    originalPath,
    subtitledPath: warnings.some((warning) => warning.code === 'subtitle_burn_failed') ? null : subtitledPath,
    srtPath,
    concatListPath,
    warnings
  };
}

export async function exportAvailableShotPreview({
  doc,
  episodePath,
  ffmpegPath = 'ffmpeg',
  outputDir = join(episodePath, 'exports'),
  signal
} = {}) {
  throwIfAborted(signal);
  const shots = Array.isArray(doc?.shots) ? doc.shots : [];
  if (!shots.length) throw publicError(409, '当前分集还没有分镜，无法生成预览');
  const preferredAssembly = await resolvePreferredAssemblyPreview({ doc, episodePath, shots });
  if (preferredAssembly) return preferredAssembly;
  const previewTimeline = await buildPreviewTimeline({ doc, episodePath, shots });
  const available = previewTimeline.entries.filter((entry) => entry.path);
  if (!available.length) throw publicError(409, '当前还没有可预览的分镜视频，请先回填至少一个分镜视频。');

  throwIfAborted(signal);
  await mkdir(outputDir, { recursive: true });
  const baseName = `${buildExportBaseName(doc, 'draft')}_${SHOT_PREVIEW_SUFFIX}`;
  const concatListPath = join(outputDir, `${baseName}.concat.txt`);
  const previewPath = join(outputDir, `${baseName}.mp4`);
  const warnings = [];

  await writeFile(concatListPath, buildConcatList(available), 'utf8');
  throwIfAborted(signal);
  // 预览只拼接已经存在的视频，用于快速目检当前素材，不改变正式导出对缺失分镜的阻塞规则。
  try {
    await runConcatExport({ ffmpegPath, videoEntries: available, doc, originalPath: previewPath, warnings, signal });
  } finally {
    // 预览页只需要最终 MP4；拼接清单是内部中间产物，成功或失败都不应留在用户项目目录里。
    await rm(concatListPath, { force: true });
  }
  const previewInfo = await stat(previewPath);

  return {
    status: 'preview',
    previewPath,
    previewAssetPath: toEpisodeAssetPath(episodePath, previewPath),
    // 拼接预览会覆盖同名文件；文件版本用于让桌面播放器绕过旧 URL 的媒体分段缓存。
    previewRevision: buildPreviewRevision(previewInfo),
    includedShots: previewTimeline.includedShots,
    missingShots: previewTimeline.missingShots,
    includedCount: previewTimeline.includedShots.length,
    missingCount: previewTimeline.missingShots.length,
    timelineSegments: previewTimeline.segments,
    warnings
  };
}

export async function readExistingShotPreview({
  doc,
  episodePath,
  outputDir = join(episodePath, 'exports')
} = {}) {
  const shots = Array.isArray(doc?.shots) ? doc.shots : [];
  if (!shots.length) return null;
  const preferredAssembly = await resolvePreferredAssemblyPreview({ doc, episodePath, shots, existing: true });
  if (preferredAssembly) return preferredAssembly;

  const previewTimeline = await buildPreviewTimeline({ doc, episodePath, shots });
  if (!previewTimeline.entries.some((entry) => entry.path)) return null;

  // 页面重载后只恢复已经生成好的 MP4，不在只读检查里重新跑 ffmpeg，避免进入导出页产生隐性副作用。
  const baseName = `${buildExportBaseName(doc, 'draft')}_${SHOT_PREVIEW_SUFFIX}`;
  const previewPath = join(outputDir, `${baseName}.mp4`);
  let previewInfo;
  try {
    previewInfo = await stat(previewPath);
    if (!previewInfo.isFile()) return null;
  } catch {
    return null;
  }

  return {
    status: 'preview',
    existing: true,
    previewPath,
    previewAssetPath: toEpisodeAssetPath(episodePath, previewPath),
    previewRevision: buildPreviewRevision(previewInfo),
    includedShots: previewTimeline.includedShots,
    missingShots: previewTimeline.missingShots,
    includedCount: previewTimeline.includedShots.length,
    missingCount: previewTimeline.missingShots.length,
    timelineSegments: previewTimeline.segments,
    warnings: []
  };
}

async function resolvePreferredAssemblyPreview({ doc, episodePath, shots, existing = false }) {
  // 手工调好的全片剪辑版比自动粗拼更接近创作者验收结果；局部修复版不能短路全片预览。
  const preferred = await findPreferredFullAssemblyPreviewNode({ doc, episodePath, shots });
  if (!preferred) return null;

  return {
    status: 'preview',
    existing,
    curatedAssembly: true,
    source: 'preferred_assembly',
    previewNodeId: preferred.node.id,
    previewTitle: preferred.node.title || '精选剪辑版',
    previewPath: preferred.absolutePath,
    previewAssetPath: isAbsolute(preferred.node.path) ? toEpisodeAssetPath(episodePath, preferred.absolutePath) : preferred.node.path,
    previewRevision: buildPreviewRevision(preferred.info),
    includedShots: preferred.includedShots,
    missingShots: [],
    includedCount: preferred.includedShots.length,
    missingCount: 0,
    warnings: []
  };
}

async function findPreferredFullAssemblyPreviewNode({ doc, episodePath, shots }) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const allShotNos = shots.map(shotNoOf);
  // 只有显式标记并且覆盖全片的 assembly 才能短路预览拼接，避免局部转场修复版遮住完整分镜预览。
  const candidates = nodes
    .filter((node) => node?.type === 'video_output' && node.path)
    .filter((node) => {
      const metadata = node.metadata || {};
      return metadata.role === 'assembly_preview'
        && (metadata.exportPreferred === true || metadata.previewRole === 'preferred_export_preview');
    })
    .sort((a, b) => Number(b.metadata?.exportPriority || 0) - Number(a.metadata?.exportPriority || 0));

  for (const node of candidates) {
    const includedShots = getAssemblyIncludedShots(node, shots);
    if (!coversEveryShot(includedShots, allShotNos)) continue;
    for (const absolutePath of resolveMediaPathCandidates(episodePath, node.path)) {
      try {
        const info = await stat(absolutePath);
        if (info.isFile()) return { node, absolutePath, includedShots, info };
      } catch {
        // A selected edit can be project-relative or episode-relative; keep trying compatible roots.
      }
    }
  }
  return null;
}

function buildPreviewRevision(info) {
  return `${Math.trunc(info.mtimeMs)}-${info.size}`;
}

function getAssemblyIncludedShots(node, shots) {
  const explicit = Array.isArray(node?.metadata?.includedShots)
    ? node.metadata.includedShots.map(String).filter(Boolean)
    : [];
  if (explicit.length) return explicit;

  const shotNos = shots.map(shotNoOf);
  const source = `${node?.id || ''} ${node?.title || ''} ${node?.path || ''}`;
  const range = source.match(/s(\d{3})\s*[-_~]\s*s(\d{3})/i);
  if (!range) return shotNos;

  const start = Number(range[1]);
  const end = Number(range[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return shotNos;
  return shotNos.filter((shotNo) => {
    const match = String(shotNo).match(/^s(\d{3})$/i);
    if (!match) return false;
    const value = Number(match[1]);
    return value >= Math.min(start, end) && value <= Math.max(start, end);
  });
}

function coversEveryShot(includedShots, allShotNos) {
  if (!allShotNos.length) return false;
  const includedSet = new Set(includedShots.map(String));
  return allShotNos.every((shotNo) => includedSet.has(String(shotNo)));
}

async function buildPreviewTimeline({ doc, episodePath, shots }) {
  const shotEntries = await collectShotVideos({ doc, episodePath, shots, selectNode: selectPreviewVideoNode });
  const assemblySegments = await collectPreferredAssemblySegments({ doc, episodePath, shots });
  const assemblyByStartIndex = new Map(assemblySegments.map((segment) => [segment.startIndex, segment]));
  const shotNos = shots.map(shotNoOf);
  const coveredShotNos = new Set();
  const entries = [];
  const segments = [];

  for (let index = 0; index < shots.length; index += 1) {
    const shotNo = shotNos[index];
    if (coveredShotNos.has(shotNo)) continue;

    const assembly = assemblyByStartIndex.get(index);
    if (assembly) {
      entries.push({
        path: assembly.path,
        source: 'assembly_preview',
        node: assembly.node,
        shotNos: assembly.includedShots
      });
      segments.push({
        source: 'assembly_preview',
        title: assembly.node.title || '剪辑修复版',
        includedShots: assembly.includedShots
      });
      for (const included of assembly.includedShots) coveredShotNos.add(included);
      continue;
    }

    const shotEntry = shotEntries[index];
    if (!shotEntry?.path) continue;
    entries.push({
      ...shotEntry,
      source: 'shot_video',
      shotNos: [shotNo]
    });
    segments.push({
      source: 'shot_video',
      title: shotEntry.node?.title || shotEntry.shot?.title || shotNo,
      includedShots: [shotNo]
    });
    coveredShotNos.add(shotNo);
  }

  return {
    entries,
    segments,
    includedShots: shotNos.filter((shotNo) => coveredShotNos.has(shotNo)),
    missingShots: shotNos.filter((shotNo) => !coveredShotNos.has(shotNo))
  };
}

async function collectPreferredAssemblySegments({ doc, episodePath, shots }) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const shotNos = shots.map(shotNoOf);
  const shotIndexByNo = new Map(shotNos.map((shotNo, index) => [shotNo, index]));
  const selected = [];
  const occupied = new Set();
  const candidates = nodes
    .filter((node) => node?.type === 'video_output' && node.path)
    .filter((node) => {
      const metadata = node.metadata || {};
      return metadata.role === 'assembly_preview'
        && (metadata.exportPreferred === true || metadata.previewRole === 'preferred_export_preview');
    })
    .map((node) => {
      const includedShots = getAssemblyIncludedShots(node, shots);
      const indexes = includedShots
        .map((shotNo) => shotIndexByNo.get(shotNo))
        .filter((index) => Number.isInteger(index))
        .sort((a, b) => a - b);
      return { node, includedShots, indexes };
    })
    .filter((candidate) => candidate.indexes.length > 0 && candidate.indexes.length < shotNos.length)
    .filter((candidate) => isContiguousIndexes(candidate.indexes))
    .sort((a, b) => {
      const priorityDelta = Number(b.node.metadata?.exportPriority || 0) - Number(a.node.metadata?.exportPriority || 0);
      if (priorityDelta) return priorityDelta;
      return b.indexes.length - a.indexes.length;
    });

  for (const candidate of candidates) {
    if (candidate.indexes.some((index) => occupied.has(index))) continue;
    const resolved = await resolveFirstExistingMediaPath(episodePath, candidate.node.path);
    if (!resolved) continue;

    for (const index of candidate.indexes) occupied.add(index);
    selected.push({
      node: candidate.node,
      path: resolved,
      startIndex: candidate.indexes[0],
      includedShots: candidate.indexes.map((index) => shotNos[index])
    });
  }

  return selected.sort((a, b) => a.startIndex - b.startIndex);
}

function isContiguousIndexes(indexes) {
  if (!indexes.length) return false;
  for (let index = 1; index < indexes.length; index += 1) {
    if (indexes[index] !== indexes[index - 1] + 1) return false;
  }
  return true;
}

async function collectShotVideos({ doc, episodePath, shots, selectNode = selectExportVideoNode }) {
  const entries = [];
  for (const shot of shots) {
    const node = selectNode(doc, shot);
    if (!node) {
      entries.push({ shot, node: null, path: null });
      continue;
    }
    const resolvedPath = await resolveFirstExistingMediaPath(episodePath, node.path);
    entries.push({ shot, node, path: resolvedPath });
  }
  return entries;
}

async function resolveFirstExistingMediaPath(episodePath, mediaPath) {
  for (const absolutePath of resolveMediaPathCandidates(episodePath, mediaPath)) {
    try {
      const info = await stat(absolutePath);
      if (info.isFile()) return absolutePath;
    } catch {
      // Try the next compatible base; imported legacy projects may mix episode-relative and project-relative media paths.
    }
  }
  return null;
}

function shotNoOf(shot) {
  return shot?.shotNo || String(shot?.id || '').replace(/^shot:/, '') || '未命名分镜';
}

function toEpisodeAssetPath(episodePath, absolutePath) {
  const relativePath = relative(episodePath, absolutePath);
  return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)
    ? relativePath
    : absolutePath;
}

function resolveMediaPathCandidates(episodePath, mediaPath) {
  if (isAbsolute(mediaPath)) return [resolve(mediaPath)];
  const episodeRelative = resolve(episodePath, mediaPath);
  // App-owned imported assets can live at the project root while the document lives under episodes/epNNN.
  const projectRelative = resolve(dirname(dirname(episodePath)), mediaPath);
  return [...new Set([episodeRelative, projectRelative])];
}

function buildConcatList(videoEntries) {
  return videoEntries
    .map((entry) => `file '${escapeConcatPath(entry.path)}'`)
    .join('\n') + '\n';
}

async function runConcatExport({ ffmpegPath, videoEntries, doc, originalPath, warnings, signal }) {
  const dimensions = inferExportDimensions(doc);
  try {
    await runFfmpeg(ffmpegPath, buildConcatFilterArgs(videoEntries, originalPath, { dimensions, withAudio: true }), { signal });
    return;
  } catch (error) {
    if (error.statusCode === 499) throw error;
    warnings.push({
      code: 'audio_concat_fallback',
      message: '部分片段的声音无法合并，已先导出无声音版本。请检查这些分镜视频后重新导出。'
    });
  }
  await runFfmpeg(ffmpegPath, buildConcatFilterArgs(videoEntries, originalPath, { dimensions, withAudio: false }), { signal });
}

function buildConcatFilterArgs(videoEntries, originalPath, { dimensions, withAudio }) {
  const inputArgs = videoEntries.flatMap((entry) => ['-i', entry.path]);
  const filters = [];
  const concatInputs = [];
  const videoFilter = [
    `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease`,
    `pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    'fps=30'
  ].join(',');
  for (let index = 0; index < videoEntries.length; index += 1) {
    // Normalize every AI clip before concat; direct stream-copy can create broken DTS/duration metadata.
    filters.push(`[${index}:v:0]${videoFilter}[v${index}]`);
    concatInputs.push(`[v${index}]`);
    if (withAudio) {
      filters.push(`[${index}:a:0]aresample=48000[a${index}]`);
      concatInputs.push(`[a${index}]`);
    }
  }
  filters.push(`${concatInputs.join('')}concat=n=${videoEntries.length}:v=1:a=${withAudio ? 1 : 0}${withAudio ? '[v][a]' : '[v]'}`);
  return [
    '-y',
    ...inputArgs,
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    ...(withAudio ? ['-map', '[a]'] : []),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    ...(withAudio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']),
    '-movflags', '+faststart',
    originalPath
  ];
}

function inferExportDimensions(doc) {
  const ratios = (doc?.tasks || [])
    .map((task) => task?.fields?.ratio || task?.params?.ratio)
    .filter(Boolean);
  const portraitVotes = ratios.filter((ratio) => String(ratio).trim() === '9:16').length;
  const landscapeVotes = ratios.filter((ratio) => String(ratio).trim() === '16:9').length;
  return portraitVotes > landscapeVotes
    ? { width: 1080, height: 1920 }
    : { width: 1920, height: 1080 };
}

function escapeConcatPath(path) {
  return String(path).replace(/'/g, "'\\''");
}

function buildExportBaseName(doc, status) {
  const projectName = safeFilePart(doc?.project?.name || 'Drama Creator');
  const episodeTitle = safeFilePart(doc?.episode?.title || doc?.episode?.id || 'ep001');
  return `${projectName}_${episodeTitle}_${exportStatusFileLabel(status)}_v001`;
}

function exportStatusFileLabel(status) {
  return status === 'final' ? '正式版' : '草稿版';
}

function safeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '')
    || 'untitled';
}

function inferExportStatus(doc) {
  const shots = Array.isArray(doc?.shots) ? doc.shots : [];
  return shots.length && shots.every((shot) => shot.status === 'approved') ? 'final' : 'draft';
}

function escapeSubtitlePath(path) {
  return String(path)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function buildSubtitleBurnWarningMessage(error) {
  const rawMessage = String(error?.publicMessage || error?.message || '');
  // 这条 message 会直接出现在导出页；不要把 ffmpeg stderr 暴露给创作者。
  if (/No such filter|subtitles|libass|fontconfig|drawtext/i.test(rawMessage)) {
    return '字幕版未生成：当前设备的视频工具不支持字幕烧录，已保留原片 MP4 和 SRT 字幕。';
  }
  return '字幕版未生成：已保留原片 MP4 和 SRT 字幕。请稍后重试，或检查本机视频工具后重新导出。';
}

function runFfmpeg(ffmpegPath, args, { signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(publicError(499, '导出已取消'));
      return;
    }
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    let killTimer = null;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', abortChild);
      callback(value);
    };
    // 用户在页面点击“取消导出”后，fetch 会中断；这里同步终止正在执行的 ffmpeg，避免后台继续占用 CPU。
    const abortChild = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1200);
      settle(reject, publicError(499, '导出已取消'));
    };
    signal?.addEventListener('abort', abortChild, { once: true });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => settle(reject, publicError(500, `ffmpeg failed to start: ${error.message}`)));
    child.on('close', (code) => {
      if (signal?.aborted) {
        settle(reject, publicError(499, '导出已取消'));
        return;
      }
      if (code === 0) {
        settle(resolvePromise);
        return;
      }
      settle(reject, publicError(500, `ffmpeg exited with ${code}: ${stderr.slice(-800)}`));
    });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw publicError(499, '导出已取消');
}

function publicError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}
