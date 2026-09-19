// OpenAI Codex OAuth 临时回调 HTTP 服务器（Phase 3 Task 2）。
//
// 设计原则：
// - 短生命周期：浏览器跳回 redirect_uri 后，第一个有效 callback resolve 即立即关闭 listener
// - 端口硬要求：OpenAI Codex 服务端把 redirect_uri 写死为 http://localhost:1455/auth/callback，
//   端口被占用时直接 fail（按 P3Q4-Q2=a 决策，不实现 device_code 兜底）
// - 防 CSRF：state 必须与发起 authorize 时生成的值完全一致，不一致即 400 + reject
// - 无第三方依赖：仅用 node:http / node:url，便于桌面端打包
//
// 调用方典型用法：
//   const { code } = await startCodexCallbackServer({ expectedState });
//   await exchangeCode({ code, verifier, fetch });

import { createServer } from 'node:http';

// 默认监听端口：OpenAI 服务端硬编码的 1455。生产代码必须用此默认值。
const DEFAULT_PORT = 1455;
// 默认超时：5 分钟，覆盖人工浏览器授权的合理时长上限
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// 默认 callback path：与 CODEX_REDIRECT_URI 中的 path 严格一致
const DEFAULT_PATH_PREFIX = '/auth/callback';

// 成功页 HTML：内联 CSS 简单美化，中英双语提示用户可以关闭窗口。
const SUCCESS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>授权成功 / Authorization Complete</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #f8fafc;
    }
    .card {
      max-width: 420px;
      padding: 32px 40px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.06);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      text-align: center;
    }
    .check {
      width: 64px;
      height: 64px;
      margin: 0 auto 16px;
      border-radius: 50%;
      background: #22c55e;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      font-weight: bold;
      color: white;
    }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { font-size: 14px; line-height: 1.6; opacity: 0.85; margin: 4px 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>授权成功，可关闭此窗口</h1>
    <p>Authorization complete, you may close this window.</p>
  </div>
</body>
</html>`;

// 错误响应统一封装：返回纯文本，避免 HTML 注入风险（state/error 来自 query 参数）。
function sendPlainText(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

// 构造带 code 字段的 Error 实例，方便上层根据 err.code 分支处理。
function makeError(message, code, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      err[k] = v;
    }
  }
  return err;
}

/**
 * 启动一个临时的 HTTP server 监听 OAuth callback。
 *
 * @param {object} options
 * @param {string} options.expectedState  发起 authorize 时生成的 state，用于 CSRF 校验（必填）
 * @param {number} [options.port=1455]    监听端口；生产固定 1455，测试可用 0 让 OS 分配
 * @param {number} [options.timeoutMs=300000]  超时未收到 callback 即 reject
 * @param {string} [options.pathPrefix='/auth/callback']  仅响应该精确路径的 GET 请求
 * @param {AbortSignal} [options.signal]  上层重新发起授权时用于取消当前临时 listener
 * @returns {Promise<{ code: string }>}
 */
export function startCodexCallbackServer(options = {}) {
  const {
    expectedState,
    port = DEFAULT_PORT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pathPrefix = DEFAULT_PATH_PREFIX,
    signal
  } = options;

  if (!expectedState) {
    return Promise.reject(new Error('startCodexCallbackServer 需要传入 expectedState'));
  }
  if (signal?.aborted) {
    return Promise.reject(makeError('OAuth callback listener cancelled before start', 'ABORT_ERR'));
  }

  return new Promise((resolve, reject) => {
    // settled 标志保证 resolve/reject 仅生效一次，且后续 callback 被忽略
    let settled = false;
    let timeoutHandle = null;

    // 统一收尾：clearTimeout + server.close，幂等
    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      signal?.removeEventListener?.('abort', abortHandler);
      try {
        server.close();
      } catch {
        // close 在某些状态下会抛，但我们已经确保 settled，不影响调用方
      }
    };

    // 包装 settle：仅首次有效；之后传入的 resolve/reject 会被忽略
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const abortHandler = () => {
      settleReject(makeError('OAuth callback listener cancelled by newer authorization flow', 'ABORT_ERR'));
    };
    signal?.addEventListener?.('abort', abortHandler, { once: true });

    // 创建 HTTP server：只关心 GET pathPrefix；其他路径回 404 并保持 listener 存活，
    // 等待真正的 callback。注意 OAuth provider 可能用 OPTIONS/HEAD 预检，我们也只匹配 GET。
    const server = createServer((req, res) => {
      // 已经 settle 过的请求一律忽略（幂等：例如用户刷新成功页也不再 resolve 第二次）
      if (settled) {
        sendPlainText(res, 410, 'callback already handled');
        return;
      }

      // 解析 URL：req.url 是相对路径，直接按 dummy host 拼装即可
      let parsed;
      try {
        parsed = new URL(req.url, 'http://127.0.0.1');
      } catch {
        sendPlainText(res, 400, 'invalid request');
        return;
      }

      // 仅处理目标路径的 GET 请求；其他路径回 404 但不结束 Promise
      if (req.method !== 'GET' || parsed.pathname !== pathPrefix) {
        sendPlainText(res, 404, 'not found');
        return;
      }

      const params = parsed.searchParams;
      const code = params.get('code');
      const state = params.get('state');
      const oauthError = params.get('error');

      // CSRF 校验：state 必须与 expectedState 完全一致
      if (state !== expectedState) {
        sendPlainText(res, 400, 'state mismatch (CSRF protection)');
        settleReject(
          makeError(
            `OAuth callback state mismatch: expected ${expectedState}, got ${state}`,
            'STATE_MISMATCH',
            { expectedState, receivedState: state }
          )
        );
        return;
      }

      // OAuth provider 直接报错（带 error= 参数），或缺 code 字段
      if (oauthError || !code) {
        sendPlainText(res, 400, 'missing code');
        const errorDescription = params.get('error_description') || '';
        settleReject(
          makeError(
            oauthError
              ? `OAuth provider returned error: ${oauthError}${errorDescription ? ` (${errorDescription})` : ''}`
              : 'OAuth callback missing required `code` parameter',
            'CALLBACK_ERROR',
            { providerError: oauthError || null, providerErrorDescription: errorDescription || null }
          )
        );
        return;
      }

      // 正常路径：返回成功页 + resolve { code }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(SUCCESS_HTML);
      settleResolve({ code });
    });

    // 端口被占用：按 P3Q4-Q2 决策直接 fail，不做 device_code 兜底
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        settleReject(
          makeError(
            `OAuth 回调端口 ${port} 已被占用：请关闭占用该端口的程序后重试。OpenAI Codex OAuth 强制要求使用 ${port} 端口（redirect_uri 由 OpenAI 服务端硬编码）。`,
            'EADDRINUSE',
            { port }
          )
        );
        return;
      }
      // 其他 listen/运行期错误也归入 fail，避免悬挂
      settleReject(err);
    });

    // 仅绑定 127.0.0.1：与 codex-cli 行为一致，避免在公网接口上暴露临时 listener
    server.listen(port, '127.0.0.1');

    // 超时：未收到 callback → reject(TIMEOUT) + close
    timeoutHandle = setTimeout(() => {
      settleReject(
        makeError(
          `OAuth callback timeout after ${timeoutMs}ms`,
          'TIMEOUT',
          { timeoutMs }
        )
      );
    }, timeoutMs);
    // unref 让超时定时器不阻止进程退出（测试场景里更安全）
    if (timeoutHandle && typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }
  });
}
