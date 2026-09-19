import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.mjs';
import { selectExportVideoNode, selectPreviewVideoNode } from '../src/workflow/videoVersions.mjs';

async function startServer(root, extra = {}) {
  const server = createServer(createApp({
    root,
    allowedEpisodeRoots: [root],
    appWorkspaceDir: join(root, '.drama-creator'),
    ...extra
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function makeFakeFfmpeg(root) {
  const bin = join(root, 'fake-ffmpeg.sh');
  await writeFile(bin, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'out="${@: -1}"',
    'mkdir -p "$(dirname "$out")"',
    'printf "fake video" > "$out"'
  ].join('\n'));
  await chmod(bin, 0o755);
  return bin;
}

async function makeEpisode() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-shot-versions-')));
  const episodePath = join(root, 'project', 'episodes', 'ep001');
  await mkdir(episodePath, { recursive: true });
  await writeFile(join(episodePath, 'drama-creator.json'), `${JSON.stringify({
    schemaVersion: '0.1.0',
    project: { name: 'demo' },
    episode: { id: 'ep001', title: '第 1 集', path: episodePath },
    shots: [{ id: 'shot:s001', shotNo: 's001', title: '开场镜头', status: 'ready_to_feed' }],
    nodes: [
      { id: 'node:script:s001', type: 'script_segment', title: '开场镜头', shotId: 'shot:s001', status: 'active', metadata: { text: '对白：终于开始了。' } },
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

async function writeExternalVideo(prefix) {
  const externalDir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const sourcePath = join(externalDir, 'result.mp4');
  await writeFile(sourcePath, Buffer.from('00000018667479706d703432', 'hex'));
  return { externalDir, sourcePath };
}

async function readDoc(episodePath) {
  return JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
}

test('manual video import creates a candidate version instead of replacing the current cut', async () => {
  const { root, episodePath } = await makeEpisode();
  const { externalDir, sourcePath } = await writeExternalVideo('drama-creator-candidate-video-');
  const { server, baseUrl } = await startServer(root);
  try {
    const response = await fetch(`${baseUrl}/api/manual-assets/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, sourcePath, kind: 'video', shotNo: 's001', title: '外部生成候选' })
    });
    const payload = await response.json();
    const saved = await readDoc(episodePath);
    const shot = saved.shots.find((item) => item.id === 'shot:s001');
    const node = saved.nodes.find((item) => item.id === payload.asset.id);

    assert.equal(response.status, 200);
    assert.equal(node.type, 'video_output');
    assert.equal(node.metadata.versionRole, 'candidate');
    assert.equal(shot.videoVersions.current, null);
    assert.equal(shot.videoVersions.candidate, node.id);
    assert.equal(shot.status, 'reviewing');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test('selectExportVideoNode keeps legacy videos exportable when current version is empty', () => {
  const doc = {
    shots: [
      {
        id: 'shot:s001',
        shotNo: 's001',
        status: 'approved',
        videoVersions: { current: null, candidate: null }
      }
    ],
    nodes: [
      {
        id: 'node:video:s001:v001',
        type: 'video_output',
        shotId: 'shot:s001',
        path: 'assets/videos/s001.mp4',
        status: 'approved'
      }
    ]
  };

  assert.equal(selectExportVideoNode(doc, doc.shots[0])?.id, 'node:video:s001:v001');
});

test('selectExportVideoNode does not export an unconfirmed candidate as the current cut', () => {
  const doc = {
    shots: [
      {
        id: 'shot:s001',
        shotNo: 's001',
        status: 'reviewing',
        videoVersions: { current: null, candidate: 'node:video:s001:v001' }
      }
    ],
    nodes: [
      {
        id: 'node:video:s001:v001',
        type: 'video_output',
        shotId: 'shot:s001',
        path: 'assets/videos/s001.mp4',
        status: 'reviewing',
        metadata: { versionRole: 'candidate' }
      }
    ]
  };

  assert.equal(selectExportVideoNode(doc, doc.shots[0]), null);
});

test('selectExportVideoNode does not export rejected or stale legacy videos', () => {
  const doc = {
    shots: [
      {
        id: 'shot:s001',
        shotNo: 's001',
        status: 'rerun_needed',
        videoVersions: { current: null, candidate: null }
      }
    ],
    nodes: [
      {
        id: 'node:video:s001:rejected',
        type: 'video_output',
        shotId: 'shot:s001',
        path: 'assets/videos/rejected.mp4',
        status: 'reviewing',
        metadata: { versionRole: 'rejected' }
      },
      {
        id: 'node:video:s001:stale',
        type: 'video_output',
        shotId: 'shot:s001',
        path: 'assets/videos/stale.mp4',
        status: 'reviewing',
        metadata: { versionRole: 'stale_candidate' }
      }
    ]
  };

  assert.equal(selectExportVideoNode(doc, doc.shots[0]), null);
});

