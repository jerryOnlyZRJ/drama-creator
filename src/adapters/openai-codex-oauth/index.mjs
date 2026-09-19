// OpenAI Codex（ChatGPT Plus/Pro 订阅）OAuth 适配器（Phase 3 Task 3）。
//
// 说明：
// - 这是一个独立的内置适配器卡片，credential.methods 只支持 'oauth'，与 api_key 形态的
//   `openai-compatible-text` 不混用。决策依据见 spec 第 9 节 P3Q4-Q1=Y。
// - 端点 / 必备 header 严格对齐 codex-cli（Rust 版）当前的实际做法：直接 POST 到
//   ChatGPT 后端的 codex/responses；除 Authorization 之外还需 OpenAI-Beta、
//   chatgpt-account-id、originator、version 四个 header。未来若 OpenAI 协议变更，
//   需要追源 codex-cli 仓库再同步调整本文件。
// - Body 形态遵循 OpenAI Responses API：instructions + input(role=user, content[type=input_text])。
//   响应解析也对应 Responses API 的 output[].content[].text 路径。

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 暴露常量供测试断言 / 上层日志引用，避免硬编码字符串散落各处。
export const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
// codex-cli 当前发布的 originator / version；保持与官方 CLI 一致以避免被风控拦截。
export const CODEX_ORIGINATOR = 'codex_cli_rs';
export const CODEX_VERSION = '0.21.0';

// 适配器 manifest：纯 OAuth 凭据形态，不展示 endpoint 模板（OAuth 流程没有这种选项）。
export const manifest = {
  contractVersion: '1.0',
  id: 'openai-codex-oauth',
  displayName: 'OpenAI Codex（ChatGPT Plus/Pro 订阅登录）',
  version: '0.1.0',
  kind: 'builtin',
  entry: 'builtin://openai-codex-oauth',
  async: false,
  productionMode: 'in_app',
  // 订阅登录仍由应用直接调用模型端点，和 API Key 一样属于“内置生成”模式。
  execution: { type: 'subscription', credentialMethods: ['oauth'] },
  capabilities: [
    {
      type: 'text_prompt',
      // 订阅通道只能展示应用侧验证过的模型候选；任意模型 ID 只保留给 API Key 自定义端点。
      // 这样设置页会渲染下拉菜单，避免用户手填未验证套餐别名导致“显示一个模型、实际失败或回退”的错觉。
      acceptsAnyModel: false,
      models: [
        {
          id: 'gpt-5-codex',
          label: 'GPT-5 Codex',
          params: {
            temperature: { type: 'number', min: 0, max: 2, step: 0.1, default: 0.7, label: '采样温度' },
            maxTokens: { type: 'number', min: 1, max: 32000, default: 1024, label: '最大 token 数' }
          }
        }
      ]
    }
  ],
  // 不提供模板：OAuth 流程没有 endpoint 选择之分。
  templates: null,
  credential: {
    required: true,
    // 唯一方法 = oauth；与 openai-compatible-text 的 ['api_key','env'] 区隔。
    methods: ['oauth'],
    fields: [
      { key: 'accessToken', label: 'Access Token', secret: true, required: true },
      { key: 'refreshToken', label: 'Refresh Token', secret: true, required: true },
      { key: 'expiresAt', label: 'Expires At (ms)', secret: false, required: false },
      { key: 'accountId', label: 'ChatGPT Account ID', secret: false, required: false }
    ],
    // 没有 env 注入路径：OAuth 流程必须走 keychain。
    env: []
  }
};

// HTTP 状态码 → 标准 error.code 映射（与 openai-compatible-text 保持一致，见契约 §2.2）。
function statusToErrorCode(status) {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'quota_exceeded';
  if (status >= 400 && status < 500) return 'invalid_params';
  return 'unknown';
}

// 主调入口。`fetch` 可注入以便测试断网时也能跑。
export async function generate(input, { fetch: injectedFetch } = {}) {
  const fetchImpl = injectedFetch || globalThis.fetch;
  const cred = input.credential || {};
  // accessToken 缺失 → 直接判定参数错误，避免发起不必要的网络请求。
  if (!cred.accessToken) {
    return { status: 'failed', outputs: [], error: { code: 'invalid_params', message: 'missing accessToken' } };
  }

  // 拼装 Responses API body。temperature / maxTokens 走 Responses API 的字段名。
  const body = {
    model: input.model,
    instructions: input.systemPrompt || '你是 Drama Creator 内置的短剧创作与 AI 素材提示词助手。',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: input.prompt }]
      }
    ],
    stream: false,
    store: false,
    ...(input.params?.temperature !== undefined ? { temperature: input.params.temperature } : {}),
    ...(input.params?.maxTokens !== undefined ? { max_output_tokens: input.params.maxTokens } : {})
  };

  // 按 codex-cli 现行实现拼装 header；accountId 缺失时跳过对应字段。
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cred.accessToken}`,
    'OpenAI-Beta': 'responses=experimental',
    originator: CODEX_ORIGINATOR,
    version: CODEX_VERSION
  };
  if (cred.accountId) {
    headers['chatgpt-account-id'] = cred.accountId;
  }

  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
  } catch (error) {
    // 网络层异常：DNS / 断网 / TLS 故障等，沿用 openai-compatible-text 的兜底文案。
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: `network error: ${error.message}` } };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return {
      status: 'failed',
      outputs: [],
      error: { code: statusToErrorCode(res.status), message: detail.slice(0, 500) || `HTTP ${res.status}` }
    };
  }

  const json = await res.json();
  // Responses API：output 是数组，需找出 type='message' 的项，再聚合其 content 中
  // type='output_text' 的 text 字段。同一回复可能有多段，全部拼接保留。
  const outputArr = Array.isArray(json?.output) ? json.output : [];
  const text = outputArr
    .filter((item) => item && item.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content.filter((c) => c && c.type === 'output_text').map((c) => c.text))
    .filter((t) => typeof t === 'string')
    .join('');

  if (!text) {
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: 'API returned no output text' } };
  }

  // 落盘为 .txt 工件，与 openai-compatible-text 的产物形态保持一致。
  const fileName = `text_${Date.now()}.txt`;
  await writeFile(join(input.outputDir, fileName), text, 'utf8');
  return { status: 'completed', outputs: [{ path: fileName, kind: 'text', role: 'primary' }] };
}
