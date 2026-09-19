// 公开测试使用虚构示例文本，保留解析与工作流断言，不承载作者作品。
// 公开测试使用虚构名称与对应资源标识，避免将创作项目的人物或作品名称带入源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.mjs';

// /api/projects 是 L1 首页和 L2 项目详情的入口数据；这一组测试覆盖：
// 自动发现、显式注册、合并去重。显式注册代表用户选择了一个外部 workspace，
// 不再要求该目录预先落在开发期 allowedEpisodeRoots 内。

async function makeWorkspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-projects-')));
  const projectA = join(root, 'project-a');
  const ep001A = join(projectA, 'scripts', 'episodes', 'ep001');
  await mkdir(ep001A, { recursive: true });
  await writeFile(join(ep001A, 'drama-creator.json'), JSON.stringify({
    schemaVersion: '0.1.0',
    project: { name: '项目 A' },
    episode: { id: 'ep001', path: ep001A },
    shots: [
      { id: 'shot:s001', shotNo: 's001', title: 'A 镜头', status: 'approved' },
      { id: 'shot:s002', shotNo: 's002', title: '待生成镜头', status: 'draft' }
    ],
    nodes: [
      { id: 'node:video:s001:v001', type: 'video_output', title: 'A 镜头', shotId: 'shot:s001', status: 'generating' },
      { id: 'node:qc:s001', type: 'qc_record', title: 'A QC', shotId: 'shot:s001', status: 'approved' },
      // 最终成片属于导出产物，不绑定具体分镜；项目进度只统计上面的分镜视频。
      { id: 'node:video:final:v001', type: 'video_output', title: '最终成片', shotId: null, status: 'approved' },
      { id: 'node:qc:final', type: 'qc_record', title: '最终成片 QC', shotId: null, status: 'approved' }
    ],
    edges: [],
    tasks: [],
    checks: []
  }));
  const ep002A = join(projectA, 'scripts', 'episodes', 'ep002');
  await mkdir(ep002A, { recursive: true });
  await writeFile(join(ep002A, 'drama-creator.json'), JSON.stringify({
    schemaVersion: '0.1.0',
    project: { name: '项目 A' },
    episode: { id: 'ep002', path: ep002A },
    shots: [],
    nodes: [],
    edges: [],
    tasks: [],
    checks: []
  }));
  return { root, projectA };
}

