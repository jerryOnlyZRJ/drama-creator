// 公开测试使用虚构示例文本，保留解析与工作流断言，不承载作者作品。
// 公开测试使用虚构名称与对应资源标识，避免将创作项目的人物或作品名称带入源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDramaCreatorDocument } from '../src/schema/dramaCreatorSchema.mjs';
import {
  applyStoryboardSplit,
  createScriptDraftFromSource,
  generatePublicAssetsFromScript,
  replaceStoryboardShots
} from '../src/workflow/scriptShots.mjs';
import { normalizeShotScriptTexts, readShotScriptText } from '../src/workflow/shotScripts.mjs';

test('createScriptDraftFromSource turns story text into a readable draft', () => {
  const draft = createScriptDraftFromSource('主角发现公司被 AI 接管。他决定深夜潜入机房，找回被删除的证据。');

  assert.match(draft.text, /场景一｜/);
  assert.match(draft.text, /画面：/);
  assert.match(draft.text, /主角发现公司被 AI 接管/);
  assert.equal(draft.source, 'local_rule');
});

test('applyStoryboardSplit creates shots, script nodes, prompts and video tasks', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001',
    episodeTitle: '第 1 集'
  });
  doc.scriptDraft = {
    text: '《分集剧本草稿》\n说明：以下内容根据故事源整理为可继续润色的可拍剧本。\n\n场景一｜深夜机房\n画面：主角发现公司被 AI 接管。\n动作：他深夜潜入机房。\n对白：这一次，我要找回证据。',
    updatedAt: '2026-06-13T00:00:00.000Z'
  };

  const result = applyStoryboardSplit(doc, { now: '2026-06-13T00:00:00.000Z' });

  assert.equal(result.shotCount >= 2, true);
  assert.equal(doc.shots.every((shot) => shot.durationSec <= 15), true);
  for (const shot of doc.shots) {
    const scriptNode = doc.nodes.find((node) => node.type === 'script_segment' && node.shotId === shot.id);
    assert.ok(shot.scriptText, `${shot.id} should carry its own script text`);
    assert.ok(scriptNode?.metadata?.text, `${shot.id} should have a script segment node`);
    assert.equal(shot.scriptText, scriptNode.metadata.text);
  }
  assert.equal(doc.shots[0].id, 'shot:s001');
  assert.doesNotMatch(doc.shots[0].scriptText, /场景一｜/);
  assert.doesNotMatch(doc.shots[0].scriptText, /说明：/);
  assert.equal(doc.nodes.some((node) => node.type === 'script_segment' && node.shotId === 'shot:s001'), true);
  assert.equal(doc.nodes.some((node) => node.type === 'video_prompt' && node.shotId === 'shot:s001'), true);
  assert.equal(doc.tasks.some((task) => task.type === 'video' && task.promptNodeId === 'node:prompt:video:s001:v001'), true);
  assert.equal(doc.publicAssets.some((asset) => asset.category === 'characters' && asset.title === '主角'), true);
  assert.equal(doc.publicAssets.some((asset) => asset.category === 'locations'), true);
  assert.equal(doc.scriptDraft.status, 'confirmed');
  assert.equal(doc.scriptDraft.confirmedAt, '2026-06-13T00:00:00.000Z');
  assert.equal(doc.workflow.currentStep, 'shot_videos');
});

test('applyStoryboardSplit ignores Markdown metadata sections and splits only the formal script body', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001',
    episodeTitle: '第 1 集'
  });
  // 这个结构复现文本模型常见输出：前面是标题/概述/人物/场景资料，真正可拍内容在“正式剧本”之后。
  doc.scriptDraft = {
    text: [
      '# 分集剧本草稿',
      '> 本集关键词：机器人、送信、抵达',
      '## 标题：机器人送信 · 第1集',
      '## 故事概述',
      '机器人小邮准备出发，把一枚蓝色胸针放进送信箱，核对今天的送达地址。',
      '## 主要人物',
      '- 小邮（机器人）：信使，即将出发',
      '- 示例奶奶：奶奶，温柔坚韧',
      '## 主要场景',
      '- 剧场后台化妆间',
      '- 小学音乐教室',
      '',
      '## 正式剧本',
      '### 场次 1',
      '- 场景：清晨，工作台前，阳光明亮。',
      '- 动作：机器人小邮停在工作台前，低头核对蓝色胸针。',
      '- 动作：它打开收纳盒，把胸针放在信封旁边。',
      '- 屏幕文字（可选）：《机器人送信》第1集',
      '### 场次 2：小学音乐教室',
      '- 画面：机器人小邮站在门口，读出信封上的地址。',
      '- 对白：',
      '- 小灯说：“地址确认好了，现在可以出发。”',
      '”'
    ].join('\n'),
    updatedAt: '2026-06-27T01:00:00.000Z'
  };

  const result = applyStoryboardSplit(doc, { now: '2026-06-27T01:00:00.000Z' });
  const shotTexts = doc.shots.map((shot) => shot.scriptText);

  assert.equal(result.shotCount, 5);
  assert.equal(shotTexts.some((text) => /^#/.test(text)), false);
  assert.equal(shotTexts.some((text) => /^-/.test(text)), false);
  assert.equal(shotTexts.some((text) => /^”$/.test(text)), false);
  assert.equal(shotTexts.some((text) => /故事概述|主要人物|主要场景|标题：|屏幕文字/.test(text)), false);
  assert.deepEqual(shotTexts, [
    '清晨，工作台前，阳光明亮。',
    '机器人小邮停在工作台前，低头核对蓝色胸针。',
    '它打开收纳盒，把胸针放在信封旁边。',
    '机器人小邮站在门口，读出信封上的地址。',
    '小灯说：“地址确认好了，现在可以出发。”'
  ]);
});

