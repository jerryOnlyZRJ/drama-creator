// 公开测试使用虚构名称与对应资源标识，避免将创作项目的人物或作品名称带入源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.mjs';

async function startServer(root) {
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir: join(root, '.drama-creator') }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function makeEpisode() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-references-')));
  const episodePath = join(root, 'projects', 'demo', 'episodes', 'ep001');
  await mkdir(episodePath, { recursive: true });
  await writeFile(join(episodePath, 'drama-creator.json'), `${JSON.stringify({
    schemaVersion: '0.1.0',
    project: { name: 'demo' },
    episode: { id: 'ep001', path: episodePath },
    shots: [{ id: 'shot:s001', shotNo: 's001', title: '权限被收回', status: 'ready_to_feed' }],
    nodes: [
      { id: 'node:script:s001', type: 'script_segment', title: '权限被收回', shotId: 'shot:s001', status: 'active', metadata: { text: '主角发现权限被收回。' } },
      { id: 'node:prompt:video:s001:v001', type: 'video_prompt', title: 'S001 视频提示词', shotId: 'shot:s001', status: 'ready_to_feed', metadata: { prompt: '@图片1 主角看向屏幕，@图片2 作为办公区参考。' } },
      { id: 'node:image:character:robot', type: 'image_asset', title: '小邮角色参考', shotId: null, path: 'scripts/assets/characters/robot.png', status: 'active', metadata: { role: 'character_ref' } },
      { id: 'node:image:scene:office', type: 'image_asset', title: '开放办公区', shotId: null, path: 'scripts/assets/scenes/office.png', status: 'active', metadata: { role: 'scene_ref' } },
      { id: 'node:video:s001:v001', type: 'video_output', title: '已生成视频', shotId: 'shot:s001', path: 'manual-assets/videos/out.mp4', status: 'reviewing', metadata: {} }
    ],
    edges: [],
    tasks: [
      { id: 'task:video:s001:v001', shotId: 'shot:s001', type: 'video', title: 'S001 视频生成', status: 'ready_to_feed', promptNodeId: 'node:prompt:video:s001:v001', outputNodeIds: [], fields: { ratio: '9:16', duration: 10 } }
    ],
    checks: [],
    activityLog: []
  }, null, 2)}\n`, 'utf8');
  return { root, episodePath };
}

test('POST /api/episode/references attaches an existing image asset without copying or re-owning it', async () => {
  const { root, episodePath } = await makeEpisode();
  const { server, baseUrl } = await startServer(root);
  try {
    const response = await fetch(`${baseUrl}/api/episode/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodePath,
        shotNo: 's001',
        assetNodeId: 'node:image:character:robot',
        role: 'character_ref'
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.reference.from, 'node:prompt:video:s001:v001');
    assert.equal(payload.reference.to, 'node:image:character:robot');
    assert.equal(payload.reference.type, 'uses_reference');

    const duplicate = await fetch(`${baseUrl}/api/episode/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodePath,
        shotNo: 's001',
        assetNodeId: 'node:image:character:robot',
        role: 'character_ref'
      })
    }).then((item) => item.json());
    assert.equal(duplicate.references.filter((edge) => edge.to === 'node:image:character:robot').length, 1);

    const saved = JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
    const sharedAsset = saved.nodes.find((node) => node.id === 'node:image:character:robot');
    assert.equal(sharedAsset.shotId, null);
    assert.equal(saved.edges.filter((edge) => edge.to === 'node:image:character:robot').length, 1);
    assert.equal(saved.activityLog.at(-1).type, 'shot_reference_added');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('PATCH and DELETE /api/episode/references reorder and detach reference edges only', async () => {
  const { root, episodePath } = await makeEpisode();
  const { server, baseUrl } = await startServer(root);
  try {
    for (const assetNodeId of ['node:image:character:robot', 'node:image:scene:office']) {
      const response = await fetch(`${baseUrl}/api/episode/references`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodePath, shotNo: 's001', assetNodeId })
      });
      assert.equal(response.status, 200);
    }

    const reorderResponse = await fetch(`${baseUrl}/api/episode/references`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodePath,
        shotNo: 's001',
        orderedAssetNodeIds: ['node:image:scene:office', 'node:image:character:robot']
      })
    });
    const reordered = await reorderResponse.json();
    assert.equal(reorderResponse.status, 200);
    assert.deepEqual(reordered.references.map((edge) => edge.to), ['node:image:scene:office', 'node:image:character:robot']);

    const deleteResponse = await fetch(`${baseUrl}/api/episode/references`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodePath,
        shotNo: 's001',
        assetNodeId: 'node:image:scene:office'
      })
    });
    const deleted = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(deleted.references.map((edge) => edge.to), ['node:image:character:robot']);

    const saved = JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
    assert.ok(saved.nodes.some((node) => node.id === 'node:image:scene:office'));
    assert.equal(saved.edges.some((edge) => edge.to === 'node:image:scene:office'), false);
    assert.equal(saved.activityLog.at(-1).type, 'shot_reference_removed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('PATCH /api/episode/references replaces one reference slot without changing the rest of the order', async () => {
  const { root, episodePath } = await makeEpisode();
  const { server, baseUrl } = await startServer(root);
  try {
    for (const assetNodeId of ['node:image:character:robot', 'node:image:scene:office']) {
      const response = await fetch(`${baseUrl}/api/episode/references`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodePath, shotNo: 's001', assetNodeId })
      });
      assert.equal(response.status, 200);
    }

    const before = JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
    const firstReference = before.edges.find((edge) => edge.to === 'node:image:character:robot');
    before.nodes.push({
      id: 'node:image:prop:phone',
      type: 'image_asset',
      title: '手机通知参考',
      shotId: null,
      path: 'scripts/assets/props/phone.png',
      status: 'active',
      metadata: { role: 'prop_ref' }
    });
    await writeFile(join(episodePath, 'drama-creator.json'), `${JSON.stringify(before, null, 2)}\n`, 'utf8');

    const replaceResponse = await fetch(`${baseUrl}/api/episode/references`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodePath,
        shotNo: 's001',
        referenceEdgeId: firstReference.id,
        assetNodeId: 'node:image:prop:phone'
      })
    });
    const replaced = await replaceResponse.json();
    assert.equal(replaceResponse.status, 200);
    assert.deepEqual(replaced.references.map((edge) => edge.to), [
      'node:image:prop:phone',
      'node:image:scene:office'
    ]);

    const saved = JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
    assert.ok(saved.nodes.some((node) => node.id === 'node:image:character:robot'), 'old asset is retained');
    assert.equal(saved.edges.some((edge) => edge.to === 'node:image:character:robot'), false, 'old slot is detached');
    assert.equal(saved.activityLog.at(-1).type, 'shot_reference_replaced');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
