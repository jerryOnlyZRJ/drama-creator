import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

// MiniMax 自有多模态 API 适配器：同一个 API Key 同时覆盖图片与视频能力。
// 官方接口不是 OpenAI /images/generations 形态，因此单独实现，避免把非兼容平台硬塞进兼容适配器。
export const manifest = {
  contractVersion: '1.0',
  id: 'minimax-media',
  displayName: 'MiniMax 图片与视频',
  version: '0.1.0',
  kind: 'builtin',
  entry: 'builtin://minimax-media',
  async: true,
  productionMode: 'in_app',
  // MiniMax 通过 API Key 提交/轮询任务，应用负责下载产物并写回项目。
  execution: { type: 'api', credentialMethods: ['api_key', 'env'] },
  capabilities: [
    {
      type: 'image',
      acceptsAnyModel: true,
      models: [
        { id: 'image-01', params: {
          width: { type: 'number', min: 512, max: 2048, step: 64, default: 1024, label: '宽度' },
          height: { type: 'number', min: 512, max: 2048, step: 64, default: 1024, label: '高度' }
        } }
      ]
    },
    {
      type: 'video',
      acceptsAnyModel: true,
      models: [
        { id: 'MiniMax-Hailuo-2.3', params: {
          duration: { type: 'number', min: 2, max: 10, step: 1, default: 5, label: '时长（秒）' },
          resolution: { type: 'enum', options: ['768P', '1080P'], default: '768P', label: '清晰度' }
        } }
      ]
    }
  ],
  // MiniMax 的图片和视频是平台自有任务接口；这里仍提供 API Key 入口和默认模型提示。
  templates: [
    {
      id: 'minimax',
      label: 'MiniMax',
      endpoint: 'https://api.minimax.io/v1',
      apiKeyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
      docsUrl: 'https://platform.minimax.io/docs/guides/quickstart-preparation',
      defaultModelId: 'MiniMax-Hailuo-2.3',
      recommendedModels: ['image-01', 'MiniMax-Hailuo-2.3']
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
      { key: 'apiKey', envVar: 'DRAMA_CREATOR_MINIMAX_API_KEY' },
      { key: 'endpoint', envVar: 'DRAMA_CREATOR_MINIMAX_ENDPOINT' }
    ]
  }
};

function statusToErrorCode(status) {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'quota_exceeded';
  if (status >= 400 && status < 500) return 'invalid_params';
  return 'unknown';
}

export async function generate(input, { fetch: injectedFetch } = {}) {
  if (input.capability === 'image') return generateImage(input, { fetch: injectedFetch });
  if (input.capability === 'video') return generateVideo(input, { fetch: injectedFetch });
  return { status: 'failed', outputs: [], error: { code: 'invalid_params', message: `unsupported capability: ${input.capability}` } };
}

async function generateImage(input, { fetch: injectedFetch } = {}) {
  const fetchImpl = injectedFetch || globalThis.fetch;
  const credential = normalizeCredential(input.credential);
  if (!credential.apiKey) return missingApiKey();

  const body = {
    model: input.model,
    prompt: input.prompt,
    response_format: 'url',
    width: input.params?.width,
    height: input.params?.height
  };
  const response = await postJson(fetchImpl, apiUrl(credential.endpoint, '/image_generation'), credential.apiKey, body);
  if (!response.ok) return responseToFailed(response);
  const json = await response.json();
  const imageUrl = extractImageUrl(json);
  if (!imageUrl) return { status: 'failed', outputs: [], error: { code: 'unknown', message: 'MiniMax did not return an image URL' } };

  const fileName = `image_${Date.now()}.png`;
  const downloaded = await downloadToOutput(fetchImpl, imageUrl, input.outputDir, fileName);
  if (downloaded.status === 'failed') return downloaded;
  return { status: 'completed', outputs: [{ path: `raw-videos/${fileName}`, kind: 'image', role: 'primary' }] };
}

async function generateVideo(input, { fetch: injectedFetch } = {}) {
  const fetchImpl = injectedFetch || globalThis.fetch;
  const credential = normalizeCredential(input.credential);
  if (!credential.apiKey) return missingApiKey();

  const body = {
    model: input.model,
    prompt: input.prompt,
    duration: input.params?.duration,
    resolution: input.params?.resolution,
    ...(await firstFramePayload(input))
  };
  const response = await postJson(fetchImpl, apiUrl(credential.endpoint, '/video_generation'), credential.apiKey, body);
  if (!response.ok) return responseToFailed(response);
  const json = await response.json();
  const taskId = extractTaskId(json);
  if (!taskId) return { status: 'failed', outputs: [], error: { code: 'unknown', message: 'MiniMax did not return a task id' } };
  return { status: 'generating', outputs: [], externalJobId: taskId };
}

