import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  CODEX_AUTHORIZE_URL,
  CODEX_TOKEN_URL
} from '../src/credentials/oauthCodex.mjs';

// ---- 工具：base64url 编码 / JWT 拼装（仅测试侧用） ---------------------------------
// 把任意 buffer/string 编成 base64url（无 = padding，+ → -，/ → _）。
function toBase64Url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// 拼一个最小可用的 JWT（header.payload.sig），sig 内容不重要，OAuth 客户端只解 payload。
function fakeJwt(payload) {
  const header = toBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = toBase64Url(JSON.stringify(payload));
  return `${header}.${body}.sig`;
}

// 注入式 mock fetch：根据 url + 期望体返回预设响应。
function makeMockFetch(handler) {
  return async function mockFetch(url, init) {
    return handler(url, init);
  };
}

// ---- 1. generatePkce / generateState 基础属性 -------------------------------------
test('generatePkce returns base64url verifier (~43 chars) using only [A-Za-z0-9_-]', () => {
  const { verifier } = generatePkce();
  // 32 字节 base64 无 padding 长度 = ceil(32 / 3 * 4) - padding = 43
  assert.equal(verifier.length, 43);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
});

test('generatePkce returns SHA256 challenge that differs from verifier', () => {
  const { verifier, challenge } = generatePkce();
  assert.equal(challenge.length, 43);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(challenge, verifier);
  // 期望 challenge 严格等于 SHA256(verifier) 的 base64url
  const expected = toBase64Url(createHash('sha256').update(verifier).digest());
  assert.equal(challenge, expected);
});

test('generateState returns 32-character hex string and is non-deterministic', () => {
  const s = generateState();
  assert.equal(s.length, 32);
  assert.match(s, /^[0-9a-f]+$/);
  // 每次调用必须返回不同的 state，以保证防 CSRF
  const s2 = generateState();
  assert.notEqual(s, s2);
});

test('two generatePkce calls produce different verifiers (randomness)', () => {
  const a = generatePkce();
  const b = generatePkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.challenge, b.challenge);
});

// ---- 2. buildAuthorizeUrl -------------------------------------------------------
test('buildAuthorizeUrl contains all required query params for codex_cli flow', () => {
  const verifier = 'a'.repeat(43);
  const state = 'b'.repeat(32);
  const url = new URL(buildAuthorizeUrl({ verifier, state }));

  assert.equal(`${url.origin}${url.pathname}`, CODEX_AUTHORIZE_URL);
  const sp = url.searchParams;
  assert.equal(sp.get('response_type'), 'code');
  assert.equal(sp.get('client_id'), CODEX_CLIENT_ID);
  assert.equal(sp.get('redirect_uri'), CODEX_REDIRECT_URI);
  assert.equal(sp.get('scope'), 'openid profile email offline_access');
  assert.equal(sp.get('code_challenge_method'), 'S256');
  assert.equal(sp.get('state'), state);
  assert.equal(sp.get('id_token_add_organizations'), 'true');
  assert.equal(sp.get('codex_cli_simplified_flow'), 'true');
  assert.equal(sp.get('originator'), 'codex_cli_rs');
  // 任务规格里列出的 codex_cli 参数总共 10 个（含独立的 code_challenge_method）
  const keys = [...sp.keys()];
  assert.equal(keys.length, 10);
});

test('buildAuthorizeUrl computes code_challenge as SHA256(verifier) base64url', () => {
  const verifier = 'fixed-verifier-value-for-test';
  const state = 'cafebabe'.repeat(4);
  const url = new URL(buildAuthorizeUrl({ verifier, state }));
  const expected = toBase64Url(createHash('sha256').update(verifier).digest());
  assert.equal(url.searchParams.get('code_challenge'), expected);
});

// 任务要求 redirect_uri 必须按百分号编码出现在拼接后的查询串中。
test('buildAuthorizeUrl percent-encodes redirect_uri in the raw query string', () => {
  const verifier = 'a'.repeat(43);
  const state = 'b'.repeat(32);
  const raw = buildAuthorizeUrl({ verifier, state });
  // 直接在原始 URL 字符串中查找百分号编码后的形态
  assert.ok(raw.includes('redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'));
});

