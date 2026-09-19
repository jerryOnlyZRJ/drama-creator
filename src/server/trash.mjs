import { cp, mkdir, readdir, readFile, rm, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { normalizeIdPart } from '../schema/dramaCreatorSchema.mjs';

// 回收站统一放在应用工作区内，删除操作只移动文件，不直接物理销毁。
// 这样用户误删项目/分集/素材时，后续可以基于 manifest 做恢复入口。
export function trashRootForWorkspace(appWorkspaceDir, bucket = 'items') {
  return join(resolve(appWorkspaceDir), '.trash', bucket);
}

export async function movePathToTrash({ targetPath, trashRoot, reason, metadata = {} }) {
  const sourcePath = resolve(targetPath);
  const safeTrashRoot = resolve(trashRoot);
  await mkdir(safeTrashRoot, { recursive: true });

  const movedAt = new Date().toISOString();
  const stamp = movedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const label = normalizeIdPart(metadata.name || metadata.title || basename(sourcePath)) || 'deleted-item';
  const destination = await uniqueTrashPath(safeTrashRoot, `${stamp}-${label}`);
  const bytes = await measurePathSize(sourcePath);

  try {
    await rename(sourcePath, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    // 自定义工作区可能和 ~/.drama-creator 不在同一磁盘；跨设备 rename 失败时先复制再删除源路径。
    await cp(sourcePath, destination, { recursive: true, force: false, errorOnExist: true });
    await rm(sourcePath, { recursive: true, force: true });
  }

  const manifestPath = `${destination}.trash.json`;
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    reason,
    movedAt,
    originalPath: sourcePath,
    trashPath: destination,
    bytes,
    metadata
  }, null, 2)}\n`, 'utf8');

  return { trashPath: destination, manifestPath, bytes, movedAt };
}

export async function summarizeTrash(appWorkspaceDir) {
  const root = join(resolve(appWorkspaceDir), '.trash');
  const items = [];
  const buckets = [];
  let totalItems = 0;
  let totalBytes = 0;

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { trashRoot: root, totalItems: 0, totalBytes: 0, buckets: [], items: [] };
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bucketRoot = join(root, entry.name);
    const summary = await summarizeTrashBucket(bucketRoot, entry.name);
    buckets.push(summary);
    items.push(...summary.itemSummaries);
    totalItems += summary.items;
    totalBytes += summary.bytes;
  }

  items.sort((a, b) => String(b.movedAt || '').localeCompare(String(a.movedAt || '')));
  return { trashRoot: root, totalItems, totalBytes, buckets, items };
}

export async function emptyTrash(appWorkspaceDir) {
  const before = await summarizeTrash(appWorkspaceDir);
  const root = join(resolve(appWorkspaceDir), '.trash');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  return { ...before, emptied: true, emptiedAt: new Date().toISOString() };
}

export async function restoreTrashItem(appWorkspaceDir, itemId) {
  const item = await readTrashItem(appWorkspaceDir, itemId);
  const destination = resolve(item.manifest.originalPath);
  if (await pathExists(destination)) {
    throw httpError(409, 'Original path already exists. Move or rename the current file before restoring.');
  }
  await mkdir(dirname(destination), { recursive: true });
  await movePath({ from: item.trashPath, to: destination });
  await rm(item.manifestPath, { force: true });
  return {
    action: 'restored',
    itemId: item.id,
    originalPath: destination,
    metadata: item.manifest.metadata || {}
  };
}

export async function permanentlyDeleteTrashItem(appWorkspaceDir, itemId) {
  const item = await readTrashItem(appWorkspaceDir, itemId);
  await rm(item.trashPath, { recursive: true, force: true });
  await rm(item.manifestPath, { force: true });
  return {
    action: 'deleted',
    itemId: item.id,
    bytes: item.bytes
  };
}

export async function readTrashItem(appWorkspaceDir, itemId) {
  const root = join(resolve(appWorkspaceDir), '.trash');
  const parsed = parseTrashItemId(itemId);
  const bucketRoot = resolve(root, parsed.bucket);
  const trashPath = resolve(bucketRoot, parsed.name);
  const manifestPath = `${trashPath}.trash.json`;
  if (!isPathInside(bucketRoot, root) || !isPathInside(trashPath, bucketRoot) || !isPathInside(manifestPath, bucketRoot)) {
    throw httpError(403, 'Forbidden trash item');
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw httpError(404, 'Trash item not found');
    throw error;
  }
  if (!manifest || typeof manifest !== 'object') throw httpError(400, 'Trash manifest is invalid');

  let info;
  try {
    info = await stat(trashPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw httpError(404, 'Trash item payload not found');
    throw error;
  }
  const bytes = await measurePathSize(trashPath);
  return {
    id: `${parsed.bucket}/${parsed.name}`,
    bucket: parsed.bucket,
    name: parsed.name,
    trashPath,
    manifestPath,
    bytes,
    isDirectory: info.isDirectory(),
    manifest,
    summary: buildTrashItemSummary({ id: `${parsed.bucket}/${parsed.name}`, bucket: parsed.bucket, name: parsed.name, trashPath, manifest, bytes, info })
  };
}

async function summarizeTrashBucket(bucketRoot, bucket) {
  let entries;
  try {
    entries = await readdir(bucketRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { bucket, items: 0, bytes: 0, itemSummaries: [] };
    throw error;
  }

  const itemSummaries = [];
  let bytes = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('.trash.json')) continue;
    const trashPath = join(bucketRoot, entry.name);
    const manifestPath = `${trashPath}.trash.json`;
    const itemBytes = await measurePathSize(trashPath);
    bytes += itemBytes;
    const manifest = await readTrashManifest(manifestPath);
    const info = await stat(trashPath);
    itemSummaries.push(buildTrashItemSummary({
      id: `${bucket}/${entry.name}`,
      bucket,
      name: entry.name,
      trashPath,
      manifest,
      bytes: itemBytes,
      info
    }));
  }
  return { bucket, items: itemSummaries.length, bytes, itemSummaries };
}

async function readTrashManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function buildTrashItemSummary({ id, bucket, name, trashPath, manifest, bytes, info }) {
  const metadata = manifest?.metadata && typeof manifest.metadata === 'object' ? manifest.metadata : {};
  return {
    id,
    bucket,
    name,
    kind: metadata.kind || normalizeTrashKind(bucket),
    title: metadata.name || metadata.title || metadata.episodeTitle || name,
    reason: manifest?.reason || '',
    movedAt: manifest?.movedAt || '',
    originalPath: manifest?.originalPath || '',
    trashPath,
    bytes,
    isDirectory: !!info?.isDirectory?.(),
    canRestore: !!manifest?.originalPath
  };
}

function normalizeTrashKind(bucket) {
  return {
    projects: 'project',
    episodes: 'episode',
    resources: 'resource',
    items: 'items'
  }[bucket] || 'items';
}

async function uniqueTrashPath(root, baseName) {
  let candidate = join(root, baseName);
  let suffix = 2;
  while (await pathExists(candidate) || await pathExists(`${candidate}.trash.json`)) {
    candidate = join(root, `${baseName}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function parseTrashItemId(itemId) {
  const raw = typeof itemId === 'string' ? itemId : '';
  const [bucket, ...rest] = raw.split('/');
  const name = rest.join('/');
  if (!bucket || !name || bucket.includes('..') || name.includes('..') || name.includes('/') || name.endsWith('.trash.json')) {
    throw httpError(400, 'Invalid trash item id');
  }
  return { bucket, name };
}

async function movePath({ from, to }) {
  try {
    await rename(from, to);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, force: false, errorOnExist: true });
    await rm(from, { recursive: true, force: true });
  }
}

async function measurePathSize(targetPath) {
  const info = await stat(targetPath);
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;

  let total = 0;
  const entries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    total += await measurePathSize(join(targetPath, entry.name));
  }
  return total;
}

function isPathInside(targetPath, allowedRoot) {
  const distance = relative(allowedRoot, targetPath);
  return distance === '' || (!distance.startsWith('..') && !isAbsolute(distance));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
