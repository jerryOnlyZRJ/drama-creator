// 公开测试使用虚构示例文本，保留解析与工作流断言，不承载作者作品。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createJimengFeedPackage } from '../src/automation/jimengFeedPackage.mjs';

function fixtureDoc() {
  return {
    episode: { id: 'ep001', path: '/project/episodes/ep001' },
    shots: [
      { id: 'shot:s001', shotNo: 's001', title: '天台对峙' }
    ],
    nodes: [
      {
        id: 'node:prompt:video:s001:v001',
        type: 'video_prompt',
        shotId: 'shot:s001',
        title: 'S001 视频提示词',
        metadata: { prompt: '9:16，5秒，@图片1 保持角色一致，接 @图片2 的尾帧继续推进。' }
      },
      {
        id: 'node:image:character:lin',
        type: 'image_asset',
        path: 'assets/lin.png',
        metadata: { role: 'character_ref' }
      },
      {
        id: 'node:image:tail:s001',
        type: 'image_asset',
        path: 'app-cache/projects/demo/resources/generated/ep001/tail.png',
        metadata: { role: 'tail_frame' }
      }
    ],
    edges: [
      { id: 'e1', from: 'node:prompt:video:s001:v001', to: 'node:image:character:lin', type: 'uses_reference', role: 'character_ref' },
      { id: 'e2', from: 'node:prompt:video:s001:v001', to: 'node:image:tail:s001', type: 'uses_reference', role: 'tail_frame' }
    ],
    tasks: [
      {
        id: 'task:video:s001:v001',
        shotId: 'shot:s001',
        type: 'video',
        promptNodeId: 'node:prompt:video:s001:v001',
        fields: { ratio: '9:16', duration: 5 }
      }
    ]
  };
}

test('creates a Jimeng browser automation feed package for a video task', () => {
  const episodeRoot = '/project/episodes/ep001';
  const resourceCacheDir = '/Users/demo/.drama-creator';
  const pkg = createJimengFeedPackage(fixtureDoc(), 'task:video:s001:v001', {
    episodeRoot,
    resourceCacheDir,
    modelDefault: { adapterId: 'jimeng-browser-automation', modelId: 'seedance-2.0-fast' }
  });

  assert.equal(pkg.schemaVersion, 'jimeng-feed-package.v1');
  assert.equal(pkg.platform, 'jimeng');
  assert.equal(pkg.automationType, 'browser');
  assert.equal(pkg.workspace.mode, '视频生成');
  assert.equal(pkg.workspace.modelId, 'seedance-2.0-fast');
  assert.equal(pkg.workspace.model, 'Seedance 2.0 Fast');
  assert.equal(pkg.workspace.referenceMode, '全能参考');
  assert.equal(pkg.workspace.spaceName, '');
  assert.match(pkg.targetUrl, /jimeng\.jianying\.com/);
  assert.equal(pkg.taskId, 'task:video:s001:v001');
  assert.equal(pkg.shot.shotNo, 's001');
  assert.equal(pkg.prompt, '9:16，5秒，@图片1 保持角色一致，接 @图片2 的尾帧继续推进。');
  assert.equal(pkg.promptSanitization.applied, false);
  assert.deepEqual(pkg.promptSanitization.removedMetadata, []);
  assert.deepEqual(pkg.params, { ratio: '9:16', duration: 5 });

  assert.deepEqual(pkg.references.map((ref) => ({
    placeholder: ref.placeholder,
    role: ref.role,
    kind: ref.kind,
    path: ref.path,
    uploadPath: ref.uploadPath
  })), [
    {
      placeholder: '@图片1',
      role: 'character_ref',
      kind: 'image',
      path: 'assets/lin.png',
      uploadPath: join(episodeRoot, 'assets/lin.png')
    },
    {
      placeholder: '@图片2',
      role: 'tail_frame',
      kind: 'image',
      path: 'app-cache/projects/demo/resources/generated/ep001/tail.png',
      uploadPath: join(resourceCacheDir, 'projects/demo/resources/generated/ep001/tail.png')
    }
  ]);
  assert.equal(pkg.warnings.length, 0);
  assert.equal(pkg.submitPolicy.requireExplicitUserConfirmation, true);
  assert.equal(pkg.submitPolicy.allowAutoSubmit, false);
  assert.ok(pkg.gates.includes('reference_asset_gate'));
  assert.ok(pkg.gates.includes('resource_mention_binding_gate'));
  assert.ok(pkg.gates.includes('pre_submit_confirmation'));
  assert.ok(pkg.gates.includes('submission_success_gate'));
  assert.ok(pkg.gates.includes('download_validation'));
});

