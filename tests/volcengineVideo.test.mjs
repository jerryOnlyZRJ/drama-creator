import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manifest, generate, poll } from '../src/adapters/volcengine-ark-video/index.mjs';

test('Volcengine Ark video manifest declares Seedance video capability', () => {
  assert.equal(manifest.id, 'volcengine-ark-video');
  assert.equal(manifest.async, true);
  const videoCapability = manifest.capabilities.find((item) => item.type === 'video');
  assert.ok(videoCapability);
  assert.ok(videoCapability.models.some((item) => item.id.includes('seedance')));
});

test('Volcengine Ark video generate submits a content generation task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-volc-video-'));
  try {
    const fakeFetch = async (url, options) => {
      assert.equal(String(url), 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'doubao-seedance-2-0-fast-260128');
      assert.ok(body.content.some((item) => item.type === 'text' && item.text.includes('--duration 5')));
      return new Response(JSON.stringify({ id: 'ark-task-1' }), { status: 200 });
    };
    const result = await generate({
      capability: 'video',
      model: 'doubao-seedance-2-0-fast-260128',
      prompt: '办公室夜戏',
      references: [],
      outputDir: dir,
      params: { duration: 5, resolution: '720p', cameraFixed: false },
      credential: { apiKey: 'sk', endpoint: 'https://ark.cn-beijing.volces.com/api/v3' }
    }, { fetch: fakeFetch });

    assert.equal(result.status, 'generating');
    assert.equal(result.externalJobId, 'ark-task-1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Volcengine Ark video poll downloads the finished video URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-volc-poll-'));
  try {
    const fakeFetch = async (url) => {
      const textUrl = String(url);
      if (textUrl.endsWith('/contents/generations/tasks/ark-task-1')) {
        return new Response(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://cdn.example.com/ark.mp4' } }), { status: 200 });
      }
      return new Response(Buffer.from([0, 0, 0, 0x18]), { status: 200 });
    };
    const result = await poll({
      externalJobId: 'ark-task-1',
      outputDir: dir,
      credential: { apiKey: 'sk', endpoint: 'https://ark.cn-beijing.volces.com/api/v3' }
    }, { fetch: fakeFetch });

    assert.equal(result.status, 'completed');
    assert.equal(result.outputs[0].kind, 'video');
    assert.match(result.outputs[0].path, /^raw-videos\/video_/);
    const bytes = await readFile(join(dir, result.outputs[0].path.replace(/^raw-videos\//, '')));
    assert.equal(bytes[3], 0x18);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
