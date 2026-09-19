import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Built-in adapter for OpenAI-compatible chat completions APIs (P2Q3).
// 用户侧只有“文本模型 API Key”一个入口；实现侧按服务商 endpoint 在 OpenAI-compatible
// Chat Completions 与 Claude Messages API 之间路由。
export const manifest = {
  contractVersion: '1.0',
  id: 'openai-compatible-text',
  displayName: '文本模型 API Key（GPT / Claude / 国内常用服务商 / Gemini / Grok / Ollama）',
  version: '0.1.0',
  kind: 'builtin',
  entry: 'builtin://openai-compatible-text',
  async: false,
  productionMode: 'in_app',
  // API Key 和 env 都属于应用内直接调用 AI 平台的内置生成路径。
  execution: { type: 'api', credentialMethods: ['api_key', 'env'] },
  capabilities: [
    {
      type: 'text_prompt',
      // 各兼容平台模型名千差万别（deepseek-chat / glm-4-plus / qwen-turbo / kimi-k2 ...），
      // 无法在 manifest 中穷举；开启 acceptsAnyModel 后由用户在请求时自填模型名。
      acceptsAnyModel: true,
      models: [
        { id: 'gpt-4o-mini', params: {
          temperature: { type: 'number', min: 0, max: 2, step: 0.1, default: 0.7, label: '采样温度' },
          maxTokens: { type: 'number', min: 1, max: 32000, default: 1024, label: '最大 token 数' }
        } }
      ]
    }
  ],
  // Settings UI uses these to one-click prefill endpoint + API Key guidance.
  // Order is product-facing: GPT first, then domestic high-usage providers,
  // then common overseas OpenAI-compatible APIs and local Ollama.
  templates: [
    {
      id: 'openai',
      label: 'OpenAI GPT',
      endpoint: 'https://api.openai.com/v1',
      apiKeyUrl: 'https://platform.openai.com/api-keys',
      docsUrl: 'https://developers.openai.com/api/docs',
      defaultModelId: 'gpt-5'
    },
    {
      id: 'anthropic',
      label: 'Claude / Anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      apiKeyUrl: 'https://platform.claude.com/settings/keys',
      docsUrl: 'https://platform.claude.com/docs/en/api/overview',
      defaultModelId: 'claude-sonnet-4-5',
      protocol: 'anthropic_messages'
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/v1',
      apiKeyUrl: 'https://platform.deepseek.com/api_keys',
      docsUrl: 'https://api-docs.deepseek.com/',
      defaultModelId: 'deepseek-chat'
    },
    {
      id: 'qwen',
      label: '通义千问 / 阿里百炼',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
      docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
      defaultModelId: 'qwen-plus'
    },
    {
      id: 'doubao',
      label: '豆包 / 火山方舟',
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKeyUrl: 'https://www.volcengine.com/docs/82379/1541594',
      docsUrl: 'https://www.volcengine.com/docs/82379/1330626',
      defaultModelId: 'doubao-seed-1-6-250615'
    },
    {
      id: 'kimi',
      label: 'Moonshot Kimi',
      endpoint: 'https://api.moonshot.cn/v1',
      apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
      docsUrl: 'https://platform.kimi.ai/docs/api/overview',
      defaultModelId: 'moonshot-v1-8k'
    },
    {
      id: 'glm',
      label: '智谱 GLM',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4',
      apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
      docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
      defaultModelId: 'glm-4-plus'
    },
    {
      id: 'hunyuan',
      label: '腾讯混元',
      endpoint: 'https://api.hunyuan.cloud.tencent.com/v1',
      apiKeyUrl: 'https://cloud.tencent.com/document/product/1729/111008',
      docsUrl: 'https://cloud.tencent.com/document/product/1729/111007',
      defaultModelId: 'hunyuan-turbos-latest'
    },
    {
      id: 'qianfan',
      label: '百度千帆',
      endpoint: 'https://qianfan.baidubce.com/v2',
      apiKeyUrl: 'https://cloud.baidu.com/doc/qianfan/s/wmh8l6tnf',
      docsUrl: 'https://cloud.baidu.com/doc/qianfan/s/Fm2vrveyu',
      defaultModelId: 'ernie-4.5-turbo-128k'
    },
    {
      id: 'minimax',
      label: 'MiniMax',
      endpoint: 'https://api.minimax.io/v1',
      apiKeyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
      docsUrl: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
      defaultModelId: 'MiniMax-M3'
    },
    {
      id: 'siliconflow',
      label: '硅基流动 SiliconFlow',
      endpoint: 'https://api.siliconflow.cn/v1',
      apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
      docsUrl: 'https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions',
      defaultModelId: 'deepseek-ai/DeepSeek-V3.2'
    },
    {
      id: 'spark',
      label: '讯飞星火',
      endpoint: 'https://spark-api-open.xf-yun.com/v1',
      apiKeyUrl: 'https://console.xfyun.cn/app/myapp',
      docsUrl: 'https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html',
      defaultModelId: 'generalv3.5'
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKeyUrl: 'https://aistudio.google.com/app/apikey',
      docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
      defaultModelId: 'gemini-2.5-flash'
    },
    {
      id: 'grok',
      label: 'xAI Grok',
      endpoint: 'https://api.x.ai/v1',
      apiKeyUrl: 'https://console.x.ai/',
      docsUrl: 'https://docs.x.ai/overview',
      defaultModelId: 'grok-4.3'
    },
    {
      id: 'ollama',
      label: '本地 Ollama',
      endpoint: 'http://localhost:11434/v1',
      apiKeyUrl: 'https://docs.ollama.com/api/openai-compatibility',
      docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
      defaultApiKey: 'ollama',
      defaultModelId: 'qwen3:8b'
    }
  ],
  credential: {
    required: true,
    methods: ['api_key', 'env'],
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, required: true },
      { key: 'endpoint', label: 'API Endpoint', secret: false, required: true }
    ],
    env: [
      { key: 'apiKey', envVar: 'DRAMA_CREATOR_OPENAI_COMPATIBLE_KEY' },
      { key: 'endpoint', envVar: 'DRAMA_CREATOR_OPENAI_COMPATIBLE_ENDPOINT' }
    ]
  }
};