// ---- 3. exchangeCode -------------------------------------------------------------
test('exchangeCode parses access_token / refresh_token / expiresAt / accountId on 200', async () => {
  const access = fakeJwt({ chatgpt_account_id: 'acct_test', sub: 'u-1' });
  const fetchMock = makeMockFetch(async (url, init) => {
    assert.equal(url, CODEX_TOKEN_URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    // body 必须是 form-urlencoded 字符串
    assert.equal(typeof init.body, 'string');
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('client_id'), CODEX_CLIENT_ID);
    assert.equal(params.get('code'), 'CODE-123');
    assert.equal(params.get('code_verifier'), 'VERIFIER-ABC');
    assert.equal(params.get('redirect_uri'), CODEX_REDIRECT_URI);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: access,
          refresh_token: 'rt_new',
          expires_in: 3600
        };
      },
      async text() {
        return '';
      }
    };
  });

  const before = Date.now();
  const result = await exchangeCode({ code: 'CODE-123', verifier: 'VERIFIER-ABC', fetch: fetchMock });
  const after = Date.now();
  assert.equal(result.accessToken, access);
  assert.equal(result.refreshToken, 'rt_new');
  assert.equal(result.accountId, 'acct_test');
  // expiresAt 应在 [before+3600s, after+3600s] 之间
  assert.ok(result.expiresAt >= before + 3600 * 1000);
  assert.ok(result.expiresAt <= after + 3600 * 1000);
});

test('exchangeCode throws Error containing status when fetch returns 401', async () => {
  const fetchMock = makeMockFetch(async () => ({
    ok: false,
    status: 401,
    async json() {
      throw new Error('not json');
    },
    async text() {
      return 'invalid_grant';
    }
  }));

  await assert.rejects(
    exchangeCode({ code: 'BAD', verifier: 'V', fetch: fetchMock }),
    (err) => /401/.test(err.message) && /invalid_grant/.test(err.message)
  );
});

// ---- 4. refreshAccessToken -----------------------------------------------------
test('refreshAccessToken parses new tokens on 200', async () => {
  const access = fakeJwt({ 'https://api.openai.com/auth/account_id': 'acct_via_claim' });
  const fetchMock = makeMockFetch(async (url, init) => {
    assert.equal(url, CODEX_TOKEN_URL);
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('grant_type'), 'refresh_token');
    assert.equal(params.get('client_id'), CODEX_CLIENT_ID);
    assert.equal(params.get('refresh_token'), 'OLD-RT');
    assert.equal(params.get('scope'), 'openid profile email offline_access');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: access,
          refresh_token: 'NEW-RT',
          expires_in: 1800
        };
      },
      async text() {
        return '';
      }
    };
  });

  const result = await refreshAccessToken({ refreshToken: 'OLD-RT', fetch: fetchMock });
  assert.equal(result.accessToken, access);
  assert.equal(result.refreshToken, 'NEW-RT');
  assert.equal(result.accountId, 'acct_via_claim');
  assert.ok(result.expiresAt > Date.now());
});

test('refreshAccessToken keeps old refresh_token when response omits it', async () => {
  const access = fakeJwt({ sub: 'fallback-sub-only' });
  const fetchMock = makeMockFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        access_token: access,
        // 故意不返 refresh_token
        expires_in: 600
      };
    },
    async text() {
      return '';
    }
  }));

  const result = await refreshAccessToken({ refreshToken: 'KEEP-ME', fetch: fetchMock });
  assert.equal(result.refreshToken, 'KEEP-ME');
  // 没有 chatgpt_account_id / openai claim → 回退到 sub
  assert.equal(result.accountId, 'fallback-sub-only');
});

// 网络错误（fetch 直接抛异常）应原样向上透传，避免吞掉底层错误信息。
test('refreshAccessToken propagates network error from injected fetch', async () => {
  const fetchMock = async () => {
    throw new Error('ENETDOWN: simulated network failure');
  };
  await assert.rejects(
    refreshAccessToken({ refreshToken: 'RT', fetch: fetchMock }),
    (err) => /ENETDOWN/.test(err.message)
  );
});