test('replaceStoryboardShots supports storyboard create, update, delete and keeps graph nodes aligned', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001',
    episodeTitle: '第 1 集'
  });
  applyStoryboardSplit(doc, {
    scriptText: '场景一｜后台\n画面：旧镜头一。\n动作：旧镜头二。',
    now: '2026-06-27T01:00:00.000Z'
  });

  const result = replaceStoryboardShots(doc, {
    shots: [
      {
        shotNo: 's001',
        title: '修改后的开场',
        scriptText: '小邮低头整理蓝色胸针。',
        durationSec: 7
      },
      {
        title: '新增舞台镜头',
        scriptText: '追光亮起，小邮走向舞台中央。',
        durationSec: 6
      }
    ],
    now: '2026-06-27T02:00:00.000Z'
  });

  const editedScriptNode = doc.nodes.find((node) => node.id === 'node:script:s001');
  const editedPromptNode = doc.nodes.find((node) => node.id === 'node:prompt:video:s001:v001');
  const editedTask = doc.tasks.find((task) => task.id === 'task:video:s001:v001');
  const createdShot = doc.shots[1];

  assert.deepEqual(result, { shotCount: 2, createdCount: 1, updatedCount: 1, deletedCount: 1 });
  assert.equal(doc.shots.length, 2);
  assert.equal(doc.shots[0].shotNo, 's001');
  assert.equal(doc.shots[0].title, '修改后的开场');
  assert.equal(doc.shots[0].scriptText, '小邮低头整理蓝色胸针。');
  assert.equal(doc.shots[0].durationSec, 7);
  assert.equal(editedScriptNode.metadata.text, '小邮低头整理蓝色胸针。');
  assert.match(editedPromptNode.metadata.prompt, /小邮低头整理蓝色胸针/);
  assert.equal(editedTask.fields.duration, 7);
  assert.equal(createdShot.shotNo, 's002');
  assert.equal(createdShot.title, '新增舞台镜头');
  assert.equal(doc.nodes.some((node) => node.shotId === 'shot:s003'), false);
  assert.equal(doc.tasks.some((task) => task.shotId === 'shot:s003'), false);
  assert.equal(doc.edges.some((edge) => edge.from.includes('s003') || edge.to.includes('s003')), false);
  assert.equal(doc.workflow.currentStep, 'script_shots');
});

test('replaceStoryboardShots renumbers following shots after deletion and remaps graph records', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001',
    episodeTitle: '第 1 集'
  });
  applyStoryboardSplit(doc, {
    scriptText: [
      '场景一｜后台',
      '画面：后台黑场。',
      '动作：小邮拿起蓝色胸针。',
      '声音：助理推门提醒。'
    ].join('\n'),
    now: '2026-06-27T01:00:00.000Z'
  });

  const originalThirdScriptNode = doc.nodes.find((node) => node.id === 'node:script:s003');
  assert.equal(originalThirdScriptNode?.shotId, 'shot:s003');

  const result = replaceStoryboardShots(doc, {
    shots: [
      {
        sourceShotNo: 's001',
        title: '后台黑场',
        scriptText: '黑场里只有远处观众声。',
        durationSec: 3
      },
      {
        sourceShotNo: 's003',
        title: '助理提醒上场',
        scriptText: '助理从门口侧后方提醒上场。',
        durationSec: 4
      }
    ],
    now: '2026-06-27T02:00:00.000Z'
  });

  assert.deepEqual(result, { shotCount: 2, createdCount: 0, updatedCount: 2, deletedCount: 1 });
  assert.deepEqual(doc.shots.map((shot) => shot.shotNo), ['s001', 's002']);
  assert.equal(doc.shots[1].id, 'shot:s002');
  assert.equal(doc.nodes.some((node) => node.id === 'node:script:s003' || node.shotId === 'shot:s003'), false);
  assert.equal(doc.tasks.some((task) => task.id === 'task:video:s003:v001' || task.shotId === 'shot:s003'), false);
  assert.equal(doc.nodes.find((node) => node.id === 'node:script:s002')?.metadata.text, '助理从门口侧后方提醒上场。');
  assert.equal(doc.tasks.find((task) => task.id === 'task:video:s002:v001')?.fields.duration, 4);
  assert.equal(doc.edges.some((edge) => edge.from.includes('s003') || edge.to.includes('s003')), false);
});

