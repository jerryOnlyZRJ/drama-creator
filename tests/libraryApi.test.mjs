// 公开测试使用虚构示例文本，保留解析与工作流断言，不承载作者作品。
// 公开测试使用虚构名称与对应资源标识，避免将创作项目的人物或作品名称带入源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createEmptyDramaCreatorDocument } from '../src/schema/dramaCreatorSchema.mjs';
import { createApp } from '../src/server/app.mjs';

// /api/library 给 L2 项目详情页的"公共资源"tab 提供分类清单。

async function makeProject() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-library-')));
  const projectRoot = join(root, 'project');
  const characters = join(projectRoot, 'scripts', 'assets', 'characters', 'images');
  const locations = join(projectRoot, 'scripts', 'assets', 'locations', 'images');
  const styleRefs = join(projectRoot, 'scripts', 'assets', 'style-refs', 'images');
  await mkdir(characters, { recursive: true });
  await mkdir(locations, { recursive: true });
  await mkdir(styleRefs, { recursive: true });
  await writeFile(join(characters, 'char_robot_v001.png'), Buffer.from('00', 'hex'));
  await writeFile(join(characters, 'char_tower_v002.png'), Buffer.from('00', 'hex'));
  await writeFile(join(locations, 'loc_office_v003.png'), Buffer.from('00', 'hex'));
  await writeFile(join(styleRefs, 'PROJECT-overall-style-anchor_v001.png'), Buffer.from('00', 'hex'));
  await writeFile(join(styleRefs, 'SHOT-01-keyframe-v1-approved.png'), Buffer.from('00', 'hex'));
  await writeFile(join(styleRefs, 'V01_tail_v1.png'), Buffer.from('00', 'hex'));
  await writeFile(join(styleRefs, 'TITLE-OPEN-01-v1-approved.png'), Buffer.from('00', 'hex'));
  return { root, projectRoot };
}

async function makeProjectWithEpisode(scriptText) {
  const { root, projectRoot } = await makeProject();
  const episodeRoot = join(projectRoot, 'episodes', 'ep001');
  await mkdir(episodeRoot, { recursive: true });
  const doc = createEmptyDramaCreatorDocument({
    projectName: '机器人送信',
    episodeId: 'ep001',
    episodePath: episodeRoot,
    episodeTitle: '第 1 集'
  });
  doc.scriptDraft = {
    text: scriptText,
    updatedAt: '2026-06-26T08:00:00.000Z'
  };
  const docPath = join(episodeRoot, 'drama-creator.json');
  await writeFile(docPath, JSON.stringify(doc, null, 2));
  return { root, projectRoot, episodeRoot, docPath };
}

