import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.mjs';

async function startServer() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-delete-')));
  const appWorkspaceDir = join(root, '.drama-creator');
  const server = createServer(createApp({
    root,
    allowedEpisodeRoots: [root],
    appWorkspaceDir,
    registryFile: join(root, 'projects.json')
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { root, appWorkspaceDir, server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(ctx) {
  await new Promise((resolve) => ctx.server.close(resolve));
  await rm(ctx.root, { recursive: true, force: true });
}

async function createProject(baseUrl, name = '删除测试项目') {
  const response = await fetch(`${baseUrl}/api/projects/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, firstEpisodeName: '第 1 集', sourceText: '测试故事。' })
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  return payload.project;
}

test('DELETE /api/projects moves app-owned project into workspace trash', async () => {
  const ctx = await startServer();
  try {
    const project = await createProject(ctx.baseUrl);
    const response = await fetch(`${ctx.baseUrl}/api/projects`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: project.path })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.action, 'trashed');
    assert.match(payload.trashPath, /\.drama-creator\/\.trash\/projects/);
    assert.equal((await stat(payload.trashPath)).isDirectory(), true);
    assert.equal((await stat(`${payload.trashPath}.trash.json`)).isFile(), true);
    await assert.rejects(() => stat(project.path), /ENOENT/);

    const list = await fetch(`${ctx.baseUrl}/api/projects`).then((r) => r.json());
    assert.equal(list.projects.some((item) => item.path === project.path), false);
  } finally {
    await stopServer(ctx);
  }
});

test('GET and DELETE /api/trash report and empty workspace trash', async () => {
  const ctx = await startServer();
  try {
    const project = await createProject(ctx.baseUrl, '回收站测试');
    const deleteResponse = await fetch(`${ctx.baseUrl}/api/projects`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: project.path })
    });
    assert.equal(deleteResponse.status, 200);

    const summaryResponse = await fetch(`${ctx.baseUrl}/api/trash`);
    const summary = await summaryResponse.json();
    assert.equal(summaryResponse.status, 200);
    assert.equal(summary.trash.totalItems, 1);
    assert.ok(summary.trash.totalBytes > 0);

    const emptyResponse = await fetch(`${ctx.baseUrl}/api/trash`, { method: 'DELETE' });
    const emptied = await emptyResponse.json();
    assert.equal(emptyResponse.status, 200);
    assert.equal(emptied.trash.emptied, true);
    assert.equal(emptied.trash.totalItems, 1);

    const after = await fetch(`${ctx.baseUrl}/api/trash`).then((r) => r.json());
    assert.equal(after.trash.totalItems, 0);
    assert.equal(after.trash.totalBytes, 0);
  } finally {
    await stopServer(ctx);
  }
});

test('POST /api/trash/restore restores an app-owned project from trash', async () => {
  const ctx = await startServer();
  try {
    const project = await createProject(ctx.baseUrl, '项目恢复测试');
    const deleteResponse = await fetch(`${ctx.baseUrl}/api/projects`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: project.path })
    });
    assert.equal(deleteResponse.status, 200);

    const summary = await fetch(`${ctx.baseUrl}/api/trash`).then((r) => r.json());
    const item = summary.trash.items.find((entry) => entry.kind === 'project');
    assert.ok(item);

    const restoreResponse = await fetch(`${ctx.baseUrl}/api/trash/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id })
    });
    const restored = await restoreResponse.json();

    assert.equal(restoreResponse.status, 200);
    assert.equal(restored.restore.action, 'restored');
    assert.equal((await stat(project.path)).isDirectory(), true);

    const list = await fetch(`${ctx.baseUrl}/api/projects`).then((r) => r.json());
    assert.equal(list.projects.some((entry) => entry.path === project.path), true);
  } finally {
    await stopServer(ctx);
  }
});

test('DELETE /api/trash/item permanently deletes one trash item', async () => {
  const ctx = await startServer();
  try {
    const project = await createProject(ctx.baseUrl, '彻底删除测试');
    const deleteResponse = await fetch(`${ctx.baseUrl}/api/projects`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: project.path })
    });
    const deletedProject = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200);

    const summary = await fetch(`${ctx.baseUrl}/api/trash`).then((r) => r.json());
    const item = summary.trash.items.find((entry) => entry.kind === 'project');
    assert.ok(item);

    const permanentResponse = await fetch(`${ctx.baseUrl}/api/trash/item`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id })
    });
    const permanent = await permanentResponse.json();

    assert.equal(permanentResponse.status, 200);
    assert.equal(permanent.delete.action, 'deleted');
    await assert.rejects(() => stat(deletedProject.trashPath), /ENOENT/);
    await assert.rejects(() => stat(`${deletedProject.trashPath}.trash.json`), /ENOENT/);

    const after = await fetch(`${ctx.baseUrl}/api/trash`).then((r) => r.json());
    assert.equal(after.trash.totalItems, 0);
  } finally {
    await stopServer(ctx);
  }
});

