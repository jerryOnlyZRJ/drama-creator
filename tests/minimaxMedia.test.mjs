import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manifest, generate, poll } from '../src/adapters/minimax-media/index.mjs';

test('MiniMax media manifest supports both image and video generation', () => {
  assert.equal(manifest.id, 'minimax-media');
  assert.equal(manifest.kind, 'builtin');
  assert.equal(manifest.async, true);
  assert.ok(manifest.capabilities.some((item) => item.type === 'image'));
  assert.ok(manifest.capabilities.some((item) => item.type === 'video'));
});

test('MiniMax image generation downloads the returned image URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-minimax-img-'));
  try {
    const fakeFetch = async (url, options) => {
      if (String(url).endsWith('/image_generation')) {
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'image-01');
        assert.equal(body.prompt, '电影感关键帧');
        return new Response(JSON.stringify({ data: { image_urls: ['https://cdn.example.com/minimax.png'] } }), { status: 200 });
      }
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200 });
    };
    const result = await generate({
      capability: 'image',
      model: 'image-01',
      prompt: '电影感关键帧',
      references: [],
      outputDir: dir,
      params: {},
      credential: { apiKey: 'sk', endpoint: 'https://api.minimax.io/v1' }
    }, { fetch: fakeFetch });

    assert.equal(result.status, 'completed');
    assert.equal(result.outputs[0].kind, 'image');
    assert.match(result.outputs[0].path, /^raw-videos\/image_/);
    const bytes = await readFile(join(dir, result.outputs[0].path.replace(/^raw-videos\//, '')));
    assert.equal(bytes[0], 0x89);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MiniMax video generation returns an async task id and poll downloads the completed video', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-minimax-video-'));
  try {
    const fakeFetch = async (url, options = {}) => {
      const textUrl = String(url);
      if (textUrl.endsWith('/video_generation')) {
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'MiniMax-Hailuo-2.3');
        return new Response(JSON.stringify({ task_id: 'task-123' }), { status: 200 });
      }
      if (textUrl.includes('/query/video_generation')) {
        return new Response(JSON.stringify({ status: 'Success', file_id: 'file-456', video_url: 'https://cdn.example.com/out.mp4' }), { status: 200 });
      }
      return new Response(Buffer.from([0, 0, 0, 0x18]), { status: 200 });
    };

    const generating = await generate({
      capability: 'video',
      model: 'MiniMax-Hailuo-2.3',
      prompt: '5 秒短剧片段',
      references: [],
      outputDir: dir,
      params: { duration: 5 },
      credential: { apiKey: 'sk', endpoint: 'https://api.minimax.io/v1' }
    }, { fetch: fakeFetch });
    assert.equal(generating.status, 'generating');
    assert.equal(generating.externalJobId, 'task-123');

    const completed = await poll({
      externalJobId: 'task-123',
      outputDir: dir,
      credential: { apiKey: 'sk', endpoint: 'https://api.minimax.io/v1' }
    }, { fetch: fakeFetch });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.outputs[0].kind, 'video');
    assert.match(completed.outputs[0].path, /^raw-videos\/video_/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
