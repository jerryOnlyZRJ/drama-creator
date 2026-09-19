// 公开测试使用虚构名称与对应资源标识，避免将创作项目的人物或作品名称带入源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.mjs';

function makeMemoryKeychain() {
  const store = new Map();
  return {
    store,
    keychain: {
      readSecret: async (account) => store.get(account) || null,
      writeSecret: async (account, payload) => { store.set(account, payload); },
      deleteSecret: async (account) => { store.delete(account); }
    }
  };
}

async function startStoryServer({ root, keychain, fetch }) {
  const appWorkspaceDir = join(root, '.drama-creator');
  const server = createServer(createApp({
    root,
    allowedEpisodeRoots: [root],
    appWorkspaceDir,
    keychain,
    fetch
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('POST /api/story/generate keeps manual fallback when text model is not configured', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-story-no-model-')));
  const { keychain } = makeMemoryKeychain();
  const server = await startStoryServer({ root, keychain });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/story/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: '一个送信机器人第一次找到森林邮局。' })
    });
    const json = await response.json();

    assert.equal(response.status, 409);
    assert.equal(json.error, 'text_model_not_configured');
    assert.equal(json.settingsUrl, '/settings.html#model-text');
    assert.equal(json.manualFallback, true);
    assert.match(json.message, /手动补写完整故事|文本模型/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/story/generate falls back to configured API Key text provider', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-story-api-')));
  const { keychain } = makeMemoryKeychain();
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || '{}') });
    return new Response(JSON.stringify({
      choices: [{ message: { content: '完整故事正文：小邮沿着地图，把信送到森林邮局。' } }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const server = await startStoryServer({ root, keychain, fetch: fakeFetch });
  try {
    const { port } = server.address();
    const credentialResponse = await fetch(`http://127.0.0.1:${port}/api/credentials/openai-compatible-text`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          apiKey: 'sk-test',
          endpoint: 'https://api.deepseek.com/v1'
        }
      })
    });
    assert.equal(credentialResponse.status, 200);

    const response = await fetch(`http://127.0.0.1:${port}/api/story/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idea: '送信机器人找到森林邮局',
        projectName: '机器人送信（公开测试样例）',
        firstEpisodeName: '第 1 集'
      })
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.adapterId, 'openai-compatible-text');
    assert.equal(json.modelId, 'deepseek-chat');
    assert.match(json.story, /完整故事正文/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(calls[0].body.model, 'deepseek-chat');
    assert.match(calls[0].body.messages.at(-1).content, /送信机器人找到森林邮局/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/story/generate keeps explicit subscription default instead of silently using API Key fallback', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-story-oauth-broken-')));
  const appWorkspaceDir = join(root, '.drama-creator');
  const { keychain, store } = makeMemoryKeychain();
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || '{}') });
    return new Response(JSON.stringify({
      choices: [{ message: { content: '完整故事正文：她在旧剧场里重新听见了自己的声音。' } }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  await mkdir(appWorkspaceDir, { recursive: true });
  await writeFile(join(appWorkspaceDir, 'settings.json'), `${JSON.stringify({
    modelDefaults: {
      text: { adapterId: 'openai-codex-oauth', modelId: 'gpt-5-codex' }
    }
  }, null, 2)}\n`, 'utf8');
  await writeFile(join(appWorkspaceDir, 'credentials.json'), `${JSON.stringify({
    credentials: [
      {
        ref: 'credential:openai-codex-oauth',
        adapterId: 'openai-codex-oauth',
        method: 'oauth',
        keychainAccount: 'drama-creator:openai-codex-oauth',
        secretFieldKeys: ['accessToken', 'refreshToken'],
        publicFields: { expiresAt: Date.now() + 3600_000, accountId: 'acc-test' }
      },
      {
        ref: 'credential:openai-compatible-text',
        adapterId: 'openai-compatible-text',
        method: 'api_key',
        keychainAccount: 'drama-creator:openai-compatible-text',
        secretFieldKeys: ['apiKey'],
        publicFields: { endpoint: 'https://api.deepseek.com/v1' }
      }
    ]
  }, null, 2)}\n`, 'utf8');
  store.set('drama-creator:openai-codex-oauth', '{not-valid-json');
  store.set('drama-creator:openai-compatible-text', JSON.stringify({ apiKey: 'sk-test' }));

  const server = await startStoryServer({ root, keychain, fetch: fakeFetch });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/story/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: '一个女孩在旧剧场重新学会唱歌。' })
    });
    const json = await response.json();

    assert.equal(response.status, 409);
    assert.equal(json.error, 'text_model_not_configured');
    assert.equal(json.settingsUrl, '/settings.html#model-text');
    assert.equal(json.manualFallback, true);
    assert.match(json.message, /OpenAI Codex|订阅|授权/);
    assert.equal(calls.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/story/generate reports explicit subscription failure instead of silently using API Key fallback', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-story-oauth-rejected-')));
  const appWorkspaceDir = join(root, '.drama-creator');
  const { keychain, store } = makeMemoryKeychain();
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || '{}') });
    if (String(url).includes('chatgpt.com/backend-api/codex/responses')) {
      return new Response('Your authentication token has been invalidated.', { status: 401 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '完整故事正文：男孩在歌声里重新找到名字。' } }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  await mkdir(appWorkspaceDir, { recursive: true });
  await writeFile(join(appWorkspaceDir, 'settings.json'), `${JSON.stringify({
    modelDefaults: {
      text: { adapterId: 'openai-codex-oauth', modelId: 'gpt-5-codex' }
    }
  }, null, 2)}\n`, 'utf8');
  await writeFile(join(appWorkspaceDir, 'credentials.json'), `${JSON.stringify({
    credentials: [
      {
        ref: 'credential:openai-codex-oauth',
        adapterId: 'openai-codex-oauth',
        method: 'oauth',
        keychainAccount: 'drama-creator:openai-codex-oauth',
        secretFieldKeys: ['accessToken', 'refreshToken'],
        publicFields: { expiresAt: Date.now() + 3600_000, accountId: 'acc-test' }
      },
      {
        ref: 'credential:openai-compatible-text',
        adapterId: 'openai-compatible-text',
        method: 'api_key',
        keychainAccount: 'drama-creator:openai-compatible-text',
        secretFieldKeys: ['apiKey'],
        publicFields: { endpoint: 'https://api.deepseek.com/v1' }
      }
    ]
  }, null, 2)}\n`, 'utf8');
  store.set('drama-creator:openai-codex-oauth', JSON.stringify({
    accessToken: 'expired-access-token',
    refreshToken: 'refresh-token'
  }));
  store.set('drama-creator:openai-compatible-text', JSON.stringify({ apiKey: 'sk-test' }));

  const server = await startStoryServer({ root, keychain, fetch: fakeFetch });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/story/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: '一个男孩因为流浪猫被霸凌，后来用歌声自救。' })
    });
    const json = await response.json();

    assert.equal(response.status, 502);
    assert.equal(json.error, 'story_generation_failed');
    assert.match(json.message, /故事生成失败/);
    assert.match(json.message, /订阅登录已失效|重新登录/);
    assert.doesNotMatch(json.message, /authentication token|token_invalidated|deepseek/i);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /chatgpt\.com\/backend-api\/codex\/responses/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/script-draft/generate keeps manual fallback when text model is not configured', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-script-no-model-')));
  const { keychain } = makeMemoryKeychain();
  const server = await startStoryServer({ root, keychain });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/script-draft/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceText: '送信机器人需要找到森林邮局。' })
    });
    const json = await response.json();

    assert.equal(response.status, 409);
    assert.equal(json.error, 'text_model_not_configured');
    assert.equal(json.settingsUrl, '/settings.html#model-text');
    assert.equal(json.manualFallback, true);
    assert.match(json.message, /手动编写剧本草稿|文本模型/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/script-draft/generate explains stale API key defaults with missing keychain secret', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-script-stale-key-')));
  const appWorkspaceDir = join(root, '.drama-creator');
  await mkdir(appWorkspaceDir, { recursive: true });
  await writeFile(join(appWorkspaceDir, 'settings.json'), `${JSON.stringify({
    modelDefaults: {
      text: {
        adapterId: 'openai-compatible-text',
        modelId: 'deepseek-v4-flash',
        providerId: 'deepseek'
      }
    }
  }, null, 2)}\n`);
  await writeFile(join(appWorkspaceDir, 'credentials.json'), `${JSON.stringify({
    credentials: [{
      ref: 'credential:openai-compatible-text',
      adapterId: 'openai-compatible-text',
      method: 'api_key',
      keychainAccount: 'drama-creator:openai-compatible-text',
      secretFieldKeys: ['apiKey'],
      publicFields: {
        endpoint: 'https://api.deepseek.com/v1',
        verification: {
          status: 'verified',
          message: '已读取 2 个模型',
          modelIds: ['deepseek-v4-flash', 'deepseek-v4-pro']
        }
      },
      updatedAt: '2026-06-20T13:12:51.803Z'
    }]
  }, null, 2)}\n`);
  const { keychain } = makeMemoryKeychain();
  const server = await startStoryServer({ root, keychain });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/script-draft/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceText: '主角因为被同学嘲笑声音，后来重新学会唱出自己的声音。' })
    });
    const json = await response.json();

    assert.equal(response.status, 409);
    assert.equal(json.error, 'text_model_not_configured');
    assert.equal(json.manualFallback, true);
    assert.equal(json.settingsUrl, '/settings.html#model-text');
    assert.match(json.message, /系统钥匙串/);
    assert.match(json.message, /更新 API Key|重新登录/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/script-draft/generate uses configured API Key text provider', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-script-api-')));
  const { keychain } = makeMemoryKeychain();
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || '{}') });
    return new Response(JSON.stringify({
      choices: [{ message: { content: '剧本草稿：\\n场景：清晨邮局\\n动作：机器人打开邮袋。\\n对白：第一封信到了。' } }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const server = await startStoryServer({ root, keychain, fetch: fakeFetch });
  try {
    const { port } = server.address();
    const credentialResponse = await fetch(`http://127.0.0.1:${port}/api/credentials/openai-compatible-text`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          apiKey: 'sk-test',
          endpoint: 'https://api.deepseek.com/v1'
        }
      })
    });
    assert.equal(credentialResponse.status, 200);

    const response = await fetch(`http://127.0.0.1:${port}/api/script-draft/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceText: '一个送信机器人穿过花园，把信交给灯塔管理员。',
        projectName: '机器人送信（公开测试样例）',
        episodeTitle: '第 1 集'
      })
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.adapterId, 'openai-compatible-text');
    assert.equal(json.modelId, 'deepseek-chat');
    assert.match(json.scriptDraft, /剧本草稿/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(calls[0].body.model, 'deepseek-chat');
    assert.match(calls[0].body.messages.at(-1).content, /分集剧本草稿/);
    assert.match(calls[0].body.messages.at(-1).content, /送信机器人/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