test('readShotScriptText prefers the shot script over generated prompt-like graph text', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001',
    episodeTitle: '第 1 集'
  });
  const shot = {
    id: 'shot:s001',
    shotNo: 's001',
    title: '后台整理胸针',
    summary: '摘要不应该覆盖剧本文本。',
    scriptText: '小邮在后台低头整理蓝色胸针。'
  };
  doc.shots.push(shot);
  doc.nodes.push({
    id: 'node:script:s001',
    type: 'script_segment',
    shotId: 'shot:s001',
    title: 's001 剧本片段',
    metadata: {
      text: '5秒9:16短剧单镜头，Seedance 2.0 / 即梦视频生成。'
    }
  });

  assert.equal(readShotScriptText(doc, shot), '小邮在后台低头整理蓝色胸针。');
});

test('generatePublicAssetsFromScript extracts public asset candidates without splitting shots', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001',
    episodeTitle: '第 1 集'
  });
  doc.scriptDraft = {
    text: [
      '## 主要人物',
      '- 小邮：负责送信的机器人，正在核对路线。',
      '- 奶奶：负责整理包裹的人。',
      '',
      '## 正式剧本',
      '场景一｜小学音乐教室',
      '画面：小邮在音乐教室清点旧钢琴旁的道具，奶奶将蓝色胸针和校服装入书包。',
      '场景二｜学校楼梯间',
      '动作：小灯在楼梯间核对节目单，小邮等待下一件包裹。',
      '场景三｜城市商业区大屏下',
      '画面：小邮经过商业区大屏，将装有练声本的书包交给收件人。'
    ].join('\n'),
    updatedAt: '2026-06-26T08:00:00.000Z'
  };

  const result = generatePublicAssetsFromScript(doc, { now: '2026-06-26T08:00:00.000Z' });
  const titlesByCategory = new Map(doc.publicAssets.map((asset) => [`${asset.category}:${asset.title}`, asset]));

  assert.equal(doc.shots.length, 0);
  assert.equal(result.createdCount >= 6, true);
  assert.ok(titlesByCategory.get('characters:小邮'));
  assert.ok(titlesByCategory.get('characters:奶奶'));
  assert.equal(titlesByCategory.has('characters:站在旧'), false);
  assert.equal(titlesByCategory.has('characters:从楼梯间'), false);
  assert.equal(titlesByCategory.has('characters:小学音乐教室'), false);
  assert.equal(titlesByCategory.has('characters:蓝色胸针'), false);
  assert.ok(titlesByCategory.get('locations:小学音乐教室'));
  assert.ok(titlesByCategory.get('locations:城市商业区大屏'));
  assert.ok(titlesByCategory.get('props:胸针'));
  assert.ok(titlesByCategory.get('props:节目单'));
  for (const asset of doc.publicAssets) {
    assert.ok(asset.prompt, `${asset.title} should carry an editable generation prompt`);
    assert.equal(Array.isArray(asset.referenceAssets), true, `${asset.title} should expose reference assets`);
  }
  assert.equal(doc.workflow.currentStep, 'script_shots');
});

test('normalizeShotScriptTexts backfills legacy shots from video prompts', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001',
    episodeTitle: '第 1 集'
  });
  doc.shots.push({
    id: 'shot:s002',
    shotNo: 's002',
    title: '权限被收回',
    summary: '权限被收回',
    status: 'draft',
    durationSec: 10
  });
  doc.nodes.push({
    id: 'node:script:s002',
    type: 'script_segment',
    title: 's002 权限被收回',
    shotId: 'shot:s002',
    status: 'draft',
    metadata: {}
  });
  doc.nodes.push({
    id: 'node:prompt:video:s002:v001',
    type: 'video_prompt',
    title: 's002 权限被收回 视频提示词',
    shotId: 'shot:s002',
    status: 'draft',
    metadata: {
      prompt: '9:16竖屏，10秒。0-3秒：邮局屏幕刷新，地图界面出现一条新路线；3-6秒：信箱连续亮起绿色指示灯；6-8秒：小邮抬起手，指向地图上的终点。镜头语言：Z1大特写。音效：两声系统提示音。禁止：水印。'
    }
  });

  const changed = normalizeShotScriptTexts(doc, { now: '2026-06-13T00:00:00.000Z' });
  const scriptNode = doc.nodes.find((node) => node.type === 'script_segment' && node.shotId === 'shot:s002');

  assert.equal(changed, true);
  assert.match(doc.shots[0].scriptText, /邮局屏幕刷新/);
  assert.match(doc.shots[0].scriptText, /指向地图上的终点/);
  assert.doesNotMatch(doc.shots[0].scriptText, /禁止/);
  assert.equal(scriptNode.metadata.text, doc.shots[0].scriptText);
});

