import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.mjs';
import { exportAvailableShotPreview, exportEpisodeVideo } from '../src/export/episodeExport.mjs';

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

async function makeFakeFfmpegWithoutSubtitleFilter(root) {
  const bin = join(root, 'fake-ffmpeg-no-subtitles.sh');
  await writeFile(bin, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if printf "%s\\n" "$@" | grep -q "subtitles=filename="; then',
    '  echo "No such filter: subtitles" >&2',
    '  exit 8',
    'fi',
    'out="${@: -1}"',
    'mkdir -p "$(dirname "$out")"',
    'printf "fake video" > "$out"'
  ].join('\n'));
  await chmod(bin, 0o755);
  return bin;
}

async function makeSlowFfmpeg(root) {
  const bin = join(root, 'fake-ffmpeg-slow.sh');
  await writeFile(bin, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'trap "exit 143" TERM',
    'sleep 10',
    'out="${@: -1}"',
    'mkdir -p "$(dirname "$out")"',
    'printf "slow video" > "$out"'
  ].join('\n'));
  await chmod(bin, 0o755);
  return bin;
}

async function makeEpisode() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-export-')));
  const episodePath = join(root, 'ep001');
  await mkdir(join(episodePath, 'raw-videos'), { recursive: true });
  await writeFile(join(episodePath, 'raw-videos', 's001.mp4'), 'v1');
  await writeFile(join(episodePath, 'raw-videos', 's002.mp4'), 'v2');
  await writeFile(join(episodePath, 'drama-creator.json'), `${JSON.stringify({
    schemaVersion: '0.1.0',
    project: { name: '测试项目' },
    episode: { id: 'ep001', title: '第 1 集', path: episodePath },
    shots: [
      { id: 'shot:s001', shotNo: 's001', title: '开场', durationSec: 5, status: 'approved' },
      { id: 'shot:s002', shotNo: 's002', title: '转折', durationSec: 5, status: 'approved' }
    ],
    nodes: [
      { id: 'node:script:s001', type: 'script_segment', title: '开场', shotId: 'shot:s001', metadata: { text: '旁白：主角走进机房。' } },
      { id: 'node:script:s002', type: 'script_segment', title: '转折', shotId: 'shot:s002', metadata: { text: '对白：证据就在这里。' } },
      { id: 'node:video:s001', type: 'video_output', title: 's001', shotId: 'shot:s001', path: 'raw-videos/s001.mp4', status: 'approved' },
      { id: 'node:video:s002', type: 'video_output', title: 's002', shotId: 'shot:s002', path: 'raw-videos/s002.mp4', status: 'approved' }
    ],
    edges: [],
    tasks: [],
    checks: [],
    activityLog: []
  }, null, 2)}\n`, 'utf8');
  return { root, episodePath };
}

