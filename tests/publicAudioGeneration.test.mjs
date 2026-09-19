// 公开测试使用虚构示例文本，保留解析与工作流断言，不承载作者作品。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePublicAudioGenerationTask } from '../src/workflow/publicAudioGeneration.mjs';

function fixtureDoc() {
  return {
    nodes: [],
    tasks: [],
    activityLog: [],
    publicAssets: [
      {
        id: 'public:voice-char-xwsboy-v001',
        title: '小邮（12岁）角色音色参考',
        category: 'voices',
        kind: 'audio',
        status: 'pending',
        prompt: '12 岁男孩，声线清亮、克制，不朗诵。',
        spokenText: '奶奶，我知道了。我会认真练习。',
        voiceName: '阳光小男孩',
        outputTarget: 'scripts/assets/voices/references/char_xwsboy_voice_v001_jimeng.m4a'
      }
    ]
  };
}

test('public voice asset becomes one reusable audio prompt and task', () => {
  const doc = fixtureDoc();
  const result = ensurePublicAudioGenerationTask(doc, 'public:voice-char-xwsboy-v001', {
    now: '2026-07-10T07:00:00.000Z'
  });

  assert.equal(result.taskId, 'task:audio:voice-char-xwsboy-v001:v001');
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.nodes[0].type, 'audio_prompt');
  assert.equal(doc.nodes[0].metadata.spokenText, '奶奶，我知道了。我会认真练习。');
  assert.equal(doc.nodes[0].metadata.prompt, '12 岁男孩，声线清亮、克制，不朗诵。');
  assert.equal(doc.tasks.length, 1);
  assert.equal(doc.tasks[0].type, 'audio');
  assert.equal(doc.tasks[0].status, 'ready_to_feed');
  assert.equal(doc.tasks[0].fields.voiceName, '阳光小男孩');
  assert.equal(doc.publicAssets[0].metadata.generationTaskId, result.taskId);
  assert.equal(doc.activityLog.at(-1).type, 'audio_feed_prepared');

  ensurePublicAudioGenerationTask(doc, 'public:voice-char-xwsboy-v001', {
    now: '2026-07-10T07:05:00.000Z'
  });
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.tasks.length, 1);
});

test('public audio generation rejects mixed scene samples and incomplete voice records', () => {
  const doc = fixtureDoc();
  doc.publicAssets[0].category = 'audio_refs';
  assert.throws(
    () => ensurePublicAudioGenerationTask(doc, 'public:voice-char-xwsboy-v001'),
    /音色参考/
  );

  doc.publicAssets[0].category = 'voices';
  doc.publicAssets[0].spokenText = '';
  assert.throws(
    () => ensurePublicAudioGenerationTask(doc, 'public:voice-char-xwsboy-v001'),
    /试听台词/
  );
});