// Translate HTTP status to our standard error.code (contract §2.2).
function statusToErrorCode(status) {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'quota_exceeded';
  if (status >= 400 && status < 500) return 'invalid_params';
  return 'unknown';
}

// `fetch` is injectable for unit tests so they never hit a real network.
export async function generate(input, { fetch: injectedFetch } = {}) {
  const fetchImpl = injectedFetch || globalThis.fetch;
  const cred = input.credential || {};
  if (!cred.apiKey) {
    return { status: 'failed', outputs: [], error: { code: 'invalid_params', message: 'missing apiKey' } };
  }
  const endpoint = (cred.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (isAnthropicEndpoint(endpoint)) return generateAnthropic(input, endpoint, fetchImpl);

  const url = `${endpoint}/chat/completions`;
  const body = {
    model: input.model,
    messages: buildChatMessages(input),
    ...('temperature' in (input.params || {}) ? { temperature: input.params.temperature } : {}),
    ...('maxTokens' in (input.params || {}) ? { max_tokens: input.params.maxTokens } : {})
  };

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cred.apiKey}` },
      body: JSON.stringify(body)
    });
  } catch (error) {
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: `network error: ${error.message}` } };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { status: 'failed', outputs: [], error: { code: statusToErrorCode(res.status), message: detail.slice(0, 500) || `HTTP ${res.status}` } };
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: 'API returned no message content' } };
  }

  // Persist output as a .txt artifact so it can be referenced like any other asset.
  const fileName = `text_${Date.now()}.txt`;
  await writeFile(join(input.outputDir, fileName), content, 'utf8');
  return { status: 'completed', outputs: [{ path: fileName, kind: 'text', role: 'primary' }] };
}

async function generateAnthropic(input, endpoint, fetchImpl) {
  const cred = input.credential || {};
  const body = {
    model: input.model,
    max_tokens: input.params?.maxTokens || 1024,
    messages: [{ role: 'user', content: input.prompt }],
    ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
    ...('temperature' in (input.params || {}) ? { temperature: input.params.temperature } : {})
  };

  let res;
  try {
    res = await fetchImpl(`${endpoint}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cred.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: `network error: ${error.message}` } };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { status: 'failed', outputs: [], error: { code: statusToErrorCode(res.status), message: detail.slice(0, 500) || `HTTP ${res.status}` } };
  }

  const json = await res.json();
  const content = extractAnthropicText(json);
  if (!content) {
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: 'Claude API returned no text content' } };
  }

  // Claude 仍产出文本资源，落盘形态与其他文本 API Key 服务商保持一致。
  const fileName = `text_${Date.now()}.txt`;
  await writeFile(join(input.outputDir, fileName), content, 'utf8');
  return { status: 'completed', outputs: [{ path: fileName, kind: 'text', role: 'primary' }] };
}

function isAnthropicEndpoint(endpoint) {
  try {
    return /(^|\.)anthropic\.com$/i.test(new URL(endpoint).hostname);
  } catch {
    return /api\.anthropic\.com/i.test(String(endpoint || ''));
  }
}

function buildChatMessages(input) {
  const messages = [];
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
  messages.push({ role: 'user', content: input.prompt });
  return messages;
}

function extractAnthropicText(json) {
  if (typeof json?.content === 'string') return json.content;
  if (!Array.isArray(json?.content)) return '';
  return json.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();
}