test('DELETE /api/projects/episode trashes a non-last app-owned episode', async () => {
  const ctx = await startServer();
  try {
    const project = await createProject(ctx.baseUrl, '分集删除测试');
    const createEpisodeResponse = await fetch(`${ctx.baseUrl}/api/projects/episode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: project.path })
    });
    const createEpisodePayload = await createEpisodeResponse.json();
    assert.equal(createEpisodeResponse.status, 200);

    const firstEpisode = createEpisodePayload.project.episodes[0];
    const response = await fetch(`${ctx.baseUrl}/api/projects/episode`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: project.path, episodePath: firstEpisode.path })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.action, 'trashed');
    assert.equal(payload.project.episodes.length, 1);
    assert.equal(payload.project.episodes[0].id, 'ep002');
    assert.equal((await stat(payload.trashPath)).isDirectory(), true);
    await assert.rejects(() => stat(firstEpisode.path), /ENOENT/);

    const lastDelete = await fetch(`${ctx.baseUrl}/api/projects/episode`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: project.path, episodePath: payload.project.episodes[0].path })
    });
    assert.equal(lastDelete.status, 409);
  } finally {
    await stopServer(ctx);
  }
});

test('DELETE /api/episode/resources removes graph references and trashes unshared media file', async () => {
  const ctx = await startServer();
  try {
    const project = await createProject(ctx.baseUrl, '资源删除测试');
    const episodePath = project.episodes[0].path;
    const videoRelativePath = 'manual-assets/videos/out.mp4';
    const videoPath = join(episodePath, videoRelativePath);
    await mkdir(join(episodePath, 'manual-assets', 'videos'), { recursive: true });
    await writeFile(videoPath, Buffer.from('fake mp4 bytes'));

    const docPath = join(episodePath, 'drama-creator.json');
    const doc = JSON.parse(await readFile(docPath, 'utf8'));
    doc.shots = [{ id: 'shot:s001', shotNo: 's001', title: '测试镜头', status: 'approved' }];
    doc.nodes = [
      { id: 'node:prompt:s001', type: 'video_prompt', title: '视频提示词', shotId: 'shot:s001', path: null, status: 'active', metadata: {} },
      { id: 'node:video:s001:v001', type: 'video_output', title: '视频产物', shotId: 'shot:s001', path: videoRelativePath, status: 'reviewing', metadata: {} },
      { id: 'node:qc:s001', type: 'qc_record', title: 'QC', shotId: 'shot:s001', path: null, status: 'approved', metadata: {} }
    ];
    doc.edges = [
      { id: 'edge:generate:s001', from: 'node:prompt:s001', to: 'node:video:s001:v001', type: 'generates', role: null, status: 'active', note: '' },
      { id: 'edge:qc:s001', from: 'node:qc:s001', to: 'node:video:s001:v001', type: 'qc_for', role: null, status: 'active', note: '' }
    ];
    doc.tasks = [{
      id: 'task:video:s001',
      shotId: 'shot:s001',
      type: 'video',
      title: '生成视频',
      status: 'approved',
      promptNodeId: 'node:prompt:s001',
      outputNodeIds: ['node:video:s001:v001'],
      fields: {}
    }];
    await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const response = await fetch(`${ctx.baseUrl}/api/episode/resources`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, nodeId: 'node:video:s001:v001' })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload.deletedNodeIds.sort(), ['node:qc:s001', 'node:video:s001:v001']);
    assert.equal(payload.trashedFiles.length, 1);
    assert.equal((await stat(payload.trashedFiles[0].trashPath)).isFile(), true);
    await assert.rejects(() => stat(videoPath), /ENOENT/);

    const nextDoc = JSON.parse(await readFile(docPath, 'utf8'));
    assert.deepEqual(nextDoc.nodes.map((node) => node.id), ['node:prompt:s001']);
    assert.deepEqual(nextDoc.edges, []);
    assert.deepEqual(nextDoc.tasks[0].outputNodeIds, []);
    assert.equal(nextDoc.tasks[0].status, 'ready_to_feed');
    assert.equal(nextDoc.shots[0].status, 'ready_to_feed');
    assert.equal(nextDoc.activityLog.at(-1).type, 'resource_deleted');
  } finally {
    await stopServer(ctx);
  }
});

test('POST /api/trash/restore restores a resource file and graph snapshot', async () => {
  const ctx = await startServer();
  try {
    const project = await createProject(ctx.baseUrl, '资源恢复测试');
    const episodePath = project.episodes[0].path;
    const videoRelativePath = 'manual-assets/videos/restorable.mp4';
    const videoPath = join(episodePath, videoRelativePath);
    await mkdir(join(episodePath, 'manual-assets', 'videos'), { recursive: true });
    await writeFile(videoPath, Buffer.from('fake restorable mp4 bytes'));

    const docPath = join(episodePath, 'drama-creator.json');
    const doc = JSON.parse(await readFile(docPath, 'utf8'));
    doc.shots = [{ id: 'shot:s001', shotNo: 's001', title: '可恢复镜头', status: 'approved' }];
    doc.nodes = [
      { id: 'node:prompt:s001', type: 'video_prompt', title: '视频提示词', shotId: 'shot:s001', path: null, status: 'active', metadata: {} },
      { id: 'node:video:s001:v001', type: 'video_output', title: '可恢复视频', shotId: 'shot:s001', path: videoRelativePath, status: 'reviewing', metadata: {} },
      { id: 'node:qc:s001', type: 'qc_record', title: 'QC', shotId: 'shot:s001', path: null, status: 'approved', metadata: {} }
    ];
    doc.edges = [
      { id: 'edge:generate:s001', from: 'node:prompt:s001', to: 'node:video:s001:v001', type: 'generates', role: null, status: 'active', note: '' },
      { id: 'edge:qc:s001', from: 'node:qc:s001', to: 'node:video:s001:v001', type: 'qc_for', role: null, status: 'active', note: '' }
    ];
    doc.tasks = [{
      id: 'task:video:s001',
      shotId: 'shot:s001',
      type: 'video',
      title: '生成视频',
      status: 'approved',
      promptNodeId: 'node:prompt:s001',
      outputNodeIds: ['node:video:s001:v001'],
      fields: {}
    }];
    doc.jobs = [{
      id: 'job:video:s001',
      taskId: 'task:video:s001',
      adapterId: 'mock-echo',
      status: 'completed',
      externalJobId: 'job-1',
      submittedAt: '2026-06-13T00:00:00.000Z',
      outputNodeIds: ['node:video:s001:v001']
    }];
    await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const deleteResponse = await fetch(`${ctx.baseUrl}/api/episode/resources`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, nodeId: 'node:video:s001:v001' })
    });
    const deletePayload = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200);

    const manifest = JSON.parse(await readFile(`${deletePayload.trashedFiles[0].trashPath}.trash.json`, 'utf8'));
    assert.equal(manifest.metadata.kind, 'resource');
    assert.equal(manifest.metadata.graphSnapshot.nodes.length, 2);
    assert.equal(manifest.metadata.graphSnapshot.edges.length, 2);

    const trash = await fetch(`${ctx.baseUrl}/api/trash`).then((r) => r.json());
    const item = trash.trash.items.find((entry) => entry.kind === 'resource');
    assert.ok(item);

    const restoreResponse = await fetch(`${ctx.baseUrl}/api/trash/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id })
    });
    const restored = await restoreResponse.json();

    assert.equal(restoreResponse.status, 200);
    assert.equal(restored.restore.graphRestored, true);
    assert.equal((await stat(videoPath)).isFile(), true);
    await assert.rejects(() => stat(deletePayload.trashedFiles[0].trashPath), /ENOENT/);

    const nextDoc = JSON.parse(await readFile(docPath, 'utf8'));
    assert.deepEqual(nextDoc.nodes.map((node) => node.id).sort(), ['node:prompt:s001', 'node:qc:s001', 'node:video:s001:v001']);
    assert.deepEqual(nextDoc.edges.map((edge) => edge.id).sort(), ['edge:generate:s001', 'edge:qc:s001']);
    assert.equal(nextDoc.tasks[0].status, 'approved');
    assert.deepEqual(nextDoc.tasks[0].outputNodeIds, ['node:video:s001:v001']);
    assert.deepEqual(nextDoc.jobs[0].outputNodeIds, ['node:video:s001:v001']);
    assert.equal(nextDoc.shots[0].status, 'approved');
    assert.equal(nextDoc.activityLog.at(-1).type, 'resource_restored');
  } finally {
    await stopServer(ctx);
  }
});

