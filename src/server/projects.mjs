import { readdir, readFile, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createEmptyDramaCreatorDocument, normalizeIdPart } from '../schema/dramaCreatorSchema.mjs';
import { movePathToTrash, trashRootForWorkspace } from './trash.mjs';

// 项目发现服务：
//   - readRegisteredProjects 读用户显式注册到 ~/.drama-creator/projects.json 的 workspace；
//   - autoDiscoverProjects 只作为开发/旧项目兼容，扫描 allowedEpisodeRoots 下的历史 scripts/episodes 布局；
//   - listProjects 合并两个来源、按 path 去重，给前端一份完整清单。

const REGISTRY_FILE = join(homedir(), '.drama-creator', 'projects.json');
const EPISODES_DIR_NAME = 'episodes';
const SCRIPTS_DIR_NAME = 'scripts';
const STATE_FILE = 'drama-creator.json';
const PROJECT_MANIFEST_FILE = 'project.json';
const DEFAULT_EPISODE_ID = 'ep001';
const V1_START_MODES = new Set(['idea_text', 'story_text', 'material_text']);

export async function listProjects({
  allowedEpisodeRoots = [],
  registryFile = REGISTRY_FILE,
  appWorkspaceDir,
  maxDepth = 5
} = {}) {
  const appOwned = appWorkspaceDir ? await listAppOwnedProjects({ appWorkspaceDir }) : [];
  const auto = await autoDiscoverProjects({ allowedEpisodeRoots, maxDepth });
  const registered = await readRegisteredProjects({ registryFile });

  const byPath = new Map();
  for (const project of [...appOwned, ...auto, ...registered]) {
    if (!byPath.has(project.path)) {
      byPath.set(project.path, project);
    }
  }
  // 按 updatedAt 降序，让最近改动的项目排在前面
  const projects = [...byPath.values()].sort((a, b) => {
    const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return tb - ta;
  });
  return projects;
}

