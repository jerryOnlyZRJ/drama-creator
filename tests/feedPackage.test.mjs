import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedPackagePreviewResult } from '../src/feed/feedPackage.mjs';

test('blocks feed package preview when pre-feed checks produce warnings', () => {
  const result = createFeedPackagePreviewResult({
    nodes: [
      {
        id: 'node:prompt:video:s001b:v002',
        type: 'video_prompt',
        title: '视频提示词',
        metadata: { prompt: '画面出现弹窗，并显示按钮。' }
      }
    ],
    edges: [],
    tasks: []
  });

  assert.equal(result.blocked, true);
  assert.match(result.message, /投喂包检查未通过/);
  assert.match(result.message, /prompt_safety/);
  assert.doesNotMatch(result.message, /【视频提示词】/);
});

test('returns plain-text feed package preview when pre-feed checks pass', () => {
  const result = createFeedPackagePreviewResult({
    nodes: [
      {
        id: 'node:prompt:video:s001b:v002',
        type: 'video_prompt',
        title: '视频提示词',
        metadata: { prompt: '镜头缓慢推进，母亲整理旧相册。' }
      }
    ],
    edges: [],
    tasks: [
      {
        id: 'task:video:s001b:v002',
        type: 'video',
        fields: { ratio: '9:16', duration: 10 }
      }
    ]
  });

  assert.equal(result.blocked, false);
  assert.match(result.message, /【视频提示词】视频提示词/);
  assert.match(result.message, /镜头缓慢推进/);
});

test('blocks feed package preview when persisted asset integrity checks warn', () => {
  const result = createFeedPackagePreviewResult({
    nodes: [
      {
        id: 'node:prompt:video:s001b:v002',
        type: 'video_prompt',
        title: '视频提示词',
        metadata: { prompt: '镜头缓慢推进，母亲整理旧相册。' }
      }
    ],
    edges: [],
    tasks: [
      {
        id: 'task:video:s001b:v002',
        type: 'video',
        fields: { ratio: '9:16', duration: 10 }
      }
    ],
    checks: [
      {
        id: 'check:asset:integrity',
        type: 'asset_integrity',
        status: 'warning',
        items: [{ label: '缺少参考图 PROP-PHOTO-01', status: 'warning' }]
      }
    ]
  });

  assert.equal(result.blocked, true);
  assert.match(result.message, /asset_integrity/);
  assert.match(result.message, /缺少参考图/);
  assert.doesNotMatch(result.message, /【视频提示词】/);
});
