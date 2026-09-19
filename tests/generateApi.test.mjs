import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.mjs';

// Minimal request helper hitting the app function directly without binding a real socket.
// readJsonBody uses `for await (const chunk of req)` so the fake req must be async-iterable.
function callApp(app, { method, url, body }) {
  return new Promise((resolve) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    async function* iter() { if (buf) yield buf; }
    const req = { method, url, [Symbol.asyncIterator]: iter };
    let payload = '';
    const res = {
      statusCode: 0,
      setHeader() {},
      writeHead(code) { res.statusCode = code; },
      end(data) { payload = data || ''; resolve({ statusCode: res.statusCode, json: payload ? JSON.parse(payload) : null }); }
    };
    app(req, res);
  });
}

test('POST /api/generate runs mock-echo and returns a completed job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-gen-api-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(join(epDir, 'raw-videos'), { recursive: true });
    const doc = {
      schemaVersion: '0.1.0', config: {}, project: {}, episode: { id: 'ep001', path: epDir },
      adapters: [], credentials: [], jobs: [],
      nodes: [{ id: 'node:prompt:video:s001:v001', type: 'video_prompt', shotId: 'shot:s001', title: 'p', metadata: { prompt: 'hi' } }],
      edges: [],
      tasks: [{ id: 'task:video:s001:v001', shotId: 'shot:s001', type: 'video', promptNodeId: 'node:prompt:video:s001:v001', outputNodeIds: [], fields: {} }],
      shots: [], checks: [], activityLog: []
    };
    await writeFile(join(epDir, 'drama-creator.json'), JSON.stringify(doc));

    const app = createApp({ root, allowedEpisodeRoots: [root] });
    const res = await callApp(app, {
      method: 'POST', url: '/api/generate',
      body: { episodePath: epDir, taskId: 'task:video:s001:v001', adapterId: 'mock-echo', capability: 'video', model: 'echo-video' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.job.status, 'completed');
    assert.equal(res.json.job.outputNodeIds.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/generate returns 400 with detail message when domain validation fails', async () => {
  // 回归用例：handleGenerate 必须把 buildGenerateInput 抛出的领域错误（如 model not found）
  // 转成 4xx 而不是被顶层 catch 兜底成 "Internal server error" 500。
  const root = await mkdtemp(join(tmpdir(), 'dc-gen-err-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(join(epDir, 'raw-videos'), { recursive: true });
    const doc = {
      schemaVersion: '0.1.0', config: {}, project: {}, episode: { id: 'ep001', path: epDir },
      adapters: [], credentials: [], jobs: [],
      nodes: [{ id: 'node:prompt:video:s001:v001', type: 'video_prompt', shotId: 'shot:s001', title: 'p', metadata: { prompt: 'hi' } }],
      edges: [],
      tasks: [{ id: 'task:video:s001:v001', shotId: 'shot:s001', type: 'video', promptNodeId: 'node:prompt:video:s001:v001', outputNodeIds: [], fields: {} }],
      shots: [], checks: [], activityLog: []
    };
    await writeFile(join(epDir, 'drama-creator.json'), JSON.stringify(doc));

    const app = createApp({ root, allowedEpisodeRoots: [root] });
    // mock-echo 适配器声明的 model 不包含 nope，应触发 buildGenerateInput 的 model not found 错误。
    const res = await callApp(app, {
      method: 'POST', url: '/api/generate',
      body: { episodePath: epDir, taskId: 'task:video:s001:v001', adapterId: 'mock-echo', capability: 'video', model: 'nope' }
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json.error, /model not found/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/jobs/refresh returns advanced count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-refresh-api-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(epDir, { recursive: true });
    const doc = {
      schemaVersion: '0.1.0', config: {}, project: {}, episode: { id: 'ep001', path: epDir },
      adapters: [], credentials: [], jobs: [], nodes: [], edges: [], tasks: [], shots: [], checks: [], activityLog: []
    };
    await writeFile(join(epDir, 'drama-creator.json'), JSON.stringify(doc));
    const app = createApp({ root, allowedEpisodeRoots: [root] });
    const res = await callApp(app, { method: 'POST', url: '/api/jobs/refresh', body: { episodePath: epDir } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.advanced, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
