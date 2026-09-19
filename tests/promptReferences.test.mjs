import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPromptReferences,
  formatPromptDisplayText,
  referenceDisplayName,
  referenceMentionName
} from '../src/workflow/promptReferences.mjs';

test('prompt reference display keeps raw placeholders stable but shows readable resource mentions', () => {
  const nodes = [
    { id: 'node:prompt:video:s001:v001', type: 'video_prompt', shotId: 'shot:s001' },
    {
      id: 'node:image:s001:tail',
      type: 'image_asset',
      title: 's001 视频尾帧',
      shotId: 'shot:s001',
      path: 'assets/images/s001-tail.png'
    },
    {
      id: 'node:image:scene:office',
      type: 'image_asset',
      title: '开放办公区',
      shotId: null,
      path: 'assets/images/office.png'
    }
  ];
  const edges = [
    { id: 'edge:ref:tail', from: 'node:prompt:video:s001:v001', to: 'node:image:s001:tail', type: 'uses_reference' },
    { id: 'edge:ref:old', from: 'node:prompt:video:s001:v001', to: 'node:image:old', type: 'uses_reference', status: 'inactive' },
    { id: 'edge:ref:office', from: 'node:prompt:video:s001:v001', to: 'node:image:scene:office', type: 'uses_reference' }
  ];

  const references = buildPromptReferences({ nodes, edges, promptId: 'node:prompt:video:s001:v001' });
  const rawPrompt = '参考 @图片1 的尾帧接续，参考 @图片2 的办公空间。';
  const displayText = formatPromptDisplayText(rawPrompt, references);

  assert.equal(rawPrompt, '参考 @图片1 的尾帧接续，参考 @图片2 的办公空间。');
  assert.equal(displayText, '参考 @镜头 s001 的尾帧接续，参考 @开放办公区 的办公空间。');
  assert.deepEqual(references.map((reference) => reference.placeholder), ['@图片1', '@图片2']);
});

test('shot-local references show shot number first and keep asset title in the upload list', () => {
  const shotLocalAsset = {
    id: 'node:image:s004:tail',
    type: 'image_asset',
    title: 's04 视频尾帧',
    shotId: 'shot:s004'
  };

  assert.equal(referenceMentionName(shotLocalAsset, 0), '镜头 s004');
  assert.equal(referenceDisplayName(shotLocalAsset, 0), '镜头 s004 · s04 视频尾帧');
});
