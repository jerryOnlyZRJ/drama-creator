import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest, generate } from '../src/adapters/openai-compatible-image/index.mjs';

test('manifest declares image capability and templates', () => {
  assert.equal(manifest.id, 'openai-compatible-image');
  const imageCapability = manifest.capabilities.find((c) => c.type === 'image');
  assert.ok(imageCapability);
  assert.equal(imageCapability.models[0].id, 'gpt-image-2');
  assert.equal(manifest.templates.find((item) => item.id === 'openai').apiKeyUrl, 'https://platform.openai.com/api-keys');
  assert.equal(manifest.templates.find((item) => item.id === 'volcengine-ark').defaultModelId, 'doubao-seedream-4-0-250828');
});

test('generate downloads remote image to outputDir and returns completed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-img-'));
  try {
    const fakeBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
    const fakeFetch = async (url) => {
      if (url.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.com/x.png' }] }), { status: 200 });
      }
      return new Response(fakeBytes, { status: 200 });
    };
    const result = await generate({
      action: 'generate', capability: 'image', model: 'gpt-image-1',
      prompt: 'a cat', references: [], outputDir: dir, params: { size: '1024x1024' },
      credential: { apiKey: 'sk', endpoint: 'https://api.openai.com/v1' }
    }, { fetch: fakeFetch });
    assert.equal(result.status, 'completed');
    assert.equal(result.outputs.length, 1);
    assert.match(result.outputs[0].path, /^raw-videos\//);
    const fileBytes = await readFile(join(dir, result.outputs[0].path.replace(/^raw-videos\//, '')));
    assert.equal(fileBytes[0], 0x89);  // PNG header preserved
    assert.equal(result.outputs[0].kind, 'image');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generate maps 401 to auth_failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-img-401-'));
  try {
    const fakeFetch = async () => new Response('', { status: 401 });
    const result = await generate({
      action: 'generate', capability: 'image', model: 'gpt-image-1',
      prompt: 'x', references: [], outputDir: dir, params: {},
      credential: { apiKey: 'bad', endpoint: 'https://api.openai.com/v1' }
    }, { fetch: fakeFetch });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'auth_failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
