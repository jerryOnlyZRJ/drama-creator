// Phase 3 Task 8 — 用 node:test 的 MockTimers 给 OAuth 自动刷新流程做端到端覆盖。
//
// 与 tests/credentialResolver.test.mjs 的区别（P3Q4-Q4 / P3Q4-Q6 决策）：
// - Task 4 已经用 options.now 函数注入覆盖了 3 条 OAuth 路径
// - 本文件不传 options.now，而是用 mock.timers.enable({ apis: ['Date'] })
//   全局拦截 Date.now / setTimeout，让 resolveCredential 走真实的默认时钟，
//   作为更接近生产行为的 fakeTimers 端到端覆盖
//
// 4 条测试覆盖：
//   1) token 未临近过期 → 不触发刷新
//   2) 临界 + tick 推进时间使其临近过期 → refresh 成功 → 写回 keychain + mutate publicFields
//   3) refresh HTTP 401 → 清 keychain + 抛 OAuthExpiredError
//   4) refresh 网络异常 (TypeError) → 与 401 走同一兜底分支

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCredential, OAuthExpiredError } from '../src/credentials/credentialResolver.mjs';

// 适配器 manifest：仅声明 oauth 一种 credential method，与生产配置一致
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

const ACCOUNT = 'drama-creator:openai-codex-oauth';

// 构造一份 OAuth credential 文档：account 固定，publicFields 由调用方传入
function makeOauthDoc(expiresAt, accountId = 'acc-old') {
  return {
    credentials: [{
      ref: 'credential:openai-codex-oauth',
      adapterId: 'openai-codex-oauth',
      method: 'oauth',
      keychainAccount: ACCOUNT,
      secretFieldKeys: ['accessToken', 'refreshToken'],
      publicFields: { expiresAt, accountId }
    }]
  };
}

// 可观测 keychain：记录每次读 / 写 / 删的参数，断言时直接看 calls
function makeFakeKeychain(initialPayload) {
  const store = new Map();
  if (initialPayload) store.set(ACCOUNT, initialPayload);
  const calls = { read: [], write: [], delete: [] };
  return {
    store,
    calls,
    async readSecret(account) {
      calls.read.push(account);
      return store.get(account) || null;
    },
    async writeSecret(account, payload) {
      calls.write.push({ account, payload });
      store.set(account, payload);
    },
    async deleteSecret(account) {
      calls.delete.push(account);
      store.delete(account);
    },
    async listAccounts() {
      return [...store.keys()];
    }
  };
}

// fetch spy：记录调用次数，未授权使用时让测试显式失败
function makeForbiddenFetch() {
  let count = 0;
  const impl = async () => {
    count += 1;
    throw new Error('fetch should not be called in this test');
  };
  return { fetch: impl, get count() { return count; } };
}

// ----------------------------------------------------------------------------
// 用例 1：token 仍有 10 分钟才过期 → 既不调 refresh 也不写 keychain
// ----------------------------------------------------------------------------
test('OAuth fresh credential does not trigger refresh under MockTimers', async (t) => {
  // 用 MockTimers 锁定 Date.now 到一个具体时刻
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-11T00:00:00Z') });
  t.after(() => mock.timers.reset());

  const expiresAt = Date.now() + 600_000; // 10 分钟后
  const doc = makeOauthDoc(expiresAt, 'acc-1');
  const keychain = makeFakeKeychain(JSON.stringify({ accessToken: 'A', refreshToken: 'R' }));
  const fetchSpy = makeForbiddenFetch();
  let refreshCallCount = 0;
  const refreshAccessToken = async () => {
    refreshCallCount += 1;
    throw new Error('refreshAccessToken should not be called');
  };

  // 关键：不传 options.now，让 resolveCredential 走默认 Date.now（被 MockTimers 拦截）
  const cred = await resolveCredential(doc, 'openai-codex-oauth', oauthManifest, {}, keychain, {
    fetch: fetchSpy.fetch,
    refreshAccessToken
  });

  assert.equal(cred.accessToken, 'A');
  assert.equal(cred.refreshToken, 'R');
  assert.equal(cred.expiresAt, expiresAt);
  assert.equal(cred.accountId, 'acc-1');
  // 仍在有效期 → 不调 refresh、不调 fetch、不写/删 keychain
  assert.equal(refreshCallCount, 0);
  assert.equal(fetchSpy.count, 0);
  assert.equal(keychain.calls.write.length, 0);
  assert.equal(keychain.calls.delete.length, 0);
});

