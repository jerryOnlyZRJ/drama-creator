import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, parse, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { importEpisode } from '../import/importEpisode.mjs';
import {
  createEdge,
  createNode,
  normalizeIdPart,
  validateDramaCreatorDocument
} from '../schema/dramaCreatorSchema.mjs';
import {
  createAppOwnedProject,
  createProjectEpisode,
  deleteProject,
  deleteProjectEpisode,
  listProjects,
  readProjectRegistryEntries,
  registerProject,
  updateProjectMetadata
} from './projects.mjs';
import { listProjectLibrary } from './library.mjs';
import {
  emptyTrash,
  movePathToTrash,
  permanentlyDeleteTrashItem,
  readTrashItem,
  restoreTrashItem,
  summarizeTrash,
  trashRootForWorkspace
} from './trash.mjs';
import { runGenerate, refreshJobs } from '../adapters/executor.mjs';
import { resolveAdapter as resolveAdapterFromRegistry, listAvailableAdapters } from '../adapters/registry.mjs';
import { runCliAdapter } from '../adapters/cliRunner.mjs';
import { createJimengFeedPackage } from '../automation/jimengFeedPackage.mjs';
import { createKeychain } from '../credentials/keychain.mjs';
import { resolveCredential } from '../credentials/credentialResolver.mjs';
import { createCredentialRef } from '../schema/dramaCreatorSchema.mjs';
import { exportAvailableShotPreview, exportEpisodeVideo, readExistingShotPreview } from '../export/episodeExport.mjs';
import { JimengAutomationError, prepareJimengAutomationRun } from '../automation/jimengScriptExecutor.mjs';
import {
  markVideoNodeAsCandidate,
  normalizeVideoVersionState,
  promoteVideoNodeToCurrent
} from '../workflow/videoVersions.mjs';
import { generatePublicAssetsFromScript } from '../workflow/scriptShots.mjs';
import { ensurePublicAudioGenerationTask } from '../workflow/publicAudioGeneration.mjs';
import {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCode
} from '../credentials/oauthCodex.mjs';
import { startCodexCallbackServer as defaultStartCodexCallbackServer } from '../credentials/oauthCallback.mjs';
import { buildPromptBestPracticeContext } from '../prompting/bestPractices.mjs';

// Phase 3 Task 5：OAuth 流程目前只支持 openai-codex-oauth 一个适配器；非白名单一律 404，
// 防止前端误传 / 历史 adapter id 把 1455 端口起到错误的流程上。
const OAUTH_SUPPORTED_ADAPTERS = new Set(['openai-codex-oauth']);
const MODEL_DEFAULT_CAPABILITIES = new Map([
  ['text', 'text_prompt'],
  ['image', 'image'],
  ['video', 'video'],
  ['audio', 'audio']
]);
const RECOMMENDED_MODEL_DEFAULTS = {
  text: { adapterId: 'openai-codex-oauth', modelId: 'gpt-5-codex' },
  image: { adapterId: 'openai-compatible-image', modelId: 'gpt-image-2', providerId: 'openai' },
  // 常规镜头的推荐默认值和重置行为回到 mini；音色锁定任务会在投喂包阶段升级到普通 2.0。
  video: { adapterId: 'jimeng-browser-automation', modelId: 'seedance-2.0-mini' },
  // 音频生成同样走即梦浏览器自动化，但使用独立模型 ID，避免把视频 Seedance 选项误当成音频模型。
  audio: { adapterId: 'jimeng-browser-automation', modelId: 'jimeng-audio' }
};
const TEXT_MODEL_SETTINGS_URL = '/settings.html#model-text';
const TEXT_API_KEY_ADAPTER_ID = 'openai-compatible-text';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

// Episode-scoped media types are served back to the browser through /api/asset so
// canvas cards can render real images and videos without exposing a generic file proxy.
const assetMimeTypes = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};
const allowedAssetExtensions = new Set(Object.keys(assetMimeTypes));
const REFERENCE_ASSET_NODE_TYPES = new Set(['image_asset', 'audio_asset']);
const SHOT_REFERENCE_EDGE_TYPES = new Set(['uses_reference', 'script_uses_asset']);
const manualImportKinds = {
  image: {
    directory: 'manual-assets/images',
    nodeType: 'image_asset',
    extensions: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
  },
  video: {
    directory: 'manual-assets/videos',
    nodeType: 'video_output',
    extensions: new Set(['.mp4', '.mov'])
  }
};
const DELETABLE_RESOURCE_NODE_TYPES = new Set(['image_asset', 'audio_asset', 'video_output', 'text_output']);
const FILE_BACKED_RESOURCE_NODE_TYPES = new Set(['image_asset', 'audio_asset', 'video_output']);