test('uses Seedance 2.0 mini when the Jimeng video default selects mini', () => {
  const pkg = createJimengFeedPackage(fixtureDoc(), 'task:video:s001:v001', {
    episodeRoot: '/project/episodes/ep001',
    resourceCacheDir: '/Users/demo/.drama-creator',
    modelDefault: { adapterId: 'jimeng-browser-automation', modelId: 'seedance-2.0-mini' }
  });

  assert.equal(pkg.workspace.modelId, 'seedance-2.0-mini');
  assert.equal(pkg.workspace.model, 'Seedance 2.0 mini');
});

test('includes the project-level Jimeng space in the feed package workspace', () => {
  const pkg = createJimengFeedPackage(fixtureDoc(), 'task:video:s001:v001', {
    jimengSpaceName: '机器人送信'
  });

  assert.equal(pkg.workspace.spaceName, '机器人送信');
});

test('resolves app-owned project asset paths from the project root for Jimeng upload', () => {
  const projectRoot = '/Users/demo/.drama-creator/projects/project-a';
  const episodeRoot = join(projectRoot, 'episodes/ep001');
  const doc = fixtureDoc();
  doc.episode.path = episodeRoot;
  const character = doc.nodes.find((node) => node.id === 'node:image:character:lin');
  character.path = 'scripts/assets/characters/lin.png';

  const pkg = createJimengFeedPackage(doc, 'task:video:s001:v001', { episodeRoot, projectRoot });

  assert.equal(pkg.references[0].uploadPath, join(projectRoot, 'scripts/assets/characters/lin.png'));
});

test('upgrades visible dialogue that cannot be post-dubbed to standard Seedance 2.0', () => {
  const projectRoot = '/Users/demo/.drama-creator/projects/project-a';
  const episodeRoot = join(projectRoot, 'episodes/ep001');
  const resourceCacheDir = '/Users/demo/.drama-creator';
  const doc = fixtureDoc();
  doc.episode.path = episodeRoot;
  doc.nodes.push({
    id: 'node:audio:voice',
    type: 'audio_asset',
    title: '小邮音色参考',
    path: 'scripts/assets/voices/references/char_xwsboy_voice_v001_s004_classroom.m4a',
    metadata: { role: 'voice_reference' }
  });
  doc.edges.push({
    id: 'e3-voice',
    from: 'node:prompt:video:s001:v001',
    to: 'node:audio:voice',
    type: 'script_uses_asset',
    role: '@音频1'
  });
  doc.tasks[0].metadata = {
    audioLockRequired: true,
    postDubbingAllowed: false
  };
  const prompt = doc.nodes.find((node) => node.id === 'node:prompt:video:s001:v001');
  prompt.metadata.prompt = '9:16，5秒，@图片1 保持角色一致，接 @图片2 的尾帧继续推进；声音参考 @音频1。';

  const pkg = createJimengFeedPackage(doc, 'task:video:s001:v001', {
    episodeRoot,
    projectRoot,
    resourceCacheDir,
    modelDefault: { adapterId: 'jimeng-browser-automation', modelId: 'seedance-2.0-mini' }
  });

  assert.equal(pkg.workspace.modelId, 'seedance-2.0');
  assert.equal(pkg.workspace.model, 'Seedance 2.0');
  assert.equal(pkg.workspace.modelPolicy, 'forced_audio_lock_prefers_seedance_2_0');

  assert.deepEqual(pkg.references.map((ref) => ({
    placeholder: ref.placeholder,
    kind: ref.kind,
    sourceNodeId: ref.sourceNodeId,
    uploadPath: ref.uploadPath
  })), [
    {
      placeholder: '@图片1',
      kind: 'image',
      sourceNodeId: 'node:image:character:lin',
      uploadPath: join(episodeRoot, 'assets/lin.png')
    },
    {
      placeholder: '@图片2',
      kind: 'image',
      sourceNodeId: 'node:image:tail:s001',
      uploadPath: join(resourceCacheDir, 'projects/demo/resources/generated/ep001/tail.png')
    },
    {
      placeholder: '@音频1',
      kind: 'audio',
      sourceNodeId: 'node:audio:voice',
      uploadPath: join(projectRoot, 'scripts/assets/voices/references/char_xwsboy_voice_v001_s004_classroom.m4a')
    }
  ]);
  assert.deepEqual(pkg.warnings, []);
});