async function startServer({ root, allowedRoot, registryFile }) {
  const server = createServer(createApp({
    root,
    allowedEpisodeRoots: [allowedRoot],
    registryFile,
    // 项目列表会合并 app-owned workspace；测试必须固定到临时目录，避免读取用户真实 ~/.drama-creator。
    appWorkspaceDir: join(root, '.drama-creator')
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('POST /api/projects/create creates the first episode and can append more episodes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-v1-create-')));
  const appWorkspaceDir = join(root, '.drama-creator');
  const server = createServer(createApp({
    root,
    allowedEpisodeRoots: [root],
    appWorkspaceDir
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '测试 AI 视频',
        firstEpisodeName: '第 1 集',
        startMode: 'story_text',
        sourceText: '一个普通人发现公司被 AI 接管。'
      })
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.project.name, '测试 AI 视频');
    assert.equal(json.project.source, 'app');
    assert.match(json.project.path, /projects\/测试-ai-视频/);
    assert.equal(json.project.episodes.length, 1);
    assert.equal(json.project.episodes[0].id, 'ep001');
    assert.equal(json.project.currentStep, 'script_shots');

    const docPath = join(json.project.episodes[0].path, 'drama-creator.json');
    assert.equal((await stat(docPath)).isFile(), true);
    const doc = JSON.parse(await readFile(docPath, 'utf8'));
    assert.equal(doc.project.name, '测试 AI 视频');
    assert.equal(doc.episode.title, '第 1 集');
    assert.equal(doc.workflow.currentStep, 'script_shots');
    assert.deepEqual(doc.workflow.steps.map((step) => step.key), ['script_shots', 'asset_library', 'shot_videos', 'export']);
    assert.equal(doc.storySources[0].type, 'story_text');
    assert.equal(json.project.coreIdea, '');

    const metadataResponse = await fetch(`http://127.0.0.1:${port}/api/projects/metadata`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: json.project.path,
        coreIdea: '人在 AI 浪潮里的价值，不该只由效率评分决定。',
        globalBrief: '主要人物：小邮、小桥。\n主要场景：办公室、机房。'
      })
    });
    const metadataJson = await metadataResponse.json();

    assert.equal(metadataResponse.status, 200);
    assert.equal(metadataJson.project.coreIdea, '人在 AI 浪潮里的价值，不该只由效率评分决定。');
    assert.equal(metadataJson.project.globalBrief, '主要人物：小邮、小桥。\n主要场景：办公室、机房。');
    assert.equal(metadataJson.project.jimengSpaceName, '');
    const manifest = JSON.parse(await readFile(join(json.project.path, 'project.json'), 'utf8'));
    assert.equal(manifest.coreIdea, '人在 AI 浪潮里的价值，不该只由效率评分决定。');
    assert.equal(manifest.globalBrief, '主要人物：小邮、小桥。\n主要场景：办公室、机房。');

    const jimengMetadataResponse = await fetch(`http://127.0.0.1:${port}/api/projects/metadata`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: json.project.path,
        coreIdea: metadataJson.project.coreIdea,
        jimengSpaceName: '机器人送信'
      })
    });
    const jimengMetadataJson = await jimengMetadataResponse.json();

    assert.equal(jimengMetadataResponse.status, 200);
    assert.equal(jimengMetadataJson.project.coreIdea, '人在 AI 浪潮里的价值，不该只由效率评分决定。');
    assert.equal(jimengMetadataJson.project.jimengSpaceName, '机器人送信');
    const jimengManifest = JSON.parse(await readFile(join(json.project.path, 'project.json'), 'utf8'));
    assert.equal(jimengManifest.jimengSpaceName, '机器人送信');

    const episodeResponse = await fetch(`http://127.0.0.1:${port}/api/projects/episode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: json.project.path })
    });
    const episodeJson = await episodeResponse.json();

    assert.equal(episodeResponse.status, 200);
    assert.equal(episodeJson.episode.id, 'ep002');
    assert.equal(episodeJson.episode.title, '第 2 集');
    assert.equal(episodeJson.project.episodes.length, 2);
    assert.deepEqual(episodeJson.project.episodes.map((ep) => ep.id), ['ep001', 'ep002']);

    const ep002DocPath = join(episodeJson.episode.path, 'drama-creator.json');
    assert.equal((await stat(ep002DocPath)).isFile(), true);
    const ep002Doc = JSON.parse(await readFile(ep002DocPath, 'utf8'));
    assert.equal(ep002Doc.project.name, '测试 AI 视频');
    assert.equal(ep002Doc.episode.id, 'ep002');
    assert.equal(ep002Doc.episode.title, '第 2 集');
    assert.equal(ep002Doc.workflow.currentStep, 'script_shots');
    assert.equal(ep002Doc.storySources.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/projects/create stores idea-generated story source metadata', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-v1-idea-create-')));
  const appWorkspaceDir = join(root, '.drama-creator');
  const server = createServer(createApp({
    root,
    allowedEpisodeRoots: [root],
    appWorkspaceDir
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '一句话扩写项目',
        firstEpisodeName: '第一集',
        startMode: 'idea_text',
        ideaText: '一个普通人被 AI 替代后重新证明自己的价值。',
        storyGeneratedBy: 'openai-compatible-text:deepseek-chat',
        sourceText: '这是文本模型扩写后的一版完整故事。'
      })
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    const doc = JSON.parse(await readFile(join(json.project.episodes[0].path, 'drama-creator.json'), 'utf8'));
    assert.equal(doc.storySources[0].type, 'idea_text');
    assert.equal(doc.storySources[0].title, '由想法生成的故事');
    assert.equal(doc.storySources[0].text, '这是文本模型扩写后的一版完整故事。');
    assert.equal(doc.storySources[0].metadata.ideaText, '一个普通人被 AI 替代后重新证明自己的价值。');
    assert.equal(doc.storySources[0].metadata.generatedBy, 'openai-compatible-text:deepseek-chat');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/projects auto-discovers projects from allowedEpisodeRoots', async () => {
  const { root, projectA } = await makeWorkspace();
  const registryFile = join(root, 'registry.json');
  const server = await startServer({ root, allowedRoot: root, registryFile });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.projects.length, 1);
    const project = json.projects[0];
    assert.equal(project.path, projectA);
    assert.equal(project.name, '项目 A');
    assert.equal(project.episodes.length, 2);
    assert.deepEqual(project.episodes.map((ep) => ep.id), ['ep001', 'ep002']);
    assert.deepEqual(project.progress, { approved: 1, total: 2 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/projects registers an explicit project path inside a dev root', async () => {
  const { root, projectA } = await makeWorkspace();
  const registryFile = join(root, 'registry.json');
  const server = await startServer({ root, allowedRoot: root, registryFile });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectA, name: '别名 A' })
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.project.path, projectA);
    assert.equal(json.project.name, '别名 A');

    // 列表里仍然只有一份（自动发现 + 显式注册去重）
    const list = await fetch(`http://127.0.0.1:${port}/api/projects`).then((r) => r.json());
    assert.equal(list.projects.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/projects registers a user-selected workspace outside dev roots', async () => {
  const { root } = await makeWorkspace();
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-outside-')));
  const registryFile = join(root, 'registry.json');
  const server = await startServer({ root, allowedRoot: root, registryFile });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: outside })
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.project.path, outside);

    const list = await fetch(`http://127.0.0.1:${port}/api/projects`).then((r) => r.json());
    assert.equal(list.projects.some((project) => project.path === outside && project.source === 'registered'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('GET /api/projects falls back gracefully when registry file is missing', async () => {
  const { root } = await makeWorkspace();
  const registryFile = join(root, 'never-created.json');
  const server = await startServer({ root, allowedRoot: root, registryFile });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(Array.isArray(json.projects), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
