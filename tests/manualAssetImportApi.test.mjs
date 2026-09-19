import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.mjs';

// 手动资源导入是“未配置模型”时的创作兜底：外部工具生成的本地文件会被复制进剧集目录，
// drama-creator.json 只记录相对路径，后续换机器或导出项目时不依赖用户原始文件位置。

async function startServer(root) {
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function makeEpisode() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-manual-import-')));
  const episodePath = join(root, 'ep001');
  await mkdir(episodePath, { recursive: true });
  await writeFile(join(episodePath, 'drama-creator.json'), `${JSON.stringify({
    schemaVersion: '0.1.0',
    project: { name: 'demo' },
    episode: { id: 'ep001', path: episodePath },
    shots: [{ id: 'shot:s001', shotNo: 's001', title: '开场镜头', status: 'draft' }],
    nodes: [
      { id: 'node:script:s001', type: 'script_segment', title: '开场镜头', shotId: 'shot:s001', status: 'draft', metadata: { text: '夜晚，主角推门而入。' } },
      { id: 'node:prompt:video:s001:v001', type: 'video_prompt', title: 's001 视频提示词', shotId: 'shot:s001', status: 'ready_to_feed', metadata: { prompt: '竖屏电影感镜头。' } }
    ],
    edges: [],
    tasks: [
      { id: 'task:video:s001:v001', shotId: 'shot:s001', type: 'video', title: 's001 视频生成', status: 'ready_to_feed', promptNodeId: 'node:prompt:video:s001:v001', outputNodeIds: [], fields: { ratio: '9:16' } }
    ],
    checks: [],
    activityLog: []
  }, null, 2)}\n`, 'utf8');
  return { root, episodePath };
}

test('POST /api/manual-assets/import copies an external image into the shot graph', async () => {
  const { root, episodePath } = await makeEpisode();
  const externalDir = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-external-image-')));
  const sourcePath = join(externalDir, 'external-frame.png');
  await writeFile(sourcePath, Buffer.from('89504e470d0a1a0a', 'hex'));

  const server = await startServer(root);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/manual-assets/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodePath,
        sourcePath,
        kind: 'image',
        shotNo: 's001',
        title: '外部关键帧'
      })
    });
    const json = await response.json();
    const saved = JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
    const node = saved.nodes.find((item) => item.id === json.asset.id);

    assert.equal(response.status, 200);
    assert.equal(json.asset.type, 'image_asset');
    assert.equal(json.asset.shotId, 'shot:s001');
    assert.match(json.asset.path, /^manual-assets\/images\//);
    assert.equal(json.asset.metadata.originalName, basename(sourcePath));
    assert.equal(JSON.stringify(saved).includes(sourcePath), false);
    assert.equal(node.path, json.asset.path);
    assert.equal(saved.edges.some((edge) => edge.type === 'uses_reference' && edge.to === node.id), true);

    const assetResponse = await fetch(`http://127.0.0.1:${port}/api/asset?episode=${encodeURIComponent(episodePath)}&path=${encodeURIComponent(node.path)}`);
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get('content-type'), 'image/png');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test('POST /api/manual-assets/import creates a video output and attaches it to the video task', async () => {
  const { root, episodePath } = await makeEpisode();
  const externalDir = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-external-video-')));
  const sourcePath = join(externalDir, 'seedance-result.mp4');
  await writeFile(sourcePath, Buffer.from('00000018667479706d703432', 'hex'));

  const server = await startServer(root);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/manual-assets/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodePath,
        sourcePath,
        kind: 'video',
        shotNo: 's001',
        title: '即梦外部成片'
      })
    });
    const json = await response.json();
    const saved = JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
    const node = saved.nodes.find((item) => item.id === json.asset.id);
    const task = saved.tasks.find((item) => item.id === 'task:video:s001:v001');
    const qcNode = saved.nodes.find((item) => item.type === 'qc_record' && item.shotId === 'shot:s001');

    assert.equal(response.status, 200);
    assert.equal(node.type, 'video_output');
    assert.equal(node.shotId, 'shot:s001');
    assert.match(node.path, /^manual-assets\/videos\//);
    assert.ok(task.outputNodeIds.includes(node.id));
    assert.equal(saved.edges.some((edge) => edge.type === 'generates' && edge.to === node.id), true);
    assert.ok(qcNode, 'manual video backfill creates a QC placeholder');
    assert.equal(qcNode.status, 'reviewing');
    assert.equal(saved.edges.some((edge) => edge.type === 'qc_for' && edge.from === qcNode.id && edge.to === node.id), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});
