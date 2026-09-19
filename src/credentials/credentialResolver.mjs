// 解析适配器 generate 入口所需的 credential 对象，遵循注入优先级（P1Q6 / §6.4）：
// 1) 若 manifest.credential.env 声明的全部环境变量都存在 → 返回 null（env bypass，由适配器自己读环境）
// 2) 否则若 doc.credentials[] 中存在该适配器记录 → 合并 keychain secrets + document publicFields
// 3) 否则 → 返回 null（适配器尚未配置；HTTP 层应在调用 generate 前拒绝）
//
// Phase 3 Task 4 新增 OAuth 路径（P3Q4-Q4）：当对应记录的 method 是 'oauth' 时：
//   - 读取 publicFields.expiresAt（毫秒时间戳）
//   - 距过期 > 60s：直接返回合并 credential
//   - 距过期 ≤ 60s（含已过期）：调用 refreshAccessToken 刷新
//       · 成功：写回 keychain（覆盖 accessToken/refreshToken），并在内存中 mutate
//         doc.credentials[i].publicFields.{expiresAt,accountId}（不写盘，由调用方负责持久化）
//       · 失败：调 keychain.deleteSecret 清空，并抛 OAuthExpiredError（code='oauth_expired'）
//
// 副作用边界：
//   - 默认仅 keychain.readSecret 一处副作用
//   - OAuth 刷新成功路径会额外触发 keychain.writeSecret + doc.credentials[i].publicFields 的 in-place mutation
//   - OAuth 刷新失败路径会触发 keychain.deleteSecret，并以异常形式中断；不会修改 doc.credentials 结构
//
// @param {object} doc - 项目文档（含可选的 `credentials[]`）
// @param {string} adapterId - 适配器标识
// @param {object} manifest - 适配器 manifest，声明 credential 需求 / env 映射
// @param {object} env - 环境变量表（通常为 `process.env`）
// @param {{ readSecret: (account: string) => Promise<string|null>,
//           writeSecret?: (account: string, payload: string) => Promise<void>,
//           deleteSecret?: (account: string) => Promise<void> }} keychain - keychain 适配
// @param {{ fetch?: Function, now?: () => number, refreshAccessToken?: Function }} [options]
//   - fetch：注入给 refreshAccessToken 的 fetch 实现，默认 globalThis.fetch
//   - now：注入当前时间（ms），方便 fakeTimers / 单测，默认 Date.now
//   - refreshAccessToken：注入刷新逻辑（避免单测真的引入网络层），默认从 oauthCodex.mjs 动态 import
// @returns {Promise<object|null>} 合并后的 credential，或 null（不应注入）
export async function resolveCredential(doc, adapterId, manifest, env, keychain, options = {}) {
  // 适配器没有声明任何 credential 需求 → 不注入
  if (!manifest?.credential?.required) return null;

  // env bypass：仅当声明的每一项 env var 都存在时触发（P1Q6）
  // 期望适配器自己读环境变量，因此返回 null
  const envSpecs = manifest.credential.env || [];
  if (envSpecs.length > 0 && envSpecs.every((spec) => env?.[spec.envVar])) {
    return null;
  }

  // 在文档中查找该适配器的 credential 记录
  const credRecord = (doc.credentials || []).find((c) => c.adapterId === adapterId);
  if (!credRecord) return null;

  // 拉 keychain 中的 secret payload；缺失或损坏都只能说明当前通道不可用，
  // 不能让上层 AI 入口直接 500，后续候选模型仍应有机会执行。
  const raw = await keychain.readSecret(credRecord.keychainAccount);
  const secrets = parseKeychainSecretPayload(raw);
  if (secrets === null) return null;
  const requiredSecretKeys = Array.isArray(credRecord.secretFieldKeys) ? credRecord.secretFieldKeys : [];
  if (requiredSecretKeys.some((key) => !hasUsableSecretValue(secrets[key]))) {
    return null;
  }
  const publicFields = credRecord.publicFields || {};

  // 仅在记录的 method 为 'oauth' 时进入刷新分支
  // （兼容历史 api_key 记录：当 method 为 'api_key' 时按现有逻辑直接合并）
  if (credRecord.method === 'oauth') {
    // 时间源 / fetch / 刷新逻辑均允许注入，便于测试与未来在 Tauri 壳内复用
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const fetchImpl = options.fetch || globalThis.fetch;
    // 默认动态 import oauthCodex 中的 refresh 实现，避免与单测路径耦合
    const refreshImpl = options.refreshAccessToken
      || (async (args) => {
        const mod = await import('./oauthCodex.mjs');
        return mod.refreshAccessToken(args);
      });

    const expiresAt = Number(publicFields.expiresAt);
    // expiresAt 缺失或不是合法数字 → 等价于「未配置」
    if (!Number.isFinite(expiresAt)) {
      return null;
    }

    // 距离过期还剩多少毫秒；阈值 60s（含已过期场景）触发刷新
    const remainingMs = expiresAt - now();
    if (remainingMs > 60_000) {
      // 仍在有效期内：直接合并 secret + publicFields 返回
      return { ...secrets, ...publicFields };
    }

    // 临近或已过期：尝试刷新
    try {
      const refreshed = await refreshImpl({
        refreshToken: secrets.refreshToken,
        fetch: fetchImpl
      });

      // 写回 keychain：仅保存 secret 部分（access/refresh token）
      const newSecretPayload = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken
      };
      await keychain.writeSecret(credRecord.keychainAccount, JSON.stringify(newSecretPayload));

      // 同步更新 doc.credentials[i].publicFields（in-place mutate；不写盘）
      // 调用方（handleGenerate）随后会 writeFile docPath，从而把新的 expiresAt 落盘
      credRecord.publicFields = {
        ...publicFields,
        expiresAt: refreshed.expiresAt,
        accountId: refreshed.accountId ?? publicFields.accountId
      };

      return {
        ...newSecretPayload,
        ...credRecord.publicFields
      };
    } catch (cause) {
      // 刷新失败：清 keychain，并抛 OAuthExpiredError 让上层翻译为 401
      // 不修改 doc.credentials 结构，避免在网络抖动等情况下污染文档
      try {
        if (typeof keychain.deleteSecret === 'function') {
          await keychain.deleteSecret(credRecord.keychainAccount);
        }
      } catch {
        // keychain 清理失败不应掩盖原始 OAuth 错误
      }
      throw new OAuthExpiredError(adapterId, cause);
    }
  }

  // 非 OAuth 路径：保持原行为（merge keychain secrets + document public fields）
  return { ...secrets, ...publicFields };
}

function parseKeychainSecretPayload(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasUsableSecretValue(value) {
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

// OAuth credential 已过期且自动刷新失败的领域错误。
// HTTP 层（handleGenerate）会捕获 code === 'oauth_expired' 并返回 401，
// 让前端 settings 页弹出「订阅登录已过期」的 banner 引导重新登录。
export class OAuthExpiredError extends Error {
  constructor(adapterId, cause) {
    super(`OAuth credential expired and refresh failed for adapter: ${adapterId}`);
    this.code = 'oauth_expired';
    this.adapterId = adapterId;
    // 保存底层原因（refreshAccessToken 抛出的 Error），便于日志诊断
    this.cause = cause;
  }
}
