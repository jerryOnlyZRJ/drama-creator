import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

// 火山方舟内容生成任务适配器，优先覆盖 Seedance / 豆包视频类模型。
// 其接口是“提交任务 + 查询任务”的平台自有形态，不与 OpenAI 图片接口共用实现。
export const manifest = {
  contractVersion: '1.0',
  id: 'volcengine-ark-video',
  displayName: '火山方舟视频（Seedance）',
  version: '0.1.0',
  kind: 'builtin',
  entry: 'builtin://volcengine-ark-video',
  async: true,
  productionMode: 'in_app',
  // 火山方舟是 API 调用型视频生成，和浏览器跳转型即梦分层展示。
  execution: { type: 'api', credentialMethods: ['api_key', 'env'] },
  capabilities: [
    {
      type: 'video',
      acceptsAnyModel: true,
      models: [
        { id: 'doubao-seedance-2-0-fast-260128', params: {
          duration: { type: 'number', min: 2, max: 12, step: 1, default: 5, label: '时长（秒）' },
          resolution: { type: 'enum', options: ['480p', '720p', '1080p'], default: '720p', label: '清晰度' },
          cameraFixed: { type: 'boolean', default: false, label: '固定镜头' }
        } },
        { id: 'doubao-seedance-2-0-260128', params: {
          duration: { type: 'number', min: 2, max: 12, step: 1, default: 5, label: '时长（秒）' },
          resolution: { type: 'enum', options: ['480p', '720p', '1080p'], default: '720p', label: '清晰度' },
          cameraFixed: { type: 'boolean', default: false, label: '固定镜头' }
        } }
      ]
    }
  ],
  // API 视频通道作为即梦自动化的内置生成备选；默认仍优先即梦外部生产流。
  templates: [
    {
      id: 'volcengine-ark',
      label: '火山方舟 Seedance',
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKeyUrl: 'https://www.volcengine.com/docs/82379/1541594',
      docsUrl: 'https://www.volcengine.com/docs/82379/1520757',
      defaultModelId: 'doubao-seedance-2-0-fast-260128',
      recommendedModels: ['doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-260128']
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
      { key: 'apiKey', envVar: 'DRAMA_CREATOR_VOLCENGINE_ARK_API_KEY' },
      { key: 'endpoint', envVar: 'DRAMA_CREATOR_VOLCENGINE_ARK_ENDPOINT' }
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
  const fetchImpl = injectedFetch || globalThis.fetch;
  const credential = normalizeCredential(input.credential);
  if (!credential.apiKey) return missingApiKey();

  const body = {
    model: input.model,
    content: await buildContent(input)
  };
  const response = await fetchImpl(apiUrl(credential.endpoint, '/contents/generations/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential.apiKey}` },
    body: JSON.stringify(body)
  });
  if (!response.ok) return responseToFailed(response);

  const json = await response.json();
  const taskId = extractTaskId(json);
  if (!taskId) return { status: 'failed', outputs: [], error: { code: 'unknown', message: 'Volcengine Ark did not return a task id' } };
  return { status: 'generating', outputs: [], externalJobId: taskId };
}

export async function poll(input, { fetch: injectedFetch } = {}) {
  const fetchImpl = injectedFetch || globalThis.fetch;
  const credential = normalizeCredential(input.credential);
  if (!credential.apiKey) return missingApiKey();

  const response = await fetchImpl(apiUrl(credential.endpoint, `/contents/generations/tasks/${encodeURIComponent(input.externalJobId)}`), {
    headers: { Authorization: `Bearer ${credential.apiKey}` }
  });
  if (!response.ok) return responseToFailed(response);

  const json = await response.json();
  const state = normalizeRemoteStatus(json.status || json.data?.status || json.task_status);
  if (state === 'generating') return { status: 'generating', outputs: [], progress: extractProgress(json) };
  if (state === 'failed') {
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: json.message || json.error?.message || 'Volcengine Ark video generation failed' } };
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
    apiKey: credential?.apiKey || process.env.DRAMA_CREATOR_VOLCENGINE_ARK_API_KEY || '',
    endpoint: credential?.endpoint || process.env.DRAMA_CREATOR_VOLCENGINE_ARK_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3'
  };
}

function missingApiKey() {
  return { status: 'failed', outputs: [], error: { code: 'invalid_params', message: 'missing apiKey' } };
}

function apiUrl(endpoint, path) {
  const clean = String(endpoint || '').replace(/\/+$/, '');
  return `${clean}${path.startsWith('/') ? path : `/${path}`}`;
}

async function responseToFailed(response) {
  const detail = await response.text().catch(() => '');
  return { status: 'failed', outputs: [], error: { code: statusToErrorCode(response.status), message: detail.slice(0, 500) || `HTTP ${response.status}` } };
}

async function buildContent(input) {
  const content = [{ type: 'text', text: buildPromptWithFlags(input) }];
  const reference = (input.references || []).find((item) => item.kind === 'image');
  const imageUrl = await referenceToImageUrl(reference, input.outputDir);
  if (imageUrl) content.push({ type: 'image_url', image_url: { url: imageUrl } });
  return content;
}

function buildPromptWithFlags(input) {
  const params = input.params || {};
  const flags = [];
  if (params.duration) flags.push(`--duration ${params.duration}`);
  if (params.resolution) flags.push(`--resolution ${params.resolution}`);
  if (typeof params.cameraFixed === 'boolean') flags.push(`--camerafixed ${params.cameraFixed}`);
  return [input.prompt, ...flags].filter(Boolean).join(' ');
}

async function referenceToImageUrl(reference, outputDir) {
  if (!reference?.path) return null;
  if (/^https?:\/\//i.test(reference.path) || /^data:image\//i.test(reference.path)) return reference.path;
  try {
    const episodeRoot = dirname(outputDir);
    const filePath = join(episodeRoot, reference.path);
    const bytes = await readFile(filePath);
    const mime = extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    // 图片参考是增强项；读取失败时仍提交纯文本任务，避免本地文件路径问题阻塞生成。
    return null;
  }
}

function extractTaskId(json) {
  return json?.id || json?.task_id || json?.data?.id || json?.data?.task_id || null;
}

function normalizeRemoteStatus(status) {
  const value = String(status || '').toLowerCase();
  if (['succeeded', 'success', 'completed', 'done'].includes(value)) return 'completed';
  if (['failed', 'fail', 'error'].includes(value)) return 'failed';
  return 'generating';
}

function extractProgress(json) {
  const raw = json?.progress ?? json?.data?.progress;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value > 1 ? value / 100 : value)) : undefined;
}

function extractVideoUrl(json) {
  return json?.content?.video_url
    || json?.data?.content?.video_url
    || json?.result?.video_url
    || json?.data?.result?.video_url
    || json?.video_url
    || json?.data?.video_url
    || null;
}

async function downloadToOutput(fetchImpl, url, outputDir, fileName) {
  const response = await fetchImpl(url);
  if (!response.ok) return { status: 'failed', outputs: [], error: { code: 'unknown', message: `download HTTP ${response.status}` } };
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(join(outputDir, fileName), bytes);
  return { status: 'completed' };
}
