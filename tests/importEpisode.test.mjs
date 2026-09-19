// 公开测试使用虚构名称与对应资源标识，避免将创作项目的人物或作品名称带入源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeedPackagePreviewResult } from '../src/feed/feedPackage.mjs';
import { importEpisode } from '../src/import/importEpisode.mjs';

test('imports an episode into a graph document', async () => {
  const { ep, root } = await createEpisodeFixture();

  try {
    const doc = await importEpisode({ episodePath: ep, write: true });
    const saved = JSON.parse(await readFile(join(ep, 'drama-creator.json'), 'utf8'));

    assert.equal(doc.episode.id, 'ep001');
    assert.equal(saved.nodes.some((node) => node.type === 'video_output'), true);
    assert.equal(saved.nodes.some((node) => node.type === 'image_prompt'), true);
    assert.equal(saved.edges.some((edge) => edge.type === 'uses_reference'), true);
    assert.equal(saved.tasks.some((task) => task.type === 'video'), true);
    // Phase 0: importer must emit externalized config + empty adapter/credential/job tables.
    assert.deepEqual(doc.config, {
      defaultRatio: '9:16',
      defaultModel: null,
      locale: 'zh-CN'
    });
    assert.deepEqual(doc.adapters, []);
    assert.deepEqual(doc.credentials, []);
    assert.deepEqual(doc.jobs, []);
  } finally {
    await removeFixture(root);
  }
});

test('links imported video outputs back to their task and prompt graph', async () => {
  const { ep, root } = await createEpisodeFixture();

  try {
    const doc = await importEpisode({ episodePath: ep, write: true });
    const task = doc.tasks.find((item) => item.id === 'task:video:s001b:v001');
    const outputNodeId = 'node:video:s001b:v002';

    assert.deepEqual(task.outputNodeIds, [outputNodeId]);
    assert.equal(
      doc.edges.some((edge) => (
        edge.from === task.promptNodeId &&
        edge.to === outputNodeId &&
        edge.type === 'generates' &&
        edge.role === 'video_generation'
      )),
      true
    );
  } finally {
    await removeFixture(root);
  }
});

test('creates a placeholder qc_record + qc_for edge for every imported video output', async () => {
  const { ep, root } = await createEpisodeFixture();

  try {
    const doc = await importEpisode({ episodePath: ep, write: false });
    const outputNodeId = 'node:video:s001b:v002';
    const placeholderQcId = 'node:qc:s001b:v002';

    const placeholderQc = doc.nodes.find((node) => node.id === placeholderQcId);
    assert.ok(placeholderQc, 'placeholder qc_record created');
    assert.equal(placeholderQc.type, 'qc_record');
    assert.equal(placeholderQc.shotId, 'shot:s001b');
    // status 与 qcNote 的具体内容由独立用例校验，本用例只关心结构正确性。
    assert.ok(['reviewing', 'rerun_needed'].includes(placeholderQc.status));
    assert.equal(placeholderQc.metadata.origin, 'placeholder-on-import');

    const qcForEdge = doc.edges.find((edge) => (
      edge.type === 'qc_for' && edge.from === placeholderQcId && edge.to === outputNodeId
    ));
    assert.ok(qcForEdge, 'placeholder qc_for edge created');

    // 全局 episode-level qc_record 仍保留作为归档
    assert.ok(doc.nodes.some((node) => node.id === 'node:qc:ep001:imported'));
  } finally {
    await removeFixture(root);
  }
});

test('emits script_uses_asset edges from each shot script to its bound assets', async () => {
  const { ep, root } = await createEpisodeFixture();

  try {
    const doc = await importEpisode({ episodePath: ep, write: false });
    const scriptId = 'node:script:s001b';
    const assetId = 'node:image:scripts-assets-keyframes-ep001-images-ep001-s001-keyframe-v003-png';

    const edge = doc.edges.find((e) => (
      e.type === 'script_uses_asset' && e.from === scriptId && e.to === assetId
    ));
    assert.ok(edge, 'script_uses_asset edge created from shot script to bound asset');
  } finally {
    await removeFixture(root);
  }
});

