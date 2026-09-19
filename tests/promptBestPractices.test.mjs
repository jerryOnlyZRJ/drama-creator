import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_BEST_PRACTICES_VERSION,
  buildPromptBestPracticeContext,
  buildPromptGuidanceSummary,
  createBestPracticeVideoPrompt
} from '../src/prompting/bestPractices.mjs';
import { applyStoryboardSplit } from '../src/workflow/scriptShots.mjs';
import { buildGenerateInput } from '../src/feed/generateInput.mjs';

test('prompt best practices are built into the app instead of reading local agent skill paths', () => {
  const text = buildPromptBestPracticeContext({ capability: 'text_prompt' });
  const video = buildPromptBestPracticeContext({ capability: 'video' });

  assert.equal(text.version, PROMPT_BEST_PRACTICES_VERSION);
  assert.match(text.systemPrompt, /故事源.*剧本草稿.*分镜拆分/);
  assert.match(text.systemPrompt, /非技术用户/);
  assert.match(video.systemPrompt, /Seedance\/即梦/);
  assert.match(video.systemPrompt, /15 秒内单镜头/);
  assert.match(video.checklist.join('\n'), /@图片1/);
  assert.equal(video.source, 'app_builtin');
  assert.equal(video.runtimePolicy.readsLocalAgentSkills, false);
  assert.doesNotMatch(video.systemPrompt, /\.agents\/skills|short-drama\/SKILL|seedance2\.0-prompt/u);
});

test('built-in prompt guidance distills short-drama and Seedance production rules', () => {
  const video = buildPromptBestPracticeContext({ capability: 'video' });
  const summary = buildPromptGuidanceSummary({ capability: 'video' });

  assert.deepEqual(video.productionFlow, [
    '故事源',
    '剧本草稿',
    '分镜拆分',
    '资产依赖矩阵',
    '公共资产库',
    '分镜参考资源',
    '即梦投喂包',
    '分镜视频',
    '质检',
    '成片导出'
  ]);
  assert.match(video.systemPrompt, /空间调度表/);
  assert.match(video.systemPrompt, /前 ?2 ?秒/);
  assert.match(video.systemPrompt, /资源 chip/);
  assert.match(video.systemPrompt, /抽象词/);
  assert.match(video.systemPrompt, /可见角色对白.*无法.*后期配音.*Seedance 2\.0/);
  assert.match(video.systemPrompt, /BGM.*后期/);
  assert.match(video.systemPrompt, /Seedance 2\.0 mini.*快速/);
  assert.equal(summary.source, 'app_builtin');
  assert.equal(summary.runtimePolicy.readsLocalAgentSkills, false);
  assert.ok(summary.principles.some((item) => /导演判断/.test(item)));
  assert.ok(summary.principles.some((item) => /提示词污染/.test(item)));
});

test('storyboard split uses Seedance-ready prompt structure for each generated shot', () => {
  const doc = {
    schemaVersion: '0.1.0',
    config: { defaultRatio: '9:16' },
    project: { name: 'demo' },
    episode: { id: 'ep001', path: '/tmp/ep001' },
    workflow: { steps: [] },
    shots: [],
    nodes: [],
    edges: [],
    tasks: [],
    activityLog: []
  };

  applyStoryboardSplit(doc, {
    scriptText: '主角发现权限被系统收回。',
    now: '2026-06-13T00:00:00.000Z'
  });

  const promptNode = doc.nodes.find((node) => node.type === 'video_prompt');
  assert.equal(promptNode.metadata.promptPolicyVersion, PROMPT_BEST_PRACTICES_VERSION);
  assert.match(promptNode.metadata.prompt, /即梦视频生成/);
  // 模型由投喂包根据任务风险选择，提示词不能把音色锁定任务重新拉回 mini。
  assert.doesNotMatch(promptNode.metadata.prompt, /Seedance 2\.0 mini/);
  assert.match(promptNode.metadata.prompt, /镜头功能/);
  assert.match(promptNode.metadata.prompt, /0-\d+秒/);
  assert.match(promptNode.metadata.prompt, /稳定性锁/);
  assert.match(promptNode.metadata.prompt, /窄化约束：禁止任何背景音乐、配乐、BGM、音乐卡点、字幕、LOGO或水印/);
  assert.doesNotMatch(promptNode.metadata.prompt, /禁止角色变脸|空间跳变|穿模|过度夸张表情/);
});

test('generate input carries system prompt and structured guidance for AI calls', () => {
  const doc = {
    nodes: [
      { id: 'node:prompt:video:s001:v001', type: 'video_prompt', shotId: 'shot:s001', title: 'p', metadata: { prompt: '改写这个提示词' } }
    ],
    edges: [],
    tasks: [
      { id: 'task:video:s001:v001', shotId: 'shot:s001', type: 'video', promptNodeId: 'node:prompt:video:s001:v001', outputNodeIds: [], fields: {} }
    ]
  };
  const adapterRef = {
    manifest: {
      capabilities: [{
        type: 'text_prompt',
        acceptsAnyModel: true,
        models: [{ id: 'gpt-4o-mini', params: {} }]
      }]
    }
  };

  const input = buildGenerateInput(doc, 'task:video:s001:v001', adapterRef, {
    capability: 'text_prompt',
    model: 'deepseek-chat',
    outputDir: '/tmp/out'
  });
  const guidance = buildPromptGuidanceSummary({ capability: 'text_prompt' });

  assert.match(input.systemPrompt, /Drama Creator 内置/);
  assert.match(input.systemPrompt, /故事源/);
  assert.deepEqual(input.promptGuidance, guidance);
});

test('best-practice video prompt keeps single-shot duration under Seedance limits', () => {
  const prompt = createBestPracticeVideoPrompt('女儿把通知放到餐桌上', { ratio: '16:9', duration: 30, referencePlaceholders: ['@图片1', '@图片2'] });

  assert.match(prompt, /^15秒16:9短剧单镜头/);
  assert.match(prompt, /导演判断/);
  assert.match(prompt, /参考资源：@图片1、@图片2/);
  assert.match(prompt, /0-\d+秒/);
  assert.match(prompt, /前2秒/);
  assert.match(prompt, /稳定性锁/);
  assert.match(prompt, /窄化约束：禁止任何背景音乐、配乐、BGM、音乐卡点、字幕、LOGO或水印/);
  assert.doesNotMatch(prompt, /Seedance 2\.0 mini/);
  assert.doesNotMatch(prompt, /禁止角色变脸|空间跳变|穿模|过度夸张表情/);
});
