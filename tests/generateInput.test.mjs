import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerateInput } from '../src/feed/generateInput.mjs';

function fixtureDoc() {
  return {
    nodes: [
      { id: 'node:prompt:video:s001:v001', type: 'video_prompt', shotId: 'shot:s001', title: 'p', metadata: { prompt: '竖屏5秒' } },
      { id: 'node:image:char-a', type: 'image_asset', path: 'images/char_a.png', metadata: { role: 'character_ref' } },
      { id: 'node:audio:voice-a', type: 'audio_asset', path: 'audio/voice_a.wav' }
    ],
    edges: [
      { id: 'e1', from: 'node:prompt:video:s001:v001', to: 'node:image:char-a', type: 'uses_reference', role: 'character_ref' },
      { id: 'e2', from: 'node:prompt:video:s001:v001', to: 'node:audio:voice-a', type: 'script_uses_asset', role: 'voice_reference' }
    ],
    tasks: [
      { id: 'task:video:s001:v001', shotId: 'shot:s001', type: 'video', promptNodeId: 'node:prompt:video:s001:v001', outputNodeIds: [], fields: {} }
    ]
  };
}

const adapterRef = {
  manifest: {
    capabilities: [{ type: 'video', models: [{ id: 'm1', params: { duration: { type: 'number', default: 5 }, ratio: { type: 'enum', default: '9:16' } } }] }]
  }
};

test('builds generate input with prompt, references, merged params and outputDir', () => {
  const input = buildGenerateInput(fixtureDoc(), 'task:video:s001:v001', adapterRef, {
    capability: 'video', model: 'm1', outputDir: '/abs/ep/raw-videos', userParams: { duration: 8 }
  });

  assert.equal(input.action, 'generate');
  assert.equal(input.capability, 'video');
  assert.equal(input.model, 'm1');
  assert.equal(input.prompt, '竖屏5秒');
  assert.equal(input.outputDir, '/abs/ep/raw-videos');
  assert.deepEqual(input.params, { duration: 8, ratio: '9:16' });
  assert.deepEqual(input.references.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'audio/voice_a.wav', role: 'voice_reference', kind: 'audio' },
    { path: 'images/char_a.png', role: 'character_ref', kind: 'image' }
  ]);
});

test('throws when task not found', () => {
  assert.throws(() => buildGenerateInput(fixtureDoc(), 'task:missing', adapterRef, { capability: 'video', model: 'm1', outputDir: '/x' }), /task not found/i);
});

test('throws when model not declared by adapter', () => {
  assert.throws(() => buildGenerateInput(fixtureDoc(), 'task:video:s001:v001', adapterRef, { capability: 'video', model: 'nope', outputDir: '/x' }), /model not found/i);
});

test('throws when capability not found in adapter', () => {
  assert.throws(
    () => buildGenerateInput(fixtureDoc(), 'task:video:s001:v001', adapterRef, { capability: 'image', model: 'm1', outputDir: '/x' }),
    /capability not found/i
  );
});

test('acceptsAnyModel passes through arbitrary model id and inherits first model defaults', () => {
  // OpenAI 兼容类适配器的回归用例：用户传入 manifest 中没有声明的 model id
  // （例如 deepseek-chat、glm-4-plus），应直接透传给下游 API，
  // 同时复用首个声明 model 的参数默认值作为模板。
  const flexibleRef = {
    manifest: {
      capabilities: [{
        type: 'text_prompt',
        acceptsAnyModel: true,
        models: [{ id: 'gpt-4o-mini', params: { temperature: { type: 'number', default: 0.7 }, maxTokens: { type: 'number', default: 1024 } } }]
      }]
    }
  };
  const input = buildGenerateInput(fixtureDoc(), 'task:video:s001:v001', flexibleRef, {
    capability: 'text_prompt', model: 'deepseek-chat', outputDir: '/abs/ep/raw-videos', userParams: { temperature: 0.3 }
  });
  // model id 原样透传，便于下游 chat completions 调用。
  assert.equal(input.model, 'deepseek-chat');
  // userParams 覆盖默认值，未显式传入的字段使用默认。
  assert.deepEqual(input.params, { temperature: 0.3, maxTokens: 1024 });
});
