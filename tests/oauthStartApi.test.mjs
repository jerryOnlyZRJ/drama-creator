// Phase 3 Task 5：覆盖 POST /api/credentials/oauth/start + GET /api/credentials/oauth/status
// 路由的核心分支。所有测试通过 createApp 的 startCallbackServer DI 注入 fake，避免真实
// 监听 1455 端口；fetch 同样可注入，token 端点不会被实际调用（fake callback server 不 resolve）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.mjs';

// 与 credentialApi.test.mjs 共用的最小请求 helper：直接调 app(req,res)，不绑 socket。
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

// drama-creator.json 的最小骨架，与 credentialApi.test.mjs 保持一致。
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

// 永远 pending 的 fake callback server：让 OAuth 流程停在 'awaiting_callback' 状态，
// 测试不会触达真实的 token 端点 / 真实的 1455 listener。
function pendingCallbackServer() {
  return new Promise(() => { /* never resolves */ });
}

test('POST /api/credentials/oauth/start rejects unknown adapterId with 404', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-oauth-start-unknown-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(epDir, { recursive: true });
    await writeFile(join(epDir, 'drama-creator.json'), JSON.stringify(emptyDoc('ep001', epDir)));

    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      startCallbackServer: pendingCallbackServer
    });
    const res = await callApp(app, {
      method: 'POST',
      url: '/api/credentials/oauth/start',
      body: { episodePath: epDir, adapterId: 'some-other-adapter' }
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.json.error, /Unknown OAuth adapter/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/credentials/oauth/start without episodePath starts global authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-oauth-start-noep-'));
  try {
    let observedExpectedState = null;
    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      // OAuth 凭据现在写入应用级 credentials.json，因此缺少 episodePath 也应能启动授权。
      startCallbackServer: ({ expectedState }) => {
        observedExpectedState = expectedState;
        return pendingCallbackServer();
      }
    });
    const res = await callApp(app, {
      method: 'POST',
      url: '/api/credentials/oauth/start',
      body: { adapterId: 'openai-codex-oauth' }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(typeof res.json.authorizeUrl, 'string');
    assert.equal(observedExpectedState, res.json.state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/credentials/oauth/start happy path returns authorizeUrl + state and flips status to awaiting_callback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-oauth-start-ok-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(epDir, { recursive: true });
    await writeFile(join(epDir, 'drama-creator.json'), JSON.stringify(emptyDoc('ep001', epDir)));

    let observedExpectedState = null;
    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      // 抓取 server 真实生成的 state，并确保不真的去监听 1455。
      startCallbackServer: ({ expectedState }) => {
        observedExpectedState = expectedState;
        return new Promise(() => { /* never resolves */ });
      }
    });
    const res = await callApp(app, {
      method: 'POST',
      url: '/api/credentials/oauth/start',
      body: { episodePath: epDir, adapterId: 'openai-codex-oauth' }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(typeof res.json.authorizeUrl, 'string');
    assert.match(res.json.authorizeUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    assert.equal(typeof res.json.state, 'string');
    assert.equal(res.json.state.length, 32); // generateState() 固定 16 字节 hex = 32 字符
    // server 把同一 state 透传给 callback server，验证生成-透传链路一致。
    assert.equal(observedExpectedState, res.json.state);

    // 立即查询状态，应已切到 awaiting_callback（fake callback 永远 pending）。
    const status = await callApp(app, { method: 'GET', url: '/api/credentials/oauth/status' });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json.state, 'awaiting_callback');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/credentials/oauth/start restarts an existing pending authorization flow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-oauth-start-restart-'));
  try {
    const starts = [];
    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      startCallbackServer: ({ expectedState, signal }) => {
        const record = { expectedState, aborted: false };
        starts.push(record);
        return new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => {
            record.aborted = true;
            const error = new Error('cancelled by newer authorization flow');
            error.code = 'ABORT_ERR';
            reject(error);
          }, { once: true });
        });
      }
    });

    const first = await callApp(app, {
      method: 'POST',
      url: '/api/credentials/oauth/start',
      body: { adapterId: 'openai-codex-oauth' }
    });
    const second = await callApp(app, {
      method: 'POST',
      url: '/api/credentials/oauth/start',
      body: { adapterId: 'openai-codex-oauth' }
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(starts.length, 2);
    assert.equal(starts[0].aborted, true);
    assert.notEqual(first.json.state, second.json.state);

    const status = await callApp(app, { method: 'GET', url: '/api/credentials/oauth/status' });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json.state, 'awaiting_callback');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/credentials/oauth/status returns idle by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-oauth-status-idle-'));
  try {
    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      startCallbackServer: pendingCallbackServer
    });
    const res = await callApp(app, { method: 'GET', url: '/api/credentials/oauth/status' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.state, 'idle');
    assert.equal(res.json.error, null);
    assert.equal(typeof res.json.lastUpdatedAt, 'number');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
