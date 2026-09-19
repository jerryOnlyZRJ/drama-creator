import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreFeedChecks } from '../src/checks/preFeedChecks.mjs';

test('flags missing referenced nodes and unsafe prompt words', () => {
  const doc = {
    nodes: [
      {
        id: 'node:prompt:video:s001b:v002',
        type: 'video_prompt',
        title: '视频提示词',
        metadata: { prompt: '画面出现弹窗，并显示按钮。' }
      }
    ],
    edges: [
      {
        id: 'edge:missing',
        from: 'node:prompt:video:s001b:v002',
        to: 'node:image:missing',
        type: 'uses_reference'
      }
    ],
    tasks: [
      {
        id: 'task:video:s001b:v002',
        type: 'video',
        fields: { ratio: '9:16', duration: 10 }
      }
    ]
  };

  const checks = runPreFeedChecks(doc);

  // Feed checks must stop unsafe prompt UI terms and broken graph references before users paste packages out.
  assert.equal(checks.some((check) => check.type === 'prompt_safety' && check.status === 'warning'), true);
  assert.equal(checks.some((check) => check.type === 'graph_integrity' && check.status === 'warning'), true);
});

test('allows unsafe UI words when they are negative prompt constraints', () => {
  const checks = runPreFeedChecks({
    nodes: [
      {
        id: 'node:prompt:video:s001b:v001',
        type: 'video_prompt',
        title: '视频提示词',
        metadata: { prompt: '9:16竖屏，禁止弹窗和按钮出现，镜头缓慢推进。' }
      }
    ],
    edges: [],
    tasks: [
      {
        id: 'task:video:s001b:v001',
        type: 'video',
        fields: { ratio: '9:16', duration: 10 }
      }
    ]
  });

  assert.equal(checks.find((check) => check.type === 'prompt_safety').status, 'pass');
});

test('allows narrative AR HUD UI terms used as short-drama visual effects', () => {
  const checks = runPreFeedChecks({
    nodes: [
      {
        id: 'node:prompt:image:s001',
        type: 'image_prompt',
        title: '关键帧提示词',
        metadata: {
          prompt: '一组半透明系统弹窗以 AR/HUD 式浮空 UI 的形式悬浮，弹窗为短剧叙事约定的可视化提示，下方一个灰色按钮。'
        }
      }
    ],
    edges: [],
    tasks: []
  });

  assert.equal(checks.find((check) => check.type === 'prompt_safety').status, 'pass');
});

test('does not treat unrelated words containing negative markers as safe constraints', () => {
  const checks = runPreFeedChecks({
    nodes: [
      {
        id: 'node:prompt:video:s001',
        type: 'video_prompt',
        title: '视频提示词',
        metadata: { prompt: '画面中无数弹窗快速闪烁，无边框弹窗悬浮在空中。' }
      }
    ],
    edges: [],
    tasks: [
      {
        id: 'task:video:s001:v001',
        type: 'video',
        fields: { ratio: '9:16', duration: 10 }
      }
    ]
  });

  const safety = checks.find((check) => check.type === 'prompt_safety');
  assert.equal(safety.status, 'warning');
  assert.equal(safety.items.some((item) => item.label.includes('弹窗')), true);
});

test('allows no-prefixed negative constraints across multiple unsafe UI words', () => {
  const checks = runPreFeedChecks({
    nodes: [
      {
        id: 'node:prompt:video:s001',
        type: 'video_prompt',
        title: '视频提示词',
        metadata: { prompt: '9:16竖屏，无任何弹窗和按钮，无 UI 弹窗和按钮，镜头缓慢推进。' }
      }
    ],
    edges: [],
    tasks: [
      {
        id: 'task:video:s001:v001',
        type: 'video',
        fields: { ratio: '9:16', duration: 10 }
      }
    ]
  });

  assert.equal(checks.find((check) => check.type === 'prompt_safety').status, 'pass');
});

test('allows any whole-second video duration up to the 15 second shot limit', () => {
  const checks = runPreFeedChecks({
    nodes: [],
    edges: [],
    tasks: [3, 4, 6, 8, 15].map((duration) => ({
      id: `task:video:s${duration}:v001`,
      type: 'video',
      fields: { ratio: '16:9', duration }
    }))
  });

  assert.equal(checks.find((check) => check.id === 'check:aspect-duration').status, 'pass');
});

test('flags video durations outside the 15 second shot limit', () => {
  const checks = runPreFeedChecks({
    nodes: [],
    edges: [],
    tasks: [
      { id: 'task:video:s000:v001', type: 'video', fields: { ratio: '16:9', duration: 0 } },
      { id: 'task:video:s016:v001', type: 'video', fields: { ratio: '16:9', duration: 16 } }
    ]
  });

  const durationCheck = checks.find((check) => check.id === 'check:aspect-duration');
  assert.equal(durationCheck.status, 'warning');
  assert.equal(durationCheck.items.length, 2);
});