test('backfills shot qcNote from 06-qc-checklist.md detail section', async () => {
  const { ep, root } = await createEpisodeFixture();

  try {
    // fixture 的 06-qc-checklist.md 含 `## s001b 即梦生成验收记录`，应被回灌到对应 placeholder。
    const doc = await importEpisode({ episodePath: ep, write: false });
    const placeholder = doc.nodes.find((n) => n.id === 'node:qc:s001b:v002');
    assert.ok(placeholder, 'placeholder exists');
    assert.match(placeholder.metadata.qcNote, /即梦生成验收记录/, 'qcNote contains the detail section');
    assert.match(placeholder.metadata.qcNote, /待验收/, 'qcNote preserves original markdown body');
  } finally {
    await removeFixture(root);
  }
});

test('imports feed-slot video task fields and negative safety constraints', async () => {
  const { ep, root } = await createEpisodeFixture();

  try {
    const doc = await importEpisode({ episodePath: ep, write: false });
    const task = doc.tasks.find((item) => item.id === 'task:video:s001b:v001');
    const preview = createFeedPackagePreviewResult(doc);

    assert.deepEqual(task.fields, { ratio: '9:16', duration: 12 });
    assert.equal(preview.blocked, false);
    assert.match(preview.message, /【视频提示词】/);
  } finally {
    await removeFixture(root);
  }
});

test('CLI imports an episode and reports graph counts', async () => {
  const { ep, root } = await createEpisodeFixture();

  try {
    const result = await runImportCli(ep);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Imported ep001/);
    assert.match(result.stdout, /shots=1 nodes=\d+ edges=\d+ tasks=1/);

    const saved = JSON.parse(await readFile(join(ep, 'drama-creator.json'), 'utf8'));
    assert.equal(saved.episode.id, 'ep001');
  } finally {
    await removeFixture(root);
  }
});

test('imports audio_asset nodes from project-level voice-index.md', async () => {
  const { ep, root } = await createEpisodeFixture();

  try {
    const doc = await importEpisode({ episodePath: ep, write: false });

    const robot = doc.nodes.find((node) => node.id === 'node:audio:char-robot-voice-v001');
    assert.ok(robot, 'audio_asset for robot created');
    assert.equal(robot.type, 'audio_asset');
    assert.equal(robot.status, 'active', '已录入参考音频应判定为 active');
    assert.equal(robot.path, 'scripts/assets/voices/references/char_robot_ref_v001.wav');
    assert.equal(robot.metadata.role, '小邮');
    assert.equal(robot.metadata.voiceId, 'char_robot_voice_v001');

    const zhou = doc.nodes.find((node) => node.id === 'node:audio:char-tower-voice-v001');
    assert.ok(zhou, 'audio_asset for tower created');
    assert.equal(zhou.status, 'missing', '待录入参考音频应判定为 missing');
  } finally {
    await removeFixture(root);
  }
});

test('links shot script to audio_asset via script_uses_asset edge when prompt mentions voice id', async () => {
  const { ep, root } = await createEpisodeFixture();

  try {
    const doc = await importEpisode({ episodePath: ep, write: false });

    // s001b 的视频提示词 fixture 含 `voice: char_robot_voice_v001`，
    // 应该自动从 node:script:s001b 连一条 script_uses_asset 边到小邮音色资产。
    const scriptId = 'node:script:s001b';
    const audioId = 'node:audio:char-robot-voice-v001';
    const edge = doc.edges.find((e) => (
      e.type === 'script_uses_asset' &&
      e.from === scriptId &&
      e.to === audioId
    ));
    assert.ok(edge, 'script_uses_asset edge from script to audio_asset created');
    assert.equal(edge.role, 'voice_reference');
    assert.match(edge.note, /char_robot_voice_v001/);
  } finally {
    await removeFixture(root);
  }
});

