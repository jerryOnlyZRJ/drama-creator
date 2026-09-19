import { applyStoryboardSplit, replaceStoryboardShots } from './src/workflow/scriptShots.mjs';
import { normalizeShotScriptTexts, readShotScriptText } from './src/workflow/shotScripts.mjs';
import { formatReadableStoryboardScriptText, formatStoryboardShotHeading } from './src/workflow/storyboardDisplay.mjs';
import { extractFirstSubtitleLine } from './src/export/subtitles.mjs';

/*
 * L2 项目详情页脚本：
 * - V1 主轴是 4-step workflow，而不是文件目录或旧 tab；
 * - 剧本与分镜 step 支持粘贴文本、读取本地文本文件并写回当前 episode document；
 * - 分镜视频与公共资源库复用原有安全渲染路径，所有可控文本只走 textContent。
 */

const params = new URLSearchParams(window.location.search);
const projectPath = params.get('path');

// workflow rail 使用面向创作阶段的短文案；第二步进入的模块仍是项目级公共资产库。
const workflowSteps = [
  { key: 'script_shots', label: '剧本与分镜' },
  { key: 'asset_library', label: '公共资产' },
  { key: 'shot_videos', label: '分镜视频' },
  { key: 'export', label: '成片导出' }
];
const workflowStepKeys = new Set(workflowSteps.map((step) => step.key));
const QC_LABEL = { reviewing: '待质检', approved: '已通过', rerun_needed: '需重跑' };
const TEXT_MODEL_SETTINGS_URL = 'settings.html#model-text';
// Step 3 对创作者只呈现一层“处理中”状态；内部仍保留更细的自动化/下载/回填节点，避免 UI 暴露多段技术中间态。
const SHOT_PROCESSING_TASK_STATUSES = new Set(['generating', 'submitted', 'waiting_download', 'waiting_backfill']);
const libraryCategoryLabels = [
  ['all', '全部'],
  ['characters', '角色'],
  ['locations', '场景'],
  ['props', '道具'],
  ['style-refs', '风格参考'],
  ['voices', '音频参考'],
  ['videos', '视频参考']
];
function initialStepFromUrl() {
  return normalizeStep(new URLSearchParams(window.location.search).get('step') || 'script_shots');
}

function updateStepInUrl(stepKey) {
  const url = new URL(window.location.href);
  const normalizedStep = normalizeStep(stepKey);
  if (normalizedStep === 'script_shots') {
    url.searchParams.delete('step');
  } else {
    url.searchParams.set('step', normalizedStep);
  }
  window.history.replaceState({}, '', url);
}

const dom = {
  projectTitle: document.getElementById('projectTitle'),
  projectMeta: document.getElementById('projectMeta'),
  projectCrumb: document.getElementById('projectCrumb'),
  workflowSteps: document.getElementById('workflowSteps'),
  stepScriptShots: document.getElementById('stepScriptShots'),
  stepAssetLibrary: document.getElementById('stepAssetLibrary'),
  stepShotVideos: document.getElementById('stepShotVideos'),
  stepExport: document.getElementById('stepExport'),
  tabShots: document.getElementById('tabShots'),
  tabLibrary: document.getElementById('tabLibrary'),
  scriptPanel: document.getElementById('scriptPanel'),
  libraryPanel: document.getElementById('libraryPanel'),
  shotsPanel: document.getElementById('shotsPanel'),
  exportPanel: document.getElementById('exportPanel'),
  episodeStrip: document.getElementById('episodeStrip'),
  episodeSelect: document.getElementById('episodeSelect'),
  episodeSummary: document.getElementById('episodeSummary'),
  episodeBar: document.getElementById('episodeBar'),
  deleteEpisodeButton: document.getElementById('deleteEpisodeButton'),
  newEpisodeButton: document.getElementById('newEpisodeButton'),
  metadataProjectName: document.getElementById('metadataProjectName'),
  metadataEpisodeName: document.getElementById('metadataEpisodeName'),
  metadataEpisodeId: document.getElementById('metadataEpisodeId'),
  metadataWorkflowStep: document.getElementById('metadataWorkflowStep'),
  metadataScriptStatus: document.getElementById('metadataScriptStatus'),
  metadataShotCount: document.getElementById('metadataShotCount'),
  metadataCoreIdea: document.getElementById('metadataCoreIdea'),
  metadataGlobalBrief: document.getElementById('metadataGlobalBrief'),
  metadataJimengSpaceName: document.getElementById('metadataJimengSpaceName'),
  metadataCoreIdeaState: document.getElementById('metadataCoreIdeaState'),
  saveCoreIdeaButton: document.getElementById('saveCoreIdeaButton'),
  storySourceEditor: document.getElementById('storySourceEditor'),
  storySourceFile: document.getElementById('storySourceFile'),
  saveStorySourceButton: document.getElementById('saveStorySourceButton'),
  storySourceMeta: document.getElementById('storySourceMeta'),
  generateScriptDraftButton: document.getElementById('generateScriptDraftButton'),
  scriptDraftEditor: document.getElementById('scriptDraftEditor'),
  saveScriptDraftButton: document.getElementById('saveScriptDraftButton'),
  scriptDraftState: document.getElementById('scriptDraftState'),
  splitStoryboardButton: document.getElementById('splitStoryboardButton'),
  storyboardState: document.getElementById('storyboardState'),
  storyboardList: document.getElementById('storyboardList'),
  addStoryboardShotButton: document.getElementById('addStoryboardShotButton'),
  saveStoryboardButton: document.getElementById('saveStoryboardButton'),
  storyboardDeleteDialog: document.getElementById('storyboardDeleteDialog'),
  storyboardDeleteBody: document.getElementById('storyboardDeleteBody'),
  cancelStoryboardDeleteButton: document.getElementById('cancelStoryboardDeleteButton'),
  confirmStoryboardDeleteButton: document.getElementById('confirmStoryboardDeleteButton'),
  generatePublicAssetsButton: document.getElementById('generatePublicAssetsButton'),
  libraryGenerationState: document.getElementById('libraryGenerationState'),
  librarySearch: document.getElementById('librarySearch'),
  libraryTabs: document.getElementById('libraryTabs'),
  libraryState: document.getElementById('libraryState'),
  libraryBody: document.getElementById('libraryBody'),
  libraryInspector: document.getElementById('libraryInspector'),
  libraryInspectorPreview: document.getElementById('libraryInspectorPreview'),
  libraryInspectorTitle: document.getElementById('libraryInspectorTitle'),
  libraryInspectorMeta: document.getElementById('libraryInspectorMeta'),
  assetNameInput: document.getElementById('assetNameInput'),
  assetCategorySelect: document.getElementById('assetCategorySelect'),
  assetStatusSelect: document.getElementById('assetStatusSelect'),
  assetRequiredCheckbox: document.getElementById('assetRequiredCheckbox'),
  assetDescriptionInput: document.getElementById('assetDescriptionInput'),
  assetPromptInput: document.getElementById('assetPromptInput'),
  assetReferenceAssetsInput: document.getElementById('assetReferenceAssetsInput'),
  assetTagsInput: document.getElementById('assetTagsInput'),
  assetLinkedShotsInput: document.getElementById('assetLinkedShotsInput'),
  assetUsageInput: document.getElementById('assetUsageInput'),
  assetSourceInput: document.getElementById('assetSourceInput'),
  saveAssetDetailButton: document.getElementById('saveAssetDetailButton'),
  generateAssetAudioButton: document.getElementById('generateAssetAudioButton'),
  deleteAssetButton: document.getElementById('deleteAssetButton'),
  assetDetailState: document.getElementById('assetDetailState'),
  shotsSearch: document.getElementById('shotsSearch'),
  shotsStatusFilter: document.getElementById('shotsStatusFilter'),
  shotsCount: document.getElementById('shotsCount'),
  shotsState: document.getElementById('shotsState'),
  shotsGrid: document.getElementById('shotsGrid'),
  exportStatusBadge: document.getElementById('exportStatusBadge'),
  exportReadiness: document.getElementById('exportReadiness'),
  exportShotList: document.getElementById('exportShotList'),
  exportStatsLegend: document.getElementById('exportStatsLegend'),
  exportPreviewMedia: document.getElementById('exportPreviewMedia'),
  exportPreviewStartButton: document.getElementById('exportPreviewStartButton'),
  exportPreviewStatus: document.getElementById('exportPreviewStatus'),
  exportSubtitleSource: document.getElementById('exportSubtitleSource'),
  exportSubtitleFont: document.getElementById('exportSubtitleFont'),
  exportSubtitleSize: document.getElementById('exportSubtitleSize'),
  exportSubtitlePosition: document.getElementById('exportSubtitlePosition'),
  exportResolutionSelect: document.getElementById('exportResolutionSelect'),
  exportFrameRateSelect: document.getElementById('exportFrameRateSelect'),
  exportFileNamePreview: document.getElementById('exportFileNamePreview'),
  exportOriginalCheck: document.getElementById('exportOriginalCheck'),
  exportSubtitleCheck: document.getElementById('exportSubtitleCheck'),
  exportSrtCheck: document.getElementById('exportSrtCheck'),
  exportStartButton: document.getElementById('exportStartButton'),
  exportCancelButton: document.getElementById('exportCancelButton'),
  exportProgress: document.getElementById('exportProgress'),
  exportProgressBar: document.getElementById('exportProgressBar'),
  exportProgressText: document.getElementById('exportProgressText'),
  exportResultSummary: document.getElementById('exportResultSummary'),
  exportResultList: document.getElementById('exportResultList'),
  footerLeft: document.getElementById('footerLeft'),
  footerRight: document.getElementById('footerRight')
};

const stepButtons = [
  dom.stepScriptShots,
  dom.stepAssetLibrary,
  dom.stepShotVideos,
  dom.stepExport
];

const state = {
  project: null,
  episodes: [],
  activeEpisodeId: null,
  activeStep: 'script_shots',
  episodeDocs: new Map(),
  libraryLoaded: false,
  libraryCategories: [],
  activeLibraryCategory: 'all',
  selectedLibraryAssetKey: null,
  libraryQuery: '',
  shotsQuery: '',
  shotsStatusFilter: 'all',
  pendingDeleteEpisodeId: null,
  pendingDeleteAssetKey: null,
  pendingDeleteStoryboardItem: null,
  exportJob: {
    running: false,
    controller: null,
    timer: null,
    progress: 0,
    message: '',
    result: null
  },
  exportPreviewJob: {
    running: false,
    loadingExisting: false,
    controller: null,
    message: '',
    result: null,
    loadKey: ''
  }
};

let activeLibraryAudio = null;
let activeLibraryImagePreview = null;
let refreshInFlight = null;
let lastForegroundRefreshAt = 0;

for (const button of stepButtons) {
  button.addEventListener('click', () => switchStep(button.dataset.step));
}
dom.tabShots.addEventListener('click', () => switchStep('shot_videos'));
dom.tabLibrary.addEventListener('click', () => switchStep('asset_library'));
dom.episodeSelect.addEventListener('change', onEpisodeSelected);
dom.deleteEpisodeButton.addEventListener('click', requestDeleteActiveEpisode);
dom.newEpisodeButton.addEventListener('click', createEpisode);
dom.saveCoreIdeaButton.addEventListener('click', saveProjectCoreIdea);
dom.saveStorySourceButton.addEventListener('click', saveStorySource);
dom.storySourceFile.addEventListener('change', onStoryFileSelected);
dom.generateScriptDraftButton.addEventListener('click', generateScriptDraft);
dom.saveScriptDraftButton.addEventListener('click', saveScriptDraft);
dom.splitStoryboardButton.addEventListener('click', splitStoryboard);
dom.addStoryboardShotButton.addEventListener('click', addStoryboardShot);
dom.saveStoryboardButton.addEventListener('click', saveStoryboardEdits);
dom.cancelStoryboardDeleteButton.addEventListener('click', closeStoryboardDeleteDialog);
dom.confirmStoryboardDeleteButton.addEventListener('click', confirmStoryboardDelete);
dom.storyboardDeleteDialog.addEventListener('click', (event) => {
  if (event.target === dom.storyboardDeleteDialog) closeStoryboardDeleteDialog();
});
dom.generatePublicAssetsButton.addEventListener('click', generatePublicAssetsFromScript);
dom.exportPreviewStartButton.addEventListener('click', generateExportPreview);
dom.exportStartButton.addEventListener('click', exportEpisode);
dom.exportCancelButton.addEventListener('click', cancelExport);
dom.librarySearch.addEventListener('input', () => {
  state.libraryQuery = dom.librarySearch.value.trim().toLowerCase();
  renderLibrary(state.libraryCategories);
});
dom.saveAssetDetailButton.addEventListener('click', saveSelectedLibraryAsset);
dom.generateAssetAudioButton.addEventListener('click', generateSelectedLibraryAudio);
dom.deleteAssetButton.addEventListener('click', deleteSelectedLibraryAsset);
dom.shotsSearch.addEventListener('input', () => {
  state.shotsQuery = dom.shotsSearch.value.trim().toLowerCase();
  renderShots();
});
dom.shotsStatusFilter.addEventListener('change', () => {
  state.shotsStatusFilter = dom.shotsStatusFilter.value;
  renderShots();
});

if (!projectPath) {
  showProjectError('缺少项目参数', '请从项目库打开一个项目。');
} else {
window.addEventListener('focus', () => refreshProjectFromServer('focus'));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshProjectFromServer('visibility');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !dom.storyboardDeleteDialog.hidden) {
    closeStoryboardDeleteDialog();
  }
});
  await loadProject();
}

async function loadProject({ force = false } = {}) {
  if (force) {
    state.episodeDocs.clear();
    state.libraryLoaded = false;
    state.libraryCategories = [];
    dom.libraryBody.replaceChildren();
  }
  try {
    const response = await fetch('/api/projects');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    const project = (json.projects || []).find((p) => p.path === projectPath);
    if (!project) {
      showProjectError('没有找到项目', '该项目可能已经被移走，或还没有出现在最近项目中。');
      return;
    }
    state.project = project;
    state.episodes = project.episodes || [];
    state.activeEpisodeId = state.activeEpisodeId && state.episodes.some((ep) => ep.id === state.activeEpisodeId)
      ? state.activeEpisodeId
      : state.episodes[0]?.id || null;
    renderEpisodeBar();
    if (state.activeEpisodeId) {
      await ensureEpisodeDoc(state.activeEpisodeId, { force });
      const doc = getActiveDoc();
      // workflow.currentStep 是生产流程状态，不是用户最后停留的导航页；默认打开剧本与分镜，
      // 只有 URL 明确带 step 参数时才恢复其它步骤，避免刷新后被历史流程状态带走。
      state.activeStep = initialStepFromUrl();
      renderHeader();
      renderWorkflowSteps();
      renderActiveStep();
    } else {
      renderHeader();
      showProjectError('该项目还没有集数', '新项目默认会创建第 1 集；请返回项目库重新创建。');
    }
  } catch (error) {
    showProjectError('加载失败', error.message);
  }
}

