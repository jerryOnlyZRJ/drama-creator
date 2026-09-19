// HTTP-level coverage for the four credential routes added in Phase 2 Task 6:
//   GET    /api/adapters
//   GET    /api/credentials?episodePath=...
//   PUT    /api/credentials/<adapterId>
//   DELETE /api/credentials/<adapterId>
//
// All keychain IO is mocked via the createApp({ keychain }) injection seam so the
// tests never touch the real OS keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.mjs';

// Minimal request helper hitting the app function directly without binding a real socket.
// readJsonBody uses `for await (const chunk of req)` so the fake req must be async-iterable.
function callApp(app, { method, url, body }) {
  return new Promise((resolve) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = {
      method,
      url,
      [Symbol.asyncIterator]: async function* () { if (buf) yield buf; }
    };
    let statusCode = 0;
    let payload = '';
    const res = {
      statusCode: 0,
      setHeader() {},
      end(data) {
        statusCode = res.statusCode;
        payload = data || '';
        resolve({ statusCode, json: payload ? JSON.parse(payload) : null });
      }
    };
    app(req, res);
  });
}

// Bare-minimum drama-creator.json document satisfying the structural contract used by
// loadEpisodeDoc + downstream handlers.
function emptyDoc(id, path) {
  return {
    schemaVersion: '0.1.0',
    config: {},
    project: {},
    episode: { id, path },
    adapters: [],
    credentials: [],
    jobs: [],
    nodes: [],
    edges: [],
    tasks: [],
    shots: [],
    checks: [],
    activityLog: []
  };
}