test('normalizeShotScriptTexts repairs local prompt text that polluted shot script fields', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001',
    episodeTitle: '第 1 集'
  });
  const promptLikeText = [
    '5秒9:16短剧单镜头，Seedance 2.0 / 即梦视频生成，电影感但以叙事清晰为第一优先级。',
    '导演判断：前2秒必须给出可理解的信息钩子或视觉动作。',
    '投喂检查：@图片N 前后留空格，进入即梦后必须绑定成真实资源 chip。'
  ].join('\n');
  doc.shots.push({
    id: 'shot:s001',
    shotNo: 's001',
    title: '# 分集剧本草稿',
    summary: '# 分集剧本草稿',
    scriptText: promptLikeText,
    status: 'draft',
    durationSec: 5
  });
  doc.nodes.push({
    id: 'node:script:s001',
    type: 'script_segment',
    title: 's001 剧本片段',
    shotId: 'shot:s001',
    status: 'draft',
    metadata: { text: promptLikeText }
  });
  doc.nodes.push({
    id: 'node:prompt:video:s001:v001',
    type: 'video_prompt',
    title: 's001 视频提示词',
    shotId: 'shot:s001',
    status: 'draft',
    metadata: {
      prompt: promptLikeText,
      promptPolicyVersion: 'drama-creator-prompt-best-practices.v2'
    }
  });

  const changed = normalizeShotScriptTexts(doc, { now: '2026-06-27T03:00:00.000Z' });
  const scriptNode = doc.nodes.find((node) => node.type === 'script_segment' && node.shotId === 'shot:s001');

  assert.equal(changed, true);
  assert.equal(doc.shots[0].scriptText, '# 分集剧本草稿');
  assert.equal(scriptNode.metadata.text, '# 分集剧本草稿');
});

test('normalizeShotScriptTexts restores Chinese draft units over English storyboard prompt pollution', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001',
    episodeTitle: '第 1 集'
  });
  doc.scriptDraft = {
    text: [
      '## 正式剧本',
      '### 场次 1：剧场后台化妆间',
      '- 画面：小邮坐在工作台前，检查送信箱。',
      '- 动作：它低头核对蓝色胸针，随后关好送信箱。'
    ].join('\n'),
    updatedAt: '2026-06-27T10:00:00.000Z'
  };
  const englishPrompt = [
    'Use case: photorealistic-natural',
    'Asset type: storyboard still for an AI short film',
    'Style/medium: photorealistic cinematic still, restrained realism.'
  ].join('\n');
  doc.shots.push({
    id: 'shot:s001',
    shotNo: 's001',
    title: 's001 adult mirror',
    summary: 'Adult Xu Wensheng sits at the makeup mirror in the backstage dressing room.',
    scriptText: englishPrompt,
    status: 'draft',
    durationSec: 5
  });
  doc.nodes.push({
    id: 'node:script:s001',
    type: 'script_segment',
    title: 's001 剧本片段',
    shotId: 'shot:s001',
    status: 'draft',
    metadata: { text: englishPrompt }
  });
  doc.nodes.push({
    id: 'node:prompt:video:s001:v001',
    type: 'video_prompt',
    title: 's001 视频提示词',
    shotId: 'shot:s001',
    status: 'draft',
    metadata: { prompt: englishPrompt }
  });

  const changed = normalizeShotScriptTexts(doc, { now: '2026-06-27T10:00:00.000Z' });
  const scriptNode = doc.nodes.find((node) => node.type === 'script_segment' && node.shotId === 'shot:s001');

  assert.equal(changed, true);
  assert.equal(doc.shots[0].scriptText, '小邮坐在工作台前，检查送信箱。');
  assert.equal(scriptNode.metadata.text, doc.shots[0].scriptText);
  assert.doesNotMatch(doc.shots[0].scriptText, /Use case|Asset type|Style\/medium/);
});