// ----------------------------------------------------------------------------
// 用例 2：临界 → tick 推进 → refresh 成功 → 写回 keychain + mutate publicFields
// ----------------------------------------------------------------------------
test('OAuth refresh succeeds after MockTimers tick crosses 60s threshold', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-11T00:00:00Z') });
  t.after(() => mock.timers.reset());

  const t0 = Date.now();
  const expiresAt = t0 + 70_000; // 距过期 70s，> 60s 阈值，第一次不应触发刷新
  const doc = makeOauthDoc(expiresAt, 'acc-old');
  const keychain = makeFakeKeychain(JSON.stringify({ accessToken: 'A', refreshToken: 'R' }));

  let refreshCallCount = 0;
  const refreshCalls = [];
  const newAccessToken = 'A2';
  const newRefreshToken = 'R2';
  // 刷新返回的 expiresAt 用「调用刷新那一刻」的 Date.now + 1h，便于断言 publicFields 同步
  let newExpiresAt;
  const refreshAccessToken = async (args) => {
    refreshCallCount += 1;
    refreshCalls.push(args);
    newExpiresAt = Date.now() + 3600_000;
    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: newExpiresAt,
      accountId: 'acc-new'
    };
  };

  // —— 第一次调用：仍在有效期内（剩 70s），断言不刷新
  const first = await resolveCredential(doc, 'openai-codex-oauth', oauthManifest, {}, keychain, {
    refreshAccessToken
  });
  assert.equal(first.accessToken, 'A');
  assert.equal(refreshCallCount, 0);
  assert.equal(keychain.calls.write.length, 0);

  // —— 推进 20s，使距过期变为 50s（< 60s 阈值）
  mock.timers.tick(20_000);

  // —— 第二次调用：应触发刷新
  const second = await resolveCredential(doc, 'openai-codex-oauth', oauthManifest, {}, keychain, {
    refreshAccessToken
  });

  // 返回的 credential 含新 token
  assert.equal(second.accessToken, newAccessToken);
  assert.equal(second.refreshToken, newRefreshToken);
  assert.equal(second.expiresAt, newExpiresAt);
  assert.equal(second.accountId, 'acc-new');

  // refreshAccessToken 仅被调用一次，且收到的 refreshToken 是旧值 'R'
  assert.equal(refreshCallCount, 1);
  assert.equal(refreshCalls[0].refreshToken, 'R');

  // keychain 被写一次，payload 含新 token，account 与原一致
  assert.equal(keychain.calls.write.length, 1);
  assert.equal(keychain.calls.write[0].account, ACCOUNT);
  const stored = JSON.parse(keychain.calls.write[0].payload);
  assert.equal(stored.accessToken, newAccessToken);
  assert.equal(stored.refreshToken, newRefreshToken);
  // payload 仅含 secret 字段，不应混入 expiresAt/accountId
  assert.equal(stored.expiresAt, undefined);
  assert.equal(stored.accountId, undefined);

  // doc.credentials[0].publicFields 已就地更新（调用方负责把它写盘）
  assert.equal(doc.credentials[0].publicFields.expiresAt, newExpiresAt);
  assert.equal(doc.credentials[0].publicFields.accountId, 'acc-new');

  // 没走失败分支，不应调 deleteSecret
  assert.equal(keychain.calls.delete.length, 0);
});