test('keeps post-production BGM references on the configured mini model', () => {
  const projectRoot = '/Users/demo/.drama-creator/projects/project-a';
  const episodeRoot = join(projectRoot, 'episodes/ep001');
  const doc = fixtureDoc();
  doc.episode.path = episodeRoot;
  doc.nodes.push({
    id: 'node:audio:bgm',
    type: 'audio_asset',
    title: '后期 BGM 参考',
    path: 'scripts/assets/audio/bgm-reference.wav',
    metadata: { role: 'bgm_reference' }
  });
  doc.edges.push({
    id: 'e3-bgm',
    from: 'node:prompt:video:s001:v001',
    to: 'node:audio:bgm',
    type: 'script_uses_asset',
    role: '@音频1'
  });
  doc.tasks[0].metadata = {
    // 后期可替换的音轨即使继承了旧锁定标记，也不能消耗普通 2.0 额度。
    audioLockRequired: true,
    postDubbingAllowed: true
  };
  const prompt = doc.nodes.find((node) => node.id === 'node:prompt:video:s001:v001');
  prompt.metadata.prompt = '9:16，5秒，@图片1 保持角色一致；@音频1 仅作为后期 BGM 节奏参考。';

  const pkg = createJimengFeedPackage(doc, 'task:video:s001:v001', {
    episodeRoot,
    projectRoot,
    modelDefault: { adapterId: 'jimeng-browser-automation', modelId: 'seedance-2.0-mini' }
  });

  assert.equal(pkg.workspace.modelId, 'seedance-2.0-mini');
  assert.equal(pkg.workspace.model, 'Seedance 2.0 mini');
  assert.equal(pkg.workspace.modelPolicy, 'configured_video_default');
});

test('ignores non-active reference edges when building Jimeng upload order', () => {
  const doc = fixtureDoc();
  doc.nodes.push({
    id: 'node:image:diagnostic-tail',
    type: 'image_asset',
    path: 'assets/diagnostic-tail.png',
    metadata: { role: 'tail_frame' }
  });
  doc.edges.unshift({
    id: 'e0-diagnostic',
    from: 'node:prompt:video:s001:v001',
    to: 'node:image:diagnostic-tail',
    type: 'uses_reference',
    role: 'diagnostic_old_tail',
    status: 'diagnostic_rejected_for_s003'
  });

  const pkg = createJimengFeedPackage(doc, 'task:video:s001:v001');

  assert.deepEqual(pkg.references.map((ref) => ref.sourceNodeId), [
    'node:image:character:lin',
    'node:image:tail:s001'
  ]);
  assert.deepEqual(pkg.references.map((ref) => ref.placeholder), ['@图片1', '@图片2']);
});

test('ignores metadata-disabled legacy reference edges without status', () => {
  const doc = fixtureDoc();
  doc.nodes.push({
    id: 'node:image:legacy-probe',
    type: 'image_asset',
    path: 'assets/legacy-probe.png',
    metadata: { role: 'diagnostic_reference' }
  });
  doc.edges.unshift({
    id: 'e0-legacy-disabled',
    from: 'node:prompt:video:s001:v001',
    to: 'node:image:legacy-probe',
    type: 'uses_reference',
    role: '@图片1',
    metadata: {
      disabledAt: '2026-07-05T00:00:00.000Z',
      disabledReason: '旧诊断参考已停用，不应进入当前投喂包。'
    }
  });

  const pkg = createJimengFeedPackage(doc, 'task:video:s001:v001');

  assert.deepEqual(pkg.references.map((ref) => ref.sourceNodeId), [
    'node:image:character:lin',
    'node:image:tail:s001'
  ]);
});