test('DELETE /api/library/item trashes an unreferenced public asset file and removes its record', async () => {
  const ctx = await startServer();
  try {
    const project = await createProject(ctx.baseUrl, '公共资产删除测试');
    const episodePath = project.episodes[0].path;
    const assetRelativePath = 'scripts/assets/characters/images/unused-character.png';
    const assetPath = join(project.path, assetRelativePath);
    await mkdir(join(project.path, 'scripts', 'assets', 'characters', 'images'), { recursive: true });
    await writeFile(assetPath, Buffer.from('fake image bytes'));

    const docPath = join(episodePath, 'drama-creator.json');
    const doc = JSON.parse(await readFile(docPath, 'utf8'));
    doc.publicAssets = [{
      id: 'public:unused-character',
      title: '未使用角色',
      category: 'characters',
      status: 'active',
      sourcePath: assetRelativePath,
      kind: 'image'
    }];
    await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const response = await fetch(`${ctx.baseUrl}/api/library/item`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: project.path,
        episodePath,
        assetId: 'public:unused-character',
        title: '未使用角色',
        category: 'characters',
        path: assetRelativePath
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.action, 'trashed');
    assert.equal(payload.record.removed, true);
    assert.equal((await stat(payload.trashedFile.trashPath)).isFile(), true);
    await assert.rejects(() => stat(assetPath), /ENOENT/);

    const nextDoc = JSON.parse(await readFile(docPath, 'utf8'));
    assert.deepEqual(nextDoc.publicAssets, []);
    assert.equal(nextDoc.activityLog.at(-1).type, 'public_asset_deleted');

    const trash = await fetch(`${ctx.baseUrl}/api/trash`).then((r) => r.json());
    const item = trash.trash.items.find((entry) => entry.kind === 'resource' && entry.title === '未使用角色');
    assert.ok(item);

    const restoreResponse = await fetch(`${ctx.baseUrl}/api/trash/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id })
    });
    const restored = await restoreResponse.json();
    assert.equal(restoreResponse.status, 200);
    assert.equal(restored.restore.action, 'restored');
    assert.equal((await stat(assetPath)).isFile(), true);
  } finally {
    await stopServer(ctx);
  }
});

test('DELETE /api/library/item refuses to remove a public asset still used by shot nodes', async () => {
  const ctx = await startServer();
  try {
    const project = await createProject(ctx.baseUrl, '公共资产引用保护测试');
    const episodePath = project.episodes[0].path;
    const assetRelativePath = 'scripts/assets/characters/images/hero.png';
    const assetPath = join(project.path, assetRelativePath);
    await mkdir(join(project.path, 'scripts', 'assets', 'characters', 'images'), { recursive: true });
    await writeFile(assetPath, Buffer.from('fake image bytes'));

    const docPath = join(episodePath, 'drama-creator.json');
    const doc = JSON.parse(await readFile(docPath, 'utf8'));
    doc.shots = [{ id: 'shot:s001', shotNo: 's001', title: '测试分镜', status: 'ready_to_feed' }];
    doc.nodes = [{
      id: 'node:image:s001:hero',
      type: 'image_asset',
      title: '主角参考',
      shotId: 'shot:s001',
      path: assetRelativePath,
      status: 'active',
      metadata: {}
    }];
    doc.publicAssets = [{
      id: 'public:hero',
      title: '主角参考',
      category: 'characters',
      status: 'active',
      sourcePath: assetRelativePath,
      kind: 'image'
    }];
    await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const response = await fetch(`${ctx.baseUrl}/api/library/item`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: project.path,
        episodePath,
        assetId: 'public:hero',
        title: '主角参考',
        category: 'characters',
        path: assetRelativePath
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 409);
    assert.match(payload.error, /仍被 1 个分镜资源引用/);
    assert.equal((await stat(assetPath)).isFile(), true);

    const nextDoc = JSON.parse(await readFile(docPath, 'utf8'));
    assert.equal(nextDoc.publicAssets.length, 1);
    assert.equal(nextDoc.nodes.length, 1);
  } finally {
    await stopServer(ctx);
  }
});