// ----------------------------------------------------------------------------
// 用例 3：refresh 抛 HTTP 401 → 清 keychain + 抛 OAuthExpiredError
// ----------------------------------------------------------------------------
test('OAuth refresh HTTP 401 clears keychain and throws OAuthExpiredError', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-11T00:00:00Z') });
  t.after(() => mock.timers.reset());

  // 距过期仅 10s，必然走刷新分支
  const expiresAt = Date.now() + 10_000;
  const doc = makeOauthDoc(expiresAt, 'acc-old');
  const keychain = makeFakeKeychain(JSON.stringify({ accessToken: 'A', refreshToken: 'R' }));

  // 模拟 refreshAccessToken 内部抛出包含 "401" 的错误（与 oauthCodex.postTokenForm 抛出的形态一致）
  const cause = new Error('OAuth token endpoint returned 401: {"error":"invalid_grant"}');
  let refreshCallCount = 0;
  const refreshAccessToken = async () => {
    refreshCallCount += 1;
    throw cause;
  };

  let thrown;
  try {
    await resolveCredential(doc, 'openai-codex-oauth', oauthManifest, {}, keychain, {
      refreshAccessToken
    });
  } catch (err) {
    thrown = err;
  }

  // 抛 OAuthExpiredError，code/adapterId/cause 链都正确
  assert.ok(thrown instanceof OAuthExpiredError, 'should throw OAuthExpiredError');
  assert.equal(thrown.code, 'oauth_expired');
  assert.equal(thrown.adapterId, 'openai-codex-oauth');
  assert.equal(thrown.cause, cause);
  assert.match(thrown.cause.message, /401/);

  // 调了一次 refresh、一次 deleteSecret；不应调 writeSecret
  assert.equal(refreshCallCount, 1);
  assert.equal(keychain.calls.delete.length, 1);
  assert.equal(keychain.calls.delete[0], ACCOUNT);
  assert.equal(keychain.calls.write.length, 0);
});

// ----------------------------------------------------------------------------
// 用例 4：refresh 抛 TypeError(fetch failed) → 与 401 走同一兜底分支
// ----------------------------------------------------------------------------
test('OAuth refresh network failure clears keychain and throws OAuthExpiredError', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-11T00:00:00Z') });
  t.after(() => mock.timers.reset());

  // 已过期场景：剩余 -5s，同样进入刷新分支
  const expiresAt = Date.now() - 5_000;
  const doc = makeOauthDoc(expiresAt, 'acc-old');
  const keychain = makeFakeKeychain(JSON.stringify({ accessToken: 'A', refreshToken: 'R' }));

  // 纯网络错误：Node fetch 在连不通时抛 TypeError('fetch failed')
  const cause = new TypeError('fetch failed');
  let refreshCallCount = 0;
  const refreshAccessToken = async () => {
    refreshCallCount += 1;
    throw cause;
  };

  let thrown;
  try {
    await resolveCredential(doc, 'openai-codex-oauth', oauthManifest, {}, keychain, {
      refreshAccessToken
    });
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown instanceof OAuthExpiredError);
  assert.equal(thrown.code, 'oauth_expired');
  assert.equal(thrown.adapterId, 'openai-codex-oauth');
  assert.equal(thrown.cause, cause);
  assert.ok(thrown.cause instanceof TypeError);

  // 与 401 路径一致：清 keychain，没有写入
  assert.equal(refreshCallCount, 1);
  assert.equal(keychain.calls.delete.length, 1);
  assert.equal(keychain.calls.delete[0], ACCOUNT);
  assert.equal(keychain.calls.write.length, 0);

  // doc.credentials 结构未被破坏（记录仍在，便于用户再次走完整登录流程后写回）
  assert.equal(doc.credentials.length, 1);
  assert.equal(doc.credentials[0].adapterId, 'openai-codex-oauth');
});
