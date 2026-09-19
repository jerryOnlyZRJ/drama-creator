import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCredential, OAuthExpiredError } from '../src/credentials/credentialResolver.mjs';

const manifest = {
  id: 'openai-text',
  credential: {
    required: true,
    methods: ['api_key', 'env'],
    fields: [
      { key: 'apiKey', secret: true, required: true },
      { key: 'endpoint', secret: false, required: false }
    ],
    env: [{ key: 'apiKey', envVar: 'OPENAI_API_KEY' }]
  }
};

const docWithCred = {
  credentials: [{
    ref: 'credential:openai-text',
    adapterId: 'openai-text',
    method: 'api_key',
    keychainAccount: 'drama-creator:openai-text',
    secretFieldKeys: ['apiKey'],
    publicFields: { endpoint: 'https://api.deepseek.com/v1' }
  }]
};

function fakeKeychain(map) {
  return { readSecret: async (acc) => map.get(acc) || null };
}

test('returns null when env variables are all present (env bypass)', async () => {
  const env = { OPENAI_API_KEY: 'sk-from-env' };
  const result = await resolveCredential(docWithCred, 'openai-text', manifest, env, fakeKeychain(new Map()));
  assert.equal(result, null);
});

test('merges keychain secrets with document public fields when env not set', async () => {
  const map = new Map([['drama-creator:openai-text', JSON.stringify({ apiKey: 'sk-from-keychain' })]]);
  const result = await resolveCredential(docWithCred, 'openai-text', manifest, {}, fakeKeychain(map));
  assert.deepEqual(result, { apiKey: 'sk-from-keychain', endpoint: 'https://api.deepseek.com/v1' });
});

test('returns null when adapter has no credential record (not configured)', async () => {
  const docEmpty = { credentials: [] };
  const result = await resolveCredential(docEmpty, 'openai-text', manifest, {}, fakeKeychain(new Map()));
  assert.equal(result, null);
});

test('returns null when keychain secret cannot be parsed', async () => {
  const map = new Map([['drama-creator:openai-text', '{not-valid-json']]);
  const result = await resolveCredential(docWithCred, 'openai-text', manifest, {}, fakeKeychain(map));
  assert.equal(result, null);
});

test('returns null when manifest declares credential not required', async () => {
  const localManifest = { id: 'mock', credential: { required: false } };
  const result = await resolveCredential({ credentials: [] }, 'mock', localManifest, {}, fakeKeychain(new Map()));
  assert.equal(result, null);
});

// ---- OAuth 路径（Phase 3 Task 4 / P3Q4-Q4）-----------------------------------

// OAuth 适配器的 manifest，只声明 oauth 一种 credential method
const oauthManifest = {
  id: 'openai-codex-oauth',
  credential: {
    required: true,
    methods: ['oauth'],
    fields: [
      { key: 'accessToken', secret: true, required: true },
      { key: 'refreshToken', secret: true, required: true },
      { key: 'expiresAt', secret: false, required: true },
      { key: 'accountId', secret: false, required: false }
    ]
  }
};

// 构造一份 OAuth credential 文档：account 固定，publicFields 含 expiresAt + accountId
function makeOauthDoc(expiresAt, accountId = 'acc-old') {
  return {
    credentials: [{
      ref: 'credential:openai-codex-oauth',
      adapterId: 'openai-codex-oauth',
      method: 'oauth',
      keychainAccount: 'drama-creator:openai-codex-oauth',
      secretFieldKeys: ['accessToken', 'refreshToken'],
      publicFields: { expiresAt, accountId }
    }]
  };
}

// 可观测 keychain：记录每次写/删的参数，方便断言
function instrumentedKeychain(initialMap) {
  const map = new Map(initialMap);
  const writes = [];
  const deletes = [];
  return {
    map,
    writes,
    deletes,
    readSecret: async (acc) => map.get(acc) || null,
    writeSecret: async (acc, payload) => {
      writes.push({ account: acc, payload });
      map.set(acc, payload);
    },
    deleteSecret: async (acc) => {
      deletes.push(acc);
      map.delete(acc);
    }
  };
}