function renderHeader() {
  const project = state.project;
  dom.projectTitle.textContent = project.name || '(未命名项目)';
  dom.projectMeta.textContent = `${state.episodes.length} 集 · ${workflowLabel(state.activeStep)}`;
  dom.projectCrumb.textContent = project.name || '项目';
  dom.footerLeft.textContent = `共 ${state.episodes.length} 集 · ${aggregateProductCount()} 个分镜视频`;
  dom.footerRight.textContent = project.updatedAt ? `更新于 ${formatTime(project.updatedAt)}` : '';
}

function aggregateProductCount() {
  return state.episodes.reduce((acc, ep) => acc + (ep.total || 0), 0);
}

function renderEpisodeBar() {
  dom.episodeSelect.replaceChildren();
  dom.episodeBar.replaceChildren();
  dom.episodeBar.hidden = true;
  for (const ep of state.episodes) {
    const option = document.createElement('option');
    option.value = ep.id;
    option.textContent = ep.title || ep.id;
    if (ep.id === state.activeEpisodeId) option.selected = true;
    dom.episodeSelect.appendChild(option);
  }
  const active = getActiveEpisode();
  dom.episodeSummary.textContent = active?.total
    ? `${active.approved || 0}/${active.total} 个分镜已通过`
    : '当前分集尚未保存分镜';
  dom.episodeSelect.disabled = state.episodes.length <= 1;
  renderEpisodeDeleteButton(active);
}

function renderEpisodeDeleteButton(active) {
  const canDelete = !!active && state.episodes.length > 1 && state.activeStep !== 'asset_library';
  dom.deleteEpisodeButton.hidden = !canDelete;
  dom.deleteEpisodeButton.disabled = !canDelete;
  if (!canDelete) {
    state.pendingDeleteEpisodeId = null;
    dom.deleteEpisodeButton.textContent = '删除分集';
    return;
  }
  const pending = state.pendingDeleteEpisodeId === active.id;
  dom.deleteEpisodeButton.textContent = pending ? '确认删除分集' : '删除分集';
}

async function onEpisodeSelected() {
  const episodeId = dom.episodeSelect.value;
  if (!episodeId || episodeId === state.activeEpisodeId) return;
  state.pendingDeleteEpisodeId = null;
  resetExportPreviewState();
  state.activeEpisodeId = episodeId;
  renderEpisodeBar();
  await ensureEpisodeDoc(episodeId);
  renderHeader();
  renderActiveStep();
}

function resetExportPreviewState() {
  if (state.exportPreviewJob.controller) state.exportPreviewJob.controller.abort();
  state.exportPreviewJob.running = false;
  state.exportPreviewJob.loadingExisting = false;
  state.exportPreviewJob.controller = null;
  state.exportPreviewJob.message = '';
  state.exportPreviewJob.result = null;
  state.exportPreviewJob.loadKey = '';
}

function requestDeleteActiveEpisode() {
  const ep = getActiveEpisode();
  if (!ep || state.episodes.length <= 1) return;
  if (state.pendingDeleteEpisodeId !== ep.id) {
    state.pendingDeleteEpisodeId = ep.id;
    dom.footerLeft.textContent = `再次点击“确认删除分集”会把 ${ep.title || ep.id} 移入回收站。`;
    renderEpisodeDeleteButton(ep);
    return;
  }
  deleteEpisode(ep);
}

async function createEpisode() {
  if (!state.project?.path) return;
  state.pendingDeleteEpisodeId = null;
  const previousLabel = dom.newEpisodeButton.textContent;
  dom.newEpisodeButton.disabled = true;
  dom.newEpisodeButton.textContent = '创建中…';
  try {
    const response = await fetch('/api/projects/episode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: state.project.path })
    });
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);

    state.project = payload.project;
    state.episodes = payload.project?.episodes || [];
    state.activeEpisodeId = payload.episode?.id || state.episodes.at(-1)?.id || state.activeEpisodeId;
    await ensureEpisodeDoc(state.activeEpisodeId);
    switchStep('script_shots');
  } catch (error) {
    dom.footerLeft.textContent = `新建分集失败：${error.message}`;
  } finally {
    dom.newEpisodeButton.disabled = false;
    dom.newEpisodeButton.textContent = previousLabel;
  }
}

async function deleteEpisode(ep) {
  if (!state.project?.path || !ep?.path) return;
  const label = ep.title || ep.id;
  state.pendingDeleteEpisodeId = null;
  // 桌面端不使用原生 confirm；外层 requestDeleteActiveEpisode 已完成两次点击确认。
  dom.deleteEpisodeButton.disabled = true;
  dom.deleteEpisodeButton.textContent = '删除中…';
  dom.footerLeft.textContent = `正在删除 ${label}…`;
  try {
    const response = await fetch('/api/projects/episode', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: state.project.path,
        episodePath: ep.path
      })
    });
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);

    state.episodeDocs.delete(ep.id);
    state.project = payload.project;
    state.episodes = payload.project?.episodes || [];
    if (state.activeEpisodeId === ep.id) {
      state.activeEpisodeId = state.episodes[0]?.id || null;
    }
    if (state.activeEpisodeId) await ensureEpisodeDoc(state.activeEpisodeId);
    renderHeader();
    renderEpisodeBar();
    renderWorkflowSteps();
    renderActiveStep();
    dom.footerLeft.textContent = `${label} 已移入回收站`;
  } catch (error) {
    dom.footerLeft.textContent = `删除分集失败：${error.message}`;
  } finally {
    renderEpisodeDeleteButton(getActiveEpisode());
  }
}

async function ensureEpisodeDoc(episodeId, { force = false } = {}) {
  if (!force && state.episodeDocs.has(episodeId)) return;
  const ep = state.episodes.find((item) => item.id === episodeId);
  if (!ep) return;
  dom.footerLeft.textContent = `正在读取 ${ep.title || ep.id}…`;
  try {
    // 分集文档可能被服务端生成、外部导入或本机脚本补齐；强制刷新时必须绕过浏览器缓存和页面内存。
    const response = await fetch(`/api/episode?path=${encodeURIComponent(ep.path)}`, { cache: 'no-store' });
    if (!response.ok) {
      const payload = await safeJson(response);
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    const doc = await response.json();
    const backfilled = normalizeShotScriptTexts(doc);
    state.episodeDocs.set(episodeId, doc);
    if (backfilled) {
      await saveEpisodeDoc(ep.path, doc);
      dom.footerLeft.textContent = `${ep.title || ep.id} 已补齐分镜剧本片段`;
    }
  } catch (error) {
    showProjectError(`加载 ${ep.title || ep.id} 失败`, error.message);
  }
}

async function refreshProjectFromServer(reason = 'manual') {
  if (!projectPath || document.hidden || refreshInFlight) return refreshInFlight;
  if (!shouldRefreshWhileForegrounded()) return null;
  const now = Date.now();
  if (reason !== 'manual' && now - lastForegroundRefreshAt < 1200) return null;
  lastForegroundRefreshAt = now;
  refreshInFlight = loadProject({ force: true })
    .catch((error) => {
      dom.footerLeft.textContent = `刷新项目失败：${error.message}`;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

function shouldRefreshWhileForegrounded() {
  const active = document.activeElement;
  if (!active) return true;
  // 用户正在编辑时不自动覆盖页面内容；切换回页面但焦点不在输入区时再同步服务端最新状态。
  if (active.matches?.('input, textarea, select, [contenteditable="true"]')) return false;
  return true;
}

function switchStep(stepKey) {
  state.activeStep = normalizeStep(stepKey);
  updateStepInUrl(state.activeStep);
  state.pendingDeleteEpisodeId = null;
  renderWorkflowSteps();
  renderHeader();
  renderEpisodeBar();
  renderActiveStep();
}

function normalizeStep(stepKey) {
  return workflowStepKeys.has(stepKey) ? stepKey : 'script_shots';
}

function workflowLabel(stepKey) {
  return workflowSteps.find((step) => step.key === stepKey)?.label || '剧本与分镜';
}

function renderWorkflowSteps() {
  const doc = getActiveDoc();
  const stepStatus = new Map((doc?.workflow?.steps || []).map((step) => [step.key, step.status]));
  for (const button of stepButtons) {
    const key = button.dataset.step;
    const isActive = key === state.activeStep;
    button.classList.toggle('is-active', isActive);
    button.dataset.status = stepStatus.get(key) || (isActive ? 'active' : 'available');
    button.setAttribute('aria-current', isActive ? 'step' : 'false');
  }
  dom.tabShots.classList.toggle('is-active', state.activeStep === 'shot_videos');
  dom.tabLibrary.classList.toggle('is-active', state.activeStep === 'asset_library');
}

function renderActiveStep() {
  // 四个创作 step 统一由 hidden 控制；成片导出只有在第 4 步激活时才占据内容区。
  const panels = {
    script_shots: dom.scriptPanel,
    asset_library: dom.libraryPanel,
    shot_videos: dom.shotsPanel,
    export: dom.exportPanel
  };
  for (const [stepKey, panel] of Object.entries(panels)) {
    panel.hidden = stepKey !== state.activeStep;
  }
  // 公共资产是项目级资源库，不绑定某个分集；进入 Step 2 时隐藏分集切换和新建分集入口。
  dom.episodeStrip.hidden = state.activeStep === 'asset_library';

  if (state.activeStep === 'script_shots') renderScriptStep();
  if (state.activeStep === 'asset_library') loadLibraryIfNeeded();
  if (state.activeStep === 'shot_videos') renderShots();
  if (state.activeStep === 'export') renderExportStep();
}

function renderScriptStep() {
  const doc = getActiveDoc();
  if (!doc) return;
  dom.storySourceEditor.disabled = false;
  dom.saveStorySourceButton.disabled = false;
  // “生成草稿”只保留为兼容旧逻辑的隐藏入口；主流程收敛到“生成分镜剧本”。
  dom.generateScriptDraftButton.hidden = true;
  dom.generateScriptDraftButton.setAttribute('aria-hidden', 'true');
  dom.generateScriptDraftButton.disabled = false;
  dom.scriptDraftEditor.disabled = false;
  dom.saveScriptDraftButton.disabled = false;
  dom.splitStoryboardButton.disabled = false;
  dom.addStoryboardShotButton.disabled = false;
  const source = getPrimaryStorySource(doc);
  dom.storySourceEditor.value = source?.text || '';
  dom.storySourceEditor.dataset.sourceType = source?.type || 'story_text';
  dom.storySourceMeta.textContent = source?.updatedAt
    ? `已保存 · ${formatTime(source.updatedAt)}`
    : source?.createdAt
      ? `已导入 · ${formatTime(source.createdAt)}`
      : '尚未保存文本';

  const scriptCount = (doc.nodes || []).filter((node) => node.type === 'script_segment').length;
  const shotCount = Array.isArray(doc.shots) ? doc.shots.length : 0;
  renderScriptMetadata({ doc, scriptCount, shotCount });
  dom.scriptDraftEditor.value = doc.scriptDraft?.text || '';
  setScriptDraftStatus(doc.scriptDraft?.updatedAt
    ? `已保存 · ${formatTime(doc.scriptDraft.updatedAt)}`
    : scriptCount
      ? `已有 ${scriptCount} 段剧本内容，可继续确认或调整。`
      : '待从故事源改编。');
  dom.storyboardState.textContent = shotCount
    ? `已拆分 ${shotCount} 个分镜，可进入分镜视频步骤。`
    : '确认故事源后生成或手动整理分镜剧本。';
  renderStoryboardList(doc);
}

function renderScriptMetadata({ doc, scriptCount, shotCount }) {
  const episode = getActiveEpisode();
  const scriptStatus = doc.scriptDraft?.updatedAt
    ? `剧本已保存 · ${formatTime(doc.scriptDraft.updatedAt)}`
    : scriptCount
      ? `${scriptCount} 段剧本待确认`
      : '待编写';
  // Step 1 的顶部只呈现可读的作品状态摘要，不暴露项目目录或 JSON 文件路径。
  dom.metadataProjectName.textContent = state.project?.name || '(未命名项目)';
  dom.metadataEpisodeName.textContent = episode?.title || doc.episode?.title || episode?.id || '第 1 集';
  dom.metadataEpisodeId.textContent = episode?.id || doc.episode?.id || 'ep001';
  dom.metadataWorkflowStep.textContent = workflowLabel(state.activeStep);
  dom.metadataScriptStatus.textContent = scriptStatus;
  dom.metadataShotCount.textContent = `${shotCount} 个`;
  dom.metadataCoreIdea.value = state.project?.coreIdea || '';
  dom.metadataGlobalBrief.value = state.project?.globalBrief || extractGlobalBriefFromScript(doc?.scriptDraft?.text || '');
  dom.metadataJimengSpaceName.value = state.project?.jimengSpaceName || '';
  const savedParts = [];
  if (state.project?.coreIdea) savedParts.push('创作方向');
  if (state.project?.globalBrief) savedParts.push('全局设定');
  if (state.project?.jimengSpaceName) savedParts.push(`即梦空间「${state.project.jimengSpaceName}」`);
  dom.metadataCoreIdeaState.textContent = savedParts.length
    ? `已保存${savedParts.join('、')}。`
    : '可补写整部作品的创作方向、全局设定和即梦空间。';
}

async function saveProjectCoreIdea() {
  if (!state.project?.path) return;
  const coreIdea = dom.metadataCoreIdea.value.trim();
  const globalBrief = dom.metadataGlobalBrief.value.trim();
  const jimengSpaceName = dom.metadataJimengSpaceName.value.trim();
  dom.saveCoreIdeaButton.disabled = true;
  dom.metadataCoreIdeaState.textContent = '保存中…';
  try {
    const response = await fetch('/api/projects/metadata', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: state.project.path,
        coreIdea,
        globalBrief,
        jimengSpaceName
      })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.message || json.error || `HTTP ${response.status}`);
    }
    // API 返回的是最新 project.json 摘要；同步本地 state，避免刷新前显示旧立意。
    state.project = json.project || { ...state.project, coreIdea, globalBrief };
    state.episodes = state.project.episodes || state.episodes;
    renderHeader();
    dom.metadataCoreIdea.value = state.project.coreIdea || '';
    dom.metadataGlobalBrief.value = state.project.globalBrief || '';
    dom.metadataJimengSpaceName.value = state.project.jimengSpaceName || '';
    const savedParts = [];
    if (state.project.coreIdea) savedParts.push('创作方向');
    if (state.project.globalBrief) savedParts.push('全局设定');
    if (state.project.jimengSpaceName) savedParts.push(`即梦空间「${state.project.jimengSpaceName}」`);
    dom.metadataCoreIdeaState.textContent = savedParts.length
      ? `已保存${savedParts.join('、')}。`
      : '已清空作品元数据。';
  } catch (error) {
    dom.metadataCoreIdeaState.textContent = `保存失败：${error.message}`;
  } finally {
    dom.saveCoreIdeaButton.disabled = false;
  }
}

function getPrimaryStorySource(doc) {
  return Array.isArray(doc.storySources) && doc.storySources.length ? doc.storySources[0] : null;
}

function extractGlobalBriefFromScript(scriptText) {
  const text = String(scriptText || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const output = [];
  let collecting = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const heading = trimmed.match(/^##\s*(.+)$/u);
    if (heading) {
      const title = heading[1].replace(/[：:].*$/u, '').trim();
      collecting = /^(?:主要人物|人物|角色|角色设定|主要场景|场景清单|重要道具|道具)$/u.test(title);
      if (collecting) output.push(`## ${title}`);
      continue;
    }
    if (!collecting) continue;
    if (/^#{1,6}\s+/u.test(trimmed)) {
      collecting = false;
      continue;
    }
    if (trimmed) output.push(trimmed);
  }
  // 旧完整剧本里的角色、场景、道具属于作品级公共信息；这里只用于元数据预填，不进入逐镜分镜剧本。
  return output.join('\n').trim();
}

async function onStoryFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await readFileAsText(file);
    dom.storySourceEditor.value = text;
    dom.storySourceEditor.dataset.sourceType = 'material_text';
    dom.storySourceMeta.textContent = `已读取本地文件：${file.name}`;
  } catch (error) {
    dom.storySourceMeta.textContent = `读取失败：${error.message}`;
  } finally {
    // 允许用户连续选择同一个文件触发 change。
    dom.storySourceFile.value = '';
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () => reject(reader.error || new Error('FileReader failed')));
    reader.readAsText(file, 'utf-8');
  });
}

