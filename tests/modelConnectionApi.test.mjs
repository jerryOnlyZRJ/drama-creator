import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.mjs';

function callApp(app, { method, url, body }) {
  return new Promise((resolve) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = {
      method,
      url,
      [Symbol.asyncIterator]: async function* () { if (buf) yield buf; }
    };
    const res = {
      statusCode: 0,
      setHeader() {},
      end(data) {
        const payload = data || '';
        resolve({ statusCode: res.statusCode, json: payload ? JSON.parse(payload) : null });
      }
    };
    app(req, res);
  });
}

test('POST /api/model-connections/test verifies API key credentials and stores model ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-model-connection-ok-'));
  try {
    const appWorkspaceDir = join(root, '.drama-creator');
    const credentialsFile = join(appWorkspaceDir, 'credentials.json');
    const fakeStore = new Map();
    let captured;
    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      appWorkspaceDir,
      credentialsFile,
      keychain: {
        readSecret: async (acc) => fakeStore.get(acc) || null,
        writeSecret: async (acc, p) => { fakeStore.set(acc, p); },
        deleteSecret: async (acc) => { fakeStore.delete(acc); },
        listAccounts: async () => [...fakeStore.keys()]
      },
      fetch: async (url, init) => {
        captured = { url, headers: init.headers };
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }), { status: 200 });
      }
    });

    const put = await callApp(app, {
      method: 'PUT',
      url: '/api/credentials/openai-compatible-text',
      body: { fields: { apiKey: 'sk-models', endpoint: 'https://api.deepseek.com/v1' } }
    });
    assert.equal(put.statusCode, 200);

    const tested = await callApp(app, {
      method: 'POST',
      url: '/api/model-connections/test',
      body: { adapterId: 'openai-compatible-text' }
    });

    assert.equal(tested.statusCode, 200);
    assert.equal(tested.json.status, 'verified');
    assert.deepEqual(tested.json.modelIds, ['deepseek-chat', 'deepseek-reasoner']);
    assert.equal(captured.url, 'https://api.deepseek.com/v1/models');
    assert.equal(captured.headers.Authorization, 'Bearer sk-models');

    const saved = JSON.parse(await readFile(credentialsFile, 'utf8'));
    assert.equal(saved.credentials[0].publicFields.verification.status, 'verified');
    assert.deepEqual(saved.credentials[0].publicFields.verification.modelIds, ['deepseek-chat', 'deepseek-reasoner']);
    assert.equal(JSON.stringify(saved).includes('sk-models'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/model-connections/test records verification failures without exposing secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-model-connection-fail-'));
  try {
    const appWorkspaceDir = join(root, '.drama-creator');
    const credentialsFile = join(appWorkspaceDir, 'credentials.json');
    const fakeStore = new Map();
    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      appWorkspaceDir,
      credentialsFile,
      keychain: {
        readSecret: async (acc) => fakeStore.get(acc) || null,
        writeSecret: async (acc, p) => { fakeStore.set(acc, p); },
        deleteSecret: async (acc) => { fakeStore.delete(acc); },
        listAccounts: async () => [...fakeStore.keys()]
      },
      fetch: async () => new Response('bad key', { status: 401 })
    });

    await callApp(app, {
      method: 'PUT',
      url: '/api/credentials/openai-compatible-text',
      body: { fields: { apiKey: 'sk-bad', endpoint: 'https://api.openai.com/v1' } }
    });

    const tested = await callApp(app, {
      method: 'POST',
      url: '/api/model-connections/test',
      body: { adapterId: 'openai-compatible-text' }
    });

    assert.equal(tested.statusCode, 200);
    assert.equal(tested.json.status, 'failed');
    assert.match(tested.json.message, /HTTP 401/);

    const saved = JSON.parse(await readFile(credentialsFile, 'utf8'));
    assert.equal(saved.credentials[0].publicFields.verification.status, 'failed');
    assert.equal(JSON.stringify(saved).includes('sk-bad'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/model-connections/test verifies Claude provider through the text API Key channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-model-connection-claude-'));
  try {
    const appWorkspaceDir = join(root, '.drama-creator');
    const credentialsFile = join(appWorkspaceDir, 'credentials.json');
    const fakeStore = new Map();
    let captured;
    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      appWorkspaceDir,
      credentialsFile,
      keychain: {
        readSecret: async (acc) => fakeStore.get(acc) || null,
        writeSecret: async (acc, p) => { fakeStore.set(acc, p); },
        deleteSecret: async (acc) => { fakeStore.delete(acc); },
        listAccounts: async () => [...fakeStore.keys()]
      },
      fetch: async (url, init) => {
        captured = { url, headers: init.headers };
        return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5' }] }), { status: 200 });
      }
    });

    const put = await callApp(app, {
      method: 'PUT',
      url: '/api/credentials/openai-compatible-text',
      body: { fields: { apiKey: 'sk-ant', endpoint: 'https://api.anthropic.com/v1' } }
    });
    assert.equal(put.statusCode, 200);

    const tested = await callApp(app, {
      method: 'POST',
      url: '/api/model-connections/test',
      body: { adapterId: 'openai-compatible-text' }
    });

    assert.equal(tested.statusCode, 200);
    assert.equal(tested.json.status, 'verified');
    assert.deepEqual(tested.json.modelIds, ['claude-sonnet-4-5']);
    assert.equal(captured.url, 'https://api.anthropic.com/v1/models');
    assert.equal(captured.headers['x-api-key'], 'sk-ant');
    assert.equal(captured.headers['anthropic-version'], '2023-06-01');

    const saved = JSON.parse(await readFile(credentialsFile, 'utf8'));
    assert.equal(JSON.stringify(saved).includes('sk-ant'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/model-connections/test rejects missing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-model-connection-missing-'));
  try {
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir: join(root, '.drama-creator') });

    const res = await callApp(app, {
      method: 'POST',
      url: '/api/model-connections/test',
      body: { adapterId: 'openai-compatible-text' }
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json.error, /Configure API Key/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
