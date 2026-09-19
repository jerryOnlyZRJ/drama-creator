import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest, generate } from '../src/adapters/openai-compatible-text/index.mjs';

test('manifest declares api_key + env credential and OpenAI-compatible templates', () => {
  assert.equal(manifest.contractVersion, '1.0');
  assert.equal(manifest.id, 'openai-compatible-text');
  assert.equal(manifest.kind, 'builtin');
  assert.equal(manifest.async, false);
  // exposes a templates list so the settings UI can offer one-click endpoint switch
  const tmplIds = manifest.templates.map((t) => t.id).sort();
  assert.deepEqual(tmplIds, [
    'anthropic',
    'deepseek',
    'doubao',
    'gemini',
    'glm',
    'grok',
    'hunyuan',
    'kimi',
    'minimax',
    'ollama',
    'openai',
    'qianfan',
    'qwen',
    'siliconflow',
    'spark'
  ]);
  assert.ok(manifest.templates.every((item) => item.endpoint && item.apiKeyUrl && item.defaultModelId));
  assert.equal(manifest.templates.find((item) => item.id === 'anthropic').protocol, 'anthropic_messages');
  assert.equal(manifest.templates.find((item) => item.id === 'ollama').defaultApiKey, 'ollama');
  assert.deepEqual(manifest.credential.methods.sort(), ['api_key', 'env']);
});

test('generate posts to <endpoint>/chat/completions with bearer apiKey and returns completed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-openai-text-'));
  try {
    let captured;
    const fakeFetch = async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '生成的提示词正文' } }] }), { status: 200 });
    };
    const result = await generate({
      action: 'generate', capability: 'text_prompt', model: 'gpt-4o-mini',
      prompt: 'rewrite this prompt', references: [], outputDir: dir,
      params: { temperature: 0.7 },
      credential: { apiKey: 'sk-test', endpoint: 'https://api.deepseek.com/v1' }
    }, { fetch: fakeFetch });
    assert.equal(captured.url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(captured.headers.Authorization, 'Bearer sk-test');
    assert.equal(captured.body.model, 'gpt-4o-mini');
    assert.equal(captured.body.messages[0].content, 'rewrite this prompt');
    assert.equal(result.status, 'completed');
    assert.equal(result.outputs.length, 1);
    const out = result.outputs[0];
    assert.equal(out.kind, 'text');
    const content = await readFile(join(dir, out.path), 'utf8');
    assert.match(content, /生成的提示词正文/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generate sends app prompt best-practice instructions as a system message when provided', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-openai-text-system-'));
  try {
    let captured;
    const fakeFetch = async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '已按短剧规范改写' } }] }), { status: 200 });
    };
    const result = await generate({
      action: 'generate', capability: 'text_prompt', model: 'gpt-4o-mini',
      prompt: 'rewrite this prompt', systemPrompt: 'Drama Creator 内置短剧提示词规范',
      references: [], outputDir: dir, params: {},
      credential: { apiKey: 'sk-test', endpoint: 'https://api.deepseek.com/v1' }
    }, { fetch: fakeFetch });

    assert.equal(captured.body.messages[0].role, 'system');
    assert.equal(captured.body.messages[0].content, 'Drama Creator 内置短剧提示词规范');
    assert.equal(captured.body.messages[1].content, 'rewrite this prompt');
    assert.equal(result.status, 'completed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generate returns failed with auth_failed when API replies 401', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-openai-text-401-'));
  try {
    const fakeFetch = async () => new Response('{"error":{"message":"bad key"}}', { status: 401 });
    const result = await generate({
      action: 'generate', capability: 'text_prompt', model: 'm',
      prompt: 'x', references: [], outputDir: dir, params: {},
      credential: { apiKey: 'bad', endpoint: 'https://api.openai.com/v1' }
    }, { fetch: fakeFetch });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'auth_failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generate routes Claude provider through Anthropic Messages API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-openai-text-claude-'));
  try {
    let captured;
    const fakeFetch = async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '剧本润色完成' }] }), { status: 200 });
    };
    const result = await generate({
      action: 'generate', capability: 'text_prompt', model: 'claude-sonnet-4-5',
      prompt: 'polish script', references: [], outputDir: dir,
      params: { temperature: 0.4, maxTokens: 2048 },
      credential: { apiKey: 'sk-ant', endpoint: 'https://api.anthropic.com/v1' }
    }, { fetch: fakeFetch });

    assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(captured.headers['x-api-key'], 'sk-ant');
    assert.equal(captured.headers['anthropic-version'], '2023-06-01');
    assert.equal(captured.body.model, 'claude-sonnet-4-5');
    assert.equal(captured.body.system, undefined);
    assert.equal(captured.body.messages[0].content, 'polish script');
    assert.equal(result.status, 'completed');
    const content = await readFile(join(dir, result.outputs[0].path), 'utf8');
    assert.equal(content, '剧本润色完成');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generate maps 429 quota_exceeded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-openai-text-429-'));
  try {
    const fakeFetch = async () => new Response('{}', { status: 429 });
    const result = await generate({
      action: 'generate', capability: 'text_prompt', model: 'm',
      prompt: 'x', references: [], outputDir: dir, params: {},
      credential: { apiKey: 'k', endpoint: 'https://api.openai.com/v1' }
    }, { fetch: fakeFetch });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'quota_exceeded');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