async function saveStorySource() {
  const doc = getActiveDoc();
  const ep = getActiveEpisode();
  if (!doc || !ep) return;
  const text = dom.storySourceEditor.value.trim();
  const now = new Date().toISOString();
  const current = getPrimaryStorySource(doc);
  const source = {
    id: current?.id || 'story:source:001',
    type: current?.type || dom.storySourceEditor.dataset.sourceType || 'story_text',
    title: current?.title || '故事源',
    text,
    createdAt: current?.createdAt || now,
    updatedAt: now
  };
  doc.storySources = [source];
  doc.workflow = normalizeWorkflow(doc.workflow);
  doc.workflow.currentStep = 'script_shots';
  appendActivity(doc, {
    id: `activity:story-source:${now.replace(/[-:.TZ]/g, '')}`,
    type: 'story_source_saved',
    at: now,
    message: text ? '故事源文本已保存' : '故事源文本已清空'
  });

  setStorySaving(true);
  try {
    await persistActiveDoc(doc);
    dom.storySourceMeta.textContent = text ? `已保存 · ${formatTime(now)}` : '已清空文本';
    dom.footerRight.textContent = `保存于 ${formatTime(now)}`;
  } catch (error) {
    dom.storySourceMeta.textContent = `保存失败：${error.message}`;
  } finally {
    setStorySaving(false);
  }
}

async function generateScriptDraft() {
  const doc = getActiveDoc();
  if (!doc) return;
  const sourceText = dom.storySourceEditor.value.trim() || getPrimaryStorySource(doc)?.text || '';
  if (!sourceText) {
    setScriptDraftStatus('请先粘贴或导入故事源。');
    return;
  }
  setScriptDraftGenerating(true);
  setScriptDraftStatus('正在生成剧本草稿…');
  try {
    const response = await fetch('/api/script-draft/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceText,
        projectName: state.project?.name,
        episodeTitle: getActiveEpisode()?.title || doc.episode?.title
      })
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      setScriptDraftStatus(
        formatScriptDraftGenerationFailureMessage(payload?.message),
        {
          settingsUrl: payload?.settingsUrl || TEXT_MODEL_SETTINGS_URL,
          actionText: '去配置文本模型'
        }
      );
      return;
    }
    const scriptDraft = String(payload?.scriptDraft || '').trim();
    if (!scriptDraft) {
      setScriptDraftStatus('文本模型没有返回剧本草稿，你可以重试，或直接手动编写。', {
        settingsUrl: TEXT_MODEL_SETTINGS_URL,
        actionText: '去配置文本模型'
      });
      return;
    }
    const now = payload?.generatedAt || new Date().toISOString();
    doc.scriptDraft = {
      text: scriptDraft,
      source: 'text_model',
      updatedAt: now,
      model: {
        adapterId: payload?.adapterId,
        modelId: payload?.modelId
      }
    };
    appendActivity(doc, {
      id: `activity:script-draft:${now.replace(/[-:.TZ]/g, '')}`,
      type: 'script_draft_generated',
      at: now,
      message: '已生成剧本草稿'
    });
    await persistScriptDraft(doc, '草稿已生成');
  } catch (error) {
    setScriptDraftStatus(formatScriptDraftGenerationFailureMessage(`${error.message}。你可以直接手动编写剧本草稿。`), {
      settingsUrl: TEXT_MODEL_SETTINGS_URL,
      actionText: '去配置文本模型'
    });
  } finally {
    setScriptDraftGenerating(false);
  }
}

async function saveScriptDraft() {
  const doc = getActiveDoc();
  if (!doc) return;
  const now = new Date().toISOString();
  doc.scriptDraft = {
    text: dom.scriptDraftEditor.value.trim(),
    source: doc.scriptDraft?.source || 'manual',
    updatedAt: now
  };
  appendActivity(doc, {
    id: `activity:script-draft-save:${now.replace(/[-:.TZ]/g, '')}`,
    type: 'script_draft_saved',
    at: now,
    message: '剧本草稿已保存'
  });
  await persistScriptDraft(doc, '草稿已保存');
}

async function persistScriptDraft(doc, successMessage) {
  setScriptDraftSaving(true);
  try {
    await persistActiveDoc(doc);
    dom.scriptDraftEditor.value = doc.scriptDraft?.text || '';
    setScriptDraftStatus(`${successMessage} · ${formatTime(doc.scriptDraft.updatedAt)}`);
    renderScriptMetadata({
      doc,
      scriptCount: (doc.nodes || []).filter((node) => node.type === 'script_segment').length,
      shotCount: Array.isArray(doc.shots) ? doc.shots.length : 0
    });
  } catch (error) {
    setScriptDraftStatus(`保存失败：${error.message}`);
  } finally {
    setScriptDraftSaving(false);
  }
}

async function splitStoryboard() {
  const doc = getActiveDoc();
  if (!doc) return;
  setStoryboardSplitting(true);
  try {
    const scriptText = await resolveStoryboardSourceScript(doc);
    if (!scriptText) return;
    const now = new Date().toISOString();
    doc.scriptDraft = {
      text: scriptText,
      source: doc.scriptDraft?.source || 'manual',
      updatedAt: now
    };
    const result = applyStoryboardSplit(doc, { scriptText, now });
    await persistActiveDoc(doc);
    renderScriptMetadata({
      doc,
      scriptCount: (doc.nodes || []).filter((node) => node.type === 'script_segment').length,
      shotCount: Array.isArray(doc.shots) ? doc.shots.length : 0
    });
    renderStoryboardList(doc);
    dom.storyboardState.textContent = `已生成 ${result.shotCount} 个分镜剧本，可在当前页面继续审改。`;
  } catch (error) {
    dom.storyboardState.textContent = `生成失败：${error.message}`;
  } finally {
    setStoryboardSplitting(false);
  }
}

async function resolveStoryboardSourceScript(doc) {
  const currentScript = dom.scriptDraftEditor.value.trim() || doc.scriptDraft?.text?.trim() || '';
  if (currentScript) return currentScript;
  const sourceText = dom.storySourceEditor.value.trim() || getPrimaryStorySource(doc)?.text || '';
  if (!sourceText) {
    dom.storyboardState.textContent = '请先粘贴或导入故事源。';
    return '';
  }
  dom.storyboardState.textContent = '正在根据故事源生成分镜剧本…';
  const response = await fetch('/api/script-draft/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceText,
      projectName: state.project?.name,
      episodeTitle: getActiveEpisode()?.title || doc.episode?.title
    })
  });
  const payload = await safeJson(response);
  if (!response.ok) {
    setScriptDraftStatus(
      formatScriptDraftGenerationFailureMessage(payload?.message),
      {
        settingsUrl: payload?.settingsUrl || TEXT_MODEL_SETTINGS_URL,
        actionText: '去配置文本模型'
      }
    );
    dom.storyboardState.textContent = '文本模型暂时不可用，可以先手动填写分镜剧本。';
    return '';
  }
  const scriptDraft = String(payload?.scriptDraft || '').trim();
  if (!scriptDraft) {
    dom.storyboardState.textContent = '文本模型没有返回可用内容，可以重试或手动填写分镜剧本。';
    return '';
  }
  const now = payload?.generatedAt || new Date().toISOString();
  doc.scriptDraft = {
    text: scriptDraft,
    source: 'text_model',
    updatedAt: now,
    model: {
      adapterId: payload?.adapterId,
      modelId: payload?.modelId
    }
  };
  appendActivity(doc, {
    id: `activity:storyboard-source:${now.replace(/[-:.TZ]/g, '')}`,
    type: 'storyboard_source_generated',
    at: now,
    message: '已生成分镜剧本来源文本'
  });
  return scriptDraft;
}

function renderStoryboardList(doc) {
  dom.storyboardList.replaceChildren();
  const shots = Array.isArray(doc.shots) ? doc.shots : [];
  const editor = document.createElement('textarea');
  editor.className = 'storyboard-script-editor';
  editor.dataset.storyboardEditor = 'true';
  editor.value = formatStoryboardEditorText(doc, shots);
  editor.placeholder = '这里展示逐镜分镜剧本。每段以“## S001 分镜｜10s｜标题”开头，下方只写这个分镜的画面、动作、对白、旁白和声音。';
  editor.addEventListener('input', () => {
    dom.saveStoryboardButton.disabled = !editor.value.trim();
  });
  dom.storyboardList.appendChild(editor);
  dom.saveStoryboardButton.disabled = !shots.length;
  dom.storyboardState.textContent = shots.length ? `${shots.length} 个分镜` : '确认剧本后拆分镜头。';
}

function compactStoryboardNo(shotNo) {
  const match = String(shotNo || '').match(/(\d+)$/);
  return match ? String(Number(match[1])).padStart(2, '0') : '新';
}

function formatStoryboardEditorText(doc, shots) {
  return shots
    .map((shot, index) => {
      const title = normalizeSingleLine(shot.title || shot.summary || `分镜 ${index + 1}`);
      const duration = normalizeStoryboardDurationInput(shot.durationSec);
      const heading = formatStoryboardShotHeading({
        shotNo: shot.shotNo || shot.id,
        title,
        durationSec: duration,
        index
      });
      const body = buildReadableStoryboardScriptText(doc, shot);
      return `## ${heading}\n\n${body}`;
    })
    .join('\n\n---\n\n');
}

function buildReadableStoryboardScriptText(doc, shot) {
  const existing = shotScriptText(doc, shot) || '';
  // 剧本页只展示用户需要验收的逐镜剧情正文；资源依赖、提示词备注等生产字段留给后续生成层。
  return formatReadableStoryboardScriptText(existing, {
    fallback: shot.summary || shot.title || buildEmptyStoryboardBlockBody()
  }) || buildEmptyStoryboardBlockBody();
}

function buildEmptyStoryboardBlockBody() {
  // 新增段落只提供可读剧本字段，避免把资源依赖或提示词字段带回剧本验收页。
  return [
    '画面：',
    '对白/旁白：',
    '声音：'
  ].join('\n');
}

function parseTimeRange(text) {
  const match = String(text || '').match(/(?:\*\*时间：\*\*|正片时间：|时间[:：])\s*([0-9]{1,2}[:：][0-9]{2}(?::[0-9]{2})?)\s*[-–—至]\s*([0-9]{1,2}[:：][0-9]{2}(?::[0-9]{2})?)/u);
  if (!match) return null;
  const startSec = parseClockTimeToSeconds(match[1]);
  const endSec = parseClockTimeToSeconds(match[2]);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null;
  return { startSec, endSec };
}