test('orders Jimeng references by explicit image placeholder edge roles', () => {
  const doc = fixtureDoc();
  doc.nodes.push({
    id: 'node:image:keyframe:s001',
    type: 'image_asset',
    path: 'assets/keyframe.png',
    metadata: { role: 'shot_keyframe' }
  });
  doc.edges[0].role = '@图片2';
  doc.edges[1].role = '@图片3';
  // Corrected keyframes can be appended after existing references; @图片N is the stable upload contract.
  doc.edges.push({
    id: 'e4-keyframe',
    from: 'node:prompt:video:s001:v001',
    to: 'node:image:keyframe:s001',
    type: 'uses_reference',
    role: '@图片1'
  });
  const prompt = doc.nodes.find((node) => node.id === 'node:prompt:video:s001:v001');
  prompt.metadata.prompt = '以 @图片1 锁定关键帧，以 @图片2 锁定角色，以 @图片3 锁定尾帧。';

  const pkg = createJimengFeedPackage(doc, 'task:video:s001:v001');

  assert.deepEqual(pkg.references.map((ref) => ref.sourceNodeId), [
    'node:image:keyframe:s001',
    'node:image:character:lin',
    'node:image:tail:s001'
  ]);
  assert.deepEqual(pkg.references.map((ref) => ref.placeholder), ['@图片1', '@图片2', '@图片3']);
});

test('marks missing Jimeng reference placeholders as warnings instead of rewriting the prompt', () => {
  const doc = fixtureDoc();
  const prompt = doc.nodes.find((node) => node.type === 'video_prompt');
  prompt.metadata.prompt = '角色从天台边缘后退，镜头缓慢推进。';

  const pkg = createJimengFeedPackage(doc, 'task:video:s001:v001');

  assert.equal(pkg.prompt, '角色从天台边缘后退，镜头缓慢推进。');
  assert.deepEqual(pkg.warnings.map((item) => item.code), ['missing_prompt_binding', 'missing_prompt_binding']);
  assert.match(pkg.warnings[0].message, /@图片1/);
});

test('removes non-shot transition metadata from Jimeng handoff prompts', () => {
  const doc = fixtureDoc();
  const prompt = doc.nodes.find((node) => node.type === 'video_prompt');
  prompt.metadata.prompt = [
    '9:16，5秒，@图片1 保持角色一致。',
    '',
    '转场到 s002：硬切（天台 → 办公室）。',
    'Transition to s003: cut to the meeting room.'
  ].join('\n');

  const pkg = createJimengFeedPackage(doc, 'task:video:s001:v001');

  assert.equal(pkg.prompt, '9:16，5秒，@图片1 保持角色一致。');
  assert.equal(pkg.promptSanitization.applied, true);
  assert.deepEqual(pkg.promptSanitization.removedMetadata, [
    '转场到 s002：硬切（天台 → 办公室）。',
    'Transition to s003: cut to the meeting room.'
  ]);
  assert.equal(pkg.prompt.includes('转场到'), false);
  assert.equal(pkg.prompt.includes('Transition to'), false);
});

test('removes app-readable reference inventory before sending prompt to Jimeng', () => {
  const doc = fixtureDoc();
  const prompt = doc.nodes.find((node) => node.type === 'video_prompt');
  prompt.metadata.prompt = [
    '以 @图片1 锁定角色，以 @图片2 锁定尾帧。生成 9:16 写实视频。',
    '',
    '0-5秒：角色从门口走入，保持克制。',
    '',
    '引用资源：',
    '@图片1：CHAR-LIN（scripts/assets/characters/lin.png；原始依赖 assets/reference-images/characters/lin.png）',
    '@图片2：TAIL-S001（scripts/assets/storyboard/tail.png；原始依赖 assets/reference-images/storyboard/tail.png）'
  ].join('\n');

  const pkg = createJimengFeedPackage(doc, 'task:video:s001:v001');

  assert.equal(pkg.prompt.includes('引用资源：'), false);
  assert.equal(pkg.prompt.includes('CHAR-LIN'), false);
  assert.equal((pkg.prompt.match(/@图片1/g) || []).length, 1);
  assert.equal((pkg.prompt.match(/@图片2/g) || []).length, 1);
  assert.equal(pkg.promptSanitization.applied, true);
  assert.equal(pkg.promptSanitization.removedReferenceInventory.length, 3);
});