test('GET /api/adapters lists builtin adapters with manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-cred-api-'));
  try {
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir: join(root, '.drama-creator') });
    const res = await callApp(app, { method: 'GET', url: '/api/adapters' });
    assert.equal(res.statusCode, 200);
    const ids = res.json.adapters.map((a) => a.id).sort();
    assert.equal(ids.includes('mock-echo'), true);
    assert.equal(ids.includes('openai-compatible-text'), true);
    assert.equal(ids.includes('openai-compatible-image'), true);
    const text = res.json.adapters.find((item) => item.id === 'openai-compatible-text');
    assert.equal(text.productionMode, 'in_app');
    assert.equal(text.execution.type, 'api');
    assert.ok(text.templates.some((item) => item.id === 'deepseek' && item.apiKeyUrl));
    assert.ok(text.templates.some((item) => item.id === 'anthropic' && item.apiKeyUrl));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PUT /api/credentials/<id> writes secret to keychain and public to document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-cred-put-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(epDir, { recursive: true });
    await writeFile(join(epDir, 'drama-creator.json'), JSON.stringify(emptyDoc('ep001', epDir)));

    // In-memory keychain backing store mimics the createKeychain return shape.
    const fakeStore = new Map();
    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      keychain: {
        readSecret: async (acc) => fakeStore.get(acc) || null,
        writeSecret: async (acc, p) => { fakeStore.set(acc, p); },
        deleteSecret: async (acc) => { fakeStore.delete(acc); },
        listAccounts: async () => [...fakeStore.keys()]
      }
    });
    const res = await callApp(app, {
      method: 'PUT',
      url: '/api/credentials/openai-compatible-text',
      body: { episodePath: epDir, fields: { apiKey: 'sk-test', endpoint: 'https://api.deepseek.com/v1' } }
    });
    assert.equal(res.statusCode, 200);
    // Secret material lives in the keychain; only its presence is asserted here.
    assert.match(fakeStore.get('drama-creator:openai-compatible-text'), /sk-test/);
    const doc = JSON.parse(await readFile(join(epDir, 'drama-creator.json'), 'utf8'));
    const cred = doc.credentials.find((c) => c.adapterId === 'openai-compatible-text');
    assert.deepEqual(cred.secretFieldKeys, ['apiKey']);
    assert.deepEqual(cred.publicFields, { endpoint: 'https://api.deepseek.com/v1' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DELETE /api/credentials/<id> removes both keychain and document entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-cred-del-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(epDir, { recursive: true });
    const initialDoc = emptyDoc('ep001', epDir);
    initialDoc.credentials.push({
      ref: 'credential:openai-compatible-text',
      adapterId: 'openai-compatible-text',
      method: 'api_key',
      keychainAccount: 'drama-creator:openai-compatible-text',
      secretFieldKeys: ['apiKey'],
      publicFields: {},
      updatedAt: 'x'
    });
    await writeFile(join(epDir, 'drama-creator.json'), JSON.stringify(initialDoc));

    const fakeStore = new Map([['drama-creator:openai-compatible-text', '{"apiKey":"sk-x"}']]);
    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      keychain: {
        readSecret: async (acc) => fakeStore.get(acc) || null,
        writeSecret: async (acc, p) => { fakeStore.set(acc, p); },
        deleteSecret: async (acc) => { fakeStore.delete(acc); },
        listAccounts: async () => [...fakeStore.keys()]
      }
    });
    const res = await callApp(app, {
      method: 'DELETE',
      url: '/api/credentials/openai-compatible-text',
      body: { episodePath: epDir }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(fakeStore.has('drama-creator:openai-compatible-text'), false);
    const doc = JSON.parse(await readFile(join(epDir, 'drama-creator.json'), 'utf8'));
    assert.equal(doc.credentials.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/credentials lists configured adapters with public fields only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-cred-list-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(epDir, { recursive: true });
    const initialDoc = emptyDoc('ep001', epDir);
    initialDoc.credentials.push({
      ref: 'credential:x',
      adapterId: 'openai-compatible-text',
      method: 'api_key',
      keychainAccount: 'drama-creator:openai-compatible-text',
      secretFieldKeys: ['apiKey'],
      publicFields: { endpoint: 'https://api.openai.com/v1' },
      updatedAt: 'x'
    });
    await writeFile(join(epDir, 'drama-creator.json'), JSON.stringify(initialDoc));

    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir: join(root, '.drama-creator') });
    const res = await callApp(app, { method: 'GET', url: `/api/credentials?episodePath=${encodeURIComponent(epDir)}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.credentials.length, 1);
    assert.equal(res.json.credentials[0].adapterId, 'openai-compatible-text');
    assert.deepEqual(res.json.credentials[0].publicFields, { endpoint: 'https://api.openai.com/v1' });
    // Secret values must NEVER leak into the response payload.
    assert.equal('apiKey' in (res.json.credentials[0].publicFields || {}), false);
    assert.equal(JSON.stringify(res.json).includes('sk-'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/credentials marks credential refs whose keychain secret is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-cred-list-stale-'));
  try {
    const appWorkspaceDir = join(root, '.drama-creator');
    const credentialsFile = join(appWorkspaceDir, 'credentials.json');
    await mkdir(appWorkspaceDir, { recursive: true });
    await writeFile(credentialsFile, JSON.stringify({
      credentials: [{
        ref: 'credential:openai-compatible-text',
        adapterId: 'openai-compatible-text',
        method: 'api_key',
        keychainAccount: 'drama-creator:openai-compatible-text',
        secretFieldKeys: ['apiKey'],
        publicFields: { endpoint: 'https://api.deepseek.com/v1' },
        updatedAt: 'x'
      }]
    }));
    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      appWorkspaceDir,
      credentialsFile,
      keychain: {
        readSecret: async () => null,
        writeSecret: async () => {},
        deleteSecret: async () => {},
        listAccounts: async () => []
      }
    });

    const res = await callApp(app, { method: 'GET', url: '/api/credentials' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.credentials[0].adapterId, 'openai-compatible-text');
    assert.equal(res.json.credentials[0].secretStatus, 'missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('global credentials do not require an episodePath and are stored under the app workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-cred-global-'));
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
      }
    });

    const put = await callApp(app, {
      method: 'PUT',
      url: '/api/credentials/openai-compatible-text',
      body: { fields: { apiKey: 'sk-global', endpoint: 'https://api.openai.com/v1' } }
    });
    assert.equal(put.statusCode, 200);
    assert.match(fakeStore.get('drama-creator:openai-compatible-text'), /sk-global/);

    const saved = JSON.parse(await readFile(credentialsFile, 'utf8'));
    assert.equal(saved.credentials[0].adapterId, 'openai-compatible-text');
    assert.deepEqual(saved.credentials[0].publicFields, { endpoint: 'https://api.openai.com/v1' });
    assert.equal(JSON.stringify(saved).includes('sk-global'), false);

    const list = await callApp(app, { method: 'GET', url: '/api/credentials' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json.credentials.length, 1);
    assert.equal(list.json.credentials[0].adapterId, 'openai-compatible-text');

    const del = await callApp(app, {
      method: 'DELETE',
      url: '/api/credentials/openai-compatible-text',
      body: {}
    });
    assert.equal(del.statusCode, 200);
    assert.equal(fakeStore.has('drama-creator:openai-compatible-text'), false);
    const afterDelete = JSON.parse(await readFile(credentialsFile, 'utf8'));
    assert.deepEqual(afterDelete.credentials, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
