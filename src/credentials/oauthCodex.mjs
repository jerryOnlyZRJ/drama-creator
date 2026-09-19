// OpenAI Codex OAuth 客户端纯逻辑层（Phase 3 Task 1）。
//
// 设计原则：
// - 纯函数：所有 IO（fetch / 随机源以外）均通过参数注入，方便单元测试与未来在 Tauri 壳内复用
// - 无第三方依赖：仅 node 内置 `node:crypto` / `node:url`，避免桌面端打包负担
// - 与 codex-cli（Rust 版）行为一致：authorize URL 的 9 个查询参数、token 端点的 form-urlencoded
//   body、JWT payload 中 accountId 的多 claim 回退顺序，都参考了官方 CLI 在 2026-06 当前的实现
//
// 注意点：
// - `state` 必须独立于 PKCE `verifier` 随机生成。Anthropic 的 OAuth 把两者合一，但 OpenAI 的服务端
//   会显式校验，混用会被拒。这里用单独的 16 字节十六进制串
// - token 端点要求 `application/x-www-form-urlencoded`（不是 JSON）。把 body 写成 JSON 会被 OpenAI
//   返 400 invalid_request，这是踩过的坑

import { randomBytes, createHash } from 'node:crypto';

// ---- 公开常量：供 Task 2/3/4 复用 ---------------------------------------------------
// OpenAI Codex CLI 注册的固定 client_id（公开身份，按 PKCE 流程不带 secret）。
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
// 1455 是 codex-cli 沿用的本地 callback 端口；Phase 3 Task 2 会起一个临时 server 监听它。
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
// 授权页地址（用户浏览器跳转过去）与 token 端点（服务端 form post）。
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

// codex-cli 在 authorize 调用上额外要求的三个开关位（缺一个会被服务端驳回）。
const CODEX_EXTRA_AUTH_PARAMS = {
  id_token_add_organizations: 'true',
  codex_cli_simplified_flow: 'true',
  originator: 'codex_cli_rs'
};

// 统一的 OAuth scope；refresh_token 调用时也要带上同一组 scope。
const CODEX_SCOPE = 'openid profile email offline_access';

// ---- 内部工具：base64url 编码 + JWT payload 解码 -------------------------------------
// base64url：base64 去掉末尾 `=`，把 `+` `/` 换成 `-` `_`。OAuth/PKCE 强制要求该形态。
function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// base64url → buffer（解码 JWT 中段时用）。
function fromBase64Url(str) {
  // 还原 base64 标准字符 + 补齐 padding，再让 Node 自带的 base64 解码处理。
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

// 从 JWT 的 payload 中按官方 codex-cli 的优先级回退取 accountId。
// 优先 chatgpt_account_id（订阅账号 ID），再 OpenAI 自定义 claim，最后兜底 sub。
function extractAccountIdFromJwt(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length < 2) return null;
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(parts[1]).toString('utf8'));
  } catch {
    return null;
  }
  return (
    payload.chatgpt_account_id ||
    payload['https://api.openai.com/auth/account_id'] ||
    payload.sub ||
    null
  );
}

// ---- 公开 API ---------------------------------------------------------------------

// 生成 PKCE verifier + challenge。verifier 是 32 字节随机的 base64url；challenge 是其 SHA256。
// PKCE 用来防中间人替换授权码，OpenAI 强制 S256 method。
export function generatePkce() {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// 生成 OAuth state：16 字节随机 hex（恒为 32 字符）。
// 必须独立于 verifier — 不少社区代码把两者复用，OpenAI 会拒。
export function generateState() {
  return randomBytes(16).toString('hex');
}

// 拼装 authorize URL。内部计算 challenge，调用方只需传 verifier + state。
// 9 个查询参数严格对齐 codex-cli Rust 版的实现，多一个少一个都会被服务端驳回。
export function buildAuthorizeUrl({ verifier, state }) {
  if (!verifier || !state) {
    throw new Error('buildAuthorizeUrl 需要同时提供 verifier 和 state');
  }
  const challenge = toBase64Url(createHash('sha256').update(verifier).digest());
  const url = new URL(CODEX_AUTHORIZE_URL);
  // 注意 URL 自己会把 scope 中的空格编码成 `+` 或 `%20`，两种都被服务端接受。
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', CODEX_REDIRECT_URI);
  url.searchParams.set('scope', CODEX_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  for (const [k, v] of Object.entries(CODEX_EXTRA_AUTH_PARAMS)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

// 内部辅助：调 OpenAI token 端点并解析响应。
// `params` 为 URLSearchParams，按 form-urlencoded 编码 body。
async function postTokenForm(params, fetchImpl) {
  const res = await fetchImpl(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok) {
    // 失败统一抛 Error 含 status + body 前 500 字符摘要，方便上层日志定位
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '<unreadable body>';
    }
    const snippet = String(bodyText).slice(0, 500);
    throw new Error(`OAuth token endpoint returned ${res.status}: ${snippet}`);
  }
  const data = await res.json();
  return data;
}

// 把 token 端点 JSON 响应归一化为 drama-creator 内部 credential 形态。
// fallbackRefreshToken：refresh 调用时若服务端不回新 refresh_token，则保留旧值。
function normalizeTokenResponse(data, fallbackRefreshToken) {
  // 必填字段校验：access_token / expires_in 始终需要；refresh_token 在交换码场景必填，
  // 在 refresh 场景缺失时由 fallbackRefreshToken 兜底
  if (!data || typeof data !== 'object') {
    throw new Error('invalid token response: missing field');
  }
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token || fallbackRefreshToken || null;
  const expiresInRaw = data.expires_in;
  if (!accessToken || !refreshToken || expiresInRaw == null) {
    throw new Error('invalid token response: missing field');
  }
  const expiresIn = Number(expiresInRaw) || 0;
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    accountId: extractAccountIdFromJwt(accessToken)
  };
}

// 用授权码换 token。注意 body 必须是 form-urlencoded（OpenAI 不接受 JSON）。
export async function exchangeCode({ code, verifier, fetch }) {
  if (!fetch) throw new Error('exchangeCode 需要注入 fetch 实现');
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: CODEX_REDIRECT_URI
  });
  const data = await postTokenForm(params, fetch);
  return normalizeTokenResponse(data, null);
}

// 用 refresh_token 续期。OpenAI 可能回新 refresh_token，也可能不回；不回时沿用旧值，
// 避免上层在写回 keychain 时清空 refreshToken 导致下一次刷新无法进行。
export async function refreshAccessToken({ refreshToken, fetch }) {
  if (!fetch) throw new Error('refreshAccessToken 需要注入 fetch 实现');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CODEX_CLIENT_ID,
    refresh_token: refreshToken,
    scope: CODEX_SCOPE
  });
  const data = await postTokenForm(params, fetch);
  return normalizeTokenResponse(data, refreshToken);
}
