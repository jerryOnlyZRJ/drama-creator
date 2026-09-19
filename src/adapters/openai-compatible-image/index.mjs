import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Built-in adapter for OpenAI-compatible image generation APIs (P2T5).
// Calls `<endpoint>/images/generations`, then downloads the returned remote
// URL into outputDir so the canvas can render it like any local asset.
export const manifest = {
  contractVersion: '1.0',
  id: 'openai-compatible-image',
  displayName: 'OpenAI 兼容图片（GPT Image / Seedream 等）',
  version: '0.1.0',
  kind: 'builtin',
  entry: 'builtin://openai-compatible-image',
  async: false,
  productionMode: 'in_app',
  // 兼容图片接口由应用直接发起 HTTP 请求，属于内置生成路径。
  execution: { type: 'api', credentialMethods: ['api_key', 'env'] },
  capabilities: [
    {
      type: 'image',
      // 同 text 适配器：兼容平台图片模型名（gpt-image-2 / doubao-seedream ...）需用户自填。
      acceptsAnyModel: true,
      models: [
        { id: 'gpt-image-2', params: {
          size: { type: 'enum', options: ['1024x1024', '1024x1792', '1792x1024'], default: '1024x1024', label: '尺寸' }
        } }
      ]
    }
  ],
  // Settings UI uses these to one-click prefill endpoint + API Key guidance.
  // Image defaults stay GPT-first; Seedream is the domestic API fallback that
  // matches the existing /images/generations implementation.
  templates: [
    {
      id: 'openai',
      label: 'OpenAI GPT Image',
      endpoint: 'https://api.openai.com/v1',
      apiKeyUrl: 'https://platform.openai.com/api-keys',
      docsUrl: 'https://developers.openai.com/api/docs/guides/image-generation',
      defaultModelId: 'gpt-image-2'
    },
    {
      id: 'volcengine-ark',
      label: '火山方舟 Seedream',
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKeyUrl: 'https://www.volcengine.com/docs/82379/1541594',
      docsUrl: 'https://www.volcengine.com/docs/82379/1541523',
      defaultModelId: 'doubao-seedream-4-0-250828'
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
  // Only forward `size` when explicitly set; OpenAI rejects unknown enum values.
  const body = {
    model: input.model,
    prompt: input.prompt,
    ...('size' in (input.params || {}) ? { size: input.params.size } : {})
  };

  // Step 1: ask the API to generate an image and return a remote URL.
  let res;
  try {
    res = await fetchImpl(`${endpoint}/images/generations`, {
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
  const remoteUrl = json?.data?.[0]?.url;
  if (!remoteUrl) {
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: 'API returned no image URL' } };
  }

  // Step 2: download the bytes into outputDir so the canvas can render it like any local asset.
  let imgRes;
  try {
    imgRes = await fetchImpl(remoteUrl);
  } catch (error) {
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: `image download failed: ${error.message}` } };
  }
  if (!imgRes.ok) {
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: `image download HTTP ${imgRes.status}` } };
  }
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const fileName = `image_${Date.now()}.png`;
  await writeFile(join(input.outputDir, fileName), buf);
  // Adapter outputs are episode-relative; outputDir points at episode/raw-videos.
  return { status: 'completed', outputs: [{ path: `raw-videos/${fileName}`, kind: 'image', role: 'primary' }] };
}