test('OAuth: returns merged credential without refresh when token is fresh', async () => {
  const fakeNow = 1_700_000_000_000;
  const expiresAt = fakeNow + 10 * 60 * 1000; // 还有 10 分钟，远超 60s 阈值
  const doc = makeOauthDoc(expiresAt, 'acc-1');
  const kc = instrumentedKeychain([
    ['drama-creator:openai-codex-oauth', JSON.stringify({ accessToken: 'A', refreshToken: 'R' })]
  ]);
  let refreshCalled = 0;
  const result = await resolveCredential(doc, 'openai-codex-oauth', oauthManifest, {}, kc, {
    now: () => fakeNow,
    refreshAccessToken: async () => { refreshCalled += 1; return null; }
  });
  assert.equal(result.accessToken, 'A');
  assert.equal(result.refreshToken, 'R');
  assert.equal(result.expiresAt, expiresAt);
  assert.equal(result.accountId, 'acc-1');
  // 仍在有效期内 → 不应触发刷新或写 keychain
  assert.equal(refreshCalled, 0);
  assert.equal(kc.writes.length, 0);
  assert.equal(kc.deletes.length, 0);
});

test('OAuth: refreshes token, writes new secret, mutates publicFields when near expiry', async () => {
  const fakeNow = 1_700_000_000_000;
  const oldExpiresAt = fakeNow + 30 * 1000; // 还剩 30s，触发刷新
  const newExpiresAt = fakeNow + 3600 * 1000;
  const doc = makeOauthDoc(oldExpiresAt, 'acc-old');
  const kc = instrumentedKeychain([
    ['drama-creator:openai-codex-oauth', JSON.stringify({ accessToken: 'A', refreshToken: 'R' })]
  ]);
  const refreshCalls = [];
  const result = await resolveCredential(doc, 'openai-codex-oauth', oauthManifest, {}, kc, {
    now: () => fakeNow,
    refreshAccessToken: async (args) => {
      refreshCalls.push(args);
      return { accessToken: 'A2', refreshToken: 'R2', expiresAt: newExpiresAt, accountId: 'acc-1' };
    }
  });
  // 返回最新的 access/refresh + 新的 expiresAt
  assert.equal(result.accessToken, 'A2');
  assert.equal(result.refreshToken, 'R2');
  assert.equal(result.expiresAt, newExpiresAt);
  assert.equal(result.accountId, 'acc-1');
  // 注入的 refresh 被调用一次，refreshToken 用旧的 'R'
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].refreshToken, 'R');
  // keychain 写入一次，account 与原一致，payload 含新 token（不含 expiresAt/accountId）
  assert.equal(kc.writes.length, 1);
  assert.equal(kc.writes[0].account, 'drama-creator:openai-codex-oauth');
  const stored = JSON.parse(kc.writes[0].payload);
  assert.equal(stored.accessToken, 'A2');
  assert.equal(stored.refreshToken, 'R2');
  assert.equal(stored.expiresAt, undefined);
  // doc.credentials[0].publicFields 已就地更新
  assert.equal(doc.credentials[0].publicFields.expiresAt, newExpiresAt);
  assert.equal(doc.credentials[0].publicFields.accountId, 'acc-1');
  // 没有走刷新失败分支，不应调 deleteSecret
  assert.equal(kc.deletes.length, 0);
});

test('OAuth: refresh failure clears keychain and throws OAuthExpiredError', async () => {
  const fakeNow = 1_700_000_000_000;
  const expiresAt = fakeNow - 5_000; // 已过期
  const doc = makeOauthDoc(expiresAt, 'acc-old');
  const kc = instrumentedKeychain([
    ['drama-creator:openai-codex-oauth', JSON.stringify({ accessToken: 'A', refreshToken: 'R' })]
  ]);
  const cause = new Error('network down');
  let thrown;
  try {
    await resolveCredential(doc, 'openai-codex-oauth', oauthManifest, {}, kc, {
      now: () => fakeNow,
      refreshAccessToken: async () => { throw cause; }
    });
  } catch (err) {
    thrown = err;
  }
  // 抛 OAuthExpiredError，code/adapterId/cause 都对得上
  assert.ok(thrown instanceof OAuthExpiredError);
  assert.equal(thrown.code, 'oauth_expired');
  assert.equal(thrown.adapterId, 'openai-codex-oauth');
  assert.equal(thrown.cause, cause);
  // keychain 被删了一次，account 与原一致
  assert.equal(kc.deletes.length, 1);
  assert.equal(kc.deletes[0], 'drama-creator:openai-codex-oauth');
  // doc.credentials 结构未被破坏（记录仍在）
  assert.equal(doc.credentials.length, 1);
  assert.equal(doc.credentials[0].adapterId, 'openai-codex-oauth');
});