test('GET /api/library groups assets by category and parses version suffixes', async () => {
  const { root, projectRoot } = await makeProject();
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/library?path=${encodeURIComponent(projectRoot)}`);
    const json = await response.json();

    assert.equal(response.status, 200);
    const characters = json.library.find((cat) => cat.category === 'characters');
    assert.ok(characters, 'characters category present');
    assert.equal(characters.items.length, 2);
    assert.equal(characters.items[0].version, 'v001');
    assert.equal(characters.items[0].path, 'scripts/assets/characters/images/char_robot_v001.png');

    const locations = json.library.find((cat) => cat.category === 'locations');
    assert.equal(locations.items[0].version, 'v003');

    const styleRefs = json.library.find((cat) => cat.category === 'style-refs');
    assert.ok(styleRefs, 'project-level style references are still public assets');
    assert.deepEqual(styleRefs.items.map((item) => item.title), ['PROJECT-overall-style-anchor']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/library exposes only canonical voice-index references', async () => {
  const { root, projectRoot } = await makeProject();
  const voicesRoot = join(projectRoot, 'scripts', 'assets', 'voices');
  const references = join(voicesRoot, 'references');
  await mkdir(references, { recursive: true });
  await writeFile(join(references, 'char_grandma_voice_v001_current.m4a'), Buffer.from('00', 'hex'));
  await writeFile(join(references, 'char_grandma_voice_v001_current.wav'), Buffer.from('00', 'hex'));
  await writeFile(join(references, 'char_grandma_voice_v001_candidate_a.mp3'), Buffer.from('00', 'hex'));
  await writeFile(join(voicesRoot, 'voice-index.md'), [
    '# 音色资产索引',
    '',
    '## 核心角色',
    '',
    '| voice_id | 角色 | 音色卡 | 参考音频 | 模型权重 | 状态 |',
    '|---|---|---|---|---|---|',
    '| char_grandma_voice_v001 | 示例奶奶 / 奶奶 | `scripts/assets/voices/cards/char_grandma_voice_v001.md` | `scripts/assets/voices/references/char_grandma_voice_v001_current.m4a` | `scripts/assets/voices/models/char_grandma_voice_v001/` | 已验收 |'
  ].join('\n'));

  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/library?path=${encodeURIComponent(projectRoot)}`);
    const json = await response.json();
    const voices = json.library.find((cat) => cat.category === 'voices');

    assert.equal(response.status, 200);
    assert.ok(voices, 'indexed voice category present');
    assert.deepEqual(voices.items.map((item) => item.path), [
      'scripts/assets/voices/references/char_grandma_voice_v001_current.m4a'
    ]);
    assert.equal(voices.items[0].title, '示例奶奶 / 奶奶');
    assert.equal(voices.items[0].voiceId, 'char_grandma_voice_v001');
    assert.equal(voices.items[0].version, 'v001');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/library keeps shot-local generated assets out of public style references', async () => {
  const { root, projectRoot } = await makeProject();
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/library?path=${encodeURIComponent(projectRoot)}`);
    const json = await response.json();

    assert.equal(response.status, 200);
    const styleRefs = json.library.find((cat) => cat.category === 'style-refs');
    const titles = styleRefs.items.map((item) => item.title);
    // style-refs 是 legacy 目录，里面可能混入分镜关键帧、尾帧和标题图；这些不应自动成为公共资产。
    assert.equal(titles.some((title) => /^SHOT-/.test(title)), false);
    assert.equal(titles.some((title) => /^V\d+_tail/.test(title)), false);
    assert.equal(titles.some((title) => /^TITLE-/.test(title)), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/library refuses unregistered project paths outside dev roots', async () => {
  const { root } = await makeProject();
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-out-')));
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/library?path=${encodeURIComponent(outside)}`);

    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('GET /api/library allows a registered workspace outside dev roots', async () => {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-app-root-')));
  const { root: externalRoot, projectRoot } = await makeProject();
  const registryFile = join(appRoot, 'projects.json');
  await writeFile(registryFile, JSON.stringify({ projects: [{ path: projectRoot, name: 'External Project' }] }));
  const server = createServer(createApp({ root: appRoot, allowedEpisodeRoots: [appRoot], registryFile }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/library?path=${encodeURIComponent(projectRoot)}`);
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.library.some((category) => category.category === 'characters'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(appRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('POST /api/library/generate-from-script writes public asset candidates into the episode document', async () => {
  const scriptText = [
    '## 主要人物',
    '- 小邮：小学音乐老师。',
    '- 奶奶：负责整理包裹的人。',
    '',
    '场景一｜小学音乐教室',
    '画面：小邮在音乐教室清点旧钢琴旁的道具，奶奶将蓝色胸针和校服装入书包。',
    '场景二｜城市商业区大屏下',
    '动作：小灯递给小邮一张节目单。'
  ].join('\n');
  const { root, episodeRoot, docPath } = await makeProjectWithEpisode(scriptText);
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/library/generate-from-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath: episodeRoot })
    });
    const json = await response.json();
    const savedDoc = JSON.parse(await readFile(docPath, 'utf8'));
    const assetKeys = savedDoc.publicAssets.map((asset) => `${asset.category}:${asset.title}`);

    assert.equal(response.status, 200);
    assert.equal(json.createdCount >= 5, true);
    assert.equal(assetKeys.includes('characters:小邮'), true);
    assert.equal(assetKeys.includes('characters:站在旧'), false);
    assert.equal(assetKeys.includes('characters:小学音乐教室'), false);
    assert.equal(assetKeys.includes('characters:蓝色胸针'), false);
    assert.equal(assetKeys.includes('locations:小学音乐教室'), true);
    assert.equal(assetKeys.includes('props:胸针'), true);
    assert.equal(savedDoc.publicAssets.every((asset) => typeof asset.prompt === 'string' && asset.prompt.length > 0), true);
    assert.equal(savedDoc.publicAssets.every((asset) => Array.isArray(asset.referenceAssets)), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/library/generate-from-script reports a clear error when no script is saved', async () => {
  const { root, episodeRoot } = await makeProjectWithEpisode('');
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/library/generate-from-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath: episodeRoot })
    });
    const json = await response.json();

    assert.equal(response.status, 400);
    assert.match(json.error, /请先保存分镜剧本/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