export function createApp({
  root = process.cwd(),
  allowedEpisodeRoots = [root],
  registryFile,
  appWorkspaceDir = join(homedir(), '.drama-creator'),
  settingsFile = join(appWorkspaceDir, 'settings.json'),
  credentialsFile = join(appWorkspaceDir, 'credentials.json'),
  resourceCacheDir,
  keychain,
  // Phase 3 Task 5：DI startCallbackServer 让单测可以避开真实 1455 端口监听。
  // 生产代码默认指向 src/credentials/oauthCallback.mjs 中的 startCodexCallbackServer，
  // 测试可注入一个永远 pending（用来验证 awaiting_callback 状态）或立即 reject（验证错误分支）的 mock。
  startCallbackServer = defaultStartCodexCallbackServer,
  fetch: injectedFetch,
  ffmpegPath = process.env.DRAMA_CREATOR_FFMPEG || 'ffmpeg'
} = {}) {
  const safeRoot = resolve(root);
  const safeAppWorkspaceDir = resolve(appWorkspaceDir);
  // App workspace is always authorized because V1 projects live under ~/.drama-creator by default.
  const safeEpisodeRoots = [...new Set([...allowedEpisodeRoots.map((item) => resolve(item)), safeAppWorkspaceDir])];
  const safeSettingsFile = resolve(settingsFile);
  const safeCredentialsFile = resolve(credentialsFile);
  const configuredResourceCacheDir = resourceCacheDir ? resolve(resourceCacheDir) : null;
  // Production callers omit `keychain`; we materialize a real one bound to keytar lazily.
  // Tests inject a fake { readSecret/writeSecret/deleteSecret/listAccounts } to avoid OS keychain IO.
  const keychainImpl = keychain || createKeychain();
  // OAuth 流程的唯一一份内存状态。整个 server 进程同一时刻只允许一个 Codex OAuth 流程
  // 进行（1455 端口本身是单例资源），因此用一个对象就够，前端通过 polling 拿最新状态即可。
  const oauthFlowStatus = {
    state: 'idle',
    error: null,
    lastUpdatedAt: Date.now()
  };
  // 把状态机放到闭包里，保证不同 createApp 实例之间互不污染（多测试并发安全）。
  const setOAuthStatus = (next) => {
    oauthFlowStatus.state = next.state;
    oauthFlowStatus.error = next.error || null;
    oauthFlowStatus.lastUpdatedAt = Date.now();
  };
  let activeOAuthController = null;
  let activeOAuthFlowId = 0;
  const beginOAuthFlow = () => {
    if (activeOAuthController && !activeOAuthController.signal.aborted) {
      activeOAuthController.abort();
    }
    activeOAuthController = new AbortController();
    activeOAuthFlowId += 1;
    return { controller: activeOAuthController, flowId: activeOAuthFlowId };
  };
  const isCurrentOAuthFlow = (flowId) => flowId === activeOAuthFlowId;
  const clearOAuthFlow = (flowId) => {
    if (isCurrentOAuthFlow(flowId)) activeOAuthController = null;
  };
  // 注入 fetch：便于 token 端点单测中 mock；生产留 globalThis.fetch。
  const fetchImpl = injectedFetch || globalThis.fetch;

  return async function app(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/api/projects' && req.method === 'GET') {
        await handleListProjects(res, safeEpisodeRoots, registryFile, safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/projects/create' && req.method === 'POST') {
        await handleCreateProject(req, res, safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/projects/metadata' && req.method === 'PATCH') {
        await handleUpdateProjectMetadata(req, res, safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/story/generate' && req.method === 'POST') {
        await handleGenerateStoryFromIdea(req, res, {
          appWorkspaceDir: safeAppWorkspaceDir,
          settingsFile: safeSettingsFile,
          credentialsFile: safeCredentialsFile,
          keychain: keychainImpl,
          fetchImpl
        });
        return;
      }
      if (url.pathname === '/api/script-draft/generate' && req.method === 'POST') {
        await handleGenerateScriptDraft(req, res, {
          appWorkspaceDir: safeAppWorkspaceDir,
          settingsFile: safeSettingsFile,
          credentialsFile: safeCredentialsFile,
          keychain: keychainImpl,
          fetchImpl
        });
        return;
      }
      if (url.pathname === '/api/projects/episode' && req.method === 'POST') {
        await handleCreateProjectEpisode(req, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/projects/episode' && req.method === 'DELETE') {
        await handleDeleteProjectEpisode(req, res, safeEpisodeRoots, registryFile, safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/projects' && req.method === 'POST') {
        await handleRegisterProject(req, res, registryFile);
        return;
      }
      if (url.pathname === '/api/projects' && req.method === 'DELETE') {
        await handleDeleteProject(req, res, safeEpisodeRoots, registryFile, safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/app-settings' && req.method === 'GET') {
        await handleGetAppSettings(res, {
          appWorkspaceDir: safeAppWorkspaceDir,
          settingsFile: safeSettingsFile,
          resourceCacheDir: configuredResourceCacheDir
        });
        return;
      }
      if (url.pathname === '/api/app-settings' && req.method === 'PATCH') {
        await handlePatchAppSettings(req, res, {
          appWorkspaceDir: safeAppWorkspaceDir,
          settingsFile: safeSettingsFile
        });
        return;
      }
      if (url.pathname === '/api/trash' && req.method === 'GET') {
        await handleGetTrashSummary(res, safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/trash' && req.method === 'DELETE') {
        await handleEmptyTrash(res, safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/trash/restore' && req.method === 'POST') {
        await handleRestoreTrashItem(req, res, safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/trash/item' && req.method === 'DELETE') {
        await handleDeleteTrashItem(req, res, safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/library' && req.method === 'GET') {
        await handleListLibrary(url, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/library/generate-from-script' && req.method === 'POST') {
        await handleGenerateLibraryFromScript(req, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/library/item' && req.method === 'DELETE') {
        await handleDeleteLibraryItem(req, res, safeEpisodeRoots, registryFile, safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/library/audio-generation/start' && req.method === 'POST') {
        await handlePublicAudioGenerationStart(req, res, safeEpisodeRoots, registryFile, {
          appWorkspaceDir: safeAppWorkspaceDir,
          settingsFile: safeSettingsFile,
          resourceCacheDir: configuredResourceCacheDir || safeAppWorkspaceDir
        });
        return;
      }
      if (url.pathname === '/api/episode' && req.method === 'GET') {
        await handleGetEpisode(url, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/import' && req.method === 'POST') {
        await handleImport(req, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/episode' && req.method === 'PATCH') {
        await handlePatchEpisode(req, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/manual-assets/import' && req.method === 'POST') {
        await handleManualAssetImport(req, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/episode/references' && req.method === 'POST') {
        await handleAddEpisodeReference(req, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/episode/references' && req.method === 'PATCH') {
        await handleReorderEpisodeReferences(req, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/episode/references' && req.method === 'DELETE') {
        await handleRemoveEpisodeReference(req, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/episode/video-version/current' && req.method === 'POST') {
        await handlePromoteVideoVersion(req, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/episode/resources' && req.method === 'DELETE') {
        await handleDeleteEpisodeResource(req, res, safeEpisodeRoots, registryFile, safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/jimeng/feed-package' && req.method === 'POST') {
        await handleJimengFeedPackage(req, res, safeEpisodeRoots, registryFile, {
          appWorkspaceDir: safeAppWorkspaceDir,
          settingsFile: safeSettingsFile,
          resourceCacheDir: configuredResourceCacheDir || safeAppWorkspaceDir
        });
        return;
      }
      if (url.pathname === '/api/jimeng/automation/start' && req.method === 'POST') {
        await handleJimengAutomationStart(req, res, safeEpisodeRoots, registryFile, {
          appWorkspaceDir: safeAppWorkspaceDir,
          settingsFile: safeSettingsFile,
          resourceCacheDir: configuredResourceCacheDir || safeAppWorkspaceDir
        });
        return;
      }
      if (url.pathname === '/api/export/episode' && req.method === 'POST') {
        await handleExportEpisode(req, res, safeEpisodeRoots, registryFile, ffmpegPath);
        return;
      }
      if (url.pathname === '/api/export/preview' && req.method === 'GET') {
        await handleGetExportPreview(url, res, safeEpisodeRoots, registryFile);
        return;
      }
      if (url.pathname === '/api/export/preview' && req.method === 'POST') {
        await handleExportPreview(req, res, safeEpisodeRoots, registryFile, ffmpegPath);
        return;
      }
      if (url.pathname === '/api/asset' && (req.method === 'GET' || req.method === 'HEAD')) {
        await handleGetAsset(req, url, res, safeEpisodeRoots, registryFile, configuredResourceCacheDir || safeAppWorkspaceDir);
        return;
      }
      if (url.pathname === '/api/generate' && req.method === 'POST') {
        await handleGenerate(req, res, safeEpisodeRoots, registryFile, safeCredentialsFile, keychainImpl, { fetchImpl });
        return;
      }
      if (url.pathname === '/api/jobs/refresh' && req.method === 'POST') {
        await handleJobsRefresh(req, res, safeEpisodeRoots, registryFile, safeCredentialsFile, keychainImpl, { fetchImpl });
        return;
      }
      if (url.pathname === '/api/adapters' && req.method === 'GET') {
        await handleListAdapters(res);
        return;
      }
      if (url.pathname === '/api/credentials' && req.method === 'GET') {
        await handleListCredentials(url, res, safeEpisodeRoots, registryFile, safeCredentialsFile, keychainImpl);
        return;
      }
      // Phase 3 Task 5：OAuth 启动入口与状态查询。前端：
      //   POST /api/credentials/oauth/start  → 立即返回 authorizeUrl，让桌面壳/浏览器打开登录页
      //   GET  /api/credentials/oauth/status → 返回 oauthFlowStatus，前端 polling 探测完成
      if (url.pathname === '/api/credentials/oauth/start' && req.method === 'POST') {
        await handleOAuthStart(req, res, safeEpisodeRoots, registryFile, safeCredentialsFile, keychainImpl, {
          startCallbackServer,
          fetchImpl,
          setOAuthStatus,
          beginOAuthFlow,
          isCurrentOAuthFlow,
          clearOAuthFlow
        });
        return;
      }
      if (url.pathname === '/api/credentials/oauth/status' && req.method === 'GET') {
        sendJson(res, 200, { ...oauthFlowStatus });
        return;
      }
      if (url.pathname === '/api/model-connections/test' && req.method === 'POST') {
        await handleTestModelConnection(req, res, safeCredentialsFile, keychainImpl, { fetchImpl });
        return;
      }
      // Match /api/credentials/<adapterId> for PUT (write) and DELETE (clear).
      const credMatch = url.pathname.match(/^\/api\/credentials\/([^/]+)$/);
      if (credMatch && req.method === 'PUT') {
        await handlePutCredential(req, res, credMatch[1], safeEpisodeRoots, registryFile, safeCredentialsFile, keychainImpl);
        return;
      }
      if (credMatch && req.method === 'DELETE') {
        await handleDeleteCredential(req, res, credMatch[1], safeEpisodeRoots, registryFile, safeCredentialsFile, keychainImpl);
        return;
      }
      if (url.pathname === '/favicon.ico' && (req.method === 'GET' || req.method === 'HEAD')) {
        // Browsers request /favicon.ico even when the static bundle has no icon file.
        // Return an explicit empty icon response so page-load diagnostics stay noise-free.
        res.statusCode = 204;
        res.end();
        return;
      }

      await handleStatic(safeRoot, url, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

async function handleListProjects(res, allowedEpisodeRoots, registryFile, appWorkspaceDir) {
  const projects = await listProjects({ allowedEpisodeRoots, appWorkspaceDir, ...(registryFile ? { registryFile } : {}) });
  sendJson(res, 200, { projects });
}

async function handleCreateProject(req, res, appWorkspaceDir) {
  const body = await readJsonBody(req);
  try {
    const project = await createAppOwnedProject({
      appWorkspaceDir,
      name: body.name,
      firstEpisodeName: body.firstEpisodeName,
      startMode: body.startMode,
      sourceText: body.sourceText,
      ideaText: body.ideaText,
      storyGeneratedBy: body.storyGeneratedBy
    });
    sendJson(res, 200, { project });
  } catch (error) {
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    throw error;
  }
}

async function handleUpdateProjectMetadata(req, res, appWorkspaceDir) {
  const body = await readJsonBody(req);
  try {
    // 当前只开放创作者可直接编辑的项目级摘要字段；集级剧本仍走 /api/episode。
    const metadataPatch = {
      appWorkspaceDir,
      projectPath: body.projectPath || body.path
    };
    if (Object.prototype.hasOwnProperty.call(body, 'coreIdea')) metadataPatch.coreIdea = body.coreIdea;
    if (Object.prototype.hasOwnProperty.call(body, 'globalBrief')) metadataPatch.globalBrief = body.globalBrief;
    if (Object.prototype.hasOwnProperty.call(body, 'jimengSpaceName')) metadataPatch.jimengSpaceName = body.jimengSpaceName;
    const project = await updateProjectMetadata(metadataPatch);
    sendJson(res, 200, { project });
  } catch (error) {
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    throw error;
  }
}

async function handleGenerateStoryFromIdea(req, res, {
  appWorkspaceDir,
  settingsFile,
  credentialsFile,
  keychain,
  fetchImpl
}) {
  const body = await readJsonBody(req);
  const idea = typeof body.idea === 'string' ? body.idea.trim() : '';
  if (!idea) {
    sendJson(res, 400, { error: 'missing_idea', message: '请先输入一个故事想法。' });
    return;
  }

  const generation = await generateTextViaConfiguredModels({
    appWorkspaceDir,
    settingsFile,
    credentialsFile,
    keychain,
    fetchImpl,
    outputSubdir: 'story-drafts',
    unavailableMessage: ({ manifest, candidate }) => `${manifest.displayName || candidate.adapterId} 暂不支持故事文本生成`,
    expiredOAuthMessage: '订阅登录已过期，请重新登录后再生成故事',
    buildInput: ({ outputDir, modelId, credential }) => buildStoryGenerationInput({
      idea,
      projectName: body.projectName,
      firstEpisodeName: body.firstEpisodeName,
      outputDir,
      modelId,
      credential
    }),
    emptyMessage: ({ manifest, candidate }) => `${manifest.displayName || candidate.adapterId} 没有返回故事内容`
  });

  if (generation.text) {
    sendJson(res, 200, {
      story: generation.text,
      adapterId: generation.adapterId,
      modelId: generation.modelId,
      generatedAt: new Date().toISOString()
    });
    return;
  }
  if (generation.runtimeErrors.length) {
    sendJson(res, 502, {
      error: 'story_generation_failed',
      message: `故事生成失败：${generation.runtimeErrors[0]}`,
      settingsUrl: TEXT_MODEL_SETTINGS_URL,
      manualFallback: true
    });
    return;
  }
  sendJson(res, 409, {
    error: 'text_model_not_configured',
    message: generation.skippedMessages.length
      ? `${generation.skippedMessages[0]}。你可以去设置页完成文本模型配置，也可以先手动补写完整故事。`
      : '文本模型还没配置。你可以去设置页完成订阅登录或 API Key 配置，也可以先手动补写完整故事。',
    settingsUrl: TEXT_MODEL_SETTINGS_URL,
    manualFallback: true
  });
}

async function handleGenerateScriptDraft(req, res, {
  appWorkspaceDir,
  settingsFile,
  credentialsFile,
  keychain,
  fetchImpl
}) {
  const body = await readJsonBody(req);
  const sourceText = typeof body.sourceText === 'string' ? body.sourceText.trim() : '';
  if (!sourceText) {
    sendJson(res, 400, { error: 'missing_source_text', message: '请先粘贴或导入故事源。' });
    return;
  }

  const generation = await generateTextViaConfiguredModels({
    appWorkspaceDir,
    settingsFile,
    credentialsFile,
    keychain,
    fetchImpl,
    outputSubdir: 'script-drafts',
    unavailableMessage: ({ manifest, candidate }) => `${manifest.displayName || candidate.adapterId} 暂不支持剧本草稿生成`,
    expiredOAuthMessage: '订阅登录已过期，请重新登录后再生成剧本草稿',
    buildInput: ({ outputDir, modelId, credential }) => buildScriptDraftGenerationInput({
      sourceText,
      projectName: body.projectName,
      episodeTitle: body.episodeTitle,
      outputDir,
      modelId,
      credential
    }),
    emptyMessage: ({ manifest, candidate }) => `${manifest.displayName || candidate.adapterId} 没有返回剧本草稿`
  });

  if (generation.text) {
    sendJson(res, 200, {
      scriptDraft: generation.text,
      adapterId: generation.adapterId,
      modelId: generation.modelId,
      generatedAt: new Date().toISOString()
    });
    return;
  }
  if (generation.runtimeErrors.length) {
    sendJson(res, 502, {
      error: 'script_draft_generation_failed',
      message: `剧本草稿生成失败：${generation.runtimeErrors[0]}`,
      settingsUrl: TEXT_MODEL_SETTINGS_URL,
      manualFallback: true
    });
    return;
  }
  sendJson(res, 409, {
    error: 'text_model_not_configured',
    message: generation.skippedMessages.length
      ? `${generation.skippedMessages[0]}。你可以去设置页完成文本模型配置，也可以直接手动编写剧本草稿。`
      : '文本模型还没配置。你可以去设置页完成订阅登录或 API Key 配置，也可以直接手动编写剧本草稿。',
    settingsUrl: TEXT_MODEL_SETTINGS_URL,
    manualFallback: true
  });
}

async function generateTextViaConfiguredModels({
  appWorkspaceDir,
  settingsFile,
  credentialsFile,
  keychain,
  fetchImpl,
  outputSubdir,
  unavailableMessage,
  expiredOAuthMessage,
  buildInput,
  emptyMessage
}) {
  await bootstrapAppWorkspace(appWorkspaceDir);
  const settings = await readAppSettingsFile(settingsFile);
  const credentialStore = await readCredentialStore(credentialsFile);
  const credentialStoreBefore = JSON.stringify(credentialStore.credentials);
  const candidates = buildTextModelCandidateSpecs(settings.modelDefaults, credentialStore.credentials);
  const outputDir = join(appWorkspaceDir, outputSubdir);
  await mkdir(outputDir, { recursive: true });

  const skippedMessages = [];
  const runtimeErrors = [];
  try {
    for (const candidate of candidates) {
      const adapterRef = await resolveAdapterFromRegistry(candidate.adapterId);
      if (!adapterRef) {
        skippedMessages.push(`未知文本模型：${candidate.adapterId}`);
        continue;
      }
      const manifest = adapterRef.manifest;
      const capability = (manifest.capabilities || []).find((item) => item.type === 'text_prompt');
      if (!capability || manifest.productionMode === 'external') {
        skippedMessages.push(unavailableMessage({ manifest, candidate }));
        continue;
      }

      const credentialDoc = { credentials: credentialStore.credentials };
      const credentialRef = findCredentialRef(credentialStore.credentials, candidate.adapterId);
      if (manifest.credential?.required && credentialRef) {
        const secretStatus = await credentialSecretStatus(credentialRef, keychain);
        if (secretStatus === 'missing') {
          skippedMessages.push(`${manifest.displayName || candidate.adapterId} 的密钥不在系统钥匙串里，请在设置页更新 API Key 或重新登录授权`);
          continue;
        }
      }
      let credential;
      try {
        credential = await resolveCredential(credentialDoc, candidate.adapterId, manifest, process.env, keychain, { fetch: fetchImpl });
      } catch (error) {
        if (error?.code === 'oauth_expired') {
          skippedMessages.push(expiredOAuthMessage);
          continue;
        }
        throw error;
      }
      if (manifest.credential?.required && credential === null) {
        skippedMessages.push(`${manifest.displayName || candidate.adapterId} 尚未完成授权`);
        continue;
      }

      const modelId = resolveTextModelId({ candidate, manifest, credentialRef, capability });
      const input = buildInput({ outputDir, modelId, credential });
      const result = await runTextAdapter(adapterRef, input, { fetchImpl });
      if (result.status === 'completed') {
        const text = await readTextFromAdapterResult(result, outputDir);
        if (!text) {
          runtimeErrors.push(emptyMessage({ manifest, candidate }));
          continue;
        }
        return { text, adapterId: candidate.adapterId, modelId, skippedMessages, runtimeErrors };
      }
      runtimeErrors.push(formatTextAdapterFailure({ result, manifest, candidate }));
    }
    return { text: '', adapterId: '', modelId: '', skippedMessages, runtimeErrors };
  } finally {
    // resolveCredential 可能刷新订阅 token；即使本轮模型最终失败，也要把刷新后的非密文字段写回。
    if (JSON.stringify(credentialStore.credentials) !== credentialStoreBefore) {
      await writeCredentialStore(credentialsFile, credentialStore);
    }
  }
}

function buildTextModelCandidateSpecs(modelDefaults, credentials) {
  const explicit = sanitizeModelDefaults(modelDefaults).text || null;
  const specs = [];
  if (explicit) {
    // 用户保存的默认文本模型是生成来源承诺；失败时必须直接暴露问题，不能静默切到其它服务商。
    specs.push(explicit);
  } else {
    specs.push(RECOMMENDED_MODEL_DEFAULTS.text);
    if (findCredentialRef(credentials, TEXT_API_KEY_ADAPTER_ID)) {
      specs.push({ adapterId: TEXT_API_KEY_ADAPTER_ID });
    }
  }

  const seen = new Set();
  return specs.filter((spec) => {
    if (!spec?.adapterId) return false;
    const key = `${spec.adapterId}:${spec.modelId || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatTextAdapterFailure({ result, manifest, candidate }) {
  const displayName = manifest.displayName || candidate.adapterId;
  const errorCode = result.error?.code || 'unknown';
  if (errorCode === 'auth_failed') {
    // 上游可能返回英文 JSON 或内部错误详情；主流程只给创作者可理解的处理动作。
    return candidate.adapterId === 'openai-codex-oauth'
      ? '订阅登录已失效，请在设置页重新登录后再试'
      : 'API Key 当前无法使用，请在设置页更新后再试';
  }
  if (errorCode === 'quota_exceeded') {
    return `${displayName} 当前额度暂时不可用，请稍后重试或切换文本模型`;
  }
  if (errorCode === 'invalid_params') {
    return `${displayName} 暂时无法接受这次生成请求，请检查模型选择后再试`;
  }
  const message = result.error?.message || '';
  if (/network error/i.test(message)) {
    return `${displayName} 网络连接失败，请检查网络后再试`;
  }
  return `${displayName} 暂时没有返回可用内容，请稍后重试`;
}

function buildStoryGenerationInput({ idea, projectName, firstEpisodeName, outputDir, modelId, credential }) {
  const bestPractice = buildPromptBestPracticeContext({ capability: 'text_prompt' });
  return {
    task: { id: 'task:story-from-idea', type: 'story_text' },
    capability: 'text_prompt',
    model: modelId,
    systemPrompt: [
      bestPractice.systemPrompt,
      '你现在只负责把用户的一句话想法扩写成完整故事源，不拆分镜、不输出视频提示词。'
    ].join('\n'),
    prompt: buildStoryFromIdeaPrompt({
      idea,
      projectName,
      firstEpisodeName
    }),
    params: { temperature: 0.78, maxTokens: 3200 },
    outputDir,
    credential
  };
}

function buildStoryFromIdeaPrompt({ idea, projectName, firstEpisodeName }) {
  return [
    `项目名称：${String(projectName || '').trim() || '未命名 AI 视频'}`,
    `首集名称：${String(firstEpisodeName || '').trim() || '第 1 集'}`,
    `用户想法：${idea}`,
    '',
    '请把这个想法扩写成一版完整故事，面向 3-5 分钟 AI 短片或短剧第一集。',
    '要求：',
    '1. 有清晰的主角、目标、阻碍、转折和结尾余韵。',
    '2. 故事需要适合后续拆成 15 秒以内的多个分镜。',
    '3. 语言自然克制，不要堆砌设定，不要写成宣传文案。',
    '4. 如果故事适合多集，只写第一集完整内容，并在结尾保留可延展的悬念。',
    '5. 只输出故事正文，不输出解释、JSON、Markdown 表格或分镜清单。'
  ].join('\n');
}

function buildScriptDraftGenerationInput({ sourceText, projectName, episodeTitle, outputDir, modelId, credential }) {
  const bestPractice = buildPromptBestPracticeContext({ capability: 'text_prompt' });
  return {
    task: { id: 'task:script-draft', type: 'script_draft' },
    capability: 'text_prompt',
    model: modelId,
    systemPrompt: [
      bestPractice.systemPrompt,
      '你现在只负责把故事源改编成可拍摄、可继续拆分分镜的分集剧本草稿，不输出视频提示词。'
    ].join('\n'),
    prompt: buildScriptDraftPrompt({
      sourceText,
      projectName,
      episodeTitle
    }),
    params: { temperature: 0.72, maxTokens: 4600 },
    outputDir,
    credential
  };
}

function buildScriptDraftPrompt({ sourceText, projectName, episodeTitle }) {
  return [
    `项目名称：${String(projectName || '').trim() || '未命名 AI 视频'}`,
    `分集名称：${String(episodeTitle || '').trim() || '第 1 集'}`,
    '',
    '故事源：',
    sourceText,
    '',
    '请把上面的故事源改编成一版正式的分集剧本草稿。',
    '要求：',
    '1. 用中文输出，面向 AI 视频短片或短剧第一集。',
    '2. 剧本需要有清楚的开端、推进、转折和结尾余韵，语气自然克制。',
    '3. 不要输出视频提示词、镜头参数、@图片占位、JSON、Markdown 表格或解释说明。',
    '4. 结构请包含：标题、故事概述、主要人物、主要场景、正式剧本。',
    '5. 正式剧本按场次书写，每场可包含：场景、动作、对白、旁白、屏幕文字。',
    '6. 后续会拆成多个 15 秒以内分镜，所以每段动作和对白要具体、可拍、不要过长。',
    '7. 如果故事源信息不足，可以做合理补全，但不要新增过多支线人物。'
  ].join('\n');
}

function resolveTextModelId({ candidate, manifest, credentialRef, capability }) {
  if (candidate.modelId) return candidate.modelId;
  const endpoint = credentialRef?.publicFields?.endpoint;
  const template = findTemplateByEndpoint(manifest.templates || [], endpoint);
  const verified = credentialRef?.publicFields?.verification?.modelIds;
  return template?.defaultModelId || (Array.isArray(verified) && verified[0]) || capability.models?.[0]?.id || 'gpt-4o-mini';
}

function findTemplateByEndpoint(templates, endpoint) {
  const target = normalizeEndpoint(endpoint);
  if (!target) return null;
  return templates.find((template) => normalizeEndpoint(template.endpoint) === target) || null;
}

function normalizeEndpoint(endpoint) {
  return String(endpoint || '').trim().replace(/\/+$/, '').toLowerCase();
}

function findCredentialRef(credentials, adapterId) {
  return usableCredentialRefs(credentials).find((item) => item.adapterId === adapterId) || null;
}

async function runTextAdapter(adapterRef, input, { fetchImpl }) {
  if (adapterRef.kind === 'cli') {
    return runCliAdapter({
      entryPath: adapterRef.entryPath,
      input,
      timeoutSec: adapterRef.manifest?.timeoutSec,
      cwd: dirname(adapterRef.entryPath)
    });
  }
  return adapterRef.module.generate(input, { fetch: fetchImpl });
}

async function readTextFromAdapterResult(result, outputDir) {
  const output = (result.outputs || []).find((item) => item?.kind === 'text' && typeof item.path === 'string');
  if (!output) return '';
  const outputPath = isAbsolute(output.path) ? resolve(output.path) : resolve(outputDir, output.path);
  const safeOutputDir = resolve(outputDir);
  if (!isPathInside(outputPath, safeOutputDir)) {
    throw new HttpError(400, 'Adapter returned an invalid text output path');
  }
  const text = await readFile(outputPath, 'utf8');
  // 文本适配器落盘文件只是接口中转产物；正文会写入项目文档，避免工作区长期堆积临时文本。
  await rm(outputPath, { force: true }).catch(() => {});
  return text.trim();
}

async function handleCreateProjectEpisode(req, res, allowedEpisodeRoots, registryFile) {
  const body = await readJsonBody(req);
  const projectPath = body.projectPath || body.path;
  if (!projectPath) {
    sendJson(res, 400, { error: 'Missing projectPath' });
    return;
  }

  let safeProjectRoot;
  try {
    safeProjectRoot = await realpath(resolve(projectPath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendJson(res, 404, { error: 'Project path not found' });
      return;
    }
    throw error;
  }

  const safeAllowedRoots = await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile);
  if (!safeAllowedRoots.some((allowedRoot) => isPathInside(safeProjectRoot, allowedRoot))) {
    sendJson(res, 403, { error: 'Forbidden project path' });
    return;
  }

  try {
    // 新分集只在已授权项目根下创建，前端无需也不应该让用户手动感知文件目录。
    const result = await createProjectEpisode({
      projectPath: safeProjectRoot,
      title: body.title
    });
    sendJson(res, 200, result);
  } catch (error) {
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    throw error;
  }
}

async function handleDeleteProjectEpisode(req, res, allowedEpisodeRoots, registryFile, appWorkspaceDir) {
  const body = await readJsonBody(req);
  const projectPath = body.projectPath || body.path;
  const episodePath = body.episodePath;
  if (!projectPath || !episodePath) {
    sendJson(res, 400, { error: 'Missing projectPath or episodePath' });
    return;
  }

  const safeAllowedRoots = await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile);
  let safeProjectRoot;
  let safeEpisodeRoot;
  try {
    safeProjectRoot = await realpath(resolve(projectPath));
    safeEpisodeRoot = await realpath(resolve(episodePath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendJson(res, 404, { error: 'Project or episode path not found' });
      return;
    }
    throw error;
  }
  if (!safeAllowedRoots.some((root) => isPathInside(safeProjectRoot, root))) {
    sendJson(res, 403, { error: 'Forbidden project path' });
    return;
  }
  if (!isPathInside(safeEpisodeRoot, safeProjectRoot)) {
    sendJson(res, 403, { error: 'Episode path is not inside the project' });
    return;
  }

  try {
    const result = await deleteProjectEpisode({
      projectPath: safeProjectRoot,
      episodePath: safeEpisodeRoot,
      appWorkspaceDir
    });
    sendJson(res, 200, result);
  } catch (error) {
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    throw error;
  }
}

async function handleRegisterProject(req, res, registryFile) {
  const body = await readJsonBody(req);
  if (!body.path) {
    sendJson(res, 400, { error: 'Missing path' });
    return;
  }
  const projectRoot = resolve(body.path);
  let safeProjectRoot;
  try {
    safeProjectRoot = await realpath(projectRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendJson(res, 404, { error: 'Project path does not exist' });
      return;
    }
    throw error;
  }
  // 用户通过桌面目录选择器或手动粘贴显式注册 workspace，即代表授权应用读写该项目；
  // 后续 GET /api/library / episode / asset 会把注册表里的路径纳入授权根。
  try {
    const entry = await registerProject({
      projectPath: safeProjectRoot,
      name: body.name,
      ...(registryFile ? { registryFile } : {})
    });
    sendJson(res, 200, { project: entry });
  } catch (error) {
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    throw error;
  }
}

async function handleDeleteProject(req, res, allowedEpisodeRoots, registryFile, appWorkspaceDir) {
  const body = await readJsonBody(req);
  const projectPath = body.projectPath || body.path;
  if (!projectPath) {
    sendJson(res, 400, { error: 'Missing projectPath' });
    return;
  }

  const safeAllowedRoots = await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile);
  let safeProjectRoot;
  try {
    safeProjectRoot = await realpath(resolve(projectPath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      try {
        const result = await deleteProject({ projectPath, appWorkspaceDir, ...(registryFile ? { registryFile } : {}) });
        sendJson(res, 200, result);
        return;
      } catch (inner) {
        if (inner?.statusCode) {
          sendJson(res, inner.statusCode, { error: inner.message });
          return;
        }
        throw inner;
      }
    }
    throw error;
  }
  if (!safeAllowedRoots.some((root) => isPathInside(safeProjectRoot, root))) {
    sendJson(res, 403, { error: 'Forbidden project path' });
    return;
  }

  try {
    const result = await deleteProject({ projectPath: safeProjectRoot, appWorkspaceDir, ...(registryFile ? { registryFile } : {}) });
    sendJson(res, 200, result);
  } catch (error) {
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    throw error;
  }
}

async function handleGetAppSettings(res, options) {
  const settings = await resolveAppSettings(options);
  sendJson(res, 200, settings);
}

async function handlePatchAppSettings(req, res, { appWorkspaceDir, settingsFile }) {
  const body = await readJsonBody(req);
  const hasResourceCacheDir = Object.prototype.hasOwnProperty.call(body, 'resourceCacheDir');
  const nextResourceCacheDir = body.resourceCacheDir;
  if (hasResourceCacheDir && nextResourceCacheDir !== null && typeof nextResourceCacheDir !== 'string') {
    sendJson(res, 400, { error: 'resourceCacheDir must be an absolute path or null' });
    return;
  }
  if (hasResourceCacheDir && typeof nextResourceCacheDir === 'string' && !isAbsolute(nextResourceCacheDir)) {
    sendJson(res, 400, { error: 'resourceCacheDir must be an absolute path' });
    return;
  }

  await bootstrapAppWorkspace(appWorkspaceDir);
  const current = await readAppSettingsFile(settingsFile);
  const paths = { ...(current.paths || {}) };
  if (hasResourceCacheDir) {
    if (nextResourceCacheDir === null) {
      delete paths.resourceCacheDir;
    } else {
      paths.resourceCacheDir = resolve(nextResourceCacheDir);
      await mkdir(paths.resourceCacheDir, { recursive: true });
    }
  }
  let modelDefaults = sanitizeModelDefaults(current.modelDefaults);
  if (Object.prototype.hasOwnProperty.call(body, 'modelDefaults')) {
    modelDefaults = await mergeModelDefaults(modelDefaults, body.modelDefaults);
  }
  await mkdir(dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify({ ...current, paths, modelDefaults }, null, 2)}\n`, 'utf8');
  const source = paths.resourceCacheDir ? 'custom' : 'default';
  sendJson(res, 200, {
    appWorkspaceDir,
    resourceCacheDir: paths.resourceCacheDir || appWorkspaceDir,
    resourceCacheDirSource: source,
    modelDefaults: applyRecommendedModelDefaults(modelDefaults)
  });
}

async function handleGetTrashSummary(res, appWorkspaceDir) {
  const trash = await summarizeTrash(appWorkspaceDir);
  sendJson(res, 200, { trash });
}

async function handleEmptyTrash(res, appWorkspaceDir) {
  const trash = await emptyTrash(appWorkspaceDir);
  sendJson(res, 200, { trash });
}

async function handleRestoreTrashItem(req, res, appWorkspaceDir) {
  const body = await readJsonBody(req);
  if (!body.itemId) {
    sendJson(res, 400, { error: 'Missing itemId' });
    return;
  }

  try {
    const item = await readTrashItem(appWorkspaceDir, body.itemId);
    const metadata = item.manifest.metadata || {};
    const result = metadata.kind === 'resource' && metadata.graphSnapshot
      ? await restoreResourceTrashItem(appWorkspaceDir, item)
      : await restoreTrashItem(appWorkspaceDir, body.itemId);
    sendJson(res, 200, { restore: result });
  } catch (error) {
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    throw error;
  }
}

async function handleDeleteTrashItem(req, res, appWorkspaceDir) {
  const body = await readJsonBody(req);
  if (!body.itemId) {
    sendJson(res, 400, { error: 'Missing itemId' });
    return;
  }
  try {
    const result = await permanentlyDeleteTrashItem(appWorkspaceDir, body.itemId);
    sendJson(res, 200, { delete: result });
  } catch (error) {
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    throw error;
  }
}

async function restoreResourceTrashItem(appWorkspaceDir, item) {
  const metadata = item.manifest.metadata || {};
  if (typeof metadata.episodePath !== 'string' || !metadata.episodePath) {
    throw new HttpError(400, 'Resource trash item is missing episode metadata');
  }

  let episodeRoot;
  try {
    episodeRoot = await realpath(resolve(metadata.episodePath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new HttpError(409, 'Original episode no longer exists. Restore the episode or project first.');
    }
    throw error;
  }

  const originalPath = resolve(item.manifest.originalPath || '');
  if (!isPathInside(originalPath, episodeRoot)) {
    throw new HttpError(403, 'Resource restore path is outside the original episode.');
  }
  if (await pathExists(originalPath)) {
    throw new HttpError(409, 'Original resource path already exists. Move or rename the current file before restoring.');
  }

  const docPath = join(episodeRoot, 'drama-creator.json');
  const doc = JSON.parse(await readFile(docPath, 'utf8'));
  const snapshot = normalizeTrashGraphSnapshot(metadata.graphSnapshot);
  applyResourceRestoreSnapshot(doc, snapshot);
  appendResourceRestoreActivity(doc, {
    metadata,
    item,
    restoredNodeIds: snapshot.nodes.map((node) => node.id).filter(Boolean),
    at: new Date().toISOString()
  });

  const validationErrors = validateDramaCreatorDocument(doc);
  if (validationErrors.length) {
    throw new HttpError(409, `Resource restore would make the episode invalid: ${validationErrors.slice(0, 3).join('; ')}`);
  }

  const restore = await restoreTrashItem(appWorkspaceDir, item.id);
  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return {
    ...restore,
    graphRestored: true,
    episodePath: episodeRoot,
    restoredNodeIds: snapshot.nodes.map((node) => node.id).filter(Boolean)
  };
}

function normalizeTrashGraphSnapshot(snapshot) {
  const safe = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    nodes: Array.isArray(safe.nodes) ? safe.nodes.filter((item) => item && typeof item.id === 'string').map(cloneJson) : [],
    edges: Array.isArray(safe.edges) ? safe.edges.filter((item) => item && typeof item.id === 'string').map(cloneJson) : [],
    taskRefs: Array.isArray(safe.taskRefs) ? safe.taskRefs.filter((item) => item && typeof item.id === 'string').map(cloneJson) : [],
    jobRefs: Array.isArray(safe.jobRefs) ? safe.jobRefs.filter((item) => item && typeof item.id === 'string').map(cloneJson) : [],
    shotRefs: Array.isArray(safe.shotRefs) ? safe.shotRefs.filter((item) => item && typeof item.id === 'string').map(cloneJson) : []
  };
}

function applyResourceRestoreSnapshot(doc, snapshot) {
  // 恢复只回填缺失的图谱片段；如果用户删除后又新建了同 ID 资源，则保留当前内容，避免覆盖新编辑。
  if (!Array.isArray(doc.nodes)) doc.nodes = [];
  if (!Array.isArray(doc.edges)) doc.edges = [];
  const nodeIds = new Set(doc.nodes.map((node) => node.id));
  for (const node of snapshot.nodes) {
    if (!nodeIds.has(node.id)) {
      doc.nodes.push(cloneJson(node));
      nodeIds.add(node.id);
    }
  }

  const edgeIds = new Set(doc.edges.map((edge) => edge.id));
  for (const edge of snapshot.edges) {
    if (edgeIds.has(edge.id)) continue;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    doc.edges.push(cloneJson(edge));
    edgeIds.add(edge.id);
  }

  const tasksById = new Map((doc.tasks || []).map((task) => [task.id, task]));
  for (const ref of snapshot.taskRefs) {
    const task = tasksById.get(ref.id);
    if (!task) continue;
    if (ref.promptNodeId && !task.promptNodeId && nodeIds.has(ref.promptNodeId)) task.promptNodeId = ref.promptNodeId;
    if (!Array.isArray(task.outputNodeIds)) task.outputNodeIds = [];
    for (const outputNodeId of ref.outputNodeIds || []) {
      if (nodeIds.has(outputNodeId) && !task.outputNodeIds.includes(outputNodeId)) task.outputNodeIds.push(outputNodeId);
    }
    if (typeof ref.status === 'string') task.status = ref.status;
  }

  const jobsById = new Map((doc.jobs || []).map((job) => [job.id, job]));
  for (const ref of snapshot.jobRefs) {
    const job = jobsById.get(ref.id);
    if (!job) continue;
    if (!Array.isArray(job.outputNodeIds)) job.outputNodeIds = [];
    for (const outputNodeId of ref.outputNodeIds || []) {
      if (nodeIds.has(outputNodeId) && !job.outputNodeIds.includes(outputNodeId)) job.outputNodeIds.push(outputNodeId);
    }
  }

  const shotsById = new Map((doc.shots || []).map((shot) => [shot.id, shot]));
  for (const ref of snapshot.shotRefs) {
    const shot = shotsById.get(ref.id);
    if (shot && typeof ref.status === 'string') shot.status = ref.status;
  }
}

function appendResourceRestoreActivity(doc, { metadata, item, restoredNodeIds, at }) {
  if (!Array.isArray(doc.activityLog)) doc.activityLog = [];
  const label = metadata.title || metadata.nodeId || item.name;
  const stamp = at.replace(/[-:.TZ]/g, '');
  doc.activityLog.push({
    id: uniqueGraphId(`activity:resource-restored:${metadata.nodeId || item.name}:${stamp}`, doc.activityLog.map((entry) => entry.id)),
    type: 'resource_restored',
    at,
    message: `${label} 已从回收站恢复`,
    nodeId: metadata.nodeId || null,
    restoredNodeIds,
    file: {
      path: metadata.relativePath || '',
      trashPath: item.trashPath
    }
  });
}

async function resolveAppSettings({ appWorkspaceDir, settingsFile, resourceCacheDir }) {
  await bootstrapAppWorkspace(appWorkspaceDir);
  const settings = await readAppSettingsFile(settingsFile);
  const custom = resourceCacheDir || (typeof settings.paths?.resourceCacheDir === 'string' ? resolve(settings.paths.resourceCacheDir) : null);
  if (custom) await mkdir(custom, { recursive: true });
  return {
    appWorkspaceDir,
    resourceCacheDir: custom || appWorkspaceDir,
    resourceCacheDirSource: custom ? 'custom' : 'default',
    modelDefaults: applyRecommendedModelDefaults(settings.modelDefaults)
  };
}

async function bootstrapAppWorkspace(appWorkspaceDir) {
  // App-owned directories are internal state, not user project content. Creating them lazily
  // keeps first-run setup invisible in the desktop app while preserving explicit project choice.
  await mkdir(appWorkspaceDir, { recursive: true });
  await mkdir(join(appWorkspaceDir, 'projects'), { recursive: true });
  await mkdir(join(appWorkspaceDir, 'adapters'), { recursive: true });
}

async function readAppSettingsFile(settingsFile) {
  try {
    const raw = JSON.parse(await readFile(settingsFile, 'utf8'));
    return {
      paths: raw.paths && typeof raw.paths === 'object' ? raw.paths : {},
      modelDefaults: sanitizeModelDefaults(raw.modelDefaults)
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { paths: {}, modelDefaults: {} };
    return { paths: {}, modelDefaults: {} };
  }
}

function sanitizeModelDefaults(modelDefaults) {
  if (!modelDefaults || typeof modelDefaults !== 'object' || Array.isArray(modelDefaults)) return {};
  const safe = {};
  for (const [capabilityKey, value] of Object.entries(modelDefaults)) {
    if (!MODEL_DEFAULT_CAPABILITIES.has(capabilityKey)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (typeof value.adapterId !== 'string' || !value.adapterId.trim()) continue;
    const next = { adapterId: value.adapterId.trim() };
    if (typeof value.modelId === 'string' && value.modelId.trim()) next.modelId = value.modelId.trim();
    if (typeof value.providerId === 'string' && value.providerId.trim()) next.providerId = value.providerId.trim();
    safe[capabilityKey] = next;
  }
  return safe;
}

function applyRecommendedModelDefaults(modelDefaults) {
  // 推荐默认值是产品最佳实践，不是用户写盘配置；显式保存的选择始终覆盖推荐。
  return sanitizeModelDefaults({
    ...RECOMMENDED_MODEL_DEFAULTS,
    ...sanitizeModelDefaults(modelDefaults)
  });
}

async function mergeModelDefaults(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new HttpError(400, 'modelDefaults must be an object');
  }
  const adapters = await listAvailableAdapters();
  const next = { ...current };
  for (const [capabilityKey, value] of Object.entries(patch)) {
    const manifestCapability = MODEL_DEFAULT_CAPABILITIES.get(capabilityKey);
    if (!manifestCapability) {
      throw new HttpError(400, `Unknown model capability: ${capabilityKey}`);
    }
    if (value === null) {
      delete next[capabilityKey];
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.adapterId !== 'string') {
      throw new HttpError(400, `modelDefaults.${capabilityKey} requires adapterId`);
    }
    const adapterId = value.adapterId.trim();
    const manifest = adapters.find((item) => item.id === adapterId);
    if (!manifest) {
      throw new HttpError(404, `Unknown adapter: ${adapterId}`);
    }
    const capability = (manifest.capabilities || []).find((item) => item.type === manifestCapability);
    if (!capability) {
      throw new HttpError(400, `Adapter ${adapterId} does not support ${capabilityKey}`);
    }
    const modelId = typeof value.modelId === 'string' && value.modelId.trim()
      ? value.modelId.trim()
      : capability.models?.[0]?.id;
    if (!modelId) {
      throw new HttpError(400, `modelDefaults.${capabilityKey} requires modelId`);
    }
    if (capability.acceptsAnyModel !== true && Array.isArray(capability.models) && capability.models.length > 0) {
      const allowedModel = capability.models.some((model) => model?.id === modelId);
      if (!allowedModel) {
        throw new HttpError(400, `Model ${modelId} is not available for ${adapterId}`);
      }
    }
    next[capabilityKey] = {
      adapterId,
      modelId,
      ...(typeof value.providerId === 'string' && value.providerId.trim() ? { providerId: value.providerId.trim() } : {})
    };
  }
  return sanitizeModelDefaults(next);
}

async function readCredentialStore(credentialsFile) {
  try {
    const raw = JSON.parse(await readFile(credentialsFile, 'utf8'));
    return { credentials: sanitizeCredentialRefs(raw.credentials) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { credentials: [] };
    return { credentials: [] };
  }
}

async function writeCredentialStore(credentialsFile, store) {
  await mkdir(dirname(credentialsFile), { recursive: true });
  const payload = { credentials: sanitizeCredentialRefs(store.credentials) };
  await writeFile(credentialsFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sanitizeCredentialRefs(credentials) {
  if (!Array.isArray(credentials)) return [];
  return credentials
    .filter((item) => item && typeof item.adapterId === 'string' && typeof item.keychainAccount === 'string')
    .map((item) => ({
      ref: item.ref || `credential:${item.adapterId}`,
      adapterId: item.adapterId,
      method: item.method || 'api_key',
      keychainAccount: item.keychainAccount,
      secretFieldKeys: Array.isArray(item.secretFieldKeys) ? item.secretFieldKeys : [],
      publicFields: item.publicFields && typeof item.publicFields === 'object' ? item.publicFields : {},
      updatedAt: item.updatedAt || new Date().toISOString()
    }));
}

function mergeCredentialRefs(globalCredentials, episodeCredentials) {
  // Global credentials are the app default; episode-local records remain a compatibility
  // override so old drama-creator.json files continue to work without migration.
  const byAdapter = new Map();
  for (const cred of usableCredentialRefs(globalCredentials)) byAdapter.set(cred.adapterId, cred);
  for (const cred of usableCredentialRefs(episodeCredentials)) byAdapter.set(cred.adapterId, cred);
  return [...byAdapter.values()];
}

function usableCredentialRefs(credentials) {
  if (!Array.isArray(credentials)) return [];
  return credentials.filter((item) => item && typeof item.adapterId === 'string' && typeof item.keychainAccount === 'string');
}

async function credentialSecretStatus(credentialRef, keychain) {
  const secretKeys = Array.isArray(credentialRef?.secretFieldKeys) ? credentialRef.secretFieldKeys : [];
  if (!secretKeys.length) return 'not_required';
  if (!credentialRef?.keychainAccount || typeof keychain?.readSecret !== 'function') return 'unknown';
  try {
    const raw = await keychain.readSecret(credentialRef.keychainAccount);
    return raw ? 'present' : 'missing';
  } catch {
    return 'unknown';
  }
}

async function handleListLibrary(url, res, allowedEpisodeRoots, registryFile) {
  const projectPath = url.searchParams.get('path');
  if (!projectPath) {
    sendJson(res, 400, { error: 'Missing project path' });
    return;
  }
  const safeAllowedRoots = await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile);
  let safeProjectRoot;
  try {
    safeProjectRoot = await realpath(resolve(projectPath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendJson(res, 404, { error: 'Project path not found' });
      return;
    }
    throw error;
  }
  if (!safeAllowedRoots.some((root) => isPathInside(safeProjectRoot, root))) {
    throw new HttpError(403, 'Forbidden project path');
  }
  const library = await listProjectLibrary(safeProjectRoot);
  sendJson(res, 200, { projectPath: safeProjectRoot, library });
}

async function handleGenerateLibraryFromScript(req, res, allowedEpisodeRoots, registryFile) {
  const body = await readJsonBody(req);
  if (!body.episodePath) {
    sendJson(res, 400, { error: '缺少分集路径，无法生成公共资产。' });
    return;
  }

  const authorizedRoots = await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile);
  const { doc, docPath, safeRoot } = await loadEpisodeDoc(body.episodePath, authorizedRoots);
  const result = generatePublicAssetsFromScript(doc, {
    scriptText: typeof body.scriptText === 'string' ? body.scriptText : undefined,
    now: new Date().toISOString()
  });
  if (result.reason === 'missing_script') {
    sendJson(res, 400, { error: '请先保存分镜剧本，再从剧本生成公共资产。' });
    return;
  }

  const validationErrors = validateDramaCreatorDocument(doc);
  if (validationErrors.length) {
    // 生成候选资产是写文档操作，写盘前先跑 schema 校验，避免把坏状态带入用户项目。
    throw new HttpError(400, `公共资产生成后文档校验失败：${validationErrors[0]}`);
  }
  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  sendJson(res, 200, {
    ok: true,
    episodePath: safeRoot,
    createdCount: result.createdCount,
    totalCount: result.totalCount,
    assets: result.assets
  });
}

async function handleDeleteLibraryItem(req, res, allowedEpisodeRoots, registryFile, appWorkspaceDir) {
  const body = await readJsonBody(req);
  if (!body.projectPath || (!body.assetId && !body.path)) {
    sendJson(res, 400, { error: '缺少要删除的资产信息' });
    return;
  }

  const safeProjectRoot = await resolveProjectPath(body.projectPath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const relativeAssetPath = normalizeProjectRelativeAssetPath(body.path || body.sourcePath || '');
  if (relativeAssetPath) {
    // Public assets can be reused by shots; deleting a referenced file would leave broken shot canvases.
    const references = await findProjectAssetNodeReferences(safeProjectRoot, relativeAssetPath);
    if (references.length) {
      sendJson(res, 409, {
        error: `这个资产仍被 ${references.length} 个分镜资源引用，请先在对应分镜里移除引用后再删除。`,
        references: references.slice(0, 10)
      });
      return;
    }
  }

  const trashedFile = relativeAssetPath
    ? await trashProjectLibraryFile({
      projectRoot: safeProjectRoot,
      relativeAssetPath,
      appWorkspaceDir,
      asset: body
    })
    : null;

  const record = body.episodePath
    ? await removePublicAssetRecord({
      episodePath: body.episodePath,
      authorizedRoots: await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile),
      assetId: body.assetId,
      relativeAssetPath,
      title: body.title
    })
    : { removed: false };

  if (!trashedFile && !record.removed) {
    sendJson(res, 404, { error: '没有找到可删除的资产文件或资产记录' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    action: trashedFile ? 'trashed' : 'record_removed',
    assetId: body.assetId || null,
    path: relativeAssetPath,
    trashedFile,
    record
  });
}

async function resolveProjectPath(projectPath, authorizedRoots) {
  let safeProjectRoot;
  try {
    safeProjectRoot = await realpath(resolve(projectPath));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(404, '项目不存在');
    throw error;
  }
  if (!authorizedRoots.some((root) => isPathInside(safeProjectRoot, root))) {
    throw new HttpError(403, '没有权限访问这个项目');
  }
  return safeProjectRoot;
}

function normalizeProjectRelativeAssetPath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.startsWith('app-cache/')) return '';
  // Only project-relative asset paths are accepted so the delete endpoint cannot touch arbitrary files.
  if (isAbsolute(raw)) throw new HttpError(400, '资产路径必须属于当前项目');
  const normalizedPath = normalize(raw).replace(/\\/g, '/');
  if (!normalizedPath || normalizedPath === '.' || normalizedPath.startsWith('../') || normalizedPath.includes('/../')) {
    throw new HttpError(400, '资产路径必须属于当前项目');
  }
  return normalizedPath;
}

async function trashProjectLibraryFile({ projectRoot, relativeAssetPath, appWorkspaceDir, asset }) {
  const candidate = resolve(projectRoot, relativeAssetPath);
  if (!isPathInside(candidate, projectRoot)) {
    throw new HttpError(403, '资产路径必须属于当前项目');
  }

  let resolvedAssetPath;
  try {
    resolvedAssetPath = await realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!isPathInside(resolvedAssetPath, projectRoot)) {
    throw new HttpError(403, '资产路径必须属于当前项目');
  }
  const info = await stat(resolvedAssetPath);
  if (!info.isFile()) throw new HttpError(400, '只能删除单个资产文件');

  const trashed = await movePathToTrash({
    targetPath: resolvedAssetPath,
    trashRoot: trashRootForWorkspace(appWorkspaceDir, 'resources'),
    reason: 'public_asset_deleted',
    metadata: {
      kind: 'resource',
      scope: 'public_asset',
      assetId: asset.assetId || null,
      title: asset.title || basename(resolvedAssetPath),
      category: asset.category || '',
      projectPath: projectRoot,
      relativePath: relativeAssetPath
    }
  });
  return {
    path: relativeAssetPath,
    trashPath: trashed.trashPath,
    bytes: trashed.bytes
  };
}

async function removePublicAssetRecord({ episodePath, authorizedRoots, assetId, relativeAssetPath, title }) {
  let doc;
  let docPath;
  try {
    ({ doc, docPath } = await loadEpisodeDoc(episodePath, authorizedRoots));
  } catch {
    return { removed: false, reason: 'episode_not_found' };
  }
  const before = Array.isArray(doc.publicAssets) ? doc.publicAssets : [];
  if (!before.length) return { removed: false };

  const removed = [];
  const next = before.filter((asset) => {
    const matched = doesPublicAssetMatchDeleteRequest(asset, { assetId, relativeAssetPath, title });
    if (matched) removed.push(cloneJson(asset));
    return !matched;
  });
  if (!removed.length) return { removed: false };

  doc.publicAssets = next;
  appendPublicAssetDeleteActivity(doc, removed[0]);
  const validationErrors = validateDramaCreatorDocument(doc);
  if (validationErrors.length) {
    throw new HttpError(400, '资产记录删除后文档校验失败');
  }
  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return {
    removed: true,
    episodePath,
    removedAssetIds: removed.map((asset) => asset.id).filter(Boolean)
  };
}

function doesPublicAssetMatchDeleteRequest(asset, { assetId, relativeAssetPath, title }) {
  if (!asset || typeof asset !== 'object') return false;
  if (assetId && asset.id === assetId) return true;
  if (relativeAssetPath && (asset.sourcePath === relativeAssetPath || asset.path === relativeAssetPath)) return true;
  return Boolean(title && asset.title === title && !relativeAssetPath);
}

function appendPublicAssetDeleteActivity(doc, asset) {
  if (!Array.isArray(doc.activityLog)) doc.activityLog = [];
  const at = new Date().toISOString();
  const stamp = at.replace(/[-:.TZ]/g, '');
  doc.activityLog.push({
    id: uniqueGraphId(`activity:public-asset-deleted:${asset.id || asset.title || 'asset'}:${stamp}`, doc.activityLog.map((entry) => entry.id)),
    type: 'public_asset_deleted',
    at,
    message: `${asset.title || asset.id || '公共资产'} 已从公共资产库移除`,
    assetId: asset.id || null,
    path: asset.sourcePath || asset.path || ''
  });
}

async function findProjectAssetNodeReferences(projectRoot, relativeAssetPath) {
  const episodeEntries = await listProjectEpisodeDocumentPaths(projectRoot);
  const references = [];
  for (const entry of episodeEntries) {
    let doc;
    try {
      doc = JSON.parse(await readFile(entry.docPath, 'utf8'));
    } catch {
      continue;
    }
    const shotsById = new Map((doc.shots || []).map((shot) => [shot.id, shot]));
    for (const node of doc.nodes || []) {
      if (node?.path !== relativeAssetPath) continue;
      const shot = shotsById.get(node.shotId);
      references.push({
        episodeId: doc.episode?.id || entry.episodeId,
        shotNo: shot?.shotNo || '',
        nodeId: node.id,
        title: node.title || ''
      });
    }
  }
  return references;
}

async function listProjectEpisodeDocumentPaths(projectRoot) {
  const roots = [join(projectRoot, 'episodes'), join(projectRoot, 'scripts', 'episodes')];
  const docs = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      docs.push({
        episodeId: entry.name,
        docPath: join(root, entry.name, 'drama-creator.json')
      });
    }
  }
  return docs;
}

async function handleGetEpisode(url, res, allowedEpisodeRoots, registryFile) {
  const episodePath = url.searchParams.get('path');
  if (!episodePath) {
    sendJson(res, 400, { error: 'Missing episode path' });
    return;
  }

  const safeEpisodePath = await resolveEpisodePath(episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const data = await readEpisodeState(safeEpisodePath);
  sendJson(res, 200, JSON.parse(data));
}

async function handleImport(req, res, allowedEpisodeRoots, registryFile) {
  const body = await readJsonBody(req);
  if (!body.episodePath) {
    sendJson(res, 400, { error: 'Missing episodePath' });
    return;
  }

  const safeEpisodePath = await resolveEpisodePath(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const doc = await importEpisode({ episodePath: safeEpisodePath, write: true });
  sendJson(res, 200, doc);
}

async function handlePatchEpisode(req, res, allowedEpisodeRoots, registryFile) {
  const body = await readJsonBody(req);
  if (!body.episodePath || !body.document) {
    sendJson(res, 400, { error: 'Missing episodePath or document' });
    return;
  }

  const safeEpisodePath = await resolveEpisodePath(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  normalizeVideoVersionState(body.document);
  const validationErrors = validateDramaCreatorDocument(body.document);
  if (validationErrors.length) {
    // Reject malformed state before writing drama-creator.json, but only return schema messages.
    sendJson(res, 400, { error: 'Invalid episode document', details: validationErrors.slice(0, 5) });
    return;
  }
  await writeFile(join(safeEpisodePath, 'drama-creator.json'), `${JSON.stringify(body.document, null, 2)}\n`, 'utf8');
  sendJson(res, 200, { ok: true });
}

async function handleManualAssetImport(req, res, allowedEpisodeRoots, registryFile) {
  const body = await readJsonBody(req);
  if (!body.episodePath || !body.sourcePath || !body.kind) {
    sendJson(res, 400, { error: 'Missing episodePath/sourcePath/kind' });
    return;
  }

  const kindConfig = manualImportKinds[body.kind];
  if (!kindConfig) {
    sendJson(res, 400, { error: 'kind must be image or video' });
    return;
  }
  if (typeof body.sourcePath !== 'string' || !isAbsolute(body.sourcePath)) {
    sendJson(res, 400, { error: 'sourcePath must be an absolute file path' });
    return;
  }

  let safeSourcePath;
  try {
    safeSourcePath = await realpath(resolve(body.sourcePath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendJson(res, 404, { error: 'Source file not found' });
      return;
    }
    throw error;
  }

  const sourceStat = await stat(safeSourcePath);
  if (!sourceStat.isFile()) {
    sendJson(res, 400, { error: 'sourcePath must point to a file' });
    return;
  }
  const sourceExt = extname(safeSourcePath).toLowerCase();
  if (!kindConfig.extensions.has(sourceExt)) {
    sendJson(res, 415, { error: `${body.kind} import does not support ${sourceExt || 'this file type'}` });
    return;
  }

  const { doc, safeRoot, docPath } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const shot = findShotForImport(doc, body.shotNo);
  if (body.shotNo && !shot) {
    sendJson(res, 404, { error: `Shot not found: ${body.shotNo}` });
    return;
  }

  const importedAt = new Date().toISOString();
  const originalName = basename(safeSourcePath);
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : parse(originalName).name;
  const shotNo = shot ? shot.shotNo || shot.id.replace(/^shot:/, '') : null;
  const destFileName = buildManualAssetFileName({ sourcePath: safeSourcePath, title, shotNo, importedAt });
  const relativePath = `${kindConfig.directory}/${destFileName}`;
  const destPath = join(safeRoot, relativePath);

  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(safeSourcePath, destPath);

  const assetNode = createManualAssetNode({
    doc,
    kind: body.kind,
    nodeType: kindConfig.nodeType,
    title,
    relativePath,
    shotId: shot?.id || null,
    originalName,
    importedAt
  });
  doc.nodes.push(assetNode);
  attachManualAssetToGraph(doc, assetNode, { kind: body.kind, shot });
  if (body.kind === 'video' && shot) {
    // 外部平台下载后回填的视频先进入候选位；用户明确确认后才会成为成片 current 版本。
    markVideoNodeAsCandidate(doc, shot, assetNode);
  }
  appendManualImportActivity(doc, assetNode, { kind: body.kind, originalName, importedAt });

  const validationErrors = validateDramaCreatorDocument(doc);
  if (validationErrors.length) {
    sendJson(res, 400, { error: 'Invalid episode document', details: validationErrors.slice(0, 5) });
    return;
  }

  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  sendJson(res, 200, { asset: assetNode });
}

async function handlePromoteVideoVersion(req, res, allowedEpisodeRoots, registryFile) {
  const body = await readJsonBody(req);
  if (!body.episodePath || !body.shotNo || !body.nodeId) {
    sendJson(res, 400, { error: 'Missing episodePath/shotNo/nodeId' });
    return;
  }

  const { doc, docPath } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const result = promoteVideoNodeToCurrent(doc, {
    shotNo: body.shotNo,
    nodeId: body.nodeId
  });
  if (result.error) {
    sendJson(res, result.statusCode || 400, { error: result.error });
    return;
  }
  const validationErrors = validateDramaCreatorDocument(doc);
  if (validationErrors.length) {
    sendJson(res, 400, { error: 'Invalid episode document', details: validationErrors.slice(0, 5) });
    return;
  }
  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  sendJson(res, 200, {
    shot: result.shot,
    video: result.node,
    videoVersions: result.videoVersions
  });
}

async function handleAddEpisodeReference(req, res, allowedEpisodeRoots, registryFile) {
  const body = await readJsonBody(req);
  if (!body.episodePath || !body.shotNo || !body.assetNodeId) {
    sendJson(res, 400, { error: 'Missing episodePath/shotNo/assetNodeId' });
    return;
  }

  const { doc, docPath } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const context = resolveShotReferenceContext(doc, body.shotNo);
  if (context.error) {
    sendJson(res, context.statusCode, { error: context.error });
    return;
  }

  const asset = findReferenceAsset(doc, body.assetNodeId);
  if (!asset) {
    sendJson(res, 404, { error: `Reference asset not found: ${body.assetNodeId}` });
    return;
  }
  if (!REFERENCE_ASSET_NODE_TYPES.has(asset.type)) {
    sendJson(res, 400, { error: `Resource type ${asset.type} cannot be used as a shot reference` });
    return;
  }

  if (!Array.isArray(doc.edges)) doc.edges = [];
  const role = normalizeReferenceRole(body.role) || defaultReferenceRole(asset);
  const existing = collectPromptReferenceEdges(doc, context.prompt.id).find((edge) => edge.to === asset.id);
  let reference = existing;
  if (existing) {
    existing.role = existing.role || role;
    existing.status = 'active';
  } else {
    reference = createEdge({
      id: uniqueGraphId(
        `edge:shot-reference:${normalizeIdPart(context.prompt.id)}:${normalizeIdPart(asset.id)}`,
        doc.edges.map((edge) => edge.id)
      ),
      from: context.prompt.id,
      to: asset.id,
      type: referenceEdgeTypeForPrompt(context.prompt),
      role,
      note: '用户添加为当前分镜参考资源'
    });
    doc.edges.push(reference);
    appendShotReferenceActivity(doc, 'shot_reference_added', {
      shot: context.shot,
      asset,
      message: `已把 ${asset.title || asset.id} 添加为 ${context.shot.shotNo || context.shot.id} 的参考资源`
    });
  }

  if (!(await validateAndWriteEpisodeDoc(doc, docPath, res))) return;
  sendJson(res, 200, {
    reference,
    references: collectPromptReferenceEdges(doc, context.prompt.id)
  });
}

async function handleReorderEpisodeReferences(req, res, allowedEpisodeRoots, registryFile) {
  const body = await readJsonBody(req);
  if (body.referenceEdgeId && body.assetNodeId) {
    await handleReplaceEpisodeReference(body, res, allowedEpisodeRoots, registryFile);
    return;
  }
  if (!body.episodePath || !body.shotNo || !Array.isArray(body.orderedAssetNodeIds)) {
    sendJson(res, 400, { error: 'Missing episodePath/shotNo/orderedAssetNodeIds' });
    return;
  }
  const orderedAssetNodeIds = body.orderedAssetNodeIds.filter((id) => typeof id === 'string' && id.trim());
  if (orderedAssetNodeIds.length !== new Set(orderedAssetNodeIds).size) {
    sendJson(res, 400, { error: 'orderedAssetNodeIds contains duplicates' });
    return;
  }

  const { doc, docPath } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const context = resolveShotReferenceContext(doc, body.shotNo);
  if (context.error) {
    sendJson(res, context.statusCode, { error: context.error });
    return;
  }

  const currentReferences = collectPromptReferenceEdges(doc, context.prompt.id);
  const referenceByAssetId = new Map(currentReferences.map((edge) => [edge.to, edge]));
  for (const assetNodeId of orderedAssetNodeIds) {
    if (!referenceByAssetId.has(assetNodeId)) {
      sendJson(res, 400, { error: `Reference is not attached to this shot: ${assetNodeId}` });
      return;
    }
  }

  const orderedReferences = orderedAssetNodeIds.map((assetNodeId) => referenceByAssetId.get(assetNodeId));
  const orderedIds = new Set(orderedReferences.map((edge) => edge.id));
  const remainingReferences = currentReferences.filter((edge) => !orderedIds.has(edge.id));
  const allReferenceIds = new Set(currentReferences.map((edge) => edge.id));
  const nextEdges = [];
  let inserted = false;
  for (const edge of doc.edges || []) {
    if (!allReferenceIds.has(edge.id)) {
      nextEdges.push(edge);
      continue;
    }
    if (!inserted) {
      // doc.edges 的顺序就是投喂包 @图片N 的顺序；只在第一条参考边位置整体替换，避免扰动其他图谱边。
      nextEdges.push(...orderedReferences, ...remainingReferences);
      inserted = true;
    }
  }
  if (!inserted) nextEdges.push(...orderedReferences, ...remainingReferences);
  doc.edges = nextEdges;
  appendShotReferenceActivity(doc, 'shot_references_reordered', {
    shot: context.shot,
    message: `${context.shot.shotNo || context.shot.id} 的参考资源顺序已更新`
  });

  if (!(await validateAndWriteEpisodeDoc(doc, docPath, res))) return;
  sendJson(res, 200, {
    references: collectPromptReferenceEdges(doc, context.prompt.id)
  });
}

async function handleReplaceEpisodeReference(body, res, allowedEpisodeRoots, registryFile) {
  if (!body.episodePath || !body.shotNo || !body.referenceEdgeId || !body.assetNodeId) {
    sendJson(res, 400, { error: 'Missing episodePath/shotNo/referenceEdgeId/assetNodeId' });
    return;
  }

  const { doc, docPath } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const context = resolveShotReferenceContext(doc, body.shotNo);
  if (context.error) {
    sendJson(res, context.statusCode, { error: context.error });
    return;
  }

  const currentReferences = collectPromptReferenceEdges(doc, context.prompt.id);
  const target = currentReferences.find((edge) => edge.id === body.referenceEdgeId);
  if (!target) {
    sendJson(res, 404, { error: 'Reference edge not found for this shot' });
    return;
  }

  const asset = findReferenceAsset(doc, body.assetNodeId);
  if (!asset) {
    sendJson(res, 404, { error: `Reference asset not found: ${body.assetNodeId}` });
    return;
  }
  if (!REFERENCE_ASSET_NODE_TYPES.has(asset.type)) {
    sendJson(res, 400, { error: `Resource type ${asset.type} cannot be used as a shot reference` });
    return;
  }
  if (currentReferences.some((edge) => edge.id !== target.id && edge.to === asset.id)) {
    sendJson(res, 409, { error: 'Reference asset is already attached to this shot' });
    return;
  }

  const edgeIdsWithoutTarget = (doc.edges || [])
    .filter((edge) => edge.id !== target.id)
    .map((edge) => edge.id);
  const replacement = createEdge({
    id: uniqueGraphId(
      `edge:shot-reference:${normalizeIdPart(context.prompt.id)}:${normalizeIdPart(asset.id)}`,
      edgeIdsWithoutTarget
    ),
    from: context.prompt.id,
    to: asset.id,
    type: referenceEdgeTypeForPrompt(context.prompt),
    role: normalizeReferenceRole(body.role) || defaultReferenceRole(asset),
    note: '用户替换当前分镜参考资源'
  });

  // 替换只改当前槽位的目标资产，不移动其他参考边；doc.edges 的相对顺序仍决定即梦 @图片N。
  doc.edges = (doc.edges || []).map((edge) => (edge.id === target.id ? replacement : edge));
  appendShotReferenceActivity(doc, 'shot_reference_replaced', {
    shot: context.shot,
    asset,
    message: `已把 ${context.shot.shotNo || context.shot.id} 的参考资源替换为 ${asset.title || asset.id}`
  });

  if (!(await validateAndWriteEpisodeDoc(doc, docPath, res))) return;
  sendJson(res, 200, {
    reference: replacement,
    references: collectPromptReferenceEdges(doc, context.prompt.id)
  });
}

async function handleRemoveEpisodeReference(req, res, allowedEpisodeRoots, registryFile) {
  const body = await readJsonBody(req);
  if (!body.episodePath || !body.shotNo || (!body.assetNodeId && !body.referenceEdgeId)) {
    sendJson(res, 400, { error: 'Missing episodePath/shotNo and assetNodeId/referenceEdgeId' });
    return;
  }

  const { doc, docPath } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const context = resolveShotReferenceContext(doc, body.shotNo);
  if (context.error) {
    sendJson(res, context.statusCode, { error: context.error });
    return;
  }

  const currentReferences = collectPromptReferenceEdges(doc, context.prompt.id);
  const target = currentReferences.find((edge) => edge.id === body.referenceEdgeId || edge.to === body.assetNodeId);
  if (!target) {
    sendJson(res, 404, { error: 'Reference edge not found for this shot' });
    return;
  }

  const asset = (doc.nodes || []).find((node) => node.id === target.to) || null;
  doc.edges = (doc.edges || []).filter((edge) => edge.id !== target.id);
  appendShotReferenceActivity(doc, 'shot_reference_removed', {
    shot: context.shot,
    asset,
    message: `已从 ${context.shot.shotNo || context.shot.id} 移除参考资源 ${asset?.title || target.to}`
  });

  if (!(await validateAndWriteEpisodeDoc(doc, docPath, res))) return;
  sendJson(res, 200, {
    removedReferenceId: target.id,
    references: collectPromptReferenceEdges(doc, context.prompt.id)
  });
}

async function handleDeleteEpisodeResource(req, res, allowedEpisodeRoots, registryFile, appWorkspaceDir) {
  const body = await readJsonBody(req);
  if (!body.episodePath || !body.nodeId) {
    sendJson(res, 400, { error: 'Missing episodePath or nodeId' });
    return;
  }

  const authorizedRoots = await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile);
  const { doc, safeRoot, docPath } = await loadEpisodeDoc(body.episodePath, authorizedRoots);
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const target = nodes.find((node) => node.id === body.nodeId);
  if (!target) {
    sendJson(res, 404, { error: 'Resource node not found' });
    return;
  }
  if (!DELETABLE_RESOURCE_NODE_TYPES.has(target.type)) {
    sendJson(res, 400, { error: `Resource type ${target.type} cannot be deleted in V1. Delete media assets or outputs only.` });
    return;
  }

  const deletePlan = buildResourceDeletePlan(doc, target);
  const fileResult = await maybeTrashNodeFile({
    doc,
    target,
    deletePlan,
    safeRoot,
    authorizedRoots,
    appWorkspaceDir
  });

  applyResourceDeletePlan(doc, deletePlan);
  appendResourceDeleteActivity(doc, {
    target,
    deletePlan,
    fileResult,
    at: new Date().toISOString()
  });

  const validationErrors = validateDramaCreatorDocument(doc);
  if (validationErrors.length) {
    sendJson(res, 400, { error: 'Invalid episode document after resource deletion', details: validationErrors.slice(0, 5) });
    return;
  }

  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  sendJson(res, 200, {
    ok: true,
    deletedNodeIds: [...deletePlan.nodeIds],
    trashedFiles: fileResult.trashed ? [fileResult.trashed] : [],
    skippedFiles: fileResult.skipped ? [fileResult.skipped] : []
  });
}

function buildResourceDeletePlan(doc, target) {
  const nodeIds = new Set([target.id]);
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc.edges) ? doc.edges : [];

  if (target.type === 'video_output') {
    for (const edge of edges) {
      if (edge.type === 'qc_for' && edge.to === target.id) nodeIds.add(edge.from);
    }
  }

  const deletedNodes = nodes.filter((node) => nodeIds.has(node.id)).map(cloneJson);
  const deletedEdges = edges
    .filter((edge) => nodeIds.has(edge.from) || nodeIds.has(edge.to))
    .map(cloneJson);
  const deletedNodeIds = new Set(deletedNodes.map((node) => node.id));
  const taskRefs = (doc.tasks || [])
    .filter((task) => deletedNodeIds.has(task.promptNodeId) || (task.outputNodeIds || []).some((id) => deletedNodeIds.has(id)))
    .map((task) => cloneJson({
      id: task.id,
      status: task.status,
      promptNodeId: task.promptNodeId || null,
      outputNodeIds: Array.isArray(task.outputNodeIds) ? task.outputNodeIds : []
    }));
  const jobRefs = (doc.jobs || [])
    .filter((job) => (job.outputNodeIds || []).some((id) => deletedNodeIds.has(id)))
    .map((job) => cloneJson({
      id: job.id,
      outputNodeIds: Array.isArray(job.outputNodeIds) ? job.outputNodeIds : []
    }));
  const affectedShotIds = new Set(deletedNodes.map((node) => node.shotId).filter(Boolean));
  const shotRefs = (doc.shots || [])
    .filter((shot) => affectedShotIds.has(shot.id))
    .map((shot) => cloneJson({ id: shot.id, status: shot.status }));

  // graphSnapshot 是回收站恢复的最小可逆信息；只保存被删除的图谱片段和会被删除流程改写的引用。
  return {
    nodeIds,
    graphSnapshot: {
      nodes: deletedNodes,
      edges: deletedEdges,
      taskRefs,
      jobRefs,
      shotRefs
    }
  };
}

async function maybeTrashNodeFile({ doc, target, deletePlan, safeRoot, authorizedRoots, appWorkspaceDir }) {
  if (!FILE_BACKED_RESOURCE_NODE_TYPES.has(target.type) || !target.path) {
    return { skipped: { path: target.path || '', reason: 'node_has_no_file' } };
  }
  if (String(target.path).startsWith('app-cache/')) {
    return { skipped: { path: target.path, reason: 'app_cache_reference' } };
  }

  const stillReferenced = (doc.nodes || []).some((node) => node.id !== target.id && node.path === target.path);
  if (stillReferenced) {
    return { skipped: { path: target.path, reason: 'still_referenced' } };
  }

  const safeAssetPath = await locateAssetCandidate(enclosingBaseCandidates(safeRoot, authorizedRoots), target.path);
  if (!safeAssetPath) {
    return { skipped: { path: target.path, reason: 'file_not_found' } };
  }
  if (!isPathInside(safeAssetPath, safeRoot)) {
    // 项目级公共资产可能被多个分集/镜头引用；单镜头删除只摘除引用，不移动共享文件。
    return { skipped: { path: target.path, reason: 'shared_project_asset' } };
  }

  const trashed = await movePathToTrash({
    targetPath: safeAssetPath,
    trashRoot: trashRootForWorkspace(appWorkspaceDir, 'resources'),
    reason: 'resource_deleted',
    metadata: {
      kind: 'resource',
      nodeId: target.id,
      nodeType: target.type,
      title: target.title,
      episodePath: safeRoot,
      relativePath: target.path,
      graphSnapshot: deletePlan.graphSnapshot
    }
  });
  return {
    trashed: {
      path: target.path,
      trashPath: trashed.trashPath,
      bytes: trashed.bytes
    }
  };
}

function applyResourceDeletePlan(doc, deletePlan) {
  const deleted = deletePlan.nodeIds;
  doc.nodes = (doc.nodes || []).filter((node) => !deleted.has(node.id));
  doc.edges = (doc.edges || []).filter((edge) => !deleted.has(edge.from) && !deleted.has(edge.to));

  for (const task of doc.tasks || []) {
    if (Array.isArray(task.outputNodeIds)) {
      const before = task.outputNodeIds.length;
      task.outputNodeIds = task.outputNodeIds.filter((id) => !deleted.has(id));
      if (before !== task.outputNodeIds.length && ['reviewing', 'approved', 'rerun_needed'].includes(task.status)) {
        task.status = 'ready_to_feed';
      }
    }
    if (task.promptNodeId && deleted.has(task.promptNodeId)) task.promptNodeId = null;
  }

  for (const job of doc.jobs || []) {
    if (Array.isArray(job.outputNodeIds)) {
      job.outputNodeIds = job.outputNodeIds.filter((id) => !deleted.has(id));
    }
  }

  for (const shot of doc.shots || []) {
    if (shot.status === 'approved' || shot.status === 'reviewing') {
      const hasOutput = (doc.nodes || []).some((node) => node.type === 'video_output' && node.shotId === shot.id);
      if (!hasOutput) shot.status = 'ready_to_feed';
    }
  }
}

function appendResourceDeleteActivity(doc, { target, deletePlan, fileResult, at }) {
  if (!Array.isArray(doc.activityLog)) doc.activityLog = [];
  const stamp = at.replace(/[-:.TZ]/g, '');
  doc.activityLog.push({
    id: uniqueGraphId(`activity:resource-deleted:${target.id}:${stamp}`, doc.activityLog.map((item) => item.id)),
    type: 'resource_deleted',
    at,
    message: `${target.title || target.id} 已删除${fileResult.trashed ? '并移入回收站' : '；文件未移动'}`,
    nodeId: target.id,
    deletedNodeIds: [...deletePlan.nodeIds],
    file: fileResult.trashed || fileResult.skipped || null
  });
}

async function handleJimengFeedPackage(req, res, allowedEpisodeRoots, registryFile, { appWorkspaceDir, settingsFile, resourceCacheDir }) {
  const body = await readJsonBody(req);
  if (!body.episodePath || !body.taskId) {
    sendJson(res, 400, { error: 'Missing episodePath/taskId' });
    return;
  }

  const { doc, safeRoot } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const appSettings = await resolveAppSettings({ appWorkspaceDir, settingsFile, resourceCacheDir });
  const projectRoot = inferProjectRootFromEpisodePath(safeRoot);
  const projectOptions = await readJimengProjectOptions(projectRoot);
  const task = (doc.tasks || []).find((item) => item.id === body.taskId);
  const capability = task?.type === 'audio' ? 'audio' : 'video';
  // 只生成给浏览器自动化执行器消费的 handoff JSON，不写回 drama-creator.json，
  // 也不触发任何外部平台提交，避免绕过即梦自动化技能要求的人工确认门禁。
  const feedPackage = createJimengFeedPackage(doc, body.taskId, {
    episodeRoot: safeRoot,
    projectRoot,
    resourceCacheDir: appSettings.resourceCacheDir,
    modelDefault: appSettings.modelDefaults?.[capability],
    jimengSpaceName: projectOptions.jimengSpaceName
  });
  sendJson(res, 200, { package: feedPackage });
}

async function handleJimengAutomationStart(req, res, allowedEpisodeRoots, registryFile, { appWorkspaceDir, settingsFile, resourceCacheDir }) {
  const body = await readJsonBody(req);
  if (!body.episodePath || !body.taskId) {
    sendJson(res, 400, { error: 'Missing episodePath/taskId' });
    return;
  }

  const { doc, safeRoot } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const appSettings = await resolveAppSettings({ appWorkspaceDir, settingsFile, resourceCacheDir });
  const projectRoot = inferProjectRootFromEpisodePath(safeRoot);
  const projectOptions = await readJimengProjectOptions(projectRoot);
  const task = (doc.tasks || []).find((item) => item.id === body.taskId);
  const capability = task?.type === 'audio' ? 'audio' : 'video';
  const feedPackage = createJimengFeedPackage(doc, body.taskId, {
    episodeRoot: safeRoot,
    projectRoot,
    resourceCacheDir: appSettings.resourceCacheDir,
    modelDefault: appSettings.modelDefaults?.[capability],
    jimengSpaceName: projectOptions.jimengSpaceName
  });

  try {
    const automation = await prepareJimengAutomationRun(feedPackage, {
      appWorkspaceDir,
      launchBrowser: body.launchBrowser !== false
    });
    // 自动化启动与投喂包是同一次用户动作的两个结果：前端需要保留投喂包给用户核对，
    // 同时展示托管浏览器当前停在哪个确认门禁，避免按钮点击后只依赖原生 alert 反馈。
    sendJson(res, 200, { package: feedPackage, automation });
  } catch (error) {
    if (error instanceof JimengAutomationError) {
      sendJson(res, error.statusCode || 500, {
        error: error.code,
        message: error.message,
        missingReferences: error.missingReferences || []
      });
      return;
    }
    throw error;
  }
}

async function handlePublicAudioGenerationStart(req, res, allowedEpisodeRoots, registryFile, { appWorkspaceDir, settingsFile, resourceCacheDir }) {
  const body = await readJsonBody(req);
  if (!body.episodePath || !body.assetId) {
    sendJson(res, 400, { error: '缺少 episodePath 或 assetId' });
    return;
  }

  const authorizedRoots = await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile);
  const { doc, docPath, safeRoot } = await loadEpisodeDoc(body.episodePath, authorizedRoots);
  let prepared;
  try {
    prepared = ensurePublicAudioGenerationTask(doc, body.assetId, { now: new Date().toISOString() });
  } catch (error) {
    sendJson(res, 400, { error: error?.message || String(error) });
    return;
  }

  const validationErrors = validateDramaCreatorDocument(doc);
  if (validationErrors.length) {
    sendJson(res, 400, { error: '音色任务写入前文档校验失败', details: validationErrors.slice(0, 5) });
    return;
  }
  // 先固化任务再打开托管窗口；即使外部页面暂时加载失败，用户也能在公共资产上重试同一任务。
  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

  const appSettings = await resolveAppSettings({ appWorkspaceDir, settingsFile, resourceCacheDir });
  const projectRoot = inferProjectRootFromEpisodePath(safeRoot);
  const projectOptions = await readJimengProjectOptions(projectRoot);
  const feedPackage = createJimengFeedPackage(doc, prepared.taskId, {
    episodeRoot: safeRoot,
    projectRoot,
    resourceCacheDir: appSettings.resourceCacheDir,
    modelDefault: appSettings.modelDefaults?.audio,
    jimengSpaceName: projectOptions.jimengSpaceName
  });

  try {
    const automation = await prepareJimengAutomationRun(feedPackage, {
      appWorkspaceDir,
      launchBrowser: body.launchBrowser !== false
    });
    sendJson(res, 200, {
      ok: true,
      asset: prepared.asset,
      taskId: prepared.taskId,
      promptNodeId: prepared.promptNodeId,
      package: feedPackage,
      automation
    });
  } catch (error) {
    if (error instanceof JimengAutomationError) {
      sendJson(res, error.statusCode || 500, {
        error: error.code,
        message: error.message,
        taskId: prepared.taskId,
        missingReferences: error.missingReferences || []
      });
      return;
    }
    throw error;
  }
}

async function handleExportEpisode(req, res, allowedEpisodeRoots, registryFile, ffmpegPath) {
  const body = await readJsonBody(req);
  if (!body.episodePath) {
    sendJson(res, 400, { error: 'Missing episodePath' });
    return;
  }
  const { doc, safeRoot } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const abortController = new AbortController();
  // 桌面端点击“取消导出”会中断 HTTP 请求；服务端据此取消 ffmpeg，避免后台导出继续跑。
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });
  try {
    const result = await exportEpisodeVideo({
      doc,
      episodePath: safeRoot,
      ffmpegPath,
      status: body.exportStatus === 'final' || body.exportStatus === 'draft' ? body.exportStatus : undefined,
      signal: abortController.signal
    });
    if (res.destroyed) return;
    sendJson(res, 200, { export: result });
  } catch (error) {
    if (res.destroyed) return;
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { error: error.publicMessage || error.message });
      return;
    }
    throw error;
  }
}

async function handleGetExportPreview(url, res, allowedEpisodeRoots, registryFile) {
  const episodePath = url.searchParams.get('episodePath');
  if (!episodePath) {
    sendJson(res, 400, { error: 'Missing episodePath' });
    return;
  }
  const { doc, safeRoot } = await loadEpisodeDoc(episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const result = await readExistingShotPreview({ doc, episodePath: safeRoot });
  sendJson(res, 200, { preview: result });
}

async function handleExportPreview(req, res, allowedEpisodeRoots, registryFile, ffmpegPath) {
  const body = await readJsonBody(req);
  if (!body.episodePath) {
    sendJson(res, 400, { error: 'Missing episodePath' });
    return;
  }
  const { doc, safeRoot } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const abortController = new AbortController();
  // 预览拼接同样可能触发 ffmpeg；页面关闭或请求中断时要释放后台进程。
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });
  try {
    const result = await exportAvailableShotPreview({
      doc,
      episodePath: safeRoot,
      ffmpegPath,
      signal: abortController.signal
    });
    if (res.destroyed) return;
    sendJson(res, 200, { preview: result });
  } catch (error) {
    if (res.destroyed) return;
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { error: error.publicMessage || error.message });
      return;
    }
    throw error;
  }
}

function findShotForImport(doc, shotNo) {
  if (!shotNo) return null;
  const normalizedShotNo = String(shotNo).replace(/^shot:/, '');
  return (doc.shots || []).find((shot) => {
    const candidateShotNo = shot.shotNo || (shot.id || '').replace(/^shot:/, '');
    return shot.id === shotNo || shot.id === `shot:${normalizedShotNo}` || candidateShotNo === normalizedShotNo;
  }) || null;
}

function resolveShotReferenceContext(doc, shotNo) {
  const shot = findShotForImport(doc, shotNo);
  if (!shot) {
    return { statusCode: 404, error: `Shot not found: ${shotNo}` };
  }
  const task = findVideoTaskForShot(doc, shot);
  const prompt = task?.promptNodeId
    ? (doc.nodes || []).find((node) => node.id === task.promptNodeId)
    : null;
  const fallbackPrompt = prompt
    || findFirstNodeForShot(doc, shot.id, 'video_prompt')
    || findFirstNodeForShot(doc, shot.id, 'image_prompt')
    || findFirstNodeForShot(doc, shot.id, 'script_segment');
  if (!fallbackPrompt) {
    return { statusCode: 404, error: `Prompt node not found for shot: ${shotNo}` };
  }
  return { shot, task, prompt: fallbackPrompt };
}

function findVideoTaskForShot(doc, shot) {
  const shotNo = shot.shotNo || (shot.id || '').replace(/^shot:/, '');
  return (doc.tasks || []).find((task) => {
    if (task.type !== 'video') return false;
    if (task.shotId === shot.id) return true;
    return String(task.shotId || '').replace(/^shot:/, '') === shotNo;
  }) || null;
}

function findReferenceAsset(doc, assetNodeId) {
  return (doc.nodes || []).find((node) => node.id === assetNodeId) || null;
}

function collectPromptReferenceEdges(doc, promptNodeId) {
  return (doc.edges || [])
    .filter((edge) => edge.from === promptNodeId && SHOT_REFERENCE_EDGE_TYPES.has(edge.type))
    .filter(isActiveShotReferenceEdge);
}

function isActiveShotReferenceEdge(edge) {
  // API 返回的“当前参考资源”必须排除历史停用边，否则前端会继续展示旧素材并污染重排/替换结果。
  if (edge.active === false) return false;
  if (edge.status && edge.status !== 'active') return false;
  return !(edge.metadata?.disabledAt || edge.metadata?.inactiveAt || edge.metadata?.inactiveReason);
}

function referenceEdgeTypeForPrompt(prompt) {
  return prompt.type === 'script_segment' ? 'script_uses_asset' : 'uses_reference';
}

function defaultReferenceRole(asset) {
  if (typeof asset.metadata?.role === 'string' && asset.metadata.role.trim()) return asset.metadata.role.trim();
  return asset.type === 'audio_asset' ? 'audio_reference' : 'reference_image';
}

function normalizeReferenceRole(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function buildManualAssetFileName({ sourcePath, title, shotNo, importedAt }) {
  const parsed = parse(sourcePath);
  const stem = normalizeIdPart(title || parsed.name) || 'asset';
  const shotPrefix = shotNo ? `${normalizeIdPart(shotNo)}-` : '';
  const stamp = importedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  // 文件名不保留原始绝对路径；只保留可读标题和导入时间，降低项目文件的本机信息泄露。
  return `${shotPrefix}${stem}-${stamp}${parsed.ext.toLowerCase()}`;
}

function createManualAssetNode({ doc, kind, nodeType, title, relativePath, shotId, originalName, importedAt }) {
  const shotPart = shotId ? shotId.replace(/^shot:/, '') : 'common';
  const idBase = `node:manual:${kind}:${shotPart}:${normalizeIdPart(title) || 'asset'}`;
  return createNode({
    id: uniqueGraphId(idBase, (doc.nodes || []).map((node) => node.id)),
    type: nodeType,
    title,
    shotId,
    path: relativePath,
    status: kind === 'video' ? 'reviewing' : 'active',
    metadata: {
      source: 'manual_import',
      originalName,
      importedAt,
      ...(kind === 'video' ? { version: 'manual' } : { chip: '外部导入' })
    }
  });
}

function attachManualAssetToGraph(doc, assetNode, { kind, shot }) {
  if (!shot) return;
  if (kind === 'image') {
    const prompt = findFirstNodeForShot(doc, shot.id, 'video_prompt')
      || findFirstNodeForShot(doc, shot.id, 'image_prompt')
      || findFirstNodeForShot(doc, shot.id, 'script_segment');
    if (prompt) {
      doc.edges.push(createEdge({
        id: uniqueGraphId(`edge:manual:image:${prompt.id}:${assetNode.id}`, (doc.edges || []).map((edge) => edge.id)),
        from: prompt.id,
        to: assetNode.id,
        type: prompt.type === 'script_segment' ? 'script_uses_asset' : 'uses_reference',
        role: '外部导入',
        note: '用户在模型未配置或外部平台生成后手动导入'
      }));
    }
    return;
  }

  const task = (doc.tasks || []).find((item) => item.type === 'video' && item.shotId === shot.id) || null;
  const promptId = task?.promptNodeId || findFirstNodeForShot(doc, shot.id, 'video_prompt')?.id || null;
  if (task && !task.outputNodeIds.includes(assetNode.id)) {
    task.outputNodeIds.push(assetNode.id);
    task.status = task.status === 'blocked' ? 'reviewing' : task.status;
  }
  if (promptId) {
    doc.edges.push(createEdge({
      id: uniqueGraphId(`edge:manual:video:${promptId}:${assetNode.id}`, (doc.edges || []).map((edge) => edge.id)),
      from: promptId,
      to: assetNode.id,
      type: 'generates',
      role: '外部导入',
      note: '用户在模型未配置或外部平台生成后手动导入'
    }));
  }
  attachManualVideoQcPlaceholder(doc, assetNode);
}

function attachManualVideoQcPlaceholder(doc, assetNode) {
  const hasQc = (doc.edges || []).some((edge) => edge.type === 'qc_for' && edge.to === assetNode.id);
  if (hasQc) return;

  const qcNode = createNode({
    id: uniqueGraphId(`node:qc:${normalizeIdPart(assetNode.id)}`, (doc.nodes || []).map((node) => node.id)),
    type: 'qc_record',
    title: `${assetNode.title || '手动导入视频'} QC`,
    shotId: assetNode.shotId,
    status: 'reviewing',
    metadata: {
      qcNote: '',
      source: 'manual_import'
    }
  });
  doc.nodes.push(qcNode);
  doc.edges.push(createEdge({
    id: uniqueGraphId(`edge:qcfor:${normalizeIdPart(assetNode.id)}`, (doc.edges || []).map((edge) => edge.id)),
    from: qcNode.id,
    to: assetNode.id,
    type: 'qc_for',
    role: 'qc_result',
    note: '手动回填视频默认进入待质检状态'
  }));
}

function findFirstNodeForShot(doc, shotId, type) {
  return (doc.nodes || []).find((node) => node.type === type && node.shotId === shotId) || null;
}

function appendManualImportActivity(doc, assetNode, { kind, originalName, importedAt }) {
  if (!Array.isArray(doc.activityLog)) doc.activityLog = [];
  doc.activityLog.push({
    id: uniqueGraphId(`activity:manual-import:${assetNode.id}`, doc.activityLog.map((item) => item.id)),
    type: 'manual_asset_imported',
    at: importedAt,
    message: `${kind === 'video' ? '视频' : '图片'}资源已手动导入：${originalName}`,
    nodeId: assetNode.id
  });
}

function appendShotReferenceActivity(doc, type, { shot, asset, message }) {
  if (!Array.isArray(doc.activityLog)) doc.activityLog = [];
  const at = new Date().toISOString();
  const stamp = at.replace(/[-:.TZ]/g, '');
  doc.activityLog.push({
    id: uniqueGraphId(
      `activity:${type}:${shot?.id || 'shot'}:${asset?.id || 'references'}:${stamp}`,
      doc.activityLog.map((item) => item.id)
    ),
    type,
    at,
    message,
    shotId: shot?.id || null,
    nodeId: asset?.id || null
  });
}

async function validateAndWriteEpisodeDoc(doc, docPath, res) {
  const validationErrors = validateDramaCreatorDocument(doc);
  if (validationErrors.length) {
    sendJson(res, 400, { error: 'Invalid episode document', details: validationErrors.slice(0, 5) });
    return false;
  }
  await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return true;
}

function uniqueGraphId(baseId, existingIds) {
  const seen = new Set(existingIds);
  if (!seen.has(baseId)) return baseId;
  let suffix = 2;
  while (seen.has(`${baseId}:${suffix}`)) suffix += 1;
  return `${baseId}:${suffix}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function handleGetAsset(req, url, res, allowedEpisodeRoots, registryFile, resourceCacheDir) {
  // Episode-scoped media proxy. Real episodes mix two path conventions:
  //   - Episode-relative ("raw-videos/foo.mp4")
  //   - Project-relative ("scripts/assets/.../foo.png")
  // We resolve by climbing the directory chain from the episode upward to the allowed
  // root, picking the first existing file. The final realpath must still live inside an
  // allowlisted root so the proxy never serves arbitrary filesystem content.
  const episodePath = url.searchParams.get('episode');
  const relativePath = url.searchParams.get('path');
  if (!episodePath || !relativePath) {
    sendJson(res, 400, { error: 'Missing episode or path' });
    return;
  }
  if (relativePath.startsWith('/')) {
    throw new HttpError(403, 'Forbidden asset path');
  }

  const safeAllowedRoots = await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile);
  const safeEpisodePath = await resolveEpisodePath(episodePath, safeAllowedRoots);
  const safeAssetPath = relativePath.startsWith('app-cache/')
    ? await locateAppCacheAsset(resourceCacheDir, relativePath)
    : await locateAssetCandidate(enclosingBaseCandidates(safeEpisodePath, safeAllowedRoots), relativePath);
  if (!safeAssetPath) throw new HttpError(404, 'Asset not found');
  if (!relativePath.startsWith('app-cache/') && !safeAllowedRoots.some((allowedRoot) => isPathInside(safeAssetPath, allowedRoot))) {
    throw new HttpError(403, 'Forbidden asset path');
  }

  const ext = extname(safeAssetPath).toLowerCase();
  if (!allowedAssetExtensions.has(ext)) {
    throw new HttpError(415, 'Unsupported asset type');
  }

  let assetStat;
  try {
    assetStat = await stat(safeAssetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(404, 'Asset not found');
    throw error;
  }
  if (!assetStat.isFile()) throw new HttpError(404, 'Asset not found');

  const contentType = assetMimeTypes[ext];
  const totalSize = assetStat.size;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=60');

  if (req.method === 'HEAD') {
    res.statusCode = 200;
    res.setHeader('Content-Length', totalSize);
    res.end();
    return;
  }

  const range = req.headers?.range;
  if (range && range.startsWith('bytes=')) {
    const [startRaw, endRaw] = range.replace('bytes=', '').split('-');
    const start = Number.parseInt(startRaw, 10);
    const end = endRaw ? Number.parseInt(endRaw, 10) : totalSize - 1;
    if (Number.isNaN(start) || start >= totalSize || end >= totalSize || start > end) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', end - start + 1);
    createReadStream(safeAssetPath, { start, end }).pipe(res);
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Length', totalSize);
  createReadStream(safeAssetPath).pipe(res);
}

async function handleStatic(root, url, res) {
  // Preserve the existing static-server behavior while allowing API routes to share the same HTTP app.
  const cleanPath = normalize(decodeURIComponent(url.pathname));
  const filePath = resolve(root, cleanPath === '/' ? 'index.html' : `.${cleanPath}`);
  if (!isPathInside(filePath, root)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return;
  }

  try {
    const data = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', mimeTypes[extname(filePath)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  }
}

// Resolve an episode path against the allowlist and load its drama-creator.json document.
// Centralizes the realpath + isPathInside guard shared by the generate/refresh routes.
async function loadEpisodeDoc(episodePath, authorizedRoots) {
  const safeRoot = await realpath(episodePath);
  if (!authorizedRoots.some((r) => isPathInside(safeRoot, r))) {
    throw new HttpError(403, 'Forbidden episode path');
  }
  const docPath = join(safeRoot, 'drama-creator.json');
  const doc = JSON.parse(await readFile(docPath, 'utf8'));
  return { doc, safeRoot, docPath };
}

function inferProjectRootFromEpisodePath(episodePath) {
  const normalized = episodePath.replace(/\\/g, '/');
  for (const marker of ['/scripts/episodes/', '/episodes/']) {
    const index = normalized.indexOf(marker);
    if (index >= 0) return episodePath.slice(0, index);
  }
  // 临时测试项目或用户手动注册的极简布局可能只有 <project>/ep001。
  // 这里只读取父目录的 project.json；不存在时 readJimengProjectOptions 会安全降级为空配置。
  return dirname(episodePath);
}

async function readJimengProjectOptions(projectRoot) {
  if (!projectRoot) return { jimengSpaceName: '' };
  try {
    const manifest = JSON.parse(await readFile(join(projectRoot, 'project.json'), 'utf8'));
    return {
      // 即梦空间是作品级外部页面目标；只传用户保存的空间名，避免把本地项目路径带进页面自动化。
      jimengSpaceName: normalizeJimengSpaceName(manifest?.jimengSpaceName)
    };
  } catch {
    return { jimengSpaceName: '' };
  }
}

function normalizeJimengSpaceName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 80);
}

async function loadCredentialWriteTarget(body, allowedEpisodeRoots, registryFile, credentialsFile) {
  if (body.episodePath) {
    const { doc, docPath } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
    return {
      credentials: sanitizeCredentialRefs(doc.credentials),
      async write(nextCredentials) {
        doc.credentials = sanitizeCredentialRefs(nextCredentials);
        await writeFile(docPath, JSON.stringify(doc, null, 2));
      }
    };
  }

  const store = await readCredentialStore(credentialsFile);
  return {
    credentials: store.credentials,
    async write(nextCredentials) {
      await writeCredentialStore(credentialsFile, { credentials: nextCredentials });
    }
  };
}

// POST /api/generate — thin wrapper over the executor's runGenerate (sync builtin adapters only in Phase 1).
async function handleGenerate(req, res, allowedEpisodeRoots, registryFile, credentialsFile, keychain, { fetchImpl } = {}) {
  const body = await readJsonBody(req);
  if (!body.episodePath || !body.taskId || !body.adapterId) {
    sendJson(res, 400, { error: 'Missing episodePath/taskId/adapterId' });
    return;
  }
  const { doc, safeRoot, docPath } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const credentialStore = await readCredentialStore(credentialsFile);
  const credentialStoreBefore = JSON.stringify(credentialStore.credentials);
  const adapterRef = await resolveAdapterFromRegistry(body.adapterId);
  if (!adapterRef) {
    sendJson(res, 404, { error: `Unknown adapter: ${body.adapterId}` });
    return;
  }
  if (adapterRef.manifest?.productionMode === 'external') {
    const execution = adapterRef.manifest.execution || {};
    const automation = adapterRef.manifest.automation || {};
    // 外部跳转型通道（如即梦）不是普通 generate API。这里返回稳定 handoff 元数据，
    // 让前端生成投喂包或引导人工回填，避免把一次“未安装自动化”写成失败 job。
    sendJson(res, 409, {
      error: 'external_handoff_required',
      adapterId: body.adapterId,
      productionMode: 'external',
      executionType: execution.type || automation.type || 'external',
      handoffEndpoint: execution.handoffEndpoint || automation.handoffEndpoint || null,
      targetUrl: execution.targetUrl || automation.targetUrl || null,
      manualBackfill: execution.manualBackfill !== false,
      message: '该通道需要跳转外部平台生成素材。请先生成投喂包，完成后通过导入外部资源回填到当前项目。'
    });
    return;
  }
  // Resolve credential per the priority chain:
  // env bypass → episode credential override → app-level credential → null.
  // For adapters declaring `credential.required=true`, a null result means the user has not
  // configured this adapter yet; we surface a clear 400 so the UI can route them to /settings.
  // OAuth 适配器在 token 临近过期时会触发自动刷新；若刷新失败，resolveCredential 会抛
  // OAuthExpiredError（code='oauth_expired'），这里翻译为 401 让前端 settings 页弹出
  // 重新登录 banner，避免被通用 try/catch 兜底成 500。
  const credentialDoc = {
    ...doc,
    credentials: mergeCredentialRefs(credentialStore.credentials, doc.credentials || [])
  };
  let credential;
  try {
    credential = await resolveCredential(credentialDoc, body.adapterId, adapterRef.manifest, process.env, keychain);
  } catch (error) {
    if (error?.code === 'oauth_expired') {
      sendJson(res, 401, {
        error: 'oauth_expired',
        adapterId: error.adapterId,
        message: '订阅登录已过期，请到设置页重新登录'
      });
      return;
    }
    throw error;
  }
  if (adapterRef.manifest?.credential?.required && credential === null) {
    sendJson(res, 400, { error: `Adapter ${body.adapterId} requires credentials. Configure in /settings.` });
    return;
  }
  // Generated artifacts always land under the episode's raw-videos/ directory.
  const outputDir = join(safeRoot, 'raw-videos');
  let job;
  try {
    const result = await runGenerate({
      doc,
      taskId: body.taskId,
      adapterRef,
      capability: body.capability,
      model: body.model,
      outputDir,
      userParams: body.params || {},
      credential,
      adapterOptions: { fetch: fetchImpl }
    });
    job = result.job;
  } catch (error) {
    // 把 buildGenerateInput / runGenerate 抛出的领域错误（task not found / capability not found / model not found ...）
    // 转成 4xx 并暴露 message，避免被顶层 catch 兜底成不可读的 500。
    sendJson(res, 400, { error: error?.message || 'Generate failed' });
    return;
  }
  // Persist the mutated graph + jobs back to disk so the caller observes the updated state.
  await writeFile(docPath, JSON.stringify(doc, null, 2));
  if (JSON.stringify(credentialStore.credentials) !== credentialStoreBefore) {
    await writeCredentialStore(credentialsFile, credentialStore);
  }
  sendJson(res, 200, { job });
}

// POST /api/jobs/refresh — poll async adapter jobs and backfill completed outputs.
// 异步视频平台（MiniMax / 火山方舟）需要凭据才能查询任务；这里复用 generate 的全局凭据解析链。
async function handleJobsRefresh(req, res, allowedEpisodeRoots, registryFile, credentialsFile, keychain, { fetchImpl } = {}) {
  const body = await readJsonBody(req);
  if (!body.episodePath) {
    sendJson(res, 400, { error: 'Missing episodePath' });
    return;
  }
  const { doc, safeRoot, docPath } = await loadEpisodeDoc(body.episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
  const outputDir = join(safeRoot, 'raw-videos');
  const credentialStore = await readCredentialStore(credentialsFile);
  const credentialStoreBefore = JSON.stringify(credentialStore.credentials);
  const credentialDoc = {
    ...doc,
    credentials: mergeCredentialRefs(credentialStore.credentials, doc.credentials || [])
  };
  const summary = await refreshJobs({
    doc,
    outputDir,
    adapterOptions: { fetch: fetchImpl },
    resolveAdapter: (adapterId) => resolveAdapterFromRegistry(stripAdapterPrefix(adapterId)),
    resolveCredentialForJob: async (job, adapterRef) => {
      const manifest = adapterRef.kind === 'cli' ? adapterRef.manifest : adapterRef.module.manifest;
      const adapterId = adapterRef.manifestId || stripAdapterPrefix(job.adapterId);
      try {
        return await resolveCredential(credentialDoc, adapterId, manifest, process.env, keychain);
      } catch (error) {
        if (error?.code === 'oauth_expired') return null;
        throw error;
      }
    }
  });
  await writeFile(docPath, JSON.stringify(doc, null, 2));
  if (JSON.stringify(credentialStore.credentials) !== credentialStoreBefore) {
    await writeCredentialStore(credentialsFile, credentialStore);
  }
  sendJson(res, 200, summary);
}

function stripAdapterPrefix(adapterId) {
  return String(adapterId || '').replace(/^adapter:/, '');
}

// GET /api/adapters — return manifest metadata for every available adapter (builtin + CLI).
// The settings UI consumes this list to render adapter cards. We strip nothing essential
// from the public manifest (templates / capabilities / field labels are needed) but never
// emit secret material; field secret flags are kept so the UI can render password inputs.
async function handleListAdapters(res) {
  const adapters = await listAvailableAdapters();
  const safe = adapters.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    version: m.version,
    kind: m.kind,
    productionMode: m.productionMode || null,
    execution: m.execution || null,
    capabilities: m.capabilities,
    automation: m.automation || null,
    templates: m.templates || null,
    credential: m.credential
      ? {
          required: !!m.credential.required,
          methods: m.credential.methods || [],
          fields: (m.credential.fields || []).map((f) => ({
            key: f.key,
            label: f.label,
            secret: !!f.secret,
            required: !!f.required
          }))
        }
      : null
  }));
  sendJson(res, 200, { adapters: safe });
}

// GET /api/credentials[?episodePath=...] — list app-level credentials, optionally merged
// with an episode's legacy document-level references.
// SECURITY: this route NEVER returns secret values. Only refs, public fields, and the list
// of secret-field key NAMES (so the UI can show "configured: apiKey ✓") leave the server.
async function handleListCredentials(url, res, allowedEpisodeRoots, registryFile, credentialsFile, keychain) {
  const episodePath = url.searchParams.get('episodePath');
  const store = await readCredentialStore(credentialsFile);
  let credentials = store.credentials;
  if (episodePath) {
    const { doc } = await loadEpisodeDoc(episodePath, await resolveAuthorizedRoots(allowedEpisodeRoots, registryFile));
    credentials = mergeCredentialRefs(store.credentials, doc.credentials || []);
  }
  const safe = await Promise.all(sanitizeCredentialRefs(credentials).map(async (c) => ({
    ref: c.ref,
    adapterId: c.adapterId,
    method: c.method,
    secretFieldKeys: c.secretFieldKeys || [],
    // secretStatus 只暴露“是否能读取到密钥”，不返回密钥内容；设置页需要它识别过期的旧凭据记录。
    secretStatus: await credentialSecretStatus(c, keychain),
    publicFields: c.publicFields || {},
    updatedAt: c.updatedAt
  })));
  sendJson(res, 200, { credentials: safe });
}

// PUT /api/credentials/<adapterId> — persist a credential for an adapter.
// Body: { fields: { <fieldKey>: <value>, ... }, episodePath? }.
// Secret fields go to the OS keychain under "drama-creator:<adapterId>" while public
// fields land in ~/.drama-creator/credentials.json by default. episodePath is kept only
// as a legacy compatibility mode for old per-episode credential refs.
async function handlePutCredential(req, res, adapterId, allowedEpisodeRoots, registryFile, credentialsFile, keychain) {
  const body = await readJsonBody(req);
  if (!body.fields || typeof body.fields !== 'object') {
    sendJson(res, 400, { error: 'Missing fields' });
    return;
  }
  // Look up the adapter manifest so we can split the inbound `fields` map into the
  // secret bucket (keychain) and the public bucket (document).
  const all = await listAvailableAdapters();
  const manifest = all.find((m) => m.id === adapterId);
  if (!manifest) {
    sendJson(res, 404, { error: `Unknown adapter: ${adapterId}` });
    return;
  }
  const fields = manifest.credential?.fields || [];
  const secretKeys = fields.filter((f) => f.secret).map((f) => f.key);
  const publicKeys = fields.filter((f) => !f.secret).map((f) => f.key);
  const target = await loadCredentialWriteTarget(body, allowedEpisodeRoots, registryFile, credentialsFile);

  const secretPayload = {};
  const publicFields = {};
  for (const [k, v] of Object.entries(body.fields)) {
    if (secretKeys.includes(k)) secretPayload[k] = v;
    else if (publicKeys.includes(k)) publicFields[k] = v;
    // Keys not declared in the manifest are silently dropped to keep the document schema honest.
  }
  const account = `drama-creator:${adapterId}`;
  const existing = target.credentials.find((c) => c.adapterId === adapterId);
  const hasIncomingSecret = Object.keys(secretPayload).length > 0;
  if (hasIncomingSecret || !existing) {
    await keychain.writeSecret(account, JSON.stringify(secretPayload));
  }

  // Replace any existing record for this adapter, or append a fresh one.
  const nextCredentials = target.credentials.filter((c) => c.adapterId !== adapterId);
  nextCredentials.push(createCredentialRef({
    ref: `credential:${adapterId}`,
    adapterId,
    method: 'api_key',
    keychainAccount: account,
    secretFieldKeys: hasIncomingSecret ? Object.keys(secretPayload) : (existing?.secretFieldKeys || []),
    publicFields: { ...(existing?.publicFields || {}), ...publicFields }
  }));
  await target.write(nextCredentials);
  sendJson(res, 200, { ok: true });
}

// DELETE /api/credentials/<adapterId> — clear an adapter's credential.
// Body: { episodePath? }. Removes the keychain entry and the selected credential ref scope.
async function handleDeleteCredential(req, res, adapterId, allowedEpisodeRoots, registryFile, credentialsFile, keychain) {
  const body = await readJsonBody(req);
  const target = await loadCredentialWriteTarget(body, allowedEpisodeRoots, registryFile, credentialsFile);
  await keychain.deleteSecret(`drama-creator:${adapterId}`);
  await target.write(target.credentials.filter((c) => c.adapterId !== adapterId));
  sendJson(res, 200, { ok: true });
}

// POST /api/credentials/oauth/start — Phase 3 Task 5：把 Codex OAuth 端到端串起来。
// Body: { adapterId, episodePath? }
//
// 设计要点：
// - adapterId 严格白名单（目前仅 'openai-codex-oauth'）。其余 404，避免前端把任意字符串
//   塞进流程导致写入错位的 keychain account。
// - 路由立即返 200 含 authorizeUrl + state；前端交给桌面壳或浏览器打开授权页。
//   1455 callback 监听以 IIFE 形式 fire-and-forget 启动；状态变更通过 setOAuthStatus 写入
//   闭包内的 oauthFlowStatus，前端通过 GET /api/credentials/oauth/status polling 拿结果。
// - 失败分支：EADDRINUSE → 'port_in_use'；TIMEOUT → 'timeout'；exchangeCode 失败 → 'failed'。
// - 成功分支：exchangeCode → 写 keychain（accessToken/refreshToken JSON）→ 写应用级
//   credentials.json；episodePath 仅作为旧剧集文件兼容写入目标。
async function handleOAuthStart(req, res, allowedEpisodeRoots, registryFile, credentialsFile, keychain, deps) {
  const { startCallbackServer, fetchImpl, setOAuthStatus, beginOAuthFlow, isCurrentOAuthFlow, clearOAuthFlow } = deps;
  const body = await readJsonBody(req);
  if (!body.adapterId || !OAUTH_SUPPORTED_ADAPTERS.has(body.adapterId)) {
    // 严格白名单：未知或非 OAuth 适配器一律 404，与现有 PUT/DELETE 的语义一致。
    sendJson(res, 404, { error: `Unknown OAuth adapter: ${body.adapterId || ''}` });
    return;
  }
  // 先校验写入目标是否可用；OAuth 回调真正完成时会重新读取，避免覆盖并发更新。
  await loadCredentialWriteTarget(body, allowedEpisodeRoots, registryFile, credentialsFile);
  const adapterId = body.adapterId;

  // PKCE + state 由 server 生成；前端不允许构造任意 authorizeUrl，仅负责打开服务端返回的 URL。
  const { verifier, challenge } = generatePkce();
  // challenge 已经被 buildAuthorizeUrl 内部重新计算一次，这里取值仅用于注释清晰；不直接使用
  void challenge;
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl({ verifier, state });
  // 同一个桌面服务进程只能监听一个 1455 callback。新的登录动作会取消旧的等待流程，
  // 避免用户重复点击“重新登录”后看到不可操作的端口占用错误。
  const { controller, flowId } = beginOAuthFlow();

  // 立即把状态切到 awaiting_callback，让前端 polling 第一次就能看到「正在等待回调」。
  setOAuthStatus({ state: 'awaiting_callback', error: null });

  // fire-and-forget：不 await，不让 HTTP 路由等到用户授权完成。
  // 任何失败都被 catch 住转写到 oauthFlowStatus，避免 unhandled rejection。
  (async () => {
    try {
      const { code } = await startCallbackServer({ expectedState: state, signal: controller.signal });
      if (!isCurrentOAuthFlow(flowId)) return;
      const tokens = await exchangeCode({ code, verifier, fetch: fetchImpl });
      if (!isCurrentOAuthFlow(flowId)) return;
      // 把 token 落进 keychain；与 PUT /api/credentials/<id> 一致的 account 命名。
      const account = `drama-creator:${adapterId}`;
      const secretPayload = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken
      };
      await keychain.writeSecret(account, JSON.stringify(secretPayload));
      // OAuth 回调发生在异步任务里；写入时重新读取目标，避免覆盖用户刚更新的凭据列表。
      const latestTarget = await loadCredentialWriteTarget(body, allowedEpisodeRoots, registryFile, credentialsFile);
      const nextCredentials = latestTarget.credentials.filter((c) => c.adapterId !== adapterId);
      nextCredentials.push(createCredentialRef({
        ref: `credential:${adapterId}`,
        adapterId,
        method: 'oauth',
        keychainAccount: account,
        secretFieldKeys: ['accessToken', 'refreshToken'],
        publicFields: {
          // expiresAt 是数字 ms 时间戳；accountId 可能为 null（JWT 解析失败兜底）。
          expiresAt: tokens.expiresAt,
          ...(tokens.accountId ? { accountId: tokens.accountId } : {})
        },
        updatedAt: new Date().toISOString()
      }));
      await latestTarget.write(nextCredentials);
      setOAuthStatus({ state: 'completed', error: null });
    } catch (error) {
      if (error?.code === 'ABORT_ERR' || !isCurrentOAuthFlow(flowId)) {
        return;
      }
      // 把 callback / token 阶段的错误归类成 UI 易消费的状态。
      // err.code 来自 oauthCallback.mjs 里 makeError 的约定；其他错误（exchange / keychain / fs）落入 'failed'。
      let nextState = 'failed';
      if (error?.code === 'EADDRINUSE') nextState = 'port_in_use';
      else if (error?.code === 'TIMEOUT') nextState = 'timeout';
      setOAuthStatus({ state: nextState, error: error?.message || String(error) });
    } finally {
      clearOAuthFlow(flowId);
    }
  })();

  // 路由立刻返回；前端拿 authorizeUrl 跳浏览器后开始 polling /status。
  sendJson(res, 200, { authorizeUrl, state });
}

// POST /api/model-connections/test — 验证某个已配置的模型通道是否可用。
// 当前实现优先覆盖 OpenAI-compatible API Key 通道：用 keychain 中的 apiKey 请求
// `<endpoint>/models`，并把非敏感的验证状态与模型 id 列表回写到 credentials.json。
async function handleTestModelConnection(req, res, credentialsFile, keychain, { fetchImpl } = {}) {
  const body = await readJsonBody(req);
  if (!body.adapterId || typeof body.adapterId !== 'string') {
    sendJson(res, 400, { error: 'Missing adapterId' });
    return;
  }
  const adapterId = body.adapterId.trim();
  const adapters = await listAvailableAdapters();
  const manifest = adapters.find((item) => item.id === adapterId);
  if (!manifest) {
    sendJson(res, 404, { error: `Unknown adapter: ${adapterId}` });
    return;
  }

  const store = await readCredentialStore(credentialsFile);
  const credential = store.credentials.find((item) => item.adapterId === adapterId);
  if (!credential) {
    sendJson(res, 400, { error: 'Configure API Key before testing this model channel' });
    return;
  }
  if (credential.method !== 'api_key') {
    sendJson(res, 400, { error: 'Only API Key model channels support connection testing now' });
    return;
  }

  let secrets = {};
  const rawSecret = await keychain.readSecret(credential.keychainAccount);
  if (rawSecret) {
    try {
      secrets = JSON.parse(rawSecret);
    } catch {
      secrets = {};
    }
  }
  const merged = { ...secrets, ...(credential.publicFields || {}) };
  if (!merged.apiKey || !merged.endpoint) {
    sendJson(res, 400, { error: 'Configure API Key and service address before testing this model channel' });
    return;
  }

  // Claude 对用户仍是“文本模型 API Key”的服务商之一；实现侧根据 endpoint 走 Messages 协议。
  const result = isAnthropicEndpoint(merged.endpoint)
    ? await testAnthropicConnection({ endpoint: merged.endpoint, apiKey: merged.apiKey, fetchImpl })
    : await testOpenAICompatibleConnection({ endpoint: merged.endpoint, apiKey: merged.apiKey, fetchImpl });
  const nextCredentials = store.credentials.map((item) => {
    if (item.adapterId !== adapterId) return item;
    return {
      ...item,
      publicFields: {
        ...(item.publicFields || {}),
        verification: {
          status: result.status,
          checkedAt: result.checkedAt,
          message: result.message,
          ...(result.modelIds?.length ? { modelIds: result.modelIds } : {})
        }
      },
      updatedAt: new Date().toISOString()
    };
  });
  await writeCredentialStore(credentialsFile, { credentials: nextCredentials });
  sendJson(res, 200, result);
}

async function testOpenAICompatibleConnection({ endpoint, apiKey, fetchImpl }) {
  const checkedAt = new Date().toISOString();
  const cleanEndpoint = String(endpoint).replace(/\/+$/, '');
  try {
    const response = await (fetchImpl || globalThis.fetch)(`${cleanEndpoint}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        status: 'failed',
        checkedAt,
        message: detail ? `HTTP ${response.status}: ${detail.slice(0, 200)}` : `HTTP ${response.status}`
      };
    }
    const json = await response.json().catch(() => ({}));
    const modelIds = extractModelIds(json).slice(0, 200);
    return {
      status: 'verified',
      checkedAt,
      message: modelIds.length ? `已读取 ${modelIds.length} 个模型` : '连接成功，但服务未返回模型列表',
      modelIds
    };
  } catch (error) {
    return {
      status: 'failed',
      checkedAt,
      message: `network error: ${error?.message || error}`
    };
  }
}

async function testAnthropicConnection({ endpoint, apiKey, fetchImpl }) {
  const checkedAt = new Date().toISOString();
  const cleanEndpoint = String(endpoint).replace(/\/+$/, '');
  try {
    const response = await (fetchImpl || globalThis.fetch)(`${cleanEndpoint}/models`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        status: 'failed',
        checkedAt,
        message: detail ? `HTTP ${response.status}: ${detail.slice(0, 200)}` : `HTTP ${response.status}`
      };
    }
    const json = await response.json().catch(() => ({}));
    const modelIds = extractModelIds(json).slice(0, 200);
    return {
      status: 'verified',
      checkedAt,
      message: modelIds.length ? `已读取 ${modelIds.length} 个模型` : '连接成功，但服务未返回模型列表',
      modelIds
    };
  } catch (error) {
    return {
      status: 'failed',
      checkedAt,
      message: `network error: ${error?.message || error}`
    };
  }
}

function isAnthropicEndpoint(endpoint) {
  return /api\.anthropic\.com/i.test(String(endpoint || ''));
}

function extractModelIds(payload) {
  const data = Array.isArray(payload?.data)
    ? payload.data
    : (Array.isArray(payload?.models) ? payload.models : []);
  return data
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item.id === 'string') return item.id;
      if (item && typeof item.name === 'string') return item.name;
      return null;
    })
    .filter(Boolean);
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function sendError(res, error) {
  if (error instanceof HttpError) {
    sendJson(res, error.statusCode, { error: error.publicMessage });
    return;
  }

  sendJson(res, 500, { error: 'Internal server error' });
}

async function readJsonBody(req) {
  // Collect small local API payloads without adding a framework dependency.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    // Bad client JSON is a request error, not an internal failure; keep parser details private.
    throw new HttpError(400, 'Invalid JSON body');
  }
}

async function resolveAuthorizedRoots(allowedEpisodeRoots, registryFile) {
  const roots = [...allowedEpisodeRoots];
  const registered = await readProjectRegistryEntries({ ...(registryFile ? { registryFile } : {}) });
  for (const entry of registered) roots.push(entry.path);

  const safeRoots = [];
  const seen = new Set();
  for (const root of roots) {
    try {
      const safeRoot = await realpath(root);
      if (!seen.has(safeRoot)) {
        seen.add(safeRoot);
        safeRoots.push(safeRoot);
      }
    } catch {
      // Removed registered projects should not brick the desktop app; they simply stop authorizing reads.
    }
  }
  return safeRoots;
}

async function resolveEpisodePath(episodePath, authorizedRoots) {
  // Resolve symlinks before applying the allowlist so links inside an allowed root cannot escape it.
  const safeEpisodePath = await realpathEpisodeDirectory(episodePath);
  if (!authorizedRoots.some((allowedRoot) => isPathInside(safeEpisodePath, allowedRoot))) {
    throw new HttpError(403, 'Forbidden episode path');
  }
  return safeEpisodePath;
}

async function realpathEpisodeDirectory(episodePath) {
  try {
    return await realpath(resolve(episodePath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new HttpError(404, 'Episode directory not found');
    }
    throw error;
  }
}

async function readEpisodeState(episodePath) {
  try {
    return await readFile(join(episodePath, 'drama-creator.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new HttpError(404, 'Episode state not found');
    }
    throw error;
  }
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function isPathInside(targetPath, allowedRoot) {
  const distance = relative(allowedRoot, targetPath);
  return distance === '' || (!distance.startsWith('..') && !isAbsolute(distance));
}

function enclosingBaseCandidates(episodePath, allowedRoots) {
  // Walk from the episode directory up to (and including) every allowed root.
  // Trying each level lets episode-relative paths resolve at the bottom while
  // project-relative paths resolve nearer the top, without giving the caller
  // a way to escape the allowlist (the realpath check still applies).
  const bases = [];
  const seen = new Set();
  for (const start of [episodePath, ...allowedRoots]) {
    let current = start;
    while (true) {
      if (!seen.has(current)) {
        seen.add(current);
        bases.push(current);
      }
      if (allowedRoots.some((root) => current === root)) break;
      const parent = resolve(current, '..');
      if (parent === current) break;
      current = parent;
    }
  }
  return bases;
}

async function locateAssetCandidate(bases, relativePath) {
  for (const base of bases) {
    const candidate = resolve(base, relativePath);
    try {
      const resolved = await realpath(candidate);
      const candidateStat = await stat(resolved);
      if (candidateStat.isFile()) return resolved;
    } catch {
      // Fall through to the next base; ENOENT etc. are expected misses.
    }
  }
  return null;
}

async function locateAppCacheAsset(resourceCacheDir, relativePath) {
  const cacheRelativePath = relativePath.slice('app-cache/'.length);
  const safeCacheRoot = await realpath(resourceCacheDir);
  const candidate = resolve(safeCacheRoot, cacheRelativePath);
  // 先做词法层面的越界判断，再访问磁盘；这样不存在的 ../../ 目标也不会被伪装成 404。
  if (!isPathInside(candidate, safeCacheRoot)) {
    throw new HttpError(403, 'Forbidden asset path');
  }
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!isPathInside(resolved, safeCacheRoot)) {
    throw new HttpError(403, 'Forbidden asset path');
  }
  const candidateStat = await stat(resolved);
  return candidateStat.isFile() ? resolved : null;
}

class HttpError extends Error {
  constructor(statusCode, publicMessage) {
    super(publicMessage);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}
