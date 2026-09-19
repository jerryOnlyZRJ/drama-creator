import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest, generate, ENDPOINT } from '../src/adapters/openai-codex-oauth/index.mjs';
import { findBuiltinAdapter } from '../src/adapters/builtins.mjs';

// Phase 3 Task 3 单测：覆盖 manifest 形状 + 注册、200 正常路径、401 鉴权失败、缺 accessToken 早退。

test('manifest declares oauth-only credential and is registered as a builtin adapter', () => {
  // 基本字段断言
  assert.equal(manifest.contractVersion, '1.0');
  assert.equal(manifest.id, 'openai-codex-oauth');
  assert.equal(manifest.kind, 'builtin');
  assert.equal(manifest.async, false);
  // OAuth 流程没有 endpoint 模板的概念
  assert.equal(manifest.templates, null);
  // 唯一方法 = oauth，不与 api_key 卡片混用
  assert.deepEqual(manifest.credential.methods, ['oauth']);
  // env 注入路径必须为空（OAuth 必须走 keychain）
  assert.deepEqual(manifest.credential.env, []);
  // 订阅通道只暴露应用验证过的模型候选，避免设置页让用户手填不稳定别名。
  const cap = manifest.capabilities[0];
  assert.equal(cap.type, 'text_prompt');
  assert.equal(cap.acceptsAnyModel, false);
  assert.deepEqual(cap.models.map((model) => model.id), ['gpt-5-codex']);
  assert.equal(cap.models[0].label, 'GPT-5 Codex');
  // 凭据字段：accessToken / refreshToken 是 secret，expiresAt / accountId 是公开
  const fieldMap = Object.fromEntries(manifest.credential.fields.map((f) => [f.key, f]));
  assert.equal(fieldMap.accessToken.secret, true);
  assert.equal(fieldMap.accessToken.required, true);
  assert.equal(fieldMap.refreshToken.secret, true);
  assert.equal(fieldMap.refreshToken.required, true);
  assert.equal(fieldMap.expiresAt.secret, false);
  assert.equal(fieldMap.accountId.secret, false);
  // 内置适配器表里能解析到该 id
  const entry = findBuiltinAdapter('openai-codex-oauth');
  assert.ok(entry, 'openai-codex-oauth should be registered in BUILTIN_ADAPTERS');
  assert.equal(entry.module.manifest.id, 'openai-codex-oauth');
});

test('generate posts to codex responses endpoint with required headers and writes text artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-codex-oauth-'));
  try {
    let captured;
    let callCount = 0;
    const fakeFetch = async (url, init) => {
      callCount += 1;
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello world' }] }]
        }),
        { status: 200 }
      );
    };
    const result = await generate(
      {
        action: 'generate',
        capability: 'text_prompt',
        model: 'gpt-5-codex',
        prompt: 'write a haiku',
        systemPrompt: 'Drama Creator 内置短剧提示词规范',
        references: [],
        outputDir: dir,
        params: { temperature: 0.5, maxTokens: 256 },
        credential: {
          accessToken: 'codex-access-xyz',
          refreshToken: 'codex-refresh-xyz',
          accountId: 'acct-123'
        }
      },
      { fetch: fakeFetch }
    );

    // 行为断言：URL / Authorization / 关键 header / body 字段
    assert.equal(callCount, 1);
    assert.equal(captured.url, ENDPOINT);
    assert.equal(captured.headers.Authorization, 'Bearer codex-access-xyz');
    assert.equal(captured.headers['chatgpt-account-id'], 'acct-123');
    assert.equal(captured.headers['OpenAI-Beta'], 'responses=experimental');
    assert.equal(captured.headers.originator, 'codex_cli_rs');
    assert.equal(captured.body.model, 'gpt-5-codex');
    assert.equal(captured.body.instructions, 'Drama Creator 内置短剧提示词规范');
    assert.equal(captured.body.input[0].role, 'user');
    assert.equal(captured.body.input[0].content[0].text, 'write a haiku');
    assert.equal(captured.body.temperature, 0.5);
    assert.equal(captured.body.max_output_tokens, 256);

    // 产物断言：完成态 + 文件落盘
    assert.equal(result.status, 'completed');
    assert.equal(result.outputs.length, 1);
    const out = result.outputs[0];
    assert.equal(out.kind, 'text');
    assert.equal(out.role, 'primary');
    assert.match(out.path, /^text_\d+\.txt$/);
    const content = await readFile(join(dir, out.path), 'utf8');
    assert.equal(content, 'hello world');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generate maps 401 response to auth_failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-codex-oauth-401-'));
  try {
    const fakeFetch = async () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 });
    const result = await generate(
      {
        action: 'generate',
        capability: 'text_prompt',
        model: 'gpt-5-codex',
        prompt: 'x',
        references: [],
        outputDir: dir,
        params: {},
        credential: { accessToken: 'expired', refreshToken: 'r' }
      },
      { fetch: fakeFetch }
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'auth_failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generate returns invalid_params and never calls fetch when accessToken is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-codex-oauth-noauth-'));
  try {
    let callCount = 0;
    const fakeFetch = async () => {
      callCount += 1;
      return new Response('{}', { status: 200 });
    };
    const result = await generate(
      {
        action: 'generate',
        capability: 'text_prompt',
        model: 'gpt-5-codex',
        prompt: 'x',
        references: [],
        outputDir: dir,
        params: {},
        credential: {}
      },
      { fetch: fakeFetch }
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'invalid_params');
    assert.match(result.error.message, /missing accessToken/);
    // 早退路径不应触发任何网络请求
    assert.equal(callCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