export async function createAppOwnedProject({
  appWorkspaceDir = join(homedir(), '.drama-creator'),
  name,
  firstEpisodeName,
  startMode,
  sourceText,
  ideaText,
  storyGeneratedBy
} = {}) {
  const projectName = typeof name === 'string' ? name.trim() : '';
  if (!projectName) {
    const error = new Error('Project name is required');
    error.statusCode = 400;
    throw error;
  }

  const resolvedStartMode = V1_START_MODES.has(startMode) ? startMode : 'story_text';
  const now = new Date().toISOString();
  const projectsRoot = join(resolve(appWorkspaceDir), 'projects');
  await mkdir(projectsRoot, { recursive: true });
  const projectId = await createUniqueProjectId(projectsRoot, normalizeIdPart(projectName) || 'untitled-project');
  const projectRoot = join(projectsRoot, projectId);
  const episodePath = join(projectRoot, EPISODES_DIR_NAME, DEFAULT_EPISODE_ID);
  await mkdir(episodePath, { recursive: true });

  const storySources = buildInitialStorySources({
    startMode: resolvedStartMode,
    sourceText,
    ideaText,
    storyGeneratedBy,
    createdAt: now
  });
  const doc = createEmptyDramaCreatorDocument({
    projectName,
    episodeId: DEFAULT_EPISODE_ID,
    episodePath,
    episodeTitle: typeof firstEpisodeName === 'string' && firstEpisodeName.trim() ? firstEpisodeName.trim() : '第 1 集',
    storySources
  });
  doc.project.id = projectId;
  doc.activityLog.push({
    id: 'activity:project-created',
    type: 'project_created',
    at: now,
    message: '项目已创建，进入剧本与分镜步骤'
  });

  const manifest = {
    id: projectId,
    name: projectName,
    source: 'app',
    currentStep: 'script_shots',
    createdAt: now,
    updatedAt: now
  };
  await writeFile(join(episodePath, STATE_FILE), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await writeFile(join(projectRoot, PROJECT_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return summarizeAppProject(projectRoot, manifest, [await summarizeEpisode(episodePath)]);
}

export async function createProjectEpisode({
  projectPath,
  title
} = {}) {
  if (!projectPath || typeof projectPath !== 'string') {
    const error = new Error('projectPath is required');
    error.statusCode = 400;
    throw error;
  }

  const projectRoot = resolve(projectPath);
  const manifest = await readProjectManifest(projectRoot);
  if (!manifest) {
    const error = new Error('Project manifest not found');
    error.statusCode = 404;
    throw error;
  }

  const existingEpisodes = await listEpisodesForProject(projectRoot);
  const nextNumber = nextEpisodeNumber(existingEpisodes);
  const episodeId = `ep${String(nextNumber).padStart(3, '0')}`;
  const episodePath = join(projectRoot, EPISODES_DIR_NAME, episodeId);
  if (await pathExists(episodePath)) {
    const error = new Error('Episode path already exists');
    error.statusCode = 409;
    throw error;
  }

  const now = new Date().toISOString();
  const firstEpisodeDoc = existingEpisodes[0]
    ? await readEpisodeDocument(existingEpisodes[0].path)
    : null;
  await mkdir(episodePath, { recursive: true });
  const doc = createEmptyDramaCreatorDocument({
    projectName: manifest.name,
    episodeId,
    episodePath,
    episodeTitle: typeof title === 'string' && title.trim() ? title.trim() : `第 ${nextNumber} 集`,
    config: firstEpisodeDoc?.config || undefined,
    storySources: []
  });
  doc.project.id = manifest.id || basename(projectRoot);
  doc.activityLog.push({
    id: `activity:episode-created:${episodeId}`,
    type: 'episode_created',
    at: now,
    message: `${doc.episode.title} 已创建，进入剧本与分镜步骤`
  });

  const nextManifest = {
    ...manifest,
    updatedAt: now
  };
  await writeFile(join(episodePath, STATE_FILE), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await writeFile(join(projectRoot, PROJECT_MANIFEST_FILE), `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');
  const episodes = await listEpisodesForProject(projectRoot);
  return {
    project: summarizeAppProject(projectRoot, nextManifest, episodes),
    episode: await summarizeEpisode(episodePath)
  };
}

export async function updateProjectMetadata(options = {}) {
  const {
    projectPath,
    appWorkspaceDir = join(homedir(), '.drama-creator'),
    coreIdea,
    globalBrief,
    jimengSpaceName
  } = options;
  if (!projectPath || typeof projectPath !== 'string') {
    const error = new Error('projectPath is required');
    error.statusCode = 400;
    throw error;
  }

  const projectRoot = await realpath(resolve(projectPath));
  const manifest = await readProjectManifest(projectRoot);
  if (!manifest) {
    const error = new Error('Project manifest not found');
    error.statusCode = 404;
    throw error;
  }
  if (!(await isAppOwnedProject(projectRoot, appWorkspaceDir, manifest))) {
    const error = new Error('Only app-owned projects can update project metadata.');
    error.statusCode = 409;
    throw error;
  }

  const episodes = await listEpisodesForProject(projectRoot);
  const now = new Date().toISOString();
  const hasCoreIdea = Object.prototype.hasOwnProperty.call(options, 'coreIdea');
  const hasGlobalBrief = Object.prototype.hasOwnProperty.call(options, 'globalBrief');
  const hasJimengSpaceName = Object.prototype.hasOwnProperty.call(options, 'jimengSpaceName');
  const nextManifest = {
    ...manifest,
    // 项目级元数据需要随作品共享；角色/场景等全局设定也放在这里，避免污染逐镜分镜剧本。
    coreIdea: hasCoreIdea ? normalizeCoreIdea(coreIdea) : normalizeCoreIdea(manifest.coreIdea),
    globalBrief: hasGlobalBrief ? normalizeGlobalBrief(globalBrief) : normalizeGlobalBrief(manifest.globalBrief),
    jimengSpaceName: hasJimengSpaceName ? normalizeJimengSpaceName(jimengSpaceName) : normalizeJimengSpaceName(manifest.jimengSpaceName),
    updatedAt: now
  };
  await writeFile(join(projectRoot, PROJECT_MANIFEST_FILE), `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');
  return summarizeAppProject(projectRoot, nextManifest, episodes);
}

export async function deleteProject({
  projectPath,
  appWorkspaceDir = join(homedir(), '.drama-creator'),
  registryFile = REGISTRY_FILE
} = {}) {
  if (!projectPath || typeof projectPath !== 'string') {
    const error = new Error('projectPath is required');
    error.statusCode = 400;
    throw error;
  }

  const requestedPath = resolve(projectPath);
  let projectRoot;
  try {
    projectRoot = await realpath(requestedPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const unregistered = await unregisterProject({ projectPath: requestedPath, registryFile });
      if (unregistered) return { action: 'unregistered', projectPath: requestedPath };
      const err = new Error('Project path not found');
      err.statusCode = 404;
      throw err;
    }
    throw error;
  }

  const manifest = await readProjectManifest(projectRoot);
  if (await isAppOwnedProject(projectRoot, appWorkspaceDir, manifest)) {
    const trashed = await movePathToTrash({
      targetPath: projectRoot,
      trashRoot: trashRootForWorkspace(appWorkspaceDir, 'projects'),
      reason: 'project_deleted',
      metadata: {
        kind: 'project',
        id: manifest.id || basename(projectRoot),
        name: manifest.name || basename(projectRoot),
        source: manifest.source || 'app'
      }
    });
    await unregisterProject({ projectPath: projectRoot, registryFile });
    return {
      action: 'trashed',
      projectPath: projectRoot,
      trashPath: trashed.trashPath,
      bytes: trashed.bytes
    };
  }

  const unregistered = await unregisterProject({ projectPath: projectRoot, registryFile });
  if (unregistered) {
    return { action: 'unregistered', projectPath: projectRoot };
  }

  const error = new Error('Only app-owned projects can be moved to trash. External auto-discovered projects cannot be deleted by Drama Creator.');
  error.statusCode = 409;
  throw error;
}

export async function deleteProjectEpisode({
  projectPath,
  episodePath,
  appWorkspaceDir = join(homedir(), '.drama-creator')
} = {}) {
  if (!projectPath || !episodePath) {
    const error = new Error('projectPath and episodePath are required');
    error.statusCode = 400;
    throw error;
  }

  const projectRoot = await realpath(resolve(projectPath));
  const episodeRoot = await realpath(resolve(episodePath));
  if (!isPathInside(episodeRoot, projectRoot)) {
    const error = new Error('Episode path is not inside the project');
    error.statusCode = 403;
    throw error;
  }

  const manifest = await readProjectManifest(projectRoot);
  if (!manifest) {
    const error = new Error('Project manifest not found');
    error.statusCode = 404;
    throw error;
  }
  if (!(await isAppOwnedProject(projectRoot, appWorkspaceDir, manifest))) {
    const error = new Error('Only app-owned episodes can be moved to trash by Drama Creator.');
    error.statusCode = 409;
    throw error;
  }

  const episodes = await listEpisodesForProject(projectRoot);
  const target = episodes.find((episode) => resolve(episode.path) === episodeRoot);
  if (!target) {
    const error = new Error('Episode not found');
    error.statusCode = 404;
    throw error;
  }
  if (episodes.length <= 1) {
    const error = new Error('Cannot delete the only episode. Delete the project instead.');
    error.statusCode = 409;
    throw error;
  }

  const trashed = await movePathToTrash({
    targetPath: episodeRoot,
    trashRoot: trashRootForWorkspace(appWorkspaceDir, 'episodes'),
    reason: 'episode_deleted',
    metadata: {
      kind: 'episode',
      projectId: manifest.id || basename(projectRoot),
      projectName: manifest.name || basename(projectRoot),
      episodeId: target.id,
      episodeTitle: target.title
    }
  });

  const now = new Date().toISOString();
  const nextManifest = { ...manifest, updatedAt: now };
  await writeFile(join(projectRoot, PROJECT_MANIFEST_FILE), `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');
  const nextEpisodes = await listEpisodesForProject(projectRoot);
  return {
    action: 'trashed',
    episodePath: episodeRoot,
    trashPath: trashed.trashPath,
    bytes: trashed.bytes,
    project: summarizeAppProject(projectRoot, nextManifest, nextEpisodes)
  };
}

export async function listAppOwnedProjects({ appWorkspaceDir } = {}) {
  const projectsRoot = join(resolve(appWorkspaceDir || join(homedir(), '.drama-creator')), 'projects');
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const projectRoot = join(projectsRoot, entry.name);
    const manifest = await readProjectManifest(projectRoot);
    if (!manifest) continue;
    const episodes = await listEpisodesForProject(projectRoot);
    projects.push(summarizeAppProject(projectRoot, manifest, episodes));
  }
  return projects;
}

export async function autoDiscoverProjects({ allowedEpisodeRoots, maxDepth }) {
  const seenProjectRoots = new Map();
  for (const root of allowedEpisodeRoots) {
    await walkForEpisodes(resolve(root), maxDepth, async (episodePath) => {
      const projectRoot = inferProjectRoot(episodePath);
      if (!projectRoot) return;
      const previous = seenProjectRoots.get(projectRoot);
      const summary = await summarizeEpisode(episodePath);
      if (!summary) return;

      if (!previous) {
        seenProjectRoots.set(projectRoot, {
          path: projectRoot,
          name: summary.projectName || basename(projectRoot),
          source: 'auto',
          episodes: [summary],
          updatedAt: summary.updatedAt
        });
        return;
      }
      previous.episodes.push(summary);
      if (summary.updatedAt && (!previous.updatedAt || summary.updatedAt > previous.updatedAt)) {
        previous.updatedAt = summary.updatedAt;
      }
      if (summary.projectName && !previous.name) {
        previous.name = summary.projectName;
      }
    });
  }
  return [...seenProjectRoots.values()].map((project) => ({
    ...project,
    episodes: project.episodes.sort((a, b) => a.id.localeCompare(b.id)),
    progress: aggregateProgress(project.episodes)
  }));
}

export async function readRegisteredProjects({ registryFile = REGISTRY_FILE } = {}) {
  const list = await readProjectRegistryEntries({ registryFile });
  const out = [];
  for (const item of list) {
    const projectRoot = resolve(item.path);
    const episodes = await listEpisodesForProject(projectRoot);
    out.push({
      path: projectRoot,
      name: item.name || episodes[0]?.projectName || basename(projectRoot),
      source: 'registered',
      episodes,
      updatedAt: episodes.reduce((acc, ep) => (ep.updatedAt && ep.updatedAt > acc ? ep.updatedAt : acc), ''),
      progress: aggregateProgress(episodes)
    });
  }
  return out;
}

export async function readProjectRegistryEntries({ registryFile = REGISTRY_FILE } = {}) {
  let payload;
  try {
    payload = await readFile(registryFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  let raw;
  try {
    raw = JSON.parse(payload);
  } catch {
    // 注册表损坏时不要让首页崩；返回空列表更好。
    return [];
  }
  const list = Array.isArray(raw?.projects) ? raw.projects : [];
  return list
    .filter((item) => item && typeof item.path === 'string')
    .map((item) => ({ path: resolve(item.path), ...(item.name ? { name: item.name } : {}) }));
}

export async function registerProject({
  projectPath,
  name,
  registryFile = REGISTRY_FILE
} = {}) {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('projectPath required');
  }
  const projectRoot = resolve(projectPath);
  let info;
  try {
    info = await stat(projectRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const err = new Error('Project path does not exist');
      err.statusCode = 404;
      throw err;
    }
    throw error;
  }
  if (!info.isDirectory()) {
    const err = new Error('Project path is not a directory');
    err.statusCode = 400;
    throw err;
  }

  await mkdir(dirname(registryFile), { recursive: true });
  let current = { projects: [] };
  try {
    current = JSON.parse(await readFile(registryFile, 'utf8'));
    if (!Array.isArray(current.projects)) current.projects = [];
  } catch {
    current = { projects: [] };
  }

  const existingIndex = current.projects.findIndex((p) => p && resolve(p.path) === projectRoot);
  const entry = { path: projectRoot, name: name || basename(projectRoot) };
  if (existingIndex >= 0) {
    current.projects[existingIndex] = { ...current.projects[existingIndex], ...entry };
  } else {
    current.projects.push(entry);
  }
  await writeFile(registryFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return entry;
}

export async function unregisterProject({
  projectPath,
  registryFile = REGISTRY_FILE
} = {}) {
  if (!projectPath || typeof projectPath !== 'string') return false;
  let current = { projects: [] };
  try {
    current = JSON.parse(await readFile(registryFile, 'utf8'));
    if (!Array.isArray(current.projects)) current.projects = [];
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    current = { projects: [] };
  }

  const target = resolve(projectPath);
  const before = current.projects.length;
  current.projects = current.projects.filter((item) => !item?.path || resolve(item.path) !== target);
  if (current.projects.length === before) return false;
  await mkdir(dirname(registryFile), { recursive: true });
  await writeFile(registryFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return true;
}

// ------------------------ helpers ------------------------

async function createUniqueProjectId(projectsRoot, baseId) {
  // 用户可重名创建项目；目录 id 用递增后缀避免覆盖已有工作区。
  let candidate = baseId;
  let suffix = 2;
  while (await pathExists(join(projectsRoot, candidate))) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function isAppOwnedProject(projectRoot, appWorkspaceDir, manifest) {
  if (!manifest || manifest.source !== 'app') return false;
  const projectsRoot = join(resolve(appWorkspaceDir), 'projects');
  let safeProjectsRoot;
  try {
    safeProjectsRoot = await realpath(projectsRoot);
  } catch {
    return false;
  }
  return isPathInside(projectRoot, safeProjectsRoot);
}

function isPathInside(targetPath, allowedRoot) {
  const distance = relative(allowedRoot, targetPath);
  return distance === '' || (!distance.startsWith('..') && !isAbsolute(distance));
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

function nextEpisodeNumber(episodes) {
  // 分集目录使用 ep001/ep002...；创建新集时按已有最大编号递增，避免用户删中间集后覆盖旧数据。
  const max = episodes.reduce((acc, episode) => {
    const match = String(episode.id || '').match(/^ep(\d+)$/);
    if (!match) return acc;
    return Math.max(acc, Number.parseInt(match[1], 10));
  }, 0);
  return max + 1;
}

async function readEpisodeDocument(episodePath) {
  try {
    return JSON.parse(await readFile(join(episodePath, STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function buildInitialStorySources({ startMode, sourceText, ideaText, storyGeneratedBy, createdAt }) {
  const text = typeof sourceText === 'string' ? sourceText.trim() : '';
  if (!text) return [];
  const source = {
    id: 'story:source:001',
    type: startMode,
    title: storySourceTitle(startMode),
    text,
    createdAt
  };
  if (startMode === 'idea_text') {
    // 保留原始想法，方便用户回溯“完整故事”是从哪一句创意扩写出来的。
    source.metadata = {
      ideaText: typeof ideaText === 'string' ? ideaText.trim() : '',
      generatedBy: typeof storyGeneratedBy === 'string' && storyGeneratedBy.trim() ? storyGeneratedBy.trim() : 'manual_or_text_model'
    };
  }
  return [source];
}

function storySourceTitle(startMode) {
  if (startMode === 'idea_text') return '由想法生成的故事';
  if (startMode === 'material_text') return '已有素材文本';
  return '故事源';
}

async function readProjectManifest(projectRoot) {
  try {
    const raw = JSON.parse(await readFile(join(projectRoot, PROJECT_MANIFEST_FILE), 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') return null;
    return raw;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

function summarizeAppProject(projectRoot, manifest, episodes) {
  const safeEpisodes = episodes.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
  const currentStep = safeEpisodes[0]?.currentStep || manifest.currentStep || 'script_shots';
  return {
    id: manifest.id || basename(projectRoot),
    path: projectRoot,
    name: manifest.name || safeEpisodes[0]?.projectName || basename(projectRoot),
    coreIdea: typeof manifest.coreIdea === 'string' ? manifest.coreIdea : '',
    globalBrief: typeof manifest.globalBrief === 'string' ? manifest.globalBrief : '',
    jimengSpaceName: normalizeJimengSpaceName(manifest.jimengSpaceName),
    source: 'app',
    currentStep,
    episodes: safeEpisodes,
    updatedAt: safeEpisodes.reduce((acc, ep) => (ep.updatedAt && ep.updatedAt > acc ? ep.updatedAt : acc), manifest.updatedAt || ''),
    progress: aggregateProgress(safeEpisodes)
  };
}

function normalizeCoreIdea(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 2000);
}

function normalizeGlobalBrief(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 6000);
}

function normalizeJimengSpaceName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 80);
}

async function walkForEpisodes(rootPath, maxDepth, onMatch, depth = 0) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const child = join(rootPath, entry.name);
    if (entry.name === EPISODES_DIR_NAME && rootPath.endsWith(`${sep}${SCRIPTS_DIR_NAME}`)) {
      // 命中 .../<projectRoot>/scripts/episodes —— 列出每一集
      let episodeEntries;
      try {
        episodeEntries = await readdir(child, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const episodeEntry of episodeEntries) {
        if (!episodeEntry.isDirectory()) continue;
        const episodePath = join(child, episodeEntry.name);
        try {
          await stat(join(episodePath, STATE_FILE));
        } catch {
          continue;
        }
        await onMatch(episodePath);
      }
      continue;
    }
    await walkForEpisodes(child, maxDepth, onMatch, depth + 1);
  }
}

function inferProjectRoot(episodePath) {
  // episodePath 形如 .../<project>/scripts/episodes/ep001
  const marker = `${sep}${SCRIPTS_DIR_NAME}${sep}${EPISODES_DIR_NAME}${sep}`;
  const idx = episodePath.indexOf(marker);
  if (idx < 0) return null;
  return episodePath.slice(0, idx);
}

async function summarizeEpisode(episodePath) {
  const statePath = join(episodePath, STATE_FILE);
  let raw;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch {
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const fileStat = await stat(statePath).catch(() => null);

  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const shots = Array.isArray(doc.shots) ? doc.shots : [];
  // 进度分母应优先来自正式分镜数；仅在旧项目没有 shots 时才退回到视频/提示词节点数量。
  const shotVideoOutputs = nodes.filter((node) => node.type === 'video_output' && node.shotId);
  const shotVideoPrompts = nodes.filter((node) => node.type === 'video_prompt' && node.shotId);
  const total = shots.length || shotVideoOutputs.length || shotVideoPrompts.length;
  const approved = shots.length
    ? shots.filter((shot) => shot.status === 'approved').length
    : nodes.filter((node) => node.type === 'qc_record' && node.shotId && node.status === 'approved').length;
  return {
    id: doc.episode?.id || basename(episodePath),
    path: episodePath,
    title: doc.episode?.title || doc.episode?.id || basename(episodePath),
    projectName: doc.project?.name || '',
    currentStep: doc.workflow?.currentStep || '',
    total,
    approved,
    nodeCount: nodes.length,
    updatedAt: fileStat?.mtime?.toISOString() || ''
  };
}

async function listEpisodesForProject(projectRoot) {
  const episodePaths = await findEpisodeDirectories(projectRoot);
  const out = [];
  for (const episodePath of episodePaths) {
    const summary = await summarizeEpisode(episodePath);
    if (summary) out.push(summary);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function findEpisodeDirectories(projectRoot, maxDepth = 8) {
  const out = [];
  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === STATE_FILE)) {
      out.push(current);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await walk(join(current, entry.name), depth + 1);
    }
  }
  await walk(resolve(projectRoot), 0);
  return out;
}

function aggregateProgress(episodes) {
  let approved = 0;
  let total = 0;
  for (const ep of episodes) {
    approved += ep.approved || 0;
    total += ep.total || 0;
  }
  return { approved, total };
}

function basename(path) {
  const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf(sep);
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