function parseClockTimeToSeconds(value) {
  const parts = String(value || '').replace(/：/g, ':').split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

function normalizeSingleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getStoryboardScriptEditor() {
  return dom.storyboardList.querySelector('[data-storyboard-editor="true"]');
}

function buildStoryboardEditItem(doc, shot = {}, { isNew = false } = {}) {
  const item = document.createElement('article');
  item.className = 'storyboard-item storyboard-item--editable';
  item.dataset.shotNo = shot.shotNo || '';
  item.dataset.sourceShotNo = shot.shotNo || '';
  item.dataset.shotId = shot.id || '';

  // 分镜列表的核心阅读对象是剧本片段，编号、标题、时长和删除动作收进紧凑头部，避免挤占正文区域。
  const top = document.createElement('div');
  top.className = 'storyboard-item__top';

  const no = document.createElement('span');
  no.className = 'storyboard-item__no';
  no.textContent = isNew ? '新' : compactStoryboardNo(shot.shotNo || shot.id);
  no.title = shot.shotNo || shot.id || '新分镜';
  top.appendChild(no);

  const titleLabel = document.createElement('label');
  titleLabel.className = 'storyboard-field storyboard-field--title';
  const titleLabelText = document.createElement('span');
  titleLabelText.className = 'sr-only';
  titleLabelText.textContent = '标题';
  titleLabel.appendChild(titleLabelText);
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = shot.title || shot.summary || '';
  // 公开界面的占位内容仅引用独立虚构演示。
  titleInput.placeholder = '例如：机器人抵达灯塔';
  titleInput.title = '分镜标题';
  titleInput.dataset.storyboardField = 'title';
  titleLabel.appendChild(titleInput);
  top.appendChild(titleLabel);

  const durationLabel = document.createElement('label');
  durationLabel.className = 'storyboard-duration';
  const durationLabelText = document.createElement('span');
  durationLabelText.className = 'sr-only';
  durationLabelText.textContent = '时长';
  durationLabel.appendChild(durationLabelText);
  const duration = document.createElement('input');
  duration.type = 'number';
  duration.min = '1';
  duration.max = '15';
  duration.step = '1';
  duration.value = String(normalizeStoryboardDurationInput(shot.durationSec));
  duration.title = '单个分镜默认不超过 15 秒';
  duration.dataset.storyboardField = 'durationSec';
  durationLabel.appendChild(duration);
  const durationUnit = document.createElement('span');
  durationUnit.textContent = 's';
  durationLabel.appendChild(durationUnit);
  top.appendChild(durationLabel);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger-button storyboard-delete-button';
  remove.textContent = '×';
  remove.title = '删除分镜';
  remove.setAttribute('aria-label', `删除 ${no.title} 分镜`);
  remove.addEventListener('click', () => openStoryboardDeleteDialog(item));
  top.appendChild(remove);
  item.appendChild(top);

  const body = document.createElement('div');
  body.className = 'storyboard-item__body';
  const scriptLabel = document.createElement('label');
  scriptLabel.className = 'storyboard-field storyboard-field--script';
  const scriptLabelText = document.createElement('span');
  scriptLabelText.className = 'storyboard-script-label';
  scriptLabelText.textContent = '剧本片段';
  scriptLabel.appendChild(scriptLabelText);
  const script = document.createElement('textarea');
  script.className = 'storyboard-item__script';
  script.rows = 5;
  script.value = doc ? (shotScriptText(doc, shot) || '') : (shot.scriptText || '');
  script.placeholder = '写清楚这个分镜要拍什么；单镜头默认不超过 15 秒。';
  script.dataset.storyboardField = 'scriptText';
  scriptLabel.appendChild(script);
  body.appendChild(scriptLabel);
  item.appendChild(body);

  return item;
}

function addStoryboardShot() {
  const editor = getStoryboardScriptEditor();
  if (!editor) return;
  const nextNo = String(parseStoryboardEditorRows(editor.value, getActiveDoc()).length + 1).padStart(2, '0');
  const nextBlock = `## S${nextNo} 分镜｜5s｜新分镜\n\n${buildEmptyStoryboardBlockBody()}\n`;
  editor.value = `${editor.value.trim() ? `${editor.value.trim()}\n\n---\n\n` : ''}${nextBlock}`;
  dom.saveStoryboardButton.disabled = false;
  dom.storyboardState.textContent = '已新增一个空白分镜段落，填写后点击“保存分镜”。';
  editor.focus();
  editor.selectionStart = editor.selectionEnd = editor.value.length;
}

async function saveStoryboardEdits() {
  const doc = getActiveDoc();
  if (!doc) return;
  const rows = collectStoryboardEditRows();
  const now = new Date().toISOString();
  const result = replaceStoryboardShots(doc, { shots: rows, now });
  setStoryboardSaving(true);
  try {
    await persistActiveDoc(doc);
    renderScriptMetadata({
      doc,
      scriptCount: (doc.nodes || []).filter((node) => node.type === 'script_segment').length,
      shotCount: Array.isArray(doc.shots) ? doc.shots.length : 0
    });
    renderStoryboardList(doc);
    renderWorkflowSteps();
    renderHeader();
    dom.storyboardState.textContent = `已保存 ${result.shotCount} 个分镜（新增 ${result.createdCount}，更新 ${result.updatedCount}，删除 ${result.deletedCount}）。`;
    dom.footerRight.textContent = `更新于 ${formatTime(now)}`;
  } catch (error) {
    dom.storyboardState.textContent = `保存分镜失败：${error.message}`;
  } finally {
    setStoryboardSaving(false);
  }
}

function collectStoryboardEditRows() {
  const editor = getStoryboardScriptEditor();
  if (editor) return parseStoryboardEditorRows(editor.value, getActiveDoc());

  return [...dom.storyboardList.querySelectorAll('.storyboard-item')]
    .map((item) => ({
      shotNo: item.dataset.shotNo || '',
      sourceShotNo: item.dataset.sourceShotNo || '',
      title: item.querySelector('[data-storyboard-field="title"]')?.value.trim() || '',
      scriptText: item.querySelector('[data-storyboard-field="scriptText"]')?.value.trim() || '',
      durationSec: Number(item.querySelector('[data-storyboard-field="durationSec"]')?.value || 5)
    }))
    // 前端先过滤完全空白的新行；数据层仍会再做一次兜底，防止误写空镜头。
    .filter((row) => row.title || row.scriptText);
}

function parseStoryboardEditorRows(text, doc) {
  const existingShots = Array.isArray(doc?.shots) ? doc.shots : [];
  const blocks = splitStoryboardEditorBlocks(text);
  return blocks
    .map((block, index) => parseStoryboardEditorBlock(block, index, existingShots))
    .filter((row) => row.title || row.scriptText);
}

function splitStoryboardEditorBlocks(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (/^##\s*(?:s?\d+|新)\b/iu.test(line.trim()) && current.some((item) => item.trim())) {
      blocks.push(current.join('\n').trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.some((line) => line.trim())) blocks.push(current.join('\n').trim());
  return blocks;
}

function parseStoryboardEditorBlock(block, index, existingShots) {
  const lines = String(block || '').split('\n');
  const heading = lines.shift() || '';
  const body = lines.join('\n').replace(/^---+$/gmu, '').trim();
  const parts = heading.replace(/^##\s*/, '').split('｜').map((part) => part.trim());
  const sourceShotNo = normalizeStoryboardHeadingShotNo(parts[0]) || existingShots[index]?.shotNo || '';
  const durationPart = parts.find((part) => /\d+(?:\.\d+)?\s*s\b/iu.test(part)) || '';
  const duration = Number(durationPart.match(/(\d+(?:\.\d+)?)/u)?.[1] || existingShots[index]?.durationSec || 5);
  const title = parts
    .filter((part, partIndex) => partIndex !== 0 && part !== durationPart)
    .join('｜')
    .trim();
  return {
    shotNo: sourceShotNo || `s${String(index + 1).padStart(3, '0')}`,
    sourceShotNo,
    title: title || existingShots[index]?.title || existingShots[index]?.summary || '',
    scriptText: body,
    durationSec: normalizeStoryboardDurationInput(duration)
  };
}

function normalizeStoryboardHeadingShotNo(value) {
  const match = String(value || '').match(/(\d+)/);
  return match ? `s${String(Number(match[1])).padStart(3, '0')}` : '';
}

function openStoryboardDeleteDialog(item) {
  if (!item) return;
  state.pendingDeleteStoryboardItem = item;
  const label = item.dataset.shotNo || item.dataset.sourceShotNo || '这个分镜';
  const title = item.querySelector('[data-storyboard-field="title"]')?.value.trim();
  dom.storyboardDeleteBody.textContent = `将删除 ${label}${title ? `「${title}」` : ''}。删除后，后续分镜会重新编号；点击“保存分镜”后会同步更新分镜脚本、提示词和视频任务。`;
  dom.storyboardDeleteDialog.hidden = false;
  dom.confirmStoryboardDeleteButton.focus();
}

function closeStoryboardDeleteDialog() {
  state.pendingDeleteStoryboardItem = null;
  dom.storyboardDeleteDialog.hidden = true;
}

function confirmStoryboardDelete() {
  const item = state.pendingDeleteStoryboardItem;
  closeStoryboardDeleteDialog();
  deleteStoryboardEditItem(item);
}

function deleteStoryboardEditItem(item) {
  if (!item?.isConnected) return;
  item.remove();
  syncStoryboardEditRowNumbers();
  dom.saveStoryboardButton.disabled = !dom.storyboardList.querySelector('.storyboard-item');
  dom.storyboardState.textContent = '分镜已从预览中移除，后续编号已重排；点击“保存分镜”后同步写入。';
}

function syncStoryboardEditRowNumbers() {
  [...dom.storyboardList.querySelectorAll('.storyboard-item')].forEach((item, index) => {
    const shotNo = `s${String(index + 1).padStart(3, '0')}`;
    item.dataset.shotNo = shotNo;
    const no = item.querySelector('.storyboard-item__no');
    if (no) {
      no.textContent = compactStoryboardNo(shotNo);
      no.title = shotNo;
    }
    const remove = item.querySelector('.storyboard-delete-button');
    remove?.setAttribute('aria-label', `删除 ${shotNo} 分镜`);
  });
}

function normalizeStoryboardDurationInput(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return 5;
  // 前端输入也限制在 15 秒内；真正写回时工作流模块还会再次校验。
  return Math.min(15, Math.max(1, Math.round(duration)));
}

function shotScriptText(doc, shot) {
  return readShotScriptText(doc, shot);
}

function normalizeWorkflow(workflow) {
  // 老文档可能没有 workflow；写回前补齐 V1 步骤，避免局部保存破坏新导航。
  const steps = workflowSteps.map((step, index) => ({
    key: step.key,
    title: step.label,
    status: index === 0 ? 'active' : 'available'
  }));
  if (!workflow || typeof workflow !== 'object') return { currentStep: 'script_shots', steps };
  return {
    currentStep: normalizeStep(workflow.currentStep),
    steps: Array.isArray(workflow.steps) && workflow.steps.length ? workflow.steps : steps
  };
}

function appendActivity(doc, item) {
  if (!Array.isArray(doc.activityLog)) doc.activityLog = [];
  doc.activityLog.push(item);
}

function setStorySaving(isSaving) {
  dom.saveStorySourceButton.disabled = isSaving;
  dom.saveStorySourceButton.textContent = isSaving ? '保存中…' : '保存文本';
}

function setScriptDraftSaving(isSaving) {
  dom.generateScriptDraftButton.disabled = isSaving;
  dom.saveScriptDraftButton.disabled = isSaving;
  dom.saveScriptDraftButton.textContent = isSaving ? '保存中…' : '保存草稿';
}

function setScriptDraftGenerating(isGenerating) {
  dom.generateScriptDraftButton.disabled = isGenerating;
  dom.saveScriptDraftButton.disabled = isGenerating;
  dom.generateScriptDraftButton.textContent = isGenerating ? '生成中…' : '生成草稿';
}

function formatScriptDraftGenerationFailureMessage(message) {
  const detail = String(message || '剧本草稿暂时无法生成，你可以去配置文本模型，或直接手动编写。').trim();
  // 点击后的失败状态要和页面初始“未配置”提示区分开，避免用户误以为按钮没有响应。
  return detail.startsWith('生成未完成') ? detail : `生成未完成：${detail}`;
}

function setScriptDraftStatus(message, { settingsUrl, actionText = '去配置文本模型' } = {}) {
  dom.scriptDraftState.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  dom.scriptDraftState.appendChild(text);
  if (!settingsUrl) return;

  // AI 能力不可用时，入口不能消失；用真实按钮承接下一步，避免桌面端把文本链接合并成不可操作文案。
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'inline-status-action';
  button.textContent = actionText;
  button.addEventListener('click', () => {
    window.location.href = settingsUrl;
  });
  dom.scriptDraftState.append(' ');
  dom.scriptDraftState.appendChild(button);
}

function setStoryboardSplitting(isSplitting) {
  dom.splitStoryboardButton.disabled = isSplitting;
  dom.splitStoryboardButton.textContent = isSplitting ? '生成中…' : '生成分镜剧本';
}

function setStoryboardSaving(isSaving) {
  dom.addStoryboardShotButton.disabled = isSaving;
  dom.saveStoryboardButton.disabled = isSaving;
  dom.saveStoryboardButton.textContent = isSaving ? '保存中…' : '保存分镜';
}

async function persistActiveDoc(doc) {
  const ep = getActiveEpisode();
  if (!ep) throw new Error('Active episode not found');
  await saveEpisodeDoc(ep.path, doc);
  state.episodeDocs.set(state.activeEpisodeId, doc);
}

async function saveEpisodeDoc(episodePath, doc) {
  const response = await fetch('/api/episode', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodePath, document: doc })
  });
  const payload = await safeJson(response);
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
}

async function loadLibraryIfNeeded() {
  if (state.libraryLoaded) {
    renderLibrary(state.libraryCategories);
    return;
  }
  await loadLibrary();
}

async function loadLibrary() {
  if (!projectPath) return;
  showLibraryState({ title: '加载中…', body: '正在读取项目公共资源。' });
  try {
    const response = await fetch(`/api/library?path=${encodeURIComponent(projectPath)}`);
    if (!response.ok) {
      const payload = await safeJson(response);
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    const json = await response.json();
    state.libraryCategories = mergeLibraryCategories(
      buildDocumentLibraryCategories(getActiveDoc()),
      json.library || []
    );
    state.libraryLoaded = true;
    renderLibrary(state.libraryCategories);
  } catch (error) {
    showLibraryState({ title: '加载失败', body: error.message });
  }
}

async function generatePublicAssetsFromScript() {
  const episode = getActiveEpisode();
  const doc = getActiveDoc();
  const scriptText = String(doc?.scriptDraft?.text || '').trim();
  if (!episode) {
    setLibraryGenerationState('未找到当前分集，请先返回项目库重新打开项目。', 'error');
    return;
  }
  if (!scriptText) {
    setLibraryGenerationState('请先回到“剧本与分镜”保存分镜剧本，再从剧本生成公共资产。', 'error');
    return;
  }

  setPublicAssetGenerationPending(true);
  setLibraryGenerationState('正在从剧本提取角色、场景、道具和风格候选…');
  try {
    const response = await fetch('/api/library/generate-from-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath: episode.path })
    });
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);

    // API 已写回分集文档；这里强制刷新缓存，保证公共资产 tab 立即反映最新候选。
    state.episodeDocs.delete(state.activeEpisodeId);
    await ensureEpisodeDoc(state.activeEpisodeId);
    state.libraryLoaded = false;
    state.selectedLibraryAssetKey = null;
    await loadLibrary();
    const createdCount = payload?.createdCount || 0;
    setLibraryGenerationState(
      createdCount
        ? `已生成 ${createdCount} 个公共资产候选，可继续编辑详情或上传素材。`
        : '剧本中的公共资产候选已存在，可继续编辑详情或上传素材。',
      'success'
    );
    renderHeader();
  } catch (error) {
    setLibraryGenerationState(`生成失败：${error.message}`, 'error');
  } finally {
    setPublicAssetGenerationPending(false);
  }
}

function setPublicAssetGenerationPending(isPending) {
  dom.generatePublicAssetsButton.disabled = isPending;
  dom.generatePublicAssetsButton.textContent = isPending ? '生成中…' : '从剧本生成公共资产';
}

function setLibraryGenerationState(message, tone = 'neutral') {
  dom.libraryGenerationState.textContent = message;
  dom.libraryGenerationState.dataset.tone = tone;
}