export async function poll(input, { fetch: injectedFetch } = {}) {
  const fetchImpl = injectedFetch || globalThis.fetch;
  const credential = normalizeCredential(input.credential);
  if (!credential.apiKey) return missingApiKey();

  const queryUrl = `${apiUrl(credential.endpoint, '/query/video_generation')}?task_id=${encodeURIComponent(input.externalJobId)}`;
  const response = await fetchImpl(queryUrl, { headers: { Authorization: `Bearer ${credential.apiKey}` } });
  if (!response.ok) return responseToFailed(response);
  const json = await response.json();
  const state = normalizeRemoteStatus(json.status || json.data?.status || json.task_status);
  if (state === 'generating') return { status: 'generating', outputs: [], progress: extractProgress(json) };
  if (state === 'failed') {
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: json.message || json.error_msg || 'MiniMax video generation failed' } };
  }

  const videoUrl = extractVideoUrl(json);
  if (!videoUrl) return { status: 'generating', outputs: [], progress: extractProgress(json) };
  const fileName = `video_${Date.now()}.mp4`;
  const downloaded = await downloadToOutput(fetchImpl, videoUrl, input.outputDir, fileName);
  if (downloaded.status === 'failed') return downloaded;
  return { status: 'completed', outputs: [{ path: `raw-videos/${fileName}`, kind: 'video', role: 'primary' }] };
}

function normalizeCredential(credential) {
  return {
    apiKey: credential?.apiKey || process.env.DRAMA_CREATOR_MINIMAX_API_KEY || '',
    endpoint: credential?.endpoint || process.env.DRAMA_CREATOR_MINIMAX_ENDPOINT || 'https://api.minimax.io/v1'
  };
}

function missingApiKey() {
  return { status: 'failed', outputs: [], error: { code: 'invalid_params', message: 'missing apiKey' } };
}

function apiUrl(endpoint, path) {
  const clean = String(endpoint || '').replace(/\/+$/, '');
  if (clean.endsWith('/v1') && path.startsWith('/v1/')) return `${clean}${path.slice(3)}`;
  return `${clean}${path.startsWith('/') ? path : `/${path}`}`;
}

async function postJson(fetchImpl, url, apiKey, body) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
}

async function responseToFailed(response) {
  const detail = await response.text().catch(() => '');
  return { status: 'failed', outputs: [], error: { code: statusToErrorCode(response.status), message: detail.slice(0, 500) || `HTTP ${response.status}` } };
}

function extractImageUrl(json) {
  return json?.data?.image_urls?.[0]
    || json?.image_urls?.[0]
    || json?.data?.[0]?.url
    || json?.images?.[0]?.url
    || null;
}

function extractTaskId(json) {
  return json?.task_id || json?.data?.task_id || json?.id || json?.data?.id || null;
}

function normalizeRemoteStatus(status) {
  const value = String(status || '').toLowerCase();
  if (['success', 'succeeded', 'completed', 'done'].includes(value)) return 'completed';
  if (['fail', 'failed', 'error'].includes(value)) return 'failed';
  return 'generating';
}

function extractProgress(json) {
  const raw = json?.progress ?? json?.data?.progress;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value > 1 ? value / 100 : value)) : undefined;
}

function extractVideoUrl(json) {
  return json?.video_url
    || json?.data?.video_url
    || json?.data?.file?.url
    || json?.file?.url
    || json?.output?.video_url
    || null;
}

async function firstFramePayload(input) {
  const firstImage = (input.references || []).find((item) => item.kind === 'image');
  if (!firstImage?.path) return {};
  if (/^https?:\/\//i.test(firstImage.path)) return { first_frame_image: firstImage.path };
  try {
    const episodeRoot = dirname(input.outputDir);
    const filePath = join(episodeRoot, firstImage.path);
    const bytes = await readFile(filePath);
    const mime = extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    return { first_frame_image: `data:${mime};base64,${bytes.toString('base64')}` };
  } catch {
    // 参考图不是必须字段；读取失败时让平台按纯文本生成，不阻塞整次任务。
    return {};
  }
}

async function downloadToOutput(fetchImpl, url, outputDir, fileName) {
  const response = await fetchImpl(url);
  if (!response.ok) return { status: 'failed', outputs: [], error: { code: 'unknown', message: `download HTTP ${response.status}` } };
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(join(outputDir, fileName), bytes);
  return { status: 'completed' };
}