async function createEpisodeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'drama-creator-import-'));
  const ep = join(root, 'ep001');
  await mkdir(join(ep, 'raw-videos'), { recursive: true });
  await mkdir(join(ep, 'scripts/assets/keyframes/ep001/images'), { recursive: true });
  // 项目级 voices 资产模拟真实仓库布局：projectRoot/scripts/assets/voices/voice-index.md。
  await mkdir(join(root, 'scripts/assets/voices/references'), { recursive: true });

  // This synthetic fixture exercises the legacy episode file contract without production story text.
  await writeFile(
    join(ep, 'script.md'),
    '第一集 1-1\n场景：森林邮局\n人物：小邮\n△ 小邮抬眼。\n小邮（OS）：我要把第一封信送到森林邮局。\n'
  );
  await writeFile(join(ep, '03-shot-list.md'), '## s001b 投递通知出现\n- 时长：10s\n');
  await writeFile(
    join(ep, '02-image-prompts.md'),
    [
      '### KF-s001 投递通知出现关键帧',
      '文件路径：`scripts/assets/keyframes/ep001/images/ep001_s001_keyframe_v003.png`',
      '```text',
      '9:16竖版构图，AR/HUD 投递通知卡片。',
      '```'
    ].join('\n')
  );
  await writeFile(
    join(ep, '04-video-prompts.md'),
    [
      '## s001b 投递通知出现',
      '> 注：剧情节奏为 13 秒，实际投喂按 12s 档生成。',
      '### 绑定素材',
      '- @图片1：KF-s001 投递通知出现关键帧 → `scripts/assets/keyframes/ep001/images/ep001_s001_keyframe_v003.png`（尾帧锁定）',
      '### 提示词',
      '```text',
      '9:16竖屏，13秒剧情节奏，禁止弹窗和按钮出现，末帧严格锁定 KF-s001。后期画外音建议（覆盖 9-13 秒，voice: char_robot_voice_v001，speed: 0.92）：小邮"测试旁白"。',
      '```'
    ].join('\n')
  );
  await writeFile(join(ep, '06-qc-checklist.md'), '## s001b 即梦生成验收记录\n结论：待验收\n');
  await writeFile(join(ep, 'feeding-log.md'), '## 即梦\n### s001b v002\n- 状态：已提交\n');
  await writeFile(join(ep, 'raw-videos/ep001_s001b_v002.mp4'), 'fake video bytes');
  await writeFile(join(ep, 'scripts/assets/keyframes/ep001/images/ep001_s001_keyframe_v003.png'), 'fake image bytes');
  // 项目级 voice-index.md：含 1 行已录入的小邮音色 + 1 行待录入的小灯，
  // 用于校验 audio_asset 节点状态推断（active vs missing）。
  await writeFile(
    join(root, 'scripts/assets/voices/voice-index.md'),
    [
      '# 核心音色资产索引',
      '',
      '## 核心角色',
      '',
      '| voice_id | 角色 | 音色卡 | 参考音频 | 模型权重 | 状态 |',
      '|---|---|---|---|---|---|',
      '| char_robot_voice_v001 | 小邮 | `scripts/assets/voices/cards/char_robot_voice_v001.md` | `scripts/assets/voices/references/char_robot_ref_v001.wav` | `scripts/assets/voices/models/char_robot_voice_v001/` | 已录入参考音频（4.36s） |',
      '| char_tower_voice_v001 | 小灯 | `scripts/assets/voices/cards/char_tower_voice_v001.md` | `scripts/assets/voices/references/char_tower_ref_v001.wav` | `scripts/assets/voices/models/char_tower_voice_v001/` | 待录入参考音频 |'
    ].join('\n')
  );
  await writeFile(join(root, 'scripts/assets/voices/references/char_robot_ref_v001.wav'), 'fake audio bytes');

  return { ep, root };
}

async function removeFixture(root) {
  // Keep repeated test runs from leaving generated episode fixtures in the OS temp dir.
  await rm(root, { recursive: true, force: true });
}

function runImportCli(episodePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/import-episode.mjs', '--episode', episodePath], {
      cwd: process.cwd(),
      env: process.env
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