function renderLibrary(categories) {
  pauseActiveLibraryAudio();
  renderLibraryTabs(categories);
  dom.libraryBody.replaceChildren();
  const filtered = filterLibraryCategories(categories);
  const visibleAssets = flattenLibraryAssets(filtered);
  if (!filtered.length) {
    renderLibraryInspector(null);
    showLibraryState({ title: '没有匹配的公共资源', body: '可以在分镜页面把单镜头资源提升为公共资产，或先从外部导入素材。' });
    return;
  }
  dom.libraryState.hidden = true;
  if (!state.selectedLibraryAssetKey || !visibleAssets.some((asset) => asset.key === state.selectedLibraryAssetKey)) {
    state.selectedLibraryAssetKey = visibleAssets[0]?.key || null;
  }
  for (const cat of filtered) {
    const section = document.createElement('section');
    section.className = 'library-section';
    const heading = document.createElement('h3');
    heading.textContent = categoryLabel(cat);
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${cat.items.length} 项`;
    heading.appendChild(count);
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'library-grid';
    for (const item of cat.items) {
      grid.appendChild(buildLibraryItem(cat, item));
    }
    section.appendChild(grid);
    dom.libraryBody.appendChild(section);
  }
  renderLibraryInspector(getSelectedLibraryAsset(filtered));
}

function renderLibraryTabs(categories) {
  dom.libraryTabs.replaceChildren();
  const counts = new Map(categories.map((cat) => [categoryKey(cat), cat.items?.length || 0]));
  for (const [key, label] of libraryCategoryLabels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'library-tab';
    if (key === state.activeLibraryCategory) button.classList.add('is-active');
    button.textContent = key === 'all' ? label : `${label} ${counts.get(key) || 0}`;
    button.addEventListener('click', () => {
      state.activeLibraryCategory = key;
      renderLibrary(state.libraryCategories);
    });
    dom.libraryTabs.appendChild(button);
  }
}

function filterLibraryCategories(categories) {
  const query = state.libraryQuery;
  return categories
    .filter((cat) => state.activeLibraryCategory === 'all' || categoryKey(cat) === state.activeLibraryCategory)
    .map((cat) => ({
      ...cat,
      items: (cat.items || []).filter((item) => matchesLibraryQuery(item, query))
    }))
    .filter((cat) => cat.items.length);
}

function matchesLibraryQuery(item, query) {
  if (!query) return true;
  const haystack = [
    item.title,
    item.path,
    item.kind,
    item.version,
    ...(Array.isArray(item.tags) ? item.tags : []),
    item.notes,
    item.description,
    item.prompt,
    item.usageRole,
    item.sourcePath,
    item.shotNo,
    ...(Array.isArray(item.referenceAssets) ? item.referenceAssets : []),
    ...(Array.isArray(item.linkedShots) ? item.linkedShots : [])
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

function categoryLabel(cat) {
  return libraryCategoryLabels.find(([key]) => key === categoryKey(cat))?.[1] || cat.label || categoryKey(cat);
}

function categoryKey(cat) {
  return cat.key || cat.category || 'uncategorized';
}

function buildDocumentLibraryCategories(doc) {
  const assets = Array.isArray(doc?.publicAssets) ? doc.publicAssets : [];
  const byCategory = new Map();
  for (const asset of assets) {
    const key = asset.category || 'props';
    if (!byCategory.has(key)) {
      byCategory.set(key, { key, category: key, label: categoryLabel({ key }), kind: 'record', items: [] });
    }
    byCategory.get(key).items.push({
      id: asset.id,
      title: asset.title,
      kind: asset.kind || '资产候选',
      status: asset.status,
      version: asset.required ? '必需' : '可选',
      notes: asset.notes,
      source: asset.source,
      sourcePath: asset.sourcePath,
      // 公共资产记录可能已经绑定到项目内真实文件；保留 path 让记录本身就能渲染预览，避免再依赖目录扫描卡片。
      path: asset.sourcePath || asset.path || '',
      required: Boolean(asset.required),
      tags: Array.isArray(asset.tags) ? asset.tags : [],
      linkedShots: Array.isArray(asset.linkedShots) ? asset.linkedShots : [],
      referenceAssets: Array.isArray(asset.referenceAssets) ? asset.referenceAssets : [],
      prompt: asset.prompt || '',
      usageRole: asset.usageRole,
      description: asset.description || asset.notes,
      // 音频资产的台词和内置音色属于生成合同，不能在目录扫描与文档记录合并时丢失。
      metadata: asset.metadata && typeof asset.metadata === 'object' ? asset.metadata : {},
      spokenText: asset.spokenText || asset.metadata?.spokenText || '',
      voiceName: asset.voiceName || asset.metadata?.voiceName || '',
      outputTarget: asset.outputTarget || asset.metadata?.outputTarget || '',
      duration: asset.duration || asset.metadata?.duration || null
    });
  }
  return [...byCategory.values()];
}

function mergeLibraryCategories(primary, secondary) {
  const byCategory = new Map();
  for (const cat of [...primary, ...secondary]) {
    const key = categoryKey(cat);
    if (!byCategory.has(key)) {
      byCategory.set(key, { ...cat, key, category: key, items: dedupeLibraryItems(cat.items || []) });
      continue;
    }
    const current = byCategory.get(key);
    current.items = dedupeLibraryItems([...current.items, ...(cat.items || [])]);
    if (current.kind === 'record' && cat.kind !== 'record') current.kind = cat.kind;
  }
  return [...byCategory.values()];
}

function buildLibraryItem(cat, item) {
  const asset = normalizeLibraryAsset(cat, item);
  const mediaKind = item.kind || cat.kind;
  const card = document.createElement('article');
  card.className = 'library-item';
  card.role = 'button';
  card.tabIndex = 0;
  card.dataset.assetKey = asset.key;
  card.classList.toggle('is-active', asset.key === state.selectedLibraryAssetKey);
  card.addEventListener('click', () => selectLibraryAsset(asset.key));
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectLibraryAsset(asset.key);
  });

  const media = document.createElement('div');
  media.className = 'library-item__media';
  if (mediaKind === 'image' && item.path) {
    const img = document.createElement('img');
    img.src = assetUrl(projectPath, item.path);
    img.alt = item.title;
    img.loading = 'lazy';
    img.addEventListener('click', (event) => {
      event.stopPropagation();
      openLibraryImagePreview(asset);
    });
    media.classList.add('is-previewable');
    media.appendChild(img);
    media.appendChild(buildLibraryPreviewButton(asset));
  } else if (mediaKind === 'audio' && item.path) {
    media.appendChild(buildAudioArtwork());
    // 音频卡片使用业务化声纹封面承载控件，避免公共资产库里出现看不出用途的通用占位块。
    const audio = document.createElement('audio');
    audio.src = assetUrl(projectPath, item.path);
    audio.controls = true;
    audio.preload = 'metadata';
    audio.setAttribute('aria-label', item.title);
    media.appendChild(registerLibraryAudio(audio));
  } else {
    const fb = document.createElement('div');
    fb.className = 'library-item__candidate';
    const status = document.createElement('span');
    status.textContent = publicAssetStatusLabel(item.status);
    fb.appendChild(status);
    const note = document.createElement('small');
    note.textContent = item.notes || '等待生成或手动上传素材';
    fb.appendChild(note);
    media.appendChild(fb);
  }
  card.appendChild(media);

  const title = document.createElement('p');
  title.className = 'library-item__title';
  title.textContent = item.title;
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'library-item__meta';
  const left = document.createElement('span');
  left.textContent = item.version || '';
  const right = document.createElement('span');
  right.textContent = item.kind || '';
  meta.appendChild(left);
  meta.appendChild(right);
  card.appendChild(meta);

  return card;
}

function dedupeLibraryItems(items) {
  const seen = new Map();
  const deduped = [];
  for (const item of items || []) {
    // 文档资产记录和目录扫描资产可能只差路径大小写；按规范化身份合并，避免同一公共资源显示两张卡。
    const key = libraryItemDedupeKey(item);
    if (!key || !seen.has(key)) {
      seen.set(key, deduped.length);
      deduped.push(item);
      continue;
    }
    const existingIndex = seen.get(key);
    if (existingIndex >= 0 && isRicherLibraryItem(item, deduped[existingIndex])) deduped[existingIndex] = item;
  }
  return deduped;
}

function libraryItemDedupeKey(item) {
  const pathKey = normalizeLibraryIdentity(item?.sourcePath || item?.path);
  if (pathKey) return `path:${pathKey}`;
  const idKey = normalizeLibraryIdentity(item?.id);
  if (idKey) return `id:${idKey}`;
  const titleKey = normalizeLibraryIdentity(item?.title);
  return titleKey ? `title:${titleKey}` : '';
}

function normalizeLibraryIdentity(value) {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}

function isRicherLibraryItem(candidate, current) {
  return libraryItemRichnessScore(candidate) > libraryItemRichnessScore(current);
}

function libraryItemRichnessScore(item) {
  return [
    item?.prompt,
    item?.description || item?.notes,
    item?.status,
    item?.sourcePath,
    item?.path,
    Array.isArray(item?.referenceAssets) && item.referenceAssets.length ? item.referenceAssets.join(',') : '',
    Array.isArray(item?.tags) && item.tags.length ? item.tags.join(',') : ''
  ].filter(Boolean).length;
}

function buildAudioArtwork() {
  const artwork = document.createElement('div');
  artwork.className = 'audio-artwork';
  artwork.setAttribute('aria-hidden', 'true');

  const disc = document.createElement('div');
  disc.className = 'audio-artwork__disc';
  const core = document.createElement('span');
  disc.appendChild(core);
  artwork.appendChild(disc);

  const wave = document.createElement('div');
  wave.className = 'audio-artwork__wave';
  for (const height of [30, 58, 44, 76, 52, 88, 48, 70, 38]) {
    const bar = document.createElement('span');
    bar.style.setProperty('--h', `${height}%`);
    wave.appendChild(bar);
  }
  artwork.appendChild(wave);

  const label = document.createElement('span');
  label.className = 'audio-artwork__label';
  label.textContent = '音频参考';
  artwork.appendChild(label);

  return artwork;
}

function buildLibraryPreviewButton(asset) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'library-preview-button';
  button.textContent = '预览';
  button.setAttribute('aria-label', `预览 ${asset.title}`);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    openLibraryImagePreview(asset);
  });
  return button;
}

function selectLibraryAsset(key) {
  if (state.selectedLibraryAssetKey !== key) state.pendingDeleteAssetKey = null;
  state.selectedLibraryAssetKey = key;
  renderLibrary(state.libraryCategories);
}

function flattenLibraryAssets(categories) {
  return categories.flatMap((cat) => (cat.items || []).map((item) => normalizeLibraryAsset(cat, item)));
}

function getSelectedLibraryAsset(categories = state.libraryCategories) {
  return flattenLibraryAssets(categories).find((asset) => asset.key === state.selectedLibraryAssetKey) || null;
}

function normalizePublicAssetStatus(status, hasPath) {
  const normalized = String(status || '').trim();
  // 音色 QC 会保留更具体的持久化状态；公共资产表单统一折叠为可编辑的“已确认”。
  if (normalized === 'approved_by_user_audio_qc' || normalized === 'approved_by_user_qc') return 'approved';
  if (normalized === 'available' || normalized === 'ready' || normalized === 'generated') return 'active';
  if (['pending', 'active', 'missing', 'approved'].includes(normalized)) return normalized;
  return hasPath ? 'active' : 'pending';
}

function normalizeLibraryAsset(cat, item) {
  const category = categoryKey(cat);
  const id = item.id || item.path || `${category}:${item.title || 'asset'}`;
  return {
    key: `${category}:${id}`,
    id,
    title: item.title || '未命名资产',
    category,
    status: normalizePublicAssetStatus(item.status, Boolean(item.path)),
    required: Boolean(item.required) || item.version === '必需',
    description: item.description || item.notes || '',
    prompt: item.prompt || '',
    referenceAssets: Array.isArray(item.referenceAssets) ? item.referenceAssets : [],
    tags: Array.isArray(item.tags) ? item.tags : [],
    linkedShots: Array.isArray(item.linkedShots) ? item.linkedShots : (item.shotNo ? [item.shotNo] : []),
    usageRole: item.usageRole || '',
    source: item.source || (item.path ? '手动上传' : '待生成'),
    sourcePath: item.sourcePath || item.path || '',
    kind: item.kind || cat.kind || 'asset',
    path: item.path || '',
    metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
    spokenText: item.spokenText || item.metadata?.spokenText || '',
    voiceName: item.voiceName || item.metadata?.voiceName || '',
    outputTarget: item.outputTarget || item.metadata?.outputTarget || '',
    duration: item.duration || item.metadata?.duration || null
  };
}

function renderLibraryInspector(asset) {
  if (!asset) {
    setLibraryFormDisabled(true);
    dom.libraryInspectorPreview.replaceChildren(document.createTextNode('选择一个公共资产'));
    dom.libraryInspectorTitle.textContent = '资产详情';
    dom.libraryInspectorMeta.textContent = '点击左侧资产后，可在这里编辑名称、分类、状态和用途。';
    dom.assetDetailState.textContent = '未选择资产';
    dom.saveAssetDetailButton.disabled = true;
    updateGenerateAssetAudioButton(null);
    updateDeleteAssetButton(null);
    return;
  }
  setLibraryFormDisabled(false);
  dom.libraryInspectorPreview.replaceChildren(buildLibraryPreview(asset));
  dom.libraryInspectorTitle.textContent = asset.title;
  dom.libraryInspectorMeta.textContent = `${categoryLabel({ key: asset.category })} · ${publicAssetStatusLabel(asset.status)}`;
  dom.assetNameInput.value = asset.title;
  dom.assetCategorySelect.value = asset.category;
  dom.assetStatusSelect.value = asset.status;
  dom.assetRequiredCheckbox.checked = asset.required;
  dom.assetDescriptionInput.value = asset.description;
  dom.assetPromptInput.value = asset.prompt;
  dom.assetReferenceAssetsInput.value = asset.referenceAssets.join(', ');
  dom.assetTagsInput.value = asset.tags.join(', ');
  dom.assetLinkedShotsInput.value = asset.linkedShots.join(', ');
  dom.assetUsageInput.value = asset.usageRole;
  dom.assetSourceInput.value = asset.sourcePath || asset.source;
  dom.assetDetailState.textContent = asset.required ? '必需资产' : '可选资产';
  dom.saveAssetDetailButton.disabled = false;
  updateGenerateAssetAudioButton(asset);
  updateDeleteAssetButton(asset);
}

function buildLibraryPreview(asset) {
  if (asset.path && asset.kind === 'image') {
    const img = document.createElement('img');
    img.src = assetUrl(projectPath, asset.path);
    img.alt = asset.title;
    // 右侧详情图本身就是用户正在检查的主预览，允许直接点击打开大图，减少在小图和详情栏之间来回找入口。
    img.className = 'library-preview-image';
    img.setAttribute('role', 'button');
    img.tabIndex = 0;
    img.setAttribute('aria-label', `预览 ${asset.title}`);
    img.addEventListener('click', () => openLibraryImagePreview(asset));
    img.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openLibraryImagePreview(asset);
    });
    return img;
  }
  if (asset.path && asset.kind === 'video') {
    const video = document.createElement('video');
    video.src = assetUrl(projectPath, asset.path);
    video.controls = true;
    video.preload = 'metadata';
    return video;
  }
  if (asset.path && asset.kind === 'audio') {
    const preview = buildAudioArtwork();
    preview.classList.add('audio-artwork--preview');
    const audio = document.createElement('audio');
    audio.src = assetUrl(projectPath, asset.path);
    audio.controls = true;
    audio.preload = 'metadata';
    preview.appendChild(registerLibraryAudio(audio));
    return preview;
  }
  const placeholder = document.createElement('span');
  placeholder.textContent = publicAssetStatusLabel(asset.status);
  return placeholder;
}

function openLibraryImagePreview(asset) {
  const relativePath = asset?.path || asset?.sourcePath;
  if (!relativePath || asset?.kind !== 'image') return;
  closeLibraryImagePreview();
  pauseActiveLibraryAudio();

  // 图片预览只创建临时浮层，不写回资产数据；关闭时会移除键盘监听，避免页面长期累积事件。
  const overlay = document.createElement('div');
  overlay.className = 'library-lightbox';
  overlay.role = 'dialog';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `预览 ${asset.title}`);

  const panel = document.createElement('div');
  panel.className = 'library-lightbox__panel';
  overlay.appendChild(panel);

  const header = document.createElement('div');
  header.className = 'library-lightbox__header';
  const title = document.createElement('strong');
  title.textContent = asset.title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'library-lightbox__close';
  close.textContent = '关闭';
  close.addEventListener('click', closeLibraryImagePreview);
  header.append(title, close);
  panel.appendChild(header);

  const img = document.createElement('img');
  img.className = 'library-lightbox__image';
  img.src = assetUrl(projectPath, relativePath);
  img.alt = asset.title;
  panel.appendChild(img);

  const meta = document.createElement('p');
  meta.className = 'library-lightbox__meta';
  meta.textContent = `${categoryLabel({ key: asset.category })} · ${publicAssetStatusLabel(asset.status)}`;
  panel.appendChild(meta);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') closeLibraryImagePreview();
  };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeLibraryImagePreview();
  });
  document.addEventListener('keydown', onKeyDown);
  overlay.cleanup = () => document.removeEventListener('keydown', onKeyDown);

  activeLibraryImagePreview = overlay;
  document.body.appendChild(overlay);
  close.focus();
}

function closeLibraryImagePreview() {
  if (!activeLibraryImagePreview) return;
  activeLibraryImagePreview.cleanup?.();
  activeLibraryImagePreview.remove();
  activeLibraryImagePreview = null;
}

function setLibraryFormDisabled(disabled) {
  for (const input of [
    dom.assetNameInput,
    dom.assetCategorySelect,
    dom.assetStatusSelect,
    dom.assetRequiredCheckbox,
    dom.assetDescriptionInput,
    dom.assetPromptInput,
    dom.assetReferenceAssetsInput,
    dom.assetTagsInput,
    dom.assetLinkedShotsInput,
    dom.assetUsageInput,
    dom.assetSourceInput
  ]) {
    input.disabled = disabled;
    if (disabled && input.type !== 'checkbox') input.value = '';
    if (disabled && input.type === 'checkbox') input.checked = false;
  }
}

async function saveSelectedLibraryAsset() {
  const doc = getActiveDoc();
  const selected = getSelectedLibraryAsset();
  if (!doc || !selected) return;
  const now = new Date().toISOString();
  const title = dom.assetNameInput.value.trim() || selected.title;
  const category = dom.assetCategorySelect.value || selected.category;
  const record = {
    id: selected.id.startsWith('public:') ? selected.id : `public:${slugify(`${category}-${title || selected.id}`)}`,
    title,
    category,
    status: dom.assetStatusSelect.value || 'pending',
    required: dom.assetRequiredCheckbox.checked,
    description: dom.assetDescriptionInput.value.trim(),
    notes: dom.assetDescriptionInput.value.trim(),
    prompt: dom.assetPromptInput.value.trim(),
    referenceAssets: normalizeAssetReferenceTokens(dom.assetReferenceAssetsInput.value),
    tags: splitList(dom.assetTagsInput.value),
    linkedShots: splitList(dom.assetLinkedShotsInput.value),
    usageRole: dom.assetUsageInput.value.trim(),
    source: dom.assetSourceInput.value.trim() || selected.source,
    sourcePath: selected.path || selected.sourcePath,
    kind: selected.kind,
    // 表单只编辑通用字段；音色名、试听台词和输出目标必须原样保留给即梦自动化。
    metadata: selected.metadata,
    spokenText: selected.spokenText,
    voiceName: selected.voiceName,
    outputTarget: selected.outputTarget,
    duration: selected.duration,
    updatedAt: now
  };
  // 公共资产详情保存只更新项目公共资产记录；分镜仍通过引用关系读取同一资产，避免两边生成重复业务身份。
  // 引用资源先保存为可编辑名称列表，等用户绑定/上传真实素材后再由分镜引用关系承接，不提前伪造图谱边。
  const others = (Array.isArray(doc.publicAssets) ? doc.publicAssets : []).filter((asset) => {
    return asset.id !== record.id && asset.id !== selected.id;
  });
  doc.publicAssets = [...others, record];
  dom.saveAssetDetailButton.disabled = true;
  dom.assetDetailState.textContent = '保存中…';
  try {
    await persistActiveDoc(doc);
    state.selectedLibraryAssetKey = `${category}:${record.id}`;
    state.libraryLoaded = false;
    await loadLibrary();
    dom.assetDetailState.textContent = `已保存 · ${formatTime(now)}`;
  } catch (error) {
    dom.assetDetailState.textContent = `保存失败：${error.message}`;
    dom.saveAssetDetailButton.disabled = false;
  }
}

function updateGenerateAssetAudioButton(asset) {
  const isVoiceAsset = asset?.category === 'voices' && asset?.kind === 'audio';
  dom.generateAssetAudioButton.hidden = !isVoiceAsset;
  dom.generateAssetAudioButton.disabled = !isVoiceAsset;
  dom.generateAssetAudioButton.textContent = asset?.path ? '重新生成音色' : '生成角色音色';
}

async function generateSelectedLibraryAudio() {
  const selected = getSelectedLibraryAsset();
  const episode = getActiveEpisode();
  if (!selected || !episode || selected.category !== 'voices' || selected.kind !== 'audio') return;

  dom.generateAssetAudioButton.disabled = true;
  dom.assetDetailState.textContent = '正在打开 Drama Creator 托管的即梦配音窗口…';
  try {
    const response = await fetch('/api/library/audio-generation/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath,
        episodePath: episode.path,
        assetId: selected.id,
        launchBrowser: true
      })
    });
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);

    const automation = payload?.automation || {};
    const page = automation.pageAutomation || {};
    if (automation.status === 'pre_submit_confirmation') {
      const credit = page.creditCost ? `，页面显示 ${page.creditCost} 积分` : '';
      dom.assetDetailState.textContent = `已填入台词并选择「${page.selectedVoice || selected.voiceName}」${credit}；等待确认生成。`;
    } else {
      dom.assetDetailState.textContent = automation.nextAction || '托管即梦窗口已打开，请按页面状态继续。';
    }
    state.libraryLoaded = false;
    await loadLibrary();
  } catch (error) {
    dom.assetDetailState.textContent = `音色生成准备失败：${error.message}`;
  } finally {
    updateGenerateAssetAudioButton(getSelectedLibraryAsset());
  }
}

function registerLibraryAudio(audio) {
  audio.dataset.libraryAudio = 'true';
  // 原生音频控件位于可点击资产卡片内，必须拦截事件，避免点击播放时触发卡片重渲染并留下游离播放实例。
  for (const eventName of ['pointerdown', 'click', 'dblclick', 'keydown']) {
    audio.addEventListener(eventName, (event) => event.stopPropagation());
  }
  audio.addEventListener('play', () => {
    pauseOtherLibraryAudio(audio);
    activeLibraryAudio = audio;
  });
  audio.addEventListener('pause', () => {
    if (activeLibraryAudio === audio) activeLibraryAudio = null;
  });
  audio.addEventListener('ended', () => {
    if (activeLibraryAudio === audio) activeLibraryAudio = null;
  });
  return audio;
}

function pauseOtherLibraryAudio(currentAudio) {
  for (const audio of document.querySelectorAll('audio[data-library-audio="true"]')) {
    if (audio !== currentAudio) audio.pause();
  }
  if (activeLibraryAudio && activeLibraryAudio !== currentAudio) activeLibraryAudio.pause();
}

function pauseActiveLibraryAudio() {
  if (activeLibraryAudio && !activeLibraryAudio.paused) activeLibraryAudio.pause();
  activeLibraryAudio = null;
}

function updateDeleteAssetButton(asset) {
  const pending = asset && state.pendingDeleteAssetKey === asset.key;
  dom.deleteAssetButton.disabled = !asset;
  dom.deleteAssetButton.textContent = pending ? '确认移入回收站' : '移入回收站';
  dom.deleteAssetButton.classList.toggle('is-confirming', Boolean(pending));
}

async function deleteSelectedLibraryAsset() {
  const selected = getSelectedLibraryAsset();
  const episode = getActiveEpisode();
  if (!selected || !episode) return;
  if (state.pendingDeleteAssetKey !== selected.key) {
    state.pendingDeleteAssetKey = selected.key;
    updateDeleteAssetButton(selected);
    dom.assetDetailState.textContent = '再次点击确认移入回收站';
    return;
  }

  dom.deleteAssetButton.disabled = true;
  dom.assetDetailState.textContent = '正在移入回收站…';
  try {
    const response = await fetch('/api/library/item', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath,
        episodePath: episode.path,
        assetId: selected.id,
        title: selected.title,
        category: selected.category,
        path: selected.path || selected.sourcePath
      })
    });
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.pendingDeleteAssetKey = null;
    state.selectedLibraryAssetKey = null;
    state.libraryLoaded = false;
    await loadLibrary();
    dom.assetDetailState.textContent = payload?.trashedFile ? '已移入回收站' : '已移除资产记录';
  } catch (error) {
    state.pendingDeleteAssetKey = null;
    updateDeleteAssetButton(selected);
    dom.assetDetailState.textContent = `删除失败：${error.message}`;
  }
}

function splitList(value) {
  return String(value || '').split(/[，,]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeAssetReferenceTokens(value) {
  return String(value || '').split(/[，,;；\n]/u).map((item) => item.trim()).filter(Boolean);
}

function slugify(value) {
  return String(value || 'asset')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'asset';
}

function publicAssetStatusLabel(status) {
  const labels = {
    pending: '待生成',
    active: '已可用',
    missing: '缺失',
    approved: '已确认'
  };
  return labels[status] || '待生成';
}

function renderShots() {
  const doc = getActiveDoc();
  if (!doc) return;
  const ep = getActiveEpisode();
  const prerequisite = getShotVideoPrerequisite(doc);
  if (prerequisite) {
    dom.shotsCount.textContent = '0 个分镜';
    showShotsState({
      title: prerequisite.title,
      body: prerequisite.body,
      actionLabel: '返回剧本与分镜',
      onAction: returnToScriptStepFromShots
    });
    return;
  }
  const shots = collectShots(doc);
  if (!shots.length) {
    showShotsState({
      title: '还没有分镜',
      body: '需要先回到「剧本与分镜」完成剧本确认和分镜拆分，之后再进入分镜视频生产。'
    });
    dom.shotsCount.textContent = '0 个分镜';
    return;
  }

  const filteredShots = shots.filter(matchesShotQueryAndStatus);
  dom.shotsCount.textContent = `显示 ${filteredShots.length} / ${shots.length} 个分镜`;
  if (!filteredShots.length) {
    showShotsState({
      title: '没有匹配的分镜',
      body: '可以换一个关键词或切回全部状态。'
    });
    return;
  }
  dom.shotsState.hidden = true;
  dom.shotsGrid.replaceChildren();
  for (const shot of filteredShots) {
    dom.shotsGrid.appendChild(buildShotCard(shot, ep));
  }
}

function matchesShotQueryAndStatus(shot) {
  const query = state.shotsQuery;
  const matchesQuery = !query || [shot.shotNo, shot.title, shot.summary].filter(Boolean).join(' ').toLowerCase().includes(query);
  const filter = state.shotsStatusFilter;
  const matchesStatus = filter === 'all' || shot.statusKey === filter;
  return matchesQuery && matchesStatus;
}

function getShotVideoPrerequisite(doc) {
  const draftText = String(doc?.scriptDraft?.text || '').trim();
  const shots = Array.isArray(doc?.shots) ? doc.shots : [];
  if (!draftText) {
    return {
      title: '还不能生成分镜视频',
      body: '当前分集还没有分镜剧本。请先回到「剧本与分镜」填写或生成分镜剧本。'
    };
  }
  if (!isScriptDraftConfirmed(doc) && !shots.length) {
    return {
      title: '分镜剧本尚未保存',
      body: '请回到「剧本与分镜」确认并保存当前分镜剧本。'
    };
  }
  if (!shots.length) {
    return {
      title: '还没有可用分镜',
      body: '当前分镜剧本文本已存在，但还没有保存为逐镜分镜。请先回到「剧本与分镜」保存分镜。'
    };
  }
  return null;
}

function isScriptDraftConfirmed(doc) {
  const draft = doc?.scriptDraft || {};
  // 兼容后续显式确认字段，也兼容旧项目：已有分镜说明该剧本已经被用于拆分。
  return draft.status === 'confirmed' || Boolean(draft.confirmedAt) || Boolean(doc?.shots?.length);
}

function returnToScriptStepFromShots() {
  switchStep('script_shots');
  // 回到 Step 1 后把焦点放到下一步最可能操作的位置，减少用户重新寻找入口的成本。
  requestAnimationFrame(() => {
    const doc = getActiveDoc();
    const target = doc?.scriptDraft?.text ? dom.splitStoryboardButton : dom.storySourceEditor;
    target?.focus();
  });
}

function buildShotCard(shot, ep) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'shot-card';
  card.dataset.shotNo = shot.shotNo;
  card.addEventListener('click', () => {
    location.href = `/shot.html?path=${encodeURIComponent(ep.path)}&shot=${encodeURIComponent(shot.shotNo)}`;
  });

  const top = document.createElement('div');
  top.className = 'shot-card__top';
  const shotno = document.createElement('span');
  shotno.className = 'shot-card__shotno';
  shotno.textContent = `镜头 ${shot.shotNo}`;
  top.appendChild(shotno);
  const qc = document.createElement('span');
  qc.className = 'shot-card__qc';
  qc.dataset.status = shot.statusKey || shot.qcStatus || 'none';
  qc.textContent = shot.statusLabel || QC_LABEL[shot.qcStatus] || shot.executionStatus || '未生成';
  top.appendChild(qc);
  card.appendChild(top);

  const media = document.createElement('div');
  media.className = 'shot-card__media';
  if (shot.thumbnailPath) {
    const img = document.createElement('img');
    img.src = assetUrl(ep.path, shot.thumbnailPath);
    img.alt = shot.title || shot.shotNo;
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      media.replaceChildren();
      const fb = document.createElement('div');
      fb.className = 'shot-card__media-fallback';
      fb.textContent = '关键帧加载失败';
      media.appendChild(fb);
    });
    media.appendChild(img);
  } else {
    const fb = document.createElement('div');
    fb.className = 'shot-card__media-fallback';
    fb.textContent = '尚未生成关键帧';
    media.appendChild(fb);
  }
  card.appendChild(media);

  const title = document.createElement('p');
  title.className = 'shot-card__title';
  title.textContent = shot.title || shot.summary || `镜头 ${shot.shotNo}`;
  card.appendChild(title);

  const footer = document.createElement('div');
  footer.className = 'shot-card__footer';
  for (const chipText of shot.chips) {
    const chip = document.createElement('span');
    chip.className = 'shot-card__chip';
    chip.textContent = chipText;
    footer.appendChild(chip);
  }
  card.appendChild(footer);
  return card;
}

function collectShots(doc) {
  const shots = Array.isArray(doc.shots) ? doc.shots : [];
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  const edges = Array.isArray(doc.edges) ? doc.edges : [];

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const usesByFrom = new Map();
  for (const edge of edges) {
    if (edge.type !== 'uses_reference') continue;
    if (!usesByFrom.has(edge.from)) usesByFrom.set(edge.from, []);
    usesByFrom.get(edge.from).push(edge);
  }

  return shots.map((shot) => {
    const shotNo = shot.shotNo || (shot.id || '').replace(/^shot:/, '');
    const promptNode = nodes.find((node) => node.type === 'video_prompt' && shotIdOf(node) === shot.id);
    const outputNode = nodes.find((node) => node.type === 'video_output' && shotIdOf(node) === shot.id);
    const task = tasks.find((item) => item.shotId === shot.id && item.type === 'video');
    const thumbnailPath = findThumbnailPath({ promptNode, usesByFrom, nodeById });
    const qcStatus = findQcStatus(nodes, edges, outputNode?.id);
    const statusKey = shotVideoStatusKey({ task, outputNode, qcStatus });
    const statusLabel = shotVideoStatusLabel(statusKey, task?.status);

    const chips = [];
    if (task?.fields?.ratio) chips.push(task.fields.ratio);
    if (task?.fields?.duration) chips.push(`${task.fields.duration}s`);
    if (outputNode?.metadata?.version) chips.push(outputNode.metadata.version);
    chips.push(outputNode ? '已回填' : statusLabel);

    return {
      shotNo,
      title: shot.title || shot.summary || '',
      summary: shot.summary || '',
      thumbnailPath,
      qcStatus,
      statusKey,
      statusLabel,
      executionStatus: taskStatusLabel(task?.status),
      chips,
      promptId: promptNode?.id,
      outputId: outputNode?.id
    };
  });
}

function shotVideoStatusKey({ task, outputNode, qcStatus }) {
  if (qcStatus === 'approved') return 'approved';
  if (qcStatus === 'rerun_needed') return 'rerun_needed';
  if (qcStatus === 'reviewing' || outputNode) return 'reviewing';
  const status = task?.status;
  if (status === 'ready_to_feed' || status === 'prompting') return 'feed_ready';
  if (SHOT_PROCESSING_TASK_STATUSES.has(status)) return 'processing';
  return 'not_started';
}

function shotVideoStatusLabel(statusKey, taskStatus) {
  const labels = {
    not_started: '未生成',
    feed_ready: '准备投喂',
    processing: '处理中',
    reviewing: '待质检',
    rerun_needed: '需重跑',
    approved: '已通过'
  };
  return labels[statusKey] || taskStatusLabel(taskStatus);
}

function findThumbnailPath({ promptNode, usesByFrom, nodeById }) {
  if (!promptNode) return null;
  const refs = usesByFrom.get(promptNode.id) || [];
  for (const edge of refs) {
    const target = nodeById.get(edge.to);
    if (isShotPreviewImage(target)) return target.path;
  }
  return null;
}

function isShotPreviewImage(target) {
  if (!target || target.type !== 'image_asset' || !target.path) return false;
  const role = String(target.metadata?.role || '');
  const path = String(target.path);
  // 分镜视频页的封面必须代表该镜头本身，不能回退到角色/场景/道具公共资产。
  // 否则清理旧视频尾帧后，公共角色图会被误显示成一排“分镜关键帧”。
  return /keyframe|storyboard_reference_frame|storyboard_keyframe_reference|post_title_card_reference/.test(role)
    || /(?:^|\/)(?:keyframes|storyboard\/longform)\//.test(path);
}

function taskStatusLabel(status) {
  const labels = {
    draft: '未生成',
    prompting: '准备提示词',
    ready_to_feed: '准备投喂',
    generating: '处理中',
    submitted: '处理中',
    waiting_download: '处理中',
    waiting_backfill: '处理中',
    reviewing: '待质检',
    approved: '已通过',
    rerun_needed: '需重跑',
    blocked: '被阻塞'
  };
  return labels[status] || '未生成';
}

function renderExportStep() {
  const doc = getActiveDoc();
  if (!doc) return;
  const summary = getExportReadiness(doc);
  renderExportCheck(summary);
  renderExportPreview(summary);
  renderExportOutput(summary);
  loadExistingExportPreview(summary);
}

function getExportReadiness(doc = getActiveDoc()) {
  const shots = Array.isArray(doc?.shots) ? doc.shots : [];
  const shotCards = collectShots(doc);
  const cardsByShotNo = new Map(shotCards.map((shot) => [shot.shotNo, shot]));
  const entries = shots.map((shot, index) => {
    const shotNo = shot.shotNo || String(shot.id || '').replace(/^shot:/, '');
    const outputNode = selectExportVideoNodeLocal(doc, shot);
    const previewNode = selectPreviewVideoNodeLocal(doc, shot);
    const qcStatus = outputNode ? (shot.status || outputNode.status || findQcStatus(doc.nodes || [], doc.edges || [], outputNode.id)) : 'missing';
    return {
      index,
      shot,
      shotNo,
      title: shot.title || shot.summary || `镜头 ${shotNo}`,
      outputNode,
      previewNode,
      version: outputNode?.metadata?.version || outputNode?.metadata?.versionRole || '当前版本',
      qcStatus,
      statusKey: outputNode ? exportShotStatusKey(qcStatus) : 'missing',
      statusLabel: outputNode ? exportShotStatusLabel(qcStatus) : '缺失视频',
      subtitle: extractExportSubtitle(doc, shot),
      thumbnailPath: cardsByShotNo.get(shotNo)?.thumbnailPath || null
    };
  });
  const missing = entries.filter((entry) => entry.statusKey === 'missing');
  const rerun = entries.filter((entry) => entry.statusKey === 'rerun');
  const reviewing = entries.filter((entry) => entry.statusKey === 'reviewing');
  const approved = entries.filter((entry) => entry.statusKey === 'approved');
  const previewAvailable = entries.filter((entry) => entry.previewNode);
  const preferredAssemblyPreview = findPreferredAssemblyPreviewLocal(doc);
  const ready = entries.length > 0 && missing.length === 0;
  const finalReady = ready && rerun.length === 0 && reviewing.length === 0 && approved.length === entries.length;
  return {
    shots,
    entries,
    missing,
    rerun,
    reviewing,
    approved,
    previewAvailable,
    preferredAssemblyPreview,
    ready,
    finalReady,
    exportStatus: !ready ? 'blocked' : finalReady ? 'final' : 'draft'
  };
}

async function exportEpisode() {
  const ep = getActiveEpisode();
  const summary = getExportReadiness();
  if (!ep || !summary.ready || state.exportJob.running) return;
  const controller = new AbortController();
  state.exportJob.running = true;
  state.exportJob.controller = controller;
  state.exportJob.result = null;
  state.exportJob.progress = 0;
  state.exportJob.message = '准备导出…';
  startExportProgress();
  renderExportStep();
  try {
    const response = await fetch('/api/export/episode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodePath: ep.path,
        exportStatus: summary.exportStatus,
        outputs: {
          original: dom.exportOriginalCheck?.checked !== false,
          subtitled: dom.exportSubtitleCheck?.checked !== false,
          srt: dom.exportSrtCheck?.checked !== false
        }
      }),
      signal: controller.signal
    });
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.exportJob.result = payload.export;
    state.exportJob.progress = 100;
    state.exportJob.message = '导出完成';
    dom.footerRight.textContent = '成片已导出';
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') {
      state.exportJob.message = '已取消导出，可以重新开始。';
      dom.footerRight.textContent = '导出已取消';
    } else {
      state.exportJob.message = `导出失败：${error.message}`;
      dom.footerRight.textContent = '导出失败';
    }
  } finally {
    stopExportProgress();
    state.exportJob.running = false;
    state.exportJob.controller = null;
    renderExportStep();
  }
}

async function generateExportPreview() {
  const ep = getActiveEpisode();
  const summary = getExportReadiness();
  if (!ep || state.exportPreviewJob.running || (!summary.previewAvailable.length && !summary.preferredAssemblyPreview)) return;
  const controller = new AbortController();
  state.exportPreviewJob.running = true;
  state.exportPreviewJob.controller = controller;
  state.exportPreviewJob.result = null;
  state.exportPreviewJob.message = summary.preferredAssemblyPreview ? '正在读取全片剪辑版…' : '正在拼接分镜视频…';
  renderExportStep();
  try {
    const response = await fetch('/api/export/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath: ep.path }),
      signal: controller.signal
    });
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.exportPreviewJob.result = payload.preview;
    state.exportPreviewJob.message = buildExportPreviewMessage(payload.preview);
    dom.footerRight.textContent = '分镜拼接预览已生成';
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') {
      state.exportPreviewJob.message = '已取消预览生成。';
    } else {
      state.exportPreviewJob.message = `预览生成失败：${error.message}`;
    }
    dom.footerRight.textContent = '预览未生成';
  } finally {
    state.exportPreviewJob.running = false;
    state.exportPreviewJob.controller = null;
    renderExportStep();
  }
}

async function loadExistingExportPreview(summary) {
  const ep = getActiveEpisode();
  if (!ep || state.activeStep !== 'export') return;
  if (state.exportPreviewJob.running || state.exportPreviewJob.loadingExisting || state.exportPreviewJob.result) return;
  if (!summary.previewAvailable.length && !summary.preferredAssemblyPreview) return;

  // 预览文件是可复用的用户成果；进入导出页时只读恢复播放器，避免刷新后看起来“预览失效”。
  const loadKey = `${ep.path}|${summary.previewAvailable.length}|${summary.entries.length}|${summary.preferredAssemblyPreview?.id || ''}`;
  if (state.exportPreviewJob.loadKey === loadKey) return;

  state.exportPreviewJob.loadingExisting = true;
  state.exportPreviewJob.loadKey = loadKey;
  try {
    const response = await fetch(`/api/export/preview?episodePath=${encodeURIComponent(ep.path)}`);
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    if (payload.preview && state.activeStep === 'export' && state.activeEpisodeId === ep.id) {
      state.exportPreviewJob.result = payload.preview;
      state.exportPreviewJob.message = buildExportPreviewMessage(payload.preview, { existing: true });
      renderExportStep();
    }
  } catch (error) {
    if (state.activeStep === 'export') {
      state.exportPreviewJob.message = `读取已有预览失败：${error.message}`;
      renderExportStep();
    }
  } finally {
    state.exportPreviewJob.loadingExisting = false;
  }
}

function cancelExport() {
  if (!state.exportJob.running || !state.exportJob.controller) return;
  state.exportJob.message = '正在取消导出…';
  state.exportJob.controller.abort();
  renderExportStep();
}

function renderExportCheck(summary) {
  dom.exportStatusBadge.dataset.status = summary.exportStatus;
  dom.exportStatusBadge.textContent = exportStatusText(summary);
  dom.exportReadiness.textContent = exportReadinessText(summary);
  dom.exportShotList.replaceChildren();
  for (const entry of summary.entries) {
    dom.exportShotList.appendChild(buildExportShotRow(entry));
  }
  dom.exportStatsLegend.replaceChildren(
    buildExportStat('通过', summary.approved.length, 'approved'),
    buildExportStat('待质检', summary.reviewing.length, 'reviewing'),
    buildExportStat('需重跑', summary.rerun.length, 'rerun'),
    buildExportStat('缺失视频', summary.missing.length, 'missing')
  );
}

function buildExportShotRow(entry) {
  const row = document.createElement('article');
  row.className = 'export-shot-row';
  row.dataset.status = entry.statusKey;

  const index = document.createElement('span');
  index.className = 'export-shot-row__index';
  index.textContent = String(entry.index + 1).padStart(2, '0');
  row.appendChild(index);

  const body = document.createElement('div');
  body.className = 'export-shot-row__body';
  const title = document.createElement('strong');
  title.textContent = entry.title;
  const meta = document.createElement('span');
  meta.textContent = entry.outputNode ? `${entry.shotNo} · ${entry.version}` : `${entry.shotNo} · 等待回填`;
  body.append(title, meta);
  row.appendChild(body);

  const status = document.createElement('span');
  status.className = 'export-shot-row__status';
  status.textContent = entry.statusLabel;
  row.appendChild(status);
  return row;
}

function buildExportStat(label, count, status) {
  const item = document.createElement('span');
  item.className = 'export-stat';
  item.dataset.status = status;
  item.textContent = `${label} ${count}`;
  return item;
}

function renderExportPreview(summary) {
  dom.exportPreviewMedia.replaceChildren();
  const previewResult = state.exportPreviewJob.result;
  if (previewResult?.previewAssetPath) {
    dom.exportPreviewMedia.appendChild(buildExportPreviewVideo(
      previewResult.previewAssetPath,
      '分镜拼接预览',
      { revision: previewResult.previewRevision }
    ));
  } else if (summary.previewAvailable.length === 1) {
    const entry = summary.previewAvailable[0];
    dom.exportPreviewMedia.appendChild(buildExportPreviewVideo(entry.previewNode.path, `${entry.shotNo} 已有视频预览`));
    const hint = document.createElement('p');
    hint.className = 'export-preview-inline-hint';
    hint.textContent = `${entry.shotNo} 已有视频可预览；生成分镜拼接预览后会得到正式的预览文件。`;
    dom.exportPreviewMedia.appendChild(hint);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'export-preview-placeholder';
    // 避免用任意分镜关键帧冒充视频预览；未生成拼接 MP4 时要明确告诉创作者下一步动作。
    placeholder.textContent = summary.previewAvailable.length
      ? `已有 ${summary.previewAvailable.length} 个视频片段，点击下方按钮生成可播放的分镜拼接预览。`
      : summary.entries.length
        ? '当前还没有可预览的视频；回填分镜视频后这里会显示播放器。'
        : '拆分并回填分镜视频后，这里会显示预览播放器。';
    dom.exportPreviewMedia.appendChild(placeholder);
  }
  renderExportPreviewAction(summary);
}

function buildExportPreviewVideo(assetPath, label, { revision } = {}) {
  const video = document.createElement('video');
  video.className = 'export-preview-video';
  video.controls = true;
  // 同名拼接预览会被覆盖；稳定的文件版本参数保证 WebView 立即请求新 MP4，而不是复用旧 Range 缓存。
  video.src = assetUrl(getActiveEpisode()?.path || projectPath, assetPath, { revision });
  video.setAttribute('aria-label', label);
  return video;
}

function renderExportPreviewAction(summary) {
  const running = state.exportPreviewJob.running;
  const loadingExisting = state.exportPreviewJob.loadingExisting;
  const hasPreview = Boolean(state.exportPreviewJob.result?.previewAssetPath);
  dom.exportPreviewStartButton.disabled = running || (!summary.previewAvailable.length && !summary.preferredAssemblyPreview);
  dom.exportPreviewStartButton.textContent = running
    ? '正在生成预览…'
    : hasPreview
      ? '重新生成分镜拼接预览'
      : '生成分镜拼接预览';
  dom.exportPreviewStatus.textContent = state.exportPreviewJob.message
    || (loadingExisting ? '正在检查是否有上次生成的片段预览…' : exportPreviewReadinessText(summary));
}

function renderExportOutput(summary) {
  const running = state.exportJob.running;
  const progress = Math.max(0, Math.min(100, state.exportJob.progress || 0));
  dom.exportFileNamePreview.value = buildExportFilePreview(summary);
  dom.exportStartButton.disabled = running || !summary.ready;
  dom.exportStartButton.textContent = running ? '导出中…' : `开始导出${summary.exportStatus === 'final' ? '正式版' : '草稿版'}（3 项）`;
  dom.exportCancelButton.hidden = !running;
  dom.exportProgress.hidden = !running && !state.exportJob.message;
  dom.exportProgressBar.style.width = `${progress}%`;
  dom.exportProgressText.textContent = state.exportJob.message || exportReadinessText(summary);
  renderExportResults(summary);
}

function renderExportResults(summary) {
  dom.exportResultList.replaceChildren();
  const result = state.exportJob.result;
  if (!result) {
    dom.exportResultSummary.textContent = summary.ready ? '等待导出' : '暂不可导出';
    return;
  }
  const items = [
    ['原片 MP4', result.originalPath],
    ['字幕版 MP4', result.subtitledPath],
    ['SRT 字幕', result.srtPath]
  ];
  let successCount = 0;
  for (const [label, path] of items) {
    const row = document.createElement('div');
    row.className = 'export-result-row';
    const name = document.createElement('strong');
    name.textContent = label;
    const file = document.createElement('span');
    file.textContent = path ? fileNameOf(path) : '未生成';
    row.append(name, file);
    row.dataset.ready = String(Boolean(path));
    if (path) successCount += 1;
    dom.exportResultList.appendChild(row);
  }
  for (const warning of result.warnings || []) {
    const row = document.createElement('div');
    row.className = 'export-result-row is-warning';
    row.textContent = warning.message || warning.code;
    dom.exportResultList.appendChild(row);
  }
  dom.exportResultSummary.textContent = `完成 ${successCount} / 3`;
}

function startExportProgress() {
  stopExportProgress();
  const startedAt = Date.now();
  state.exportJob.timer = window.setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const stages = [
      [0, 8, '准备分镜清单…'],
      [800, 28, '统一视频格式…'],
      [2200, 54, '合成原片…'],
      [4200, 74, '生成字幕文件…'],
      [6200, 88, '整理导出结果…']
    ];
    const stage = stages.reduce((current, item) => (elapsed >= item[0] ? item : current), stages[0]);
    state.exportJob.progress = Math.max(state.exportJob.progress, stage[1]);
    state.exportJob.message = stage[2];
    if (state.activeStep === 'export') renderExportStep();
  }, 500);
}

function stopExportProgress() {
  if (state.exportJob.timer) window.clearInterval(state.exportJob.timer);
  state.exportJob.timer = null;
}

function selectExportVideoNodeLocal(doc, shot) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  if (shot.videoVersions && Object.prototype.hasOwnProperty.call(shot.videoVersions, 'current')) {
    const current = shot.videoVersions.current
      ? nodes.find((node) => node.id === shot.videoVersions.current && node.type === 'video_output' && node.path)
      : null;
    if (current) return current;
    if (shot.videoVersions.candidate) return null;
    // Legacy imported projects may have an empty current slot while the old video_output is still the confirmed cut.
    return selectLegacyExportVideoNodeLocal(nodes, shot);
  }
  return selectLegacyExportVideoNodeLocal(nodes, shot);
}

function selectPreviewVideoNodeLocal(doc, shot) {
  const exportNode = selectExportVideoNodeLocal(doc, shot);
  if (exportNode) return exportNode;
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const outputs = nodes.filter((node) => node.type === 'video_output' && node.shotId === shot.id && node.path);
  if (!outputs.length) return null;
  const candidate = shot.videoVersions?.candidate
    ? outputs.find((node) => node.id === shot.videoVersions.candidate)
    : null;
  if (candidate) return candidate;
  // 仅用于导出页目检预览；正式导出仍由 selectExportVideoNodeLocal 限定当前版本。
  return outputs.find((node) => node.metadata?.versionRole === 'candidate')
    || outputs.find((node) => !['unselected', 'rejected'].includes(node.metadata?.versionRole))
    || outputs[0];
}

function selectLegacyExportVideoNodeLocal(nodes, shot) {
  const outputs = nodes.filter((node) => node.type === 'video_output' && node.shotId === shot.id && node.path);
  return outputs.find((node) => node.metadata?.versionRole === 'current')
    || outputs.find((node) => !['candidate', 'unselected'].includes(node.metadata?.versionRole))
    || null;
}

function findPreferredAssemblyPreviewLocal(doc) {
  // 与服务端保持同一条选择规则：只有覆盖全片的人工剪辑版才优先显示，局部修复版不能遮住完整分镜预览。
  const shotNos = (Array.isArray(doc?.shots) ? doc.shots : []).map(shotNoOfLocal);
  return (doc?.nodes || [])
    .filter((node) => node.type === 'video_output' && node.path && node.metadata?.role === 'assembly_preview')
    .filter((node) => node.metadata?.exportPreferred === true || node.metadata?.previewRole === 'preferred_export_preview')
    .sort((a, b) => Number(b.metadata?.exportPriority || 0) - Number(a.metadata?.exportPriority || 0))
    .find((node) => assemblyCoversEveryShotLocal(node, shotNos)) || null;
}

function exportShotStatusKey(status) {
  if (status === 'approved') return 'approved';
  if (status === 'rerun_needed') return 'rerun';
  return 'reviewing';
}

function exportShotStatusLabel(status) {
  if (status === 'approved') return '通过';
  if (status === 'rerun_needed') return '需重跑';
  return '待质检';
}

function exportStatusText(summary) {
  if (!summary.entries.length) return '待准备';
  if (!summary.ready) return '不可导出';
  return summary.finalReady ? '可导出正式版' : '可导出草稿';
}

function exportReadinessText(summary) {
  if (!summary.entries.length) return '还没有分镜视频。完成分镜拆分并回填视频后，这里会开放导出。';
  if (summary.missing.length) return `仍有 ${summary.missing.length} 个分镜缺少视频，暂不能导出。`;
  if (summary.rerun.length) return `${summary.rerun.length} 个分镜标记为需重跑，可以导出草稿版用于预览。`;
  if (summary.reviewing.length) return `${summary.reviewing.length} 个分镜还未通过质检，可以导出草稿版。`;
  return '所有分镜视频已通过质检，可以导出正式版、字幕版和 SRT。';
}

function exportPreviewReadinessText(summary) {
  if (!summary.entries.length) return '还没有分镜，暂时无法生成分镜拼接预览。';
  if (summary.preferredAssemblyPreview) return '已选择覆盖全片的剪辑修复版，导出页会优先播放这版。';
  if (!summary.previewAvailable.length) return '暂无可拼接的视频；导入或设为候选/当前版本后可生成预览。';
  const missingCount = Math.max(0, summary.entries.length - summary.previewAvailable.length);
  if (missingCount) return `可先拼接 ${summary.previewAvailable.length} 个已有视频预览，${missingCount} 个缺失分镜不会进入预览。`;
  return '已有视频齐全，可以先生成分镜拼接预览，也可以继续正式导出。';
}

function buildExportPreviewMessage(preview, { existing = false } = {}) {
  const included = Number(preview?.includedCount || preview?.includedShots?.length || 0);
  const missing = Number(preview?.missingCount || preview?.missingShots?.length || 0);
  const prefix = preview?.curatedAssembly
    ? `${existing ? '已找到' : '已使用'}剪辑修复版${preview.previewTitle ? `「${preview.previewTitle}」` : ''}`
    : existing ? '已找到上次生成的分镜拼接预览' : '已生成分镜拼接预览';
  if (missing > 0) return `${prefix}：包含 ${included} 个分镜，未包含 ${missing} 个缺失分镜。`;
  return `${prefix}：包含 ${included} 个分镜。`;
}

function assemblyCoversEveryShotLocal(node, shotNos) {
  if (!shotNos.length) return false;
  const included = getAssemblyIncludedShotNosLocal(node, shotNos);
  const includedSet = new Set(included.map(String));
  return shotNos.every((shotNo) => includedSet.has(String(shotNo)));
}

function getAssemblyIncludedShotNosLocal(node, shotNos) {
  const explicit = Array.isArray(node?.metadata?.includedShots)
    ? node.metadata.includedShots.map(String).filter(Boolean)
    : [];
  if (explicit.length) return explicit;

  const source = `${node?.id || ''} ${node?.title || ''} ${node?.path || ''}`;
  const range = source.match(/s(\d{3})\s*[-_~]\s*s(\d{3})/i);
  if (!range) return shotNos;

  const start = Number(range[1]);
  const end = Number(range[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return shotNos;
  return shotNos.filter((shotNo) => {
    const match = String(shotNo).match(/^s(\d{3})$/i);
    if (!match) return false;
    const value = Number(match[1]);
    return value >= Math.min(start, end) && value <= Math.max(start, end);
  });
}

function shotNoOfLocal(shot) {
  return shot?.shotNo || String(shot?.id || '').replace(/^shot:/, '') || '未命名分镜';
}

function buildExportFilePreview(summary) {
  const ep = getActiveEpisode();
  const project = safeNamePart(state.project?.name || '作品');
  const episode = safeNamePart(ep?.title || ep?.id || '第1集');
  const status = summary.exportStatus === 'final' ? '正式版' : '草稿版';
  return `${project}_${episode}_${status}_v001`;
}

function extractExportSubtitle(doc, shot) {
  // 与服务端 SRT 共用字幕提取规则，避免预览显示视频提示词而导出又是另一套结果。
  return extractFirstSubtitleLine(doc, shot);
}

function fileNameOf(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || '导出文件';
}

function safeNamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '')
    || '未命名';
}

function shotIdOf(node) {
  return node?.shotId || null;
}

function findQcStatus(nodes, edges, outputNodeId) {
  if (!outputNodeId) return 'none';
  const qcEdge = edges.find((edge) => edge.type === 'qc_for' && edge.to === outputNodeId);
  if (!qcEdge) return 'none';
  const qcNode = nodes.find((node) => node.id === qcEdge.from);
  return qcNode?.status || 'none';
}

function assetUrl(episodePath, relativePath, { revision } = {}) {
  const params = new URLSearchParams({ episode: episodePath, path: relativePath });
  if (revision) params.set('revision', String(revision));
  return `/api/asset?${params.toString()}`;
}

function showProjectError(title, body) {
  state.activeStep = 'script_shots';
  renderWorkflowSteps();
  dom.scriptPanel.hidden = false;
  dom.libraryPanel.hidden = true;
  dom.shotsPanel.hidden = true;
  dom.exportPanel.hidden = true;
  dom.storySourceEditor.disabled = true;
  dom.saveStorySourceButton.disabled = true;
  dom.scriptDraftState.textContent = title;
  dom.storyboardState.textContent = body || '';
  dom.footerLeft.textContent = title;
}

function showShotsState({ title, body, actionLabel, onAction }) {
  dom.shotsState.hidden = false;
  dom.shotsState.replaceChildren();
  const card = document.createElement('div');
  card.className = 'state-card';
  const h = document.createElement('h2');
  h.textContent = title;
  card.appendChild(h);
  const p = document.createElement('p');
  p.textContent = body || '';
  card.appendChild(p);
  if (actionLabel && typeof onAction === 'function') {
    const actions = document.createElement('div');
    actions.className = 'state-card__actions';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'primary-button';
    action.textContent = actionLabel;
    action.addEventListener('click', onAction);
    actions.appendChild(action);
    card.appendChild(actions);
  }
  dom.shotsState.appendChild(card);
  dom.shotsGrid.replaceChildren();
}

function showLibraryState({ title, body }) {
  dom.libraryState.hidden = false;
  dom.libraryState.replaceChildren();
  const card = document.createElement('div');
  card.className = 'state-card';
  const h = document.createElement('h2');
  h.textContent = title;
  card.appendChild(h);
  const p = document.createElement('p');
  p.textContent = body || '';
  card.appendChild(p);
  dom.libraryState.appendChild(card);
  dom.libraryBody.replaceChildren();
}

function getActiveDoc() {
  return state.episodeDocs.get(state.activeEpisodeId) || null;
}

function getActiveEpisode() {
  return state.episodes.find((item) => item.id === state.activeEpisodeId) || null;
}

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

function formatTime(iso) {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}