test('keeps legacy single-shot prompt text after removing reference inventory block', () => {
  const doc = fixtureDoc();
  const prompt = doc.nodes.find((node) => node.type === 'video_prompt');
  prompt.metadata.prompt = [
    'Use case: photorealistic-natural',
    '引用资源：',
    '@图片1：SCENE-BACKSTAGE-MAKEUP-01（scripts/assets/locations/scene.png）',
    '',
    '单镜头提示词：',
    '以 @图片1 锁定后台化妆镜，生成 16:9 写实视频。'
  ].join('\n');

  const pkg = createJimengFeedPackage(doc, 'task:video:s001:v001');

  assert.equal(pkg.prompt.includes('SCENE-BACKSTAGE-MAKEUP-01'), false);
  assert.equal(pkg.prompt.includes('单镜头提示词：'), false);
  assert.match(pkg.prompt, /Use case: photorealistic-natural/);
  assert.match(pkg.prompt, /以 @图片1 锁定后台化妆镜/);
});

test('keeps shot-body transition-like descriptions that are not metadata lines', () => {
  const doc = fixtureDoc();
  const prompt = doc.nodes.find((node) => node.type === 'video_prompt');
  prompt.metadata.prompt = '镜头从走廊转场感推进到办公室门口，@图片1 保持角色一致。';

  const pkg = createJimengFeedPackage(doc, 'task:video:s001:v001');

  assert.equal(pkg.prompt, '镜头从走廊转场感推进到办公室门口，@图片1 保持角色一致。');
  assert.equal(pkg.promptSanitization.applied, false);
});

test('creates a spoken-text-only Jimeng feed package for a public audio task', () => {
  const doc = fixtureDoc();
  doc.nodes.push({
    id: 'node:prompt:audio:voice-xwsboy:v001',
    type: 'audio_prompt',
    title: '小邮童年音色提示',
    metadata: {
      prompt: '12 岁男孩，声线清亮、克制，不朗诵。',
      listeningTarget: '12 岁男孩，声线清亮、克制，不朗诵。',
      spokenText: '奶奶，我知道了。我会认真练习。',
      voiceName: '阳光小男孩',
      assetId: 'public:voice-char-xwsboy-v001'
    }
  });
  doc.tasks.push({
    id: 'task:audio:voice-xwsboy:v001',
    shotId: null,
    type: 'audio',
    title: '生成童年小邮音色',
    status: 'ready_to_feed',
    promptNodeId: 'node:prompt:audio:voice-xwsboy:v001',
    fields: {
      assetId: 'public:voice-char-xwsboy-v001',
      assetTitle: '小邮（12岁）角色音色参考',
      spokenText: '奶奶，我知道了。我会认真练习。',
      voiceName: '阳光小男孩',
      duration: 8,
      outputTarget: 'scripts/assets/voices/references/char_xwsboy_voice_v001_jimeng.m4a'
    }
  });

  const pkg = createJimengFeedPackage(doc, 'task:audio:voice-xwsboy:v001', {
    modelDefault: { adapterId: 'jimeng-browser-automation', modelId: 'jimeng-audio' },
    jimengSpaceName: '机器人送信'
  });

  assert.equal(pkg.capability, 'audio');
  assert.match(pkg.targetUrl, /ai_feature_name=audio/);
  assert.equal(pkg.workspace.mode, '配音生成');
  assert.equal(pkg.workspace.modelId, 'jimeng-audio');
  assert.equal(pkg.workspace.voiceName, '阳光小男孩');
  assert.equal(pkg.prompt, '奶奶，我知道了。我会认真练习。');
  assert.equal(pkg.prompt.includes('12 岁男孩'), false);
  assert.equal(pkg.audio.listeningTarget, '12 岁男孩，声线清亮、克制，不朗诵。');
  assert.equal(pkg.audio.outputTarget, 'scripts/assets/voices/references/char_xwsboy_voice_v001_jimeng.m4a');
  assert.deepEqual(pkg.params, { duration: 8 });
  assert.deepEqual(pkg.references, []);
  assert.deepEqual(pkg.warnings, []);
  assert.equal(pkg.promptSanitization.policy, 'spoken_text_only');
});