test('selectPreviewVideoNode skips rejected or stale videos instead of reviving old candidates', () => {
  const doc = {
    shots: [
      {
        id: 'shot:s001',
        shotNo: 's001',
        status: 'rerun_needed',
        videoVersions: { current: null, candidate: null }
      }
    ],
    nodes: [
      {
        id: 'node:video:s001:rejected',
        type: 'video_output',
        shotId: 'shot:s001',
        path: 'assets/videos/rejected.mp4',
        status: 'reviewing',
        metadata: { versionRole: 'rejected' }
      },
      {
        id: 'node:video:s001:stale',
        type: 'video_output',
        shotId: 'shot:s001',
        path: 'assets/videos/stale.mp4',
        status: 'reviewing',
        metadata: { versionRole: 'stale_candidate' }
      }
    ]
  };

  assert.equal(selectPreviewVideoNode(doc, doc.shots[0]), null);
});

test('POST /api/episode/video-version/current promotes a candidate to the current cut', async () => {
  const { root, episodePath } = await makeEpisode();
  const first = await writeExternalVideo('drama-creator-current-video-');
  const { server, baseUrl } = await startServer(root);
  try {
    const importResponse = await fetch(`${baseUrl}/api/manual-assets/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, sourcePath: first.sourcePath, kind: 'video', shotNo: 's001', title: '候选视频' })
    });
    const imported = await importResponse.json();
    assert.equal(importResponse.status, 200);

    const promoteResponse = await fetch(`${baseUrl}/api/episode/video-version/current`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, shotNo: 's001', nodeId: imported.asset.id })
    });
    const promoted = await promoteResponse.json();
    const saved = await readDoc(episodePath);
    const shot = saved.shots.find((item) => item.id === 'shot:s001');
    const node = saved.nodes.find((item) => item.id === imported.asset.id);

    assert.equal(promoteResponse.status, 200);
    assert.equal(promoted.videoVersions.current, imported.asset.id);
    assert.equal(promoted.videoVersions.candidate, null);
    assert.equal(shot.videoVersions.current, imported.asset.id);
    assert.equal(shot.videoVersions.candidate, null);
    assert.equal(node.metadata.versionRole, 'current');
    assert.equal(shot.status, 'reviewing');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(first.externalDir, { recursive: true, force: true });
  }
});

test('QC approval propagates to the current video, shot, task, and export status', async () => {
  const { root, episodePath } = await makeEpisode();
  const external = await writeExternalVideo('drama-creator-approved-video-');
  const ffmpegPath = await makeFakeFfmpeg(root);
  const { server, baseUrl } = await startServer(root, { ffmpegPath });
  try {
    const imported = await fetch(`${baseUrl}/api/manual-assets/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, sourcePath: external.sourcePath, kind: 'video', shotNo: 's001', title: '可导出视频' })
    }).then((response) => response.json());
    await fetch(`${baseUrl}/api/episode/video-version/current`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, shotNo: 's001', nodeId: imported.asset.id })
    });

    const draft = await readDoc(episodePath);
    const qcNode = draft.nodes.find((node) => node.type === 'qc_record' && node.shotId === 'shot:s001');
    qcNode.status = 'approved';
    qcNode.metadata = { ...(qcNode.metadata || {}), qcNote: '通过', qcUpdatedAt: '2026-06-14T00:00:00.000Z' };

    const patchResponse = await fetch(`${baseUrl}/api/episode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, document: draft })
    });
    assert.equal(patchResponse.status, 200);

    const saved = await readDoc(episodePath);
    const shot = saved.shots.find((item) => item.id === 'shot:s001');
    const task = saved.tasks.find((item) => item.type === 'video' && item.shotId === 'shot:s001');
    const currentNode = saved.nodes.find((item) => item.id === imported.asset.id);

    assert.equal(shot.status, 'approved');
    assert.equal(task.status, 'approved');
    assert.equal(currentNode.status, 'approved');

    const exportResponse = await fetch(`${baseUrl}/api/export/episode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath })
    });
    const exportPayload = await exportResponse.json();
    assert.equal(exportResponse.status, 200);
    assert.equal(exportPayload.export.status, 'final');
    assert.equal((await stat(exportPayload.export.originalPath)).isFile(), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(external.externalDir, { recursive: true, force: true });
  }
});