test('POST /api/export/episode creates original video, subtitled copy and srt', async () => {
  const { root, episodePath } = await makeEpisode();
  const ffmpegPath = await makeFakeFfmpeg(root);
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root], ffmpegPath }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/export/episode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath })
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.export.status, 'final');
    assert.match(json.export.originalPath, /_正式版_v001\.mp4$/);
    assert.match(json.export.subtitledPath, /_正式版_v001_字幕版\.mp4$/);
    assert.match(json.export.srtPath, /_正式版_v001\.srt$/);
    assert.equal((await stat(json.export.originalPath)).isFile(), true);
    assert.equal((await stat(json.export.subtitledPath)).isFile(), true);
    assert.equal((await stat(json.export.srtPath)).isFile(), true);
    const srt = await readFile(json.export.srtPath, 'utf8');
    assert.match(srt, /主角走进机房/);
    assert.match(srt, /证据就在这里/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/export/episode blocks missing shot videos with creator-facing copy', async () => {
  const { root, episodePath } = await makeEpisode();
  const ffmpegPath = await makeFakeFfmpeg(root);
  const docPath = join(episodePath, 'drama-creator.json');
  const doc = JSON.parse(await readFile(docPath, 'utf8'));
  doc.nodes.find((node) => node.id === 'node:video:s002').path = 'raw-videos/not-found.mp4';
  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root], ffmpegPath }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/export/episode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath })
    });
    const json = await response.json();

    assert.equal(response.status, 409);
    assert.match(json.error, /缺少 1 个分镜视频/);
    // API 错误会直接显示到页面通知里，不能把英文工程错误暴露给创作者。
    assert.doesNotMatch(json.error, /Missing videos|shots/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/export/preview stitches available shot videos without opening final export', async () => {
  const { root, episodePath } = await makeEpisode();
  const ffmpegPath = await makeFakeFfmpeg(root);
  const docPath = join(episodePath, 'drama-creator.json');
  const doc = JSON.parse(await readFile(docPath, 'utf8'));
  doc.shots[0].videoVersions = { current: null, candidate: 'node:video:s001' };
  doc.nodes.find((node) => node.id === 'node:video:s001').metadata = { versionRole: 'candidate' };
  doc.nodes.find((node) => node.id === 'node:video:s002').path = 'raw-videos/not-found.mp4';
  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root], ffmpegPath }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const exportResponse = await fetch(`http://127.0.0.1:${port}/api/export/episode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath })
    });
    assert.equal(exportResponse.status, 409);

    const previewResponse = await fetch(`http://127.0.0.1:${port}/api/export/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath })
    });
    const json = await previewResponse.json();

    assert.equal(previewResponse.status, 200);
    assert.equal(json.preview.status, 'preview');
    assert.deepEqual(json.preview.includedShots, ['s001']);
    assert.deepEqual(json.preview.missingShots, ['s002']);
    assert.match(json.preview.previewAssetPath, /^exports\//);
    assert.match(json.preview.previewPath, /分镜拼接预览\.mp4$/);
    // 同名预览会被反复覆盖，响应必须携带文件版本，避免桌面播放器复用旧的 Range 缓存。
    assert.match(json.preview.previewRevision, /^\d+-\d+$/);
    assert.equal((await stat(json.preview.previewPath)).isFile(), true);
    assert.equal(json.preview.concatListPath, undefined);
    // 预览清单只是 ffmpeg 中间产物；API 成功后不应把它留在创作者项目目录里。
    await assert.rejects(stat(json.preview.previewPath.replace(/\.mp4$/, '.concat.txt')), { code: 'ENOENT' });

    const existingResponse = await fetch(
      `http://127.0.0.1:${port}/api/export/preview?episodePath=${encodeURIComponent(episodePath)}`
    );
    const existingJson = await existingResponse.json();

    assert.equal(existingResponse.status, 200);
    assert.equal(existingJson.preview.existing, true);
    assert.equal(existingJson.preview.previewAssetPath, json.preview.previewAssetPath);
    assert.equal(existingJson.preview.previewRevision, json.preview.previewRevision);
    assert.deepEqual(existingJson.preview.includedShots, ['s001']);
    assert.deepEqual(existingJson.preview.missingShots, ['s002']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/export/preview prefers a selected assembly cut over auto stitching', async () => {
  const { root, episodePath } = await makeEpisode();
  const ffmpegPath = await makeFakeFfmpeg(root);
  const docPath = join(episodePath, 'drama-creator.json');
  await mkdir(join(episodePath, 'raw-videos'), { recursive: true });
  await writeFile(join(episodePath, 'raw-videos', 'selected-assembly.mp4'), 'selected edit');
  const doc = JSON.parse(await readFile(docPath, 'utf8'));
  doc.nodes.push({
    id: 'node:video:assembly:selected',
    type: 'video_output',
    title: '剪辑修复版',
    shotId: null,
    path: 'raw-videos/selected-assembly.mp4',
    status: 'reviewing',
    metadata: {
      role: 'assembly_preview',
      exportPreferred: true,
      exportPriority: 100,
      includedShots: ['s001', 's002']
    }
  });
  doc.nodes.find((node) => node.id === 'node:video:s002').path = 'raw-videos/not-found.mp4';
  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root], ffmpegPath }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const previewResponse = await fetch(`http://127.0.0.1:${port}/api/export/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath })
    });
    const json = await previewResponse.json();

    assert.equal(previewResponse.status, 200);
    assert.equal(json.preview.curatedAssembly, true);
    assert.equal(json.preview.previewNodeId, 'node:video:assembly:selected');
    assert.equal(json.preview.previewTitle, '剪辑修复版');
    assert.equal(json.preview.previewAssetPath, 'raw-videos/selected-assembly.mp4');
    assert.equal(json.preview.previewPath, join(episodePath, 'raw-videos', 'selected-assembly.mp4'));
    assert.deepEqual(json.preview.includedShots, ['s001', 's002']);
    assert.deepEqual(json.preview.missingShots, []);

    const existingResponse = await fetch(
      `http://127.0.0.1:${port}/api/export/preview?episodePath=${encodeURIComponent(episodePath)}`
    );
    const existingJson = await existingResponse.json();
    assert.equal(existingJson.preview.existing, true);
    assert.equal(existingJson.preview.curatedAssembly, true);
    assert.equal(existingJson.preview.previewAssetPath, 'raw-videos/selected-assembly.mp4');

    await assert.rejects(
      stat(join(episodePath, 'exports', '测试项目_第1集_草稿版_v001_分镜拼接预览.mp4')),
      { code: 'ENOENT' }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/export/preview keeps partial assembly repairs as fixed timeline segments', async () => {
  const { root, episodePath } = await makeEpisode();
  const ffmpegPath = await makeFakeFfmpeg(root);
  const docPath = join(episodePath, 'drama-creator.json');
  await writeFile(join(episodePath, 'raw-videos', 'partial-assembly.mp4'), 'partial edit');
  await writeFile(join(episodePath, 'raw-videos', 's003.mp4'), 'v3');
  const doc = JSON.parse(await readFile(docPath, 'utf8'));
  doc.shots.push({ id: 'shot:s003', shotNo: 's003', title: '修复后续接续', durationSec: 5, status: 'reviewing' });
  doc.nodes.push({ id: 'node:video:s003', type: 'video_output', title: 's003', shotId: 'shot:s003', path: 'raw-videos/s003.mp4', status: 'reviewing' });
  doc.nodes.push({
    id: 'node:video:assembly:partial',
    type: 'video_output',
    title: 'S001-S002 局部剪辑修复版',
    shotId: null,
    path: 'raw-videos/partial-assembly.mp4',
    status: 'reviewing',
    metadata: {
      role: 'assembly_preview',
      exportPreferred: true,
      exportPriority: 100,
      includedShots: ['s001', 's002']
    }
  });
  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root], ffmpegPath }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const previewResponse = await fetch(`http://127.0.0.1:${port}/api/export/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath })
    });
    const json = await previewResponse.json();

    assert.equal(previewResponse.status, 200);
    assert.equal(json.preview.curatedAssembly, undefined);
    assert.match(json.preview.previewPath, /分镜拼接预览\.mp4$/);
    assert.deepEqual(json.preview.includedShots, ['s001', 's002', 's003']);
    assert.deepEqual(json.preview.missingShots, []);
    assert.deepEqual(json.preview.timelineSegments.map((segment) => ({
      source: segment.source,
      includedShots: segment.includedShots
    })), [
      { source: 'assembly_preview', includedShots: ['s001', 's002'] },
      { source: 'shot_video', includedShots: ['s003'] }
    ]);
    assert.equal((await stat(json.preview.previewPath)).isFile(), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('exportAvailableShotPreview keeps a creator-facing error when no videos exist', async () => {
  const { root, episodePath } = await makeEpisode();
  const ffmpegPath = await makeFakeFfmpeg(root);
  const doc = JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
  doc.nodes = doc.nodes.filter((node) => node.type !== 'video_output');
  try {
    await assert.rejects(
      exportAvailableShotPreview({ doc, episodePath, ffmpegPath }),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.match(error.publicMessage, /还没有可预览的分镜视频/);
        assert.doesNotMatch(error.publicMessage, /Missing videos|ffmpeg/i);
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportEpisodeVideo marks unreviewed or rerun-needed episodes as draft outputs', async () => {
  const { root, episodePath } = await makeEpisode();
  const ffmpegPath = await makeFakeFfmpeg(root);
  const doc = JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
  doc.shots[1].status = 'rerun_needed';
  try {
    const result = await exportEpisodeVideo({ doc, episodePath, ffmpegPath });

    assert.equal(result.status, 'draft');
    assert.match(result.originalPath, /_草稿版_v001\.mp4$/);
    assert.match(result.subtitledPath, /_草稿版_v001_字幕版\.mp4$/);
    assert.match(result.srtPath, /_草稿版_v001\.srt$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildSrt extracts creator-facing subtitles instead of video prompts', async () => {
  const { root, episodePath } = await makeEpisode();
  const ffmpegPath = await makeFakeFfmpeg(root);
  const doc = JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
  doc.shots = [
    { id: 'shot:s001', shotNo: 's001', title: '空镜', durationSec: 5, status: 'approved' },
    { id: 'shot:s002', shotNo: 's002', title: '女儿发问', durationSec: 4, status: 'approved' },
    { id: 'shot:s003', shotNo: 's003', title: '旁白收束', durationSec: 3, status: 'approved' }
  ];
  doc.nodes = [
    {
      id: 'node:script:s001',
      type: 'script_segment',
      title: '空镜',
      shotId: 'shot:s001',
      metadata: { text: '6秒横屏16:9南方老城旧街区清晨远景，参考 @图片1 的拆迁围挡街景。\n对白：无，本镜以动作建立日常。\n音效：风声。' }
    },
    {
      id: 'node:script:s002',
      type: 'script_segment',
      title: '女儿发问',
      shotId: 'shot:s002',
      metadata: { text: '7秒横屏16:9日间内景。\n对白（女儿，轻声）："这是爸爸吗？"\n音效：屋内极静。' }
    },
    {
      id: 'node:script:s003',
      type: 'script_segment',
      title: '旁白收束',
      shotId: 'shot:s003',
      metadata: { text: '@音频1：母亲对白音色严格参考，台词："他也应该被记住。"' }
    },
    { id: 'node:video:s001', type: 'video_output', title: 's001', shotId: 'shot:s001', path: 'raw-videos/s001.mp4', status: 'approved' },
    { id: 'node:video:s002', type: 'video_output', title: 's002', shotId: 'shot:s002', path: 'raw-videos/s002.mp4', status: 'approved' },
    { id: 'node:video:s003', type: 'video_output', title: 's003', shotId: 'shot:s003', path: 'raw-videos/s002.mp4', status: 'approved' }
  ];
  try {
    const result = await exportEpisodeVideo({ doc, episodePath, ffmpegPath });
    const srt = await readFile(result.srtPath, 'utf8');

    assert.doesNotMatch(srt, /6秒横屏|参考 @图片|音效/);
    assert.doesNotMatch(srt, /无，本镜以动作/);
    assert.match(srt, /00:00:05,000 --> 00:00:09,000\n这是爸爸吗？/);
    assert.match(srt, /00:00:09,000 --> 00:00:12,000\n他也应该被记住。/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/export/episode resolves project-relative video output paths', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-export-project-root-')));
  const projectRoot = join(root, 'project-a');
  const episodePath = join(projectRoot, 'episodes', 'ep001');
  await mkdir(join(projectRoot, 'assets', 'videos'), { recursive: true });
  await mkdir(episodePath, { recursive: true });
  await writeFile(join(projectRoot, 'assets', 'videos', 's001.mp4'), 'v1');
  await writeFile(join(episodePath, 'drama-creator.json'), `${JSON.stringify({
    schemaVersion: '0.1.0',
    project: { name: '项目根目录视频' },
    episode: { id: 'ep001', title: '第 1 集', path: episodePath },
    shots: [
      { id: 'shot:s001', shotNo: 's001', title: '开场', durationSec: 5, status: 'approved' }
    ],
    nodes: [
      { id: 'node:script:s001', type: 'script_segment', title: '开场', shotId: 'shot:s001', metadata: { text: '旁白：项目根目录视频可以导出。' } },
      { id: 'node:video:s001', type: 'video_output', title: 's001', shotId: 'shot:s001', path: 'assets/videos/s001.mp4', status: 'approved' }
    ],
    edges: [],
    tasks: [],
    checks: [],
    activityLog: []
  }, null, 2)}\n`, 'utf8');
  const ffmpegPath = await makeFakeFfmpeg(root);
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root], ffmpegPath }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/export/episode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath })
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal((await stat(json.export.originalPath)).isFile(), true);
    const concatList = await readFile(json.export.concatListPath, 'utf8');
    assert.match(concatList, /assets\/videos\/s001\.mp4/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('exportEpisodeVideo keeps original and SRT when subtitle burn is unavailable', async () => {
  const { root, episodePath } = await makeEpisode();
  const ffmpegPath = await makeFakeFfmpegWithoutSubtitleFilter(root);
  const doc = JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
  try {
    const result = await exportEpisodeVideo({ doc, episodePath, ffmpegPath });

    assert.equal((await stat(result.originalPath)).isFile(), true);
    assert.equal((await stat(result.srtPath)).isFile(), true);
    assert.equal(result.subtitledPath, null);
    assert.deepEqual(result.warnings.map((warning) => warning.code), ['subtitle_burn_failed']);
    assert.match(result.warnings[0].message, /字幕版未生成/);
    assert.match(result.warnings[0].message, /原片 MP4 和 SRT 字幕/);
    // Warning 会直接展示给创作者，不能泄漏 ffmpeg 的底层错误日志。
    assert.doesNotMatch(result.warnings[0].message, /No such filter|ffmpeg exited|subtitles=filename/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportEpisodeVideo can be cancelled while ffmpeg is running', async () => {
  const { root, episodePath } = await makeEpisode();
  const ffmpegPath = await makeSlowFfmpeg(root);
  const doc = JSON.parse(await readFile(join(episodePath, 'drama-creator.json'), 'utf8'));
  const controller = new AbortController();
  const exporting = exportEpisodeVideo({ doc, episodePath, ffmpegPath, signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  try {
    await assert.rejects(exporting, (error) => {
      assert.equal(error.statusCode, 499);
      assert.match(error.publicMessage, /取消/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