test('uses an approved public voice reference for downstream shot dialogue audio', () => {
  const projectRoot = '/Users/demo/.drama-creator/projects/project-a';
  const episodeRoot = join(projectRoot, 'episodes/ep001');
  const doc = fixtureDoc();
  doc.episode.path = episodeRoot;
  doc.nodes.push(
    {
      id: 'node:prompt:audio:s006:boy-response-v001',
      type: 'audio_prompt',
      title: 'S006 少年回应提示',
      metadata: {
        prompt: '12 岁男孩，低声回应。',
        spokenText: '我试试。',
        voiceName: '阳光小男孩',
        linkedVoiceAssetId: 'public:voice-char-xwsboy-v001'
      }
    },
    {
      id: 'node:audio:char_xwsboy_voice_v001',
      type: 'audio_asset',
      title: '小邮（12岁）角色音色参考（已确认）',
      path: 'scripts/assets/voices/references/char_xwsboy_voice_v001_jimeng.wav',
      status: 'approved_by_user_audio_qc',
      metadata: {
        publicAssetId: 'public:voice-char-xwsboy-v001',
        canonicalCharacterVoice: true,
        selected: true,
        jimengCustomVoiceName: '小邮童年 B'
      }
    }
  );
  doc.tasks.push({
    id: 'task:audio:s006:boy-response:v001',
    shotId: 'shot:s006',
    type: 'audio',
    title: '生成 S006 少年回应',
    status: 'ready_to_feed',
    promptNodeId: 'node:prompt:audio:s006:boy-response-v001',
    fields: {
      spokenText: '我试试。',
      voiceName: '阳光小男孩',
      outputTarget: 'manual-assets/audio/s006-boy-response-v001.mp3'
    },
    metadata: {
      linkedVoiceAssetId: 'public:voice-char-xwsboy-v001'
    }
  });

  const pkg = createJimengFeedPackage(doc, 'task:audio:s006:boy-response:v001', {
    episodeRoot,
    projectRoot,
    jimengSpaceName: '机器人送信'
  });

  assert.equal(pkg.capability, 'audio');
  assert.equal(pkg.workspace.mode, '配音生成');
  assert.equal(pkg.workspace.voiceName, '小邮童年 B');
  assert.equal(pkg.audio.voiceSource, 'public_reference');
  assert.equal(pkg.audio.cloneVoiceName, '小邮童年 B');
  assert.equal(pkg.audio.linkedVoiceAssetId, 'public:voice-char-xwsboy-v001');
  assert.equal(pkg.audio.referenceSourceNodeId, 'node:audio:char_xwsboy_voice_v001');
  assert.deepEqual(pkg.references.map((ref) => ({
    placeholder: ref.placeholder,
    kind: ref.kind,
    role: ref.role,
    sourceNodeId: ref.sourceNodeId,
    uploadPath: ref.uploadPath
  })), [{
    placeholder: '@音频1',
    kind: 'audio',
    role: 'public_voice_reference',
    sourceNodeId: 'node:audio:char_xwsboy_voice_v001',
    uploadPath: join(projectRoot, 'scripts/assets/voices/references/char_xwsboy_voice_v001_jimeng.wav')
  }]);
  assert.deepEqual(pkg.warnings, []);
});

test('does not silently fall back when a linked public voice reference is missing', () => {
  const doc = fixtureDoc();
  doc.nodes.push({
    id: 'node:prompt:audio:s006:boy-response-v001',
    type: 'audio_prompt',
    metadata: {
      spokenText: '我试试。',
      voiceName: '阳光小男孩',
      linkedVoiceAssetId: 'public:voice-char-xwsboy-v001'
    }
  });
  doc.tasks.push({
    id: 'task:audio:s006:boy-response:v001',
    shotId: 'shot:s006',
    type: 'audio',
    promptNodeId: 'node:prompt:audio:s006:boy-response-v001',
    fields: { spokenText: '我试试。', voiceName: '阳光小男孩' },
    metadata: { linkedVoiceAssetId: 'public:voice-char-xwsboy-v001' }
  });

  assert.throws(
    () => createJimengFeedPackage(doc, 'task:audio:s006:boy-response:v001'),
    /approved public voice reference not found/i
  );
});

test('rejects task types outside Jimeng video and audio automation', () => {
  const doc = fixtureDoc();
  doc.tasks[0].type = 'image';

  assert.throws(
    () => createJimengFeedPackage(doc, 'task:video:s001:v001'),
    /only supports video or audio tasks/i
  );
});
