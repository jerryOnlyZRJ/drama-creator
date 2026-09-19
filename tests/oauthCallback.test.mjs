import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startCodexCallbackServer } from '../src/credentials/oauthCallback.mjs';

// ---- 测试辅助：分配一个空闲端口 ---------------------------------------------------
// 通过 listen(0) 让 OS 分配空闲端口，读取后立即关闭。返回端口号。
// 注意：close 与下游 listen 之间存在极小的竞态窗口，但在本机单测里几乎不会触发。
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// 等待若干毫秒，给 server.listen 留下绑定时间。
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 以指数退避重试发起 GET，应对 listen 尚未完成的瞬间窗口。
async function fetchWithRetry(url, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url);
    } catch (err) {
      lastError = err;
      await sleep(20 * (i + 1));
    }
  }
  throw lastError;
}

// ---- 1. 正常路径：state 匹配 + code 返回成功页 -----------------------------------
test('startCodexCallbackServer resolves with code on valid callback and serves success page', async () => {
  const port = await getFreePort();
  const promise = startCodexCallbackServer({ expectedState: 'S', port, timeoutMs: 5000 });
  // 立即挂载一个安静的 catch，防止后续 await 链中出现 unhandledRejection 抖动
  const safe = promise.catch(() => undefined);
  // 给 server.listen 一点时间完成绑定
  await sleep(20);

  const res = await fetchWithRetry(`http://127.0.0.1:${port}/auth/callback?code=X&state=S`);
  assert.equal(res.status, 200);
  const body = await res.text();
  // 中英双语提示至少匹配其中一句
  assert.ok(body.includes('授权成功') || /Authorization/i.test(body));

  const result = await promise;
  assert.deepEqual(result, { code: 'X' });
  await safe; // 占位 await，避免未使用变量

  // 第一个有效 callback 之后 server 应已关闭：再次连接应失败
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/auth/callback?code=Y&state=S`),
    (err) => err instanceof Error
  );
});

// ---- 2. state mismatch：返回 400 + reject(STATE_MISMATCH) -----------------------
test('startCodexCallbackServer rejects with STATE_MISMATCH when state does not match', async () => {
  const port = await getFreePort();
  const promise = startCodexCallbackServer({ expectedState: 'S', port, timeoutMs: 5000 });
  // 关键：先把 reject 断言挂上去，避免 fetch 发生时 promise 已 reject 而无 catcher
  const rejection = assert.rejects(
    promise,
    (err) => err instanceof Error && err.code === 'STATE_MISMATCH'
  );
  await sleep(20);

  const res = await fetchWithRetry(`http://127.0.0.1:${port}/auth/callback?code=X&state=WRONG`);
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /state mismatch/i);

  await rejection;
});

// ---- 3. 端口被占用：reject 且文案含中文“已被占用” --------------------------------
test('startCodexCallbackServer fails fast with EADDRINUSE when port is already taken', async () => {
  const port = await getFreePort();
  // 先在该端口起一个占位 dummy server，复刻 1455 被占用的场景
  const dummy = createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve, reject) => {
    dummy.once('error', reject);
    dummy.listen(port, '127.0.0.1', resolve);
  });

  try {
    await assert.rejects(
      startCodexCallbackServer({ expectedState: 'S', port, timeoutMs: 5000 }),
      (err) => err instanceof Error && /已被占用/.test(err.message) && err.code === 'EADDRINUSE'
    );
  } finally {
    // 清理 dummy server，避免端口悬挂
    await new Promise((resolve) => dummy.close(() => resolve()));
  }
});

// ---- 4. 超时：未命中 callback 应在 timeoutMs 后 reject(TIMEOUT) -----------------
test('startCodexCallbackServer rejects with TIMEOUT when no callback arrives in time', async () => {
  const port = await getFreePort();
  const start = Date.now();
  await assert.rejects(
    startCodexCallbackServer({ expectedState: 'S', port, timeoutMs: 50 }),
    (err) => err instanceof Error && err.code === 'TIMEOUT'
  );
  const elapsed = Date.now() - start;
  // 允许少量误差：触发后 server 应该已经被释放
  assert.ok(elapsed >= 40, `elapsed should be at least ~50ms, got ${elapsed}`);

  // 端口已被释放：可以再次绑定
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => probe.close(() => resolve()));
});
