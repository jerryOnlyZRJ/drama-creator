/*
 * L3 分镜画布 (shot.js):
 *   1. 通过 ?path=<episodePath>&shot=<shotNo> 决定渲染哪一个分镜闭包；
 *   2. 调用 buildClusters(doc, { shotFilter }) 仅保留该镜头闭包；
 *   3. 顶部 prev/next 按钮按 shotNo 字典序在同一 episode 内跳转；
 *   4. 三列布局：剧本 / 素材 / 产物，图片视频通过 /api/asset 渲染。
 *
 * 安全约束：
 *   - 所有用户/文档可控字符串通过 createElement + textContent 注入；
 *   - QC 备注始终通过 textarea.value 写入，不走 HTML 沟道。
 */

import { buildClusters, LAYOUT_METRICS } from './src/layout/clusters.mjs';
import { createFeedPackagePreviewResult } from './src/feed/feedPackage.mjs';
import {
  buildPromptReferences,
  formatPromptDisplayText,
  PROMPT_REFERENCE_EDGE_TYPES
} from './src/workflow/promptReferences.mjs';

const QC_STATUSES = new Set(['reviewing', 'approved', 'rerun_needed']);
const QC_LABEL = { reviewing: '待质检', approved: '已通过', rerun_needed: '需重跑' };
const REFERENCE_EDGE_TYPES = PROMPT_REFERENCE_EDGE_TYPES;
const SUPPORTING_OUTPUT_BADGES = new Set(['同镜头产物', '预览参考', '旧版参考']);

const COLUMN_LABELS = {
  script: { tag: 'SCRIPT', title: '剧本资源族' },
  asset: { tag: 'ASSETS', title: '素材资源族' },
  product: { tag: 'OUTPUTS', title: '产物资源族' }
};

const params = new URLSearchParams(window.location.search);
const episodePath = params.get('path');
const initialShot = params.get('shot');

const state = {
  doc: createEmptyDocument(),
  clusters: [],
  links: [],
  shotList: [],          // 按 shotNo 字典序排序的 shot 元数据，用于 prev/next 导航
  shotNo: initialShot || null,
  selectedClusterId: null,
  saveState: 'idle',
  errorMessage: '',
  referenceFilter: '',
  referenceReplaceEdgeId: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  positionOverrides: new Map(),
  jimengFeedPackage: null,
  pendingDeleteResourceNodeId: null,
  editingPromptNodeId: null,
  promptDraft: '',
  promptSaveMessage: ''
};

let activeShotAudio = null;

const dom = {
  shell: document.querySelector('.app-shell'),
  shotTitle: document.getElementById('shotTitle'),
  shotMeta: document.getElementById('shotMeta'),
  projectCrumb: document.getElementById('projectCrumb'),
  shotCrumb: document.getElementById('shotCrumb'),
  backToShotVideos: document.getElementById('backToShotVideos'),
  prevButton: document.getElementById('prevShot'),
  nextButton: document.getElementById('nextShot'),
  referenceManagerButton: document.getElementById('referenceManagerButton'),
  referenceManagerDialog: document.getElementById('referenceManagerDialog'),
  referenceManagerClose: document.getElementById('referenceManagerClose'),
  currentReferenceCount: document.getElementById('currentReferenceCount'),
  currentReferenceList: document.getElementById('currentReferenceList'),
  referenceAssetSearch: document.getElementById('referenceAssetSearch'),
  availableReferenceList: document.getElementById('availableReferenceList'),
  referenceManagerError: document.getElementById('referenceManagerError'),
  manualImportButton: document.getElementById('manualImportButton'),
  manualImportDialog: document.getElementById('manualImportDialog'),
  manualImportForm: document.getElementById('manualImportForm'),
  manualImportKind: document.getElementById('manualImportKind'),
  manualImportPath: document.getElementById('manualImportPath'),
  manualImportTitle: document.getElementById('manualImportTitle'),
  manualImportFileButton: document.getElementById('pickManualAssetFile'),
  manualImportError: document.getElementById('manualImportError'),
  manualImportCancel: document.getElementById('manualImportCancel'),
  feedButton: document.getElementById('feedButton'),
  submitJimengAutomationButton: document.getElementById('submitJimengAutomationButton'),
  jimengFeedDialog: document.getElementById('jimengFeedDialog'),
  jimengFeedTitle: document.getElementById('jimengFeedTitle'),
  jimengTargetLink: document.getElementById('jimengTargetLink'),
  jimengAutomationStatus: document.getElementById('jimengAutomationStatus'),
  jimengPromptText: document.getElementById('jimengPromptText'),
  jimengReferenceList: document.getElementById('jimengReferenceList'),
  jimengGateList: document.getElementById('jimengGateList'),
  jimengWarningSection: document.getElementById('jimengWarningSection'),
  jimengWarningList: document.getElementById('jimengWarningList'),
  jimengFeedClose: document.getElementById('jimengFeedClose'),
  copyJimengPrompt: document.getElementById('copyJimengPrompt'),
  copyJimengUploadList: document.getElementById('copyJimengUploadList'),
  copyJimengJson: document.getElementById('copyJimengJson'),
  startJimengAutomation: document.getElementById('startJimengAutomation'),
  saveState: document.getElementById('saveState'),
  counts: document.getElementById('counts'),
  errorBanner: document.getElementById('errorBanner'),
  viewport: document.getElementById('canvasViewport'),
  stage: document.getElementById('canvasStage'),
  cards: document.getElementById('canvasCards'),
  lines: document.getElementById('canvasLines'),
  columns: document.getElementById('canvasColumns'),
  overlay: document.getElementById('canvasOverlay'),
  overlayTitle: document.getElementById('overlayTitle'),
  overlayBody: document.getElementById('overlayBody'),
  overlayHint: document.getElementById('overlayHint'),
  inspectorTitle: document.getElementById('inspectorTitle'),
  inspectorSubtitle: document.getElementById('inspectorSubtitle'),
  inspectorMedia: document.getElementById('inspectorMedia'),
  inspectorMeta: document.getElementById('inspectorMeta'),
  setCurrentVideoButton: document.getElementById('setCurrentVideoButton'),
  deleteResourceButton: document.getElementById('deleteResourceButton'),
  resourceDeleteHint: document.getElementById('resourceDeleteHint'),
  qcStatus: document.getElementById('qcStatus'),
  qcNote: document.getElementById('qcNote'),
  qcUpdatedAt: document.getElementById('qcUpdatedAt'),
  saveQcButton: document.getElementById('saveQcButton'),
  zoomLabel: document.getElementById('zoomLabel'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  zoomReset: document.getElementById('zoomReset')
};

bindEvents();
await loadEpisode();

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

async function loadEpisode() {
  if (!episodePath) {
    showOverlay({
      title: '缺少 path 参数',
      body: '请通过 /shot.html?path=<episodePath>&shot=<shotNo> 打开分镜画布。',
      hint: ''
    });
    setSaveState('idle');
    render();
    return;
  }
  if (!state.shotNo) {
    showOverlay({
      title: '缺少 shot 参数',
      body: '请补上 shot 编号，例如 ?shot=s001a。',
      hint: ''
    });
    setSaveState('idle');
    render();
    return;
  }

  setSaveState('loading');
  render();

  try {
    const response = await fetch(`/api/episode?path=${encodeURIComponent(episodePath)}`);
    if (!response.ok) {
      await applyApiError(response, '读取 episode JSON 失败');
      return;
    }
    state.doc = await response.json();
    state.errorMessage = '';
    state.positionOverrides.clear();
    state.shotList = collectShotList(state.doc);
    rebuildLayout();
    fitToContent();
    setSaveState('loaded');
  } catch (error) {
    state.errorMessage = `读取本地 API 失败：${error.message}`;
    setSaveState('error');
  }
  render();
}

function collectShotList(doc) {
  // 同一 episode 内的 shot 列表，用于按 shotNo 字典序导航
  const shots = Array.isArray(doc?.shots) ? doc.shots : [];
  return shots
    .map((shot) => ({
      shotNo: shot.shotNo || (shot.id || '').replace(/^shot:/, ''),
      title: shot.title || shot.summary || '',
      id: shot.id
    }))
    .filter((shot) => shot.shotNo)
    .sort((a, b) => a.shotNo.localeCompare(b.shotNo));
}

function rebuildLayout() {
  const { clusters, links } = buildClusters(state.doc, { shotFilter: state.shotNo });
  state.clusters = clusters;
  state.links = links;
}

// ---------------------------------------------------------------------------
// 渲染主流程
// ---------------------------------------------------------------------------

function render() {
  renderHeader();
  renderStatus();
  renderCanvas();
  renderInspector();
}

function renderHeader() {
  const episode = state.doc?.episode || {};
  const titleParts = [];
  if (episode.id) titleParts.push(episode.id);
  if (state.shotNo) titleParts.push(`镜头 ${state.shotNo}`);
  dom.shotTitle.textContent = titleParts.join(' · ') || 'Drama Creator';

  const currentShot = state.shotList.find((shot) => shot.shotNo === state.shotNo);
  const projectName = state.doc?.project?.name || '';
  dom.shotMeta.textContent = currentShot?.title
    ? `${projectName} · ${currentShot.title}`
    : projectName || '未加载';

  const projectRoot = inferProjectRoot(episodePath);

  // 面包屑
  if (projectName) {
    dom.projectCrumb.textContent = projectName;
    if (projectRoot) {
      dom.projectCrumb.href = `/project.html?path=${encodeURIComponent(projectRoot)}`;
    } else {
      dom.projectCrumb.href = '/';
    }
  }
  dom.shotCrumb.textContent = state.shotNo ? `镜头 ${state.shotNo}` : '镜头';

  if (projectRoot) {
    // 项目详情页默认打开「剧本与分镜」；从分镜画布返回管理列表必须显式指定 Step 3。
    dom.backToShotVideos.href = `/project.html?path=${encodeURIComponent(projectRoot)}&step=shot_videos`;
    dom.backToShotVideos.removeAttribute('aria-disabled');
    dom.backToShotVideos.title = '返回分镜视频管理页';
  } else {
    dom.backToShotVideos.href = '/';
    dom.backToShotVideos.setAttribute('aria-disabled', 'true');
    dom.backToShotVideos.title = '当前路径无法识别项目根目录，将返回项目库';
  }

  // prev/next 按钮
  const idx = state.shotList.findIndex((shot) => shot.shotNo === state.shotNo);
  const prev = idx > 0 ? state.shotList[idx - 1] : null;
  const next = idx >= 0 && idx < state.shotList.length - 1 ? state.shotList[idx + 1] : null;
  dom.prevButton.disabled = !prev;
  dom.nextButton.disabled = !next;
  const currentVideoTask = findCurrentVideoTask();
  dom.referenceManagerButton.disabled = !episodePath || !state.shotNo || !findPromptIdForCurrentShot();
  dom.manualImportButton.disabled = !episodePath || !state.shotNo;
  dom.feedButton.disabled = !episodePath || !state.shotNo || !currentVideoTask;
  dom.submitJimengAutomationButton.disabled = !episodePath || !state.shotNo || !currentVideoTask;
  dom.prevButton.title = prev ? `上一镜头：${prev.shotNo}${prev.title ? ` · ${prev.title}` : ''}` : '已经是第一个镜头';
  dom.nextButton.title = next ? `下一镜头：${next.shotNo}${next.title ? ` · ${next.title}` : ''}` : '已经是最后一个镜头';
  dom.referenceManagerButton.title = dom.referenceManagerButton.disabled ? '当前镜头缺少可绑定的提示词节点' : '添加或调整当前镜头参考资源';
  dom.manualImportButton.title = dom.manualImportButton.disabled ? '需要先进入具体镜头' : '导入外部生成的图片或视频';
  dom.feedButton.title = dom.feedButton.disabled ? '当前镜头还没有可投喂的视频任务' : '查看即梦提示词、参考图顺序和人工上传清单';
  dom.submitJimengAutomationButton.title = dom.submitJimengAutomationButton.disabled
    ? '当前镜头还没有可启动的视频任务'
    : '使用全局视频模型配置启动应用托管的即梦自动化窗口';
  dom.prevButton.dataset.target = prev?.shotNo || '';
  dom.nextButton.dataset.target = next?.shotNo || '';
}

function inferProjectRoot(epPath) {
  if (!epPath) return null;
  // 先兼容旧导入目录，再处理 APP 当前创建的 projects/<name>/episodes/<ep> 布局。
  const legacyMarker = '/scripts/episodes/';
  const legacyIdx = epPath.indexOf(legacyMarker);
  if (legacyIdx >= 0) return epPath.slice(0, legacyIdx);
  const appWorkspaceMarker = '/episodes/';
  const appWorkspaceIdx = epPath.indexOf(appWorkspaceMarker);
  return appWorkspaceIdx >= 0 ? epPath.slice(0, appWorkspaceIdx) : null;
}

function renderStatus() {
  const stateLabel = {
    idle: '等待加载',
    loading: '加载中',
    loaded: '已加载',
    saving: '保存中',
    saved: '已保存',
    error: '需要处理'
  }[state.saveState] || '';
  dom.saveState.textContent = stateLabel;
  dom.saveState.dataset.state = state.saveState;

  const nodeCount = state.doc?.nodes?.length || 0;
  const edgeCount = state.doc?.edges?.length || 0;
  dom.counts.textContent = `${nodeCount} 资源节点 · ${edgeCount} 依赖边 · ${state.clusters.length} 资源卡`;

  if (state.errorMessage) {
    dom.errorBanner.hidden = false;
    dom.errorBanner.textContent = state.errorMessage;
  } else {
    dom.errorBanner.hidden = true;
    dom.errorBanner.textContent = '';
  }
}

function renderCanvas() {
  if (!state.clusters.length) {
    pauseActiveShotAudio();
    dom.overlay.hidden = false;
    dom.cards.replaceChildren();
    dom.lines.replaceChildren();
    dom.columns.replaceChildren();
    return;
  }
  dom.overlay.hidden = true;

  renderColumnHeaders();
  renderCards();
  renderLinks();
  applyTransform();
}

function renderColumnHeaders() {
  const fragment = document.createDocumentFragment();
  for (const column of Object.keys(COLUMN_LABELS)) {
    const sample = state.clusters.find((cluster) => cluster.column === column);
    if (!sample) continue;
    const x = sample.position.x;
    const header = document.createElement('div');
    header.className = 'canvas-column-header';
    header.style.left = `${x}px`;
    header.style.top = '8px';
    const tag = document.createElement('span');
    tag.textContent = COLUMN_LABELS[column].tag;
    header.appendChild(tag);
    const title = document.createElement('strong');
    title.textContent = COLUMN_LABELS[column].title;
    header.appendChild(title);
    fragment.appendChild(header);
  }
  dom.columns.replaceChildren(fragment);
}

function renderCards() {
  pauseActiveShotAudio();
  const fragment = document.createDocumentFragment();
  for (const cluster of state.clusters) {
    fragment.appendChild(buildClusterCardElement(cluster));
  }
  dom.cards.replaceChildren(fragment);
}

function buildClusterCardElement(cluster) {
  const card = document.createElement('article');
  card.className = 'cluster-card';
  card.tabIndex = 0;
  card.role = 'button';
  card.setAttribute('aria-label', `${cluster.title || cluster.id} 资源卡`);
  card.dataset.clusterId = cluster.id;
  card.dataset.column = cluster.column;
  card.dataset.kind = cluster.kind;
  if (cluster.id === state.selectedClusterId) card.classList.add('is-selected');

  const position = effectivePosition(cluster);
  card.style.left = `${position.x}px`;
  card.style.top = `${position.y}px`;
  card.style.width = `${LAYOUT_METRICS.cardWidth}px`;

  // 顶部：shotNo + kind 标签
  const top = document.createElement('div');
  top.className = 'cluster-card__top';
  const shotChip = document.createElement('span');
  shotChip.className = 'cluster-card__shotno';
  shotChip.textContent = cluster.shotNo ? `镜头 ${cluster.shotNo}` : '通用';
  top.appendChild(shotChip);

  const kindChip = document.createElement('span');
  kindChip.className = 'cluster-card__kind';
  kindChip.textContent = cluster.subtitle || cluster.kind;
  top.appendChild(kindChip);

  const supportingBadge = (cluster.badges || []).find((badge) => SUPPORTING_OUTPUT_BADGES.has(badge));
  if (supportingBadge) {
    const relationChip = document.createElement('span');
    relationChip.className = 'cluster-card__kind cluster-card__kind--supporting';
    relationChip.textContent = supportingBadge;
    top.appendChild(relationChip);
  }
  card.appendChild(top);

  // 标题
  const title = document.createElement('h3');
  title.className = 'cluster-card__title';
  title.textContent = cluster.title || cluster.id;
  card.appendChild(title);

  // 媒体 / 摘录
  if (cluster.column === 'script') {
    const excerpt = document.createElement('p');
    excerpt.className = 'cluster-card__excerpt';
    excerpt.textContent = scriptExcerpt(cluster);
    card.appendChild(excerpt);
  } else {
    card.appendChild(buildMediaElement(cluster));
  }

  // 底部：badges + QC chip
  const footer = document.createElement('div');
  footer.className = 'cluster-card__footer';
  for (const badge of cluster.badges || []) {
    const chip = document.createElement('span');
    chip.className = 'cluster-card__badge';
    chip.dataset.badge = badge;
    if (SUPPORTING_OUTPUT_BADGES.has(badge)) chip.classList.add('cluster-card__badge--supporting');
    chip.textContent = badge;
    footer.appendChild(chip);
  }
  if (cluster.qc?.status) {
    const qc = document.createElement('span');
    qc.className = 'cluster-card__qc';
    qc.dataset.status = cluster.qc.status;
    qc.textContent = QC_LABEL[cluster.qc.status] || cluster.qc.status;
    footer.appendChild(qc);
  }
  const detailsButton = document.createElement('button');
  detailsButton.type = 'button';
  detailsButton.className = 'cluster-card__details';
  detailsButton.textContent = cluster.kind === 'video' ? '详情/QC' : '详情';
  detailsButton.addEventListener('pointerdown', (event) => event.stopPropagation());
  detailsButton.addEventListener('click', (event) => {
    event.stopPropagation();
    state.selectedClusterId = cluster.id;
    render();
  });
  footer.appendChild(detailsButton);
  card.appendChild(footer);

  return card;
}

function buildMediaElement(cluster) {
  const wrap = document.createElement('div');
  wrap.className = 'cluster-card__media';

  const sourcePath = mediaPathFor(cluster);
  if (!sourcePath) {
    const fallback = document.createElement('div');
    fallback.className = 'cluster-card__media-fallback';
    const strong = document.createElement('strong');
    strong.textContent = cluster.kind === 'audio' ? '音频未生成' : '素材未生成';
    fallback.appendChild(strong);
    const hint = document.createElement('span');
    hint.textContent = '提示词就绪后即可触发投喂';
    fallback.appendChild(hint);
    wrap.appendChild(fallback);
    return wrap;
  }

  const url = assetUrl(sourcePath);
  if (cluster.kind === 'image') {
    const img = document.createElement('img');
    img.alt = cluster.title || '图片素材';
    img.loading = 'lazy';
    img.src = url;
    img.addEventListener('error', () => replaceWithFallback(wrap, '图片加载失败', sourcePath));
    wrap.appendChild(img);
  } else if (cluster.kind === 'video') {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.controls = true;
    video.src = url;
    video.addEventListener('error', () => replaceWithFallback(wrap, '视频加载失败', sourcePath));
    // 视频控件应直接响应播放/暂停，不触发资源卡选中或拖拽。
    video.addEventListener('pointerdown', (event) => event.stopPropagation());
    video.addEventListener('click', (event) => event.stopPropagation());
    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'cluster-card__play';
    playButton.addEventListener('pointerdown', (event) => event.stopPropagation());
    playButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleVideoPlayback(video, playButton);
    });
    video.addEventListener('play', () => updateVideoPlayButton(video, playButton));
    video.addEventListener('pause', () => updateVideoPlayButton(video, playButton));
    updateVideoPlayButton(video, playButton);
    wrap.appendChild(video);
    wrap.appendChild(playButton);
  } else if (cluster.kind === 'audio') {
    // 音频卡直接挂 <audio controls>，让画布上能 inline 试听参考音频/成片对白。
    // 失败时（404 / 路径越权）降级为带文件路径提示的占位块，方便定位资产位置。
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    audio.setAttribute('aria-label', cluster.title || '音频素材');
    audio.addEventListener('error', () => replaceWithFallback(wrap, '音频加载失败', sourcePath));
    wrap.appendChild(registerShotAudio(audio));
  } else {
    const fallback = document.createElement('div');
    fallback.className = 'cluster-card__media-fallback';
    fallback.textContent = sourcePath;
    wrap.appendChild(fallback);
  }
  return wrap;
}

function registerShotAudio(audio) {
  audio.dataset.shotAudio = 'true';
  // 音频控件嵌在可选中的资源卡里，阻止控件事件冒泡，避免播放时触发卡片重渲染。
  for (const eventName of ['pointerdown', 'click', 'dblclick', 'keydown']) {
    audio.addEventListener(eventName, (event) => event.stopPropagation());
  }
  audio.addEventListener('play', () => {
    pauseOtherShotAudio(audio);
    activeShotAudio = audio;
  });
  audio.addEventListener('pause', () => {
    if (activeShotAudio === audio) activeShotAudio = null;
  });
  audio.addEventListener('ended', () => {
    if (activeShotAudio === audio) activeShotAudio = null;
  });
  return audio;
}

function pauseOtherShotAudio(currentAudio) {
  for (const audio of document.querySelectorAll('audio[data-shot-audio="true"]')) {
    if (audio !== currentAudio) audio.pause();
  }
  if (activeShotAudio && activeShotAudio !== currentAudio) activeShotAudio.pause();
}

function pauseActiveShotAudio() {
  if (activeShotAudio && !activeShotAudio.paused) activeShotAudio.pause();
  activeShotAudio = null;
}

function replaceWithFallback(wrap, label, path) {
  // 渲染降级时不要把任意路径直接写进 innerHTML，使用 textContent 节点。
  wrap.replaceChildren();
  const fallback = document.createElement('div');
  fallback.className = 'cluster-card__media-fallback';
  const strong = document.createElement('strong');
  strong.textContent = label;
  fallback.appendChild(strong);
  const hint = document.createElement('span');
  hint.textContent = path;
  fallback.appendChild(hint);
  wrap.appendChild(fallback);
}

function mediaPathFor(cluster) {
  if (cluster.column === 'asset') return cluster.asset?.path || null;
  if (cluster.column === 'product') return cluster.output?.path || null;
  return null;
}

function toggleVideoPlayback(video, button) {
  if (video.paused) {
    const playPromise = video.play();
    if (playPromise?.catch) playPromise.catch(() => updateVideoPlayButton(video, button));
  } else {
    video.pause();
  }
  updateVideoPlayButton(video, button);
}

function updateVideoPlayButton(video, button) {
  const playing = !video.paused;
  button.classList.toggle('is-playing', playing);
  button.setAttribute('aria-pressed', String(playing));
  button.setAttribute('aria-label', playing ? '暂停视频' : '播放视频');
  button.textContent = playing ? '⏸' : '▶';
}

function assetUrl(relativePath) {
  return `/api/asset?episode=${encodeURIComponent(episodePath)}&path=${encodeURIComponent(relativePath)}`;
}

function scriptExcerpt(cluster) {
  const text = cluster.members?.script?.metadata?.text
    || cluster.members?.script?.metadata?.scriptText
    || cluster.members?.script?.metadata?.summary
    || cluster.members?.script?.title
    || '剧本片段';
  return text;
}

// ---------------------------------------------------------------------------
// 连线（基于 DOM 真实位置）
// ---------------------------------------------------------------------------

function renderLinks() {
  const svg = dom.lines;
  svg.replaceChildren();

  if (!state.links.length) return;

  const stageRect = dom.stage.getBoundingClientRect();
  const viewportRect = dom.viewport.getBoundingClientRect();
  const zoom = state.zoom || 1;
  // 以 stage 局部坐标系（未经 transform 的逻辑像素）计算路径
  const localRect = (id) => {
    const card = dom.cards.querySelector(`[data-cluster-id="${cssEscape(id)}"]`);
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return {
      left: (rect.left - stageRect.left) / zoom,
      right: (rect.right - stageRect.left) / zoom,
      top: (rect.top - stageRect.top) / zoom,
      bottom: (rect.bottom - stageRect.top) / zoom,
      centerY: (rect.top + rect.bottom) / 2 - stageRect.top
    };
  };

  // 计算 SVG 视框：覆盖整个 stage 的逻辑像素尺寸
  const stageWidth = dom.stage.offsetWidth;
  const stageHeight = dom.stage.offsetHeight;
  svg.setAttribute('viewBox', `0 0 ${stageWidth} ${stageHeight}`);
  svg.setAttribute('width', stageWidth);
  svg.setAttribute('height', stageHeight);

  for (const link of state.links) {
    const fromRect = localRect(link.fromCluster);
    const toRect = localRect(link.toCluster);
    if (!fromRect || !toRect) continue;

    // 如果 fromColumn 在 toColumn 左侧则从右出，否则从左出，避免反向连线视觉错乱。
    const fromOnLeft = fromRect.left < toRect.left;
    const x1 = fromOnLeft ? fromRect.right : fromRect.left;
    const y1 = fromRect.centerY / zoom;
    const x2 = fromOnLeft ? toRect.left : toRect.right;
    const y2 = toRect.centerY / zoom;
    const dx = Math.max(60, Math.abs(x2 - x1) * 0.45);
    const c1x = fromOnLeft ? x1 + dx : x1 - dx;
    const c2x = fromOnLeft ? x2 - dx : x2 + dx;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`);
    path.classList.add('edge', `edge--${link.tone || link.kind}`);
    path.dataset.linkId = link.id;
    if (state.selectedClusterId
      && link.fromCluster !== state.selectedClusterId
      && link.toCluster !== state.selectedClusterId) {
      path.classList.add('is-dim');
    }
    if (state.selectedClusterId
      && (link.fromCluster === state.selectedClusterId || link.toCluster === state.selectedClusterId)) {
      path.classList.add('is-highlight');
    }
    svg.appendChild(path);

    if (link.tone === 'supporting' && link.label) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.classList.add('edge-label', 'edge-label--supporting');
      label.dataset.linkId = link.id;
      label.setAttribute('x', String((x1 + x2) / 2));
      label.setAttribute('y', String((y1 + y2) / 2 - 8));
      label.textContent = link.label;
      // 同镜头历史视频不是正式生成依赖，必须显式标注为参考关系，避免看起来像游离产物。
      if (state.selectedClusterId
        && link.fromCluster !== state.selectedClusterId
        && link.toCluster !== state.selectedClusterId) {
        label.classList.add('is-dim');
      }
      if (state.selectedClusterId
        && (link.fromCluster === state.selectedClusterId || link.toCluster === state.selectedClusterId)) {
        label.classList.add('is-highlight');
      }
      svg.appendChild(label);
    }
  }
  // 视口/viewport 没用到，但保留 ref 防止 lint 误报。
  void viewportRect;
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

function renderInspector() {
  const cluster = state.clusters.find((item) => item.id === state.selectedClusterId);
  if (!cluster) {
    dom.inspectorTitle.textContent = '选择一张卡片';
    dom.inspectorSubtitle.textContent = '点击画布卡片查看资源预览、提示词、引用资源和质检结论。';
    dom.inspectorMedia.hidden = true;
    dom.inspectorMedia.replaceChildren();
    dom.inspectorMeta.replaceChildren();
    setResourceActions(null);
    setQcEditor(null);
    return;
  }

  dom.inspectorTitle.textContent = cluster.title;
  dom.inspectorSubtitle.textContent = `${COLUMN_LABELS[cluster.column]?.title || cluster.column} · ${cluster.subtitle}`;

  // Media preview
  const mediaPath = mediaPathFor(cluster);
  if (mediaPath) {
    dom.inspectorMedia.hidden = false;
    dom.inspectorMedia.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'inspector__media';
    if (cluster.kind === 'image') {
      const img = document.createElement('img');
      img.src = assetUrl(mediaPath);
      img.alt = cluster.title;
      wrap.appendChild(img);
    } else if (cluster.kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.muted = true;
      video.src = assetUrl(mediaPath);
      wrap.appendChild(video);
    }
    dom.inspectorMedia.appendChild(wrap);
  } else {
    dom.inspectorMedia.hidden = true;
    dom.inspectorMedia.replaceChildren();
  }

  // Meta dl
  dom.inspectorMeta.replaceChildren();
  const dl = document.createElement('dl');
  appendMeta(dl, '资源族', COLUMN_LABELS[cluster.column]?.title || cluster.column);
  if (cluster.shotNo) appendMeta(dl, '镜头', cluster.shotNo);
  if (cluster.statusLabel) appendMeta(dl, '状态', cluster.statusLabel);
  if (cluster.asset?.path) appendMeta(dl, '素材路径', cluster.asset.path, true);
  if (cluster.output?.path) appendMeta(dl, '产物路径', cluster.output.path, true);
  if (cluster.task?.fields?.ratio) appendMeta(dl, '比例', cluster.task.fields.ratio);
  if (cluster.task?.fields?.duration) appendMeta(dl, '时长', `${cluster.task.fields.duration}s`);
  if (cluster.task?.id) appendMeta(dl, '任务', cluster.task.id, true);
  appendMeta(dl, '资源 ID', cluster.primaryNodeId, true);
  dom.inspectorMeta.appendChild(dl);

  const scriptText = scriptTextForCluster(cluster);
  if (scriptText) {
    dom.inspectorMeta.appendChild(buildScriptInspectorSection(scriptText));
  }

  if (cluster.promptText || cluster.members?.prompt) {
    dom.inspectorMeta.appendChild(buildPromptInspectorSection(cluster));
  }

  setQcEditor(cluster);
  setResourceActions(cluster);
}

function scriptTextForCluster(cluster) {
  if (cluster?.column !== 'script') return '';
  const scriptNode = cluster.members?.script || null;
  const nodeText = String(scriptNode?.metadata?.text || '').trim();
  if (nodeText) return nodeText;

  const shot = (state.doc.shots || []).find((item) => (
    item.id === scriptNode?.shotId
    || item.shotNo === cluster.shotNo
    || item.id === `shot:${cluster.shotNo}`
  ));
  return String(shot?.scriptText || '').trim();
}

function buildScriptInspectorSection(scriptText) {
  const section = document.createElement('section');
  section.className = 'script-detail';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = '剧本内容';

  const block = document.createElement('pre');
  block.className = 'script-detail__body';
  // 剧本节点本身就是生产源；详情面板必须回读正文，不能只展示资源 ID。
  block.textContent = scriptText;

  section.append(eyebrow, block);
  return section;
}

function appendMeta(dl, label, value, mono) {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  if (mono) {
    const code = document.createElement('code');
    code.textContent = String(value);
    dd.appendChild(code);
  } else {
    dd.textContent = String(value);
  }
  row.appendChild(dt);
  row.appendChild(dd);
  dl.appendChild(row);
}

function buildPromptInspectorSection(cluster) {
  const promptNode = cluster.members?.prompt || null;
  const references = collectPromptReferences(promptNode?.id);
  const rawPromptText = promptTextForEditing(promptNode, cluster);
  const isEditing = Boolean(promptNode?.id && state.editingPromptNodeId === promptNode.id);
  const section = document.createElement('section');
  section.className = 'prompt-section';

  const header = document.createElement('div');
  header.className = 'prompt-section__header';
  const heading = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = '提示词';
  const title = document.createElement('strong');
  title.className = 'prompt-section__title';
  title.textContent = promptNode?.title || promptKindLabel(promptNode);
  heading.append(eyebrow, title);
  header.appendChild(heading);

  if (promptNode?.id && state.shotNo) {
    const actions = document.createElement('div');
    actions.className = 'prompt-section__actions';
    if (!isEditing) {
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'ghost-button prompt-section__action';
      editButton.textContent = '编辑提示词';
      editButton.addEventListener('click', () => {
        state.editingPromptNodeId = promptNode.id;
        state.promptDraft = rawPromptText;
        state.promptSaveMessage = '';
        render();
      });
      actions.appendChild(editButton);
    }

    const bindButton = document.createElement('button');
    bindButton.type = 'button';
    bindButton.className = 'ghost-button prompt-section__action';
    bindButton.textContent = '引用资源';
    bindButton.addEventListener('click', () => {
      state.referenceReplaceEdgeId = null;
      openReferenceManagerDialog();
    });
    actions.appendChild(bindButton);
    header.appendChild(actions);
  }
  section.appendChild(header);

  if (references.length) {
    const list = document.createElement('ul');
    list.className = 'prompt-section__references';
    for (const reference of references) {
      const item = document.createElement('li');
      const order = document.createElement('span');
      order.className = 'prompt-section__order';
      order.textContent = `上传顺序 ${reference.order}`;
      const name = document.createElement('strong');
      name.textContent = reference.displayName;
      item.append(order, name);
      list.appendChild(item);
    }
    section.appendChild(list);
  }

  if (isEditing) {
    section.appendChild(buildPromptEditor(promptNode, rawPromptText));
  } else {
    const block = document.createElement('pre');
    block.className = 'prompt-block';
    block.textContent = formatPromptDisplayText(rawPromptText, references);
    section.appendChild(block);
  }
  return section;
}

function promptTextForEditing(promptNode, cluster) {
  const prompt = String(promptNode?.metadata?.prompt || '').trim();
  return prompt || String(cluster.promptText || '').trim();
}

function buildPromptEditor(promptNode, rawPromptText) {
  const wrapper = document.createElement('div');
  wrapper.className = 'prompt-editor';

  const textarea = document.createElement('textarea');
  textarea.className = 'prompt-editor__textarea';
  textarea.value = state.promptDraft || rawPromptText;
  textarea.placeholder = '写入这一镜头的视频生成提示词。';
  textarea.addEventListener('input', () => {
    state.promptDraft = textarea.value;
    saveButton.disabled = !state.promptDraft.trim();
  });

  const hint = document.createElement('p');
  hint.className = 'prompt-editor__hint';
  hint.textContent = '保存后会用于投喂包和后续生成；引用资源顺序仍通过“引用资源”调整。';

  const actions = document.createElement('div');
  actions.className = 'prompt-editor__actions';
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'primary-button';
  saveButton.textContent = '保存提示词';
  saveButton.disabled = !textarea.value.trim();
  saveButton.addEventListener('click', () => savePromptText(promptNode.id, textarea.value));

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'ghost-button';
  cancelButton.textContent = '取消';
  cancelButton.addEventListener('click', () => {
    state.editingPromptNodeId = null;
    state.promptDraft = '';
    state.promptSaveMessage = '';
    render();
  });
  actions.append(saveButton, cancelButton);

  wrapper.append(textarea, hint, actions);
  if (state.promptSaveMessage) {
    const message = document.createElement('p');
    message.className = 'prompt-editor__message';
    message.textContent = state.promptSaveMessage;
    wrapper.appendChild(message);
  }
  return wrapper;
}

function promptKindLabel(promptNode) {
  if (promptNode?.type === 'image_prompt') return '图片提示词';
  if (promptNode?.type === 'audio_prompt') return '音频提示词';
  return '视频提示词';
}

function collectPromptReferences(promptId) {
  return buildPromptReferences({
    nodes: state.doc.nodes || [],
    edges: state.doc.edges || [],
    promptId
  });
}

function setQcEditor(cluster) {
  const qcCapable = cluster && cluster.column === 'product' && (cluster.members?.qc || cluster.qc);
  dom.qcStatus.disabled = !qcCapable;
  dom.qcNote.disabled = !qcCapable;
  dom.saveQcButton.disabled = !qcCapable;
  if (!qcCapable) {
    dom.qcStatus.value = 'reviewing';
    dom.qcNote.value = '';
    dom.qcUpdatedAt.textContent = cluster ? '该卡片不参与质检流程' : '';
    return;
  }
  const qc = cluster.qc || {};
  dom.qcStatus.value = QC_STATUSES.has(qc.status) ? qc.status : 'reviewing';
  // textarea.value 写入而不是 innerHTML，确保用户输入永不进入 HTML 解析路径。
  dom.qcNote.value = typeof qc.note === 'string' ? qc.note : '';
  dom.qcUpdatedAt.textContent = qc.updatedAt ? `更新于 ${formatTime(qc.updatedAt)}` : '尚未保存';
}

function setResourceActions(cluster) {
  const target = deletableNodeForCluster(cluster);
  const promotableVideo = promotableVideoForCluster(cluster);
  if (state.pendingDeleteResourceNodeId && state.pendingDeleteResourceNodeId !== target?.id) {
    state.pendingDeleteResourceNodeId = null;
  }
  dom.setCurrentVideoButton.disabled = !promotableVideo;
  dom.setCurrentVideoButton.dataset.nodeId = promotableVideo?.id || '';
  dom.deleteResourceButton.disabled = !target;
  dom.deleteResourceButton.dataset.nodeId = target?.id || '';
  dom.deleteResourceButton.textContent = target && state.pendingDeleteResourceNodeId === target.id
    ? '确认移入回收站'
    : '移入回收站';
  if (!cluster) {
    dom.resourceDeleteHint.textContent = '选择图片、音频或视频资源后可删除。';
    return;
  }
  if (promotableVideo) {
    dom.resourceDeleteHint.textContent = `${promotableVideo.title || promotableVideo.id} 是候选视频；确认可用后可设为当前版本，再进入 QC 和成片导出。`;
    return;
  }
  if (!target) {
    dom.resourceDeleteHint.textContent = '剧本、提示词和未生成占位不在第一版删除范围内。';
    return;
  }
  dom.resourceDeleteHint.textContent = `${target.title || target.id} 会从图谱移除；未被其他资源引用的文件会进入回收站。`;
}

function deletableNodeForCluster(cluster) {
  if (!cluster) return null;
  const node = cluster.members?.primaryOutput || cluster.members?.asset || null;
  if (!node) return null;
  return ['image_asset', 'audio_asset', 'video_output', 'text_output'].includes(node.type) ? node : null;
}

function promotableVideoForCluster(cluster) {
  const node = cluster?.members?.primaryOutput || null;
  if (!node || node.type !== 'video_output') return null;
  if (node.metadata?.versionRole === 'candidate') return node;
  const shot = findShotByNo(cluster.shotNo || state.shotNo);
  return shot?.videoVersions?.candidate === node.id ? node : null;
}

function findShotByNo(shotNo) {
  const normalized = String(shotNo || '').replace(/^shot:/, '');
  return (state.doc?.shots || []).find((shot) => {
    const candidate = shot.shotNo || String(shot.id || '').replace(/^shot:/, '');
    return shot.id === shotNo || shot.id === `shot:${normalized}` || candidate === normalized;
  }) || null;
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// QC 保存
// ---------------------------------------------------------------------------

async function savePromptText(promptNodeId, promptText) {
  const targetNode = (state.doc.nodes || []).find((node) => node.id === promptNodeId);
  const nextPrompt = String(promptText || '').trim();
  if (!targetNode) {
    state.errorMessage = '没有找到可保存的提示词。';
    setSaveState('error');
    render();
    return;
  }
  if (!nextPrompt) {
    state.promptSaveMessage = '提示词不能为空。';
    render();
    return;
  }

  const selectedNodeId = targetNode.id;
  // 只更新底层原始提示词；详情区的资源名展示和投喂包绑定仍分别由渲染层与引用边负责。
  targetNode.metadata = {
    ...(targetNode.metadata || {}),
    prompt: nextPrompt,
    promptUpdatedAt: new Date().toISOString()
  };

  setSaveState('saving');
  renderStatus();
  try {
    const response = await fetch('/api/episode', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, document: state.doc })
    });
    if (!response.ok) {
      await applyApiError(response, '保存提示词失败');
      return;
    }
    state.editingPromptNodeId = null;
    state.promptDraft = '';
    state.promptSaveMessage = '';
    await loadEpisode();
    selectClusterByNodeId(selectedNodeId);
    setSaveState('saved');
    state.errorMessage = '';
  } catch (error) {
    state.errorMessage = `保存提示词失败：${error.message}`;
    setSaveState('error');
  }
  render();
}

async function saveQcRecord() {
  const cluster = state.clusters.find((item) => item.id === state.selectedClusterId);
  if (!cluster) return;
  const selectedNodeId = cluster.primaryNodeId;
  const qcNodeId = cluster.members?.qc?.id;
  const targetNode = qcNodeId
    ? state.doc.nodes.find((node) => node.id === qcNodeId)
    : null;
  if (!targetNode) {
    state.errorMessage = '该 cluster 没有可写的 QC 节点。';
    setSaveState('error');
    render();
    return;
  }

  const status = QC_STATUSES.has(dom.qcStatus.value) ? dom.qcStatus.value : 'reviewing';
  const note = dom.qcNote.value.trim();
  targetNode.status = status;
  targetNode.metadata = {
    ...(targetNode.metadata || {}),
    qcNote: note,
    qcUpdatedAt: new Date().toISOString()
  };

  setSaveState('saving');
  render();
  try {
    const response = await fetch('/api/episode', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, document: state.doc })
    });
    if (!response.ok) {
      await applyApiError(response, '保存 QC 失败');
      return;
    }
    await loadEpisode();
    selectClusterByNodeId(selectedNodeId);
    setSaveState('saved');
    state.errorMessage = '';
  } catch (error) {
    state.errorMessage = `保存 QC 失败：${error.message}`;
    setSaveState('error');
  }
  render();
}

// ---------------------------------------------------------------------------
// 投喂预览
// ---------------------------------------------------------------------------

async function showFeedPackageSummary() {
  const result = createFeedPackagePreviewResult(state.doc);
  if (result.blocked) {
    // 阻断信息仍然使用 alert，避免项目提示词或检查文本进入 HTML 解析路径。
    window.alert(result.message);
    return;
  }

  const task = findCurrentVideoTask();
  if (!task) {
    window.alert('当前镜头没有可投喂到即梦的视频任务。');
    return;
  }

  try {
    const response = await fetch('/api/jimeng/feed-package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, taskId: task.id })
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      window.alert(payload?.error || `生成即梦投喂包失败：HTTP ${response.status}`);
      return;
    }
    renderJimengFeedPackage(payload.package);
    openJimengFeedDialog();
  } catch (error) {
    window.alert(`生成即梦投喂包失败：${error.message}`);
  }
}

function findCurrentVideoTask() {
  const shot = state.shotList.find((item) => item.shotNo === state.shotNo) || null;
  const normalizedShotNo = String(state.shotNo || '').replace(/^shot:/, '');
  return (state.doc.tasks || []).find((task) => {
    if (task.type !== 'video') return false;
    if (shot?.id && task.shotId === shot.id) return true;
    return String(task.shotId || '').replace(/^shot:/, '') === normalizedShotNo;
  }) || null;
}

function findPromptIdForCurrentShot() {
  const task = findCurrentVideoTask();
  if (task?.promptNodeId) return task.promptNodeId;
  const shot = state.shotList.find((item) => item.shotNo === state.shotNo) || null;
  const shotId = shot?.id || `shot:${String(state.shotNo || '').replace(/^shot:/, '')}`;
  const prompt = (state.doc.nodes || []).find((node) => node.shotId === shotId && (node.type === 'video_prompt' || node.type === 'image_prompt'));
  return prompt?.id || '';
}

function currentReferenceEdges() {
  const promptId = findPromptIdForCurrentShot();
  if (!promptId) return [];
  return (state.doc.edges || []).filter((edge) => edge.from === promptId && REFERENCE_EDGE_TYPES.has(edge.type));
}

function imageAssetsById() {
  return new Map((state.doc.nodes || [])
    .filter((node) => node.type === 'image_asset' && node.path)
    .map((node) => [node.id, node]));
}

function openReferenceManagerDialog() {
  if (!episodePath || !state.shotNo) return;
  state.referenceFilter = '';
  state.referenceReplaceEdgeId = null;
  dom.referenceAssetSearch.value = '';
  clearReferenceManagerError();
  renderReferenceManager();
  if (typeof dom.referenceManagerDialog.showModal === 'function') {
    dom.referenceManagerDialog.showModal();
  } else {
    dom.referenceManagerDialog.setAttribute('open', '');
  }
}

function renderReferenceManager() {
  const references = currentReferenceEdges();
  const assets = imageAssetsById();
  renderCurrentReferences(references, assets);
  renderAvailableReferences(references, assets);
}

function renderCurrentReferences(references, assets) {
  dom.currentReferenceCount.textContent = `${references.length} 项`;
  dom.currentReferenceList.replaceChildren();
  if (!references.length) {
    const empty = document.createElement('li');
    empty.className = 'reference-manager__empty';
    empty.textContent = '当前镜头还没有参考图片。';
    dom.currentReferenceList.appendChild(empty);
    return;
  }
  references.forEach((edge, index) => {
    const asset = assets.get(edge.to);
    const isReplacing = state.referenceReplaceEdgeId === edge.id;
    const item = buildReferenceItem({
      asset,
      edge,
      prefix: `上传顺序 ${index + 1}`,
      active: isReplacing,
      actions: [
        { label: '上移', disabled: index === 0, onClick: () => moveReference(index, -1) },
        { label: '下移', disabled: index === references.length - 1, onClick: () => moveReference(index, 1) },
        { label: isReplacing ? '取消替换' : '替换', onClick: () => toggleReplaceReference(edge) },
        { label: '移除', danger: true, onClick: () => removeReference(edge) }
      ]
    });
    dom.currentReferenceList.appendChild(item);
  });
}

function renderAvailableReferences(references, assets) {
  const attachedIds = new Set(references.map((edge) => edge.to));
  const replacingEdge = references.find((edge) => edge.id === state.referenceReplaceEdgeId) || null;
  const replacingIndex = replacingEdge ? references.findIndex((edge) => edge.id === replacingEdge.id) : -1;
  const filter = state.referenceFilter;
  const candidates = [...assets.values()]
    .filter((asset) => !attachedIds.has(asset.id))
    .filter((asset) => {
      if (!filter) return true;
      return [asset.title, asset.path, asset.metadata?.role, asset.id]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(filter));
    })
    .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id, 'zh-CN'));

  dom.availableReferenceList.replaceChildren();
  if (!candidates.length) {
    const empty = document.createElement('div');
    empty.className = 'reference-manager__empty';
    empty.textContent = replacingEdge
      ? '没有可替换的图片资产，可先导入外部图片或在资产库补充。'
      : (filter ? '没有匹配的图片资产。' : '没有可添加的图片资产，可先导入外部图片或在资产库补充。');
    dom.availableReferenceList.appendChild(empty);
    return;
  }
  for (const asset of candidates) {
    const item = buildReferenceItem({
      asset,
      prefix: asset.shotId ? '分镜资产' : '公共资产',
      actions: [{
        label: replacingEdge ? `替换到第 ${replacingIndex + 1} 位` : '添加到末尾',
        primary: true,
        onClick: () => (replacingEdge ? replaceReference(asset, replacingEdge) : addReference(asset))
      }]
    });
    dom.availableReferenceList.appendChild(item);
  }
}

function buildReferenceItem({ asset, edge, prefix, actions, active = false }) {
  const item = document.createElement(edge ? 'li' : 'div');
  item.className = 'reference-manager__item';
  if (active) item.classList.add('is-replacing');

  const preview = document.createElement('div');
  preview.className = 'reference-manager__preview';
  if (asset?.path) {
    const img = document.createElement('img');
    img.alt = asset.title || asset.id;
    img.loading = 'lazy';
    img.src = assetUrl(asset.path);
    img.addEventListener('error', () => {
      preview.textContent = '无预览';
    });
    preview.appendChild(img);
  } else {
    preview.textContent = '缺失';
  }
  item.appendChild(preview);

  const body = document.createElement('div');
  body.className = 'reference-manager__item-body';
  const title = document.createElement('strong');
  title.textContent = asset?.title || edge?.to || '未知资源';
  const meta = document.createElement('span');
  meta.textContent = [prefix, edge?.role || asset?.metadata?.role || '参考图', asset?.path || '无路径'].filter(Boolean).join(' · ');
  body.append(title, meta);
  item.appendChild(body);

  const actionWrap = document.createElement('div');
  actionWrap.className = 'reference-manager__actions';
  for (const action of actions || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.primary ? 'primary-button' : (action.danger ? 'danger-button' : 'ghost-button');
    button.textContent = action.label;
    button.disabled = !!action.disabled;
    button.addEventListener('click', action.onClick);
    actionWrap.appendChild(button);
  }
  item.appendChild(actionWrap);
  return item;
}

async function addReference(asset) {
  await mutateReferenceManager('/api/episode/references', {
    method: 'POST',
    body: { episodePath, shotNo: state.shotNo, assetNodeId: asset.id, role: asset.metadata?.role || 'reference_image' }
  });
}

function toggleReplaceReference(edge) {
  state.referenceReplaceEdgeId = state.referenceReplaceEdgeId === edge.id ? null : edge.id;
  renderReferenceManager();
}

async function replaceReference(asset, edge) {
  await mutateReferenceManager('/api/episode/references', {
    method: 'PATCH',
    body: {
      episodePath,
      shotNo: state.shotNo,
      referenceEdgeId: edge.id,
      assetNodeId: asset.id,
      role: asset.metadata?.role || 'reference_image'
    }
  });
}

async function moveReference(index, delta) {
  const references = currentReferenceEdges();
  const next = [...references];
  const target = index + delta;
  if (target < 0 || target >= next.length) return;
  [next[index], next[target]] = [next[target], next[index]];
  await mutateReferenceManager('/api/episode/references', {
    method: 'PATCH',
    body: { episodePath, shotNo: state.shotNo, orderedAssetNodeIds: next.map((edge) => edge.to) }
  });
}

async function removeReference(edge) {
  await mutateReferenceManager('/api/episode/references', {
    method: 'DELETE',
    body: { episodePath, shotNo: state.shotNo, referenceEdgeId: edge.id }
  });
}

async function mutateReferenceManager(url, { method, body }) {
  clearReferenceManagerError();
  setSaveState('saving');
  renderStatus();
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      showReferenceManagerError(payload?.error || `参考资源操作失败：HTTP ${response.status}`);
      setSaveState('error');
      renderStatus();
      return;
    }
    state.referenceReplaceEdgeId = null;
    await loadEpisode();
    renderReferenceManager();
  } catch (error) {
    showReferenceManagerError(`参考资源操作失败：${error.message}`);
    setSaveState('error');
    renderStatus();
  }
}

function showReferenceManagerError(message) {
  dom.referenceManagerError.hidden = false;
  dom.referenceManagerError.textContent = message;
}

function clearReferenceManagerError() {
  dom.referenceManagerError.hidden = true;
  dom.referenceManagerError.textContent = '';
}

function renderJimengFeedPackage(feedPackage) {
  state.jimengFeedPackage = feedPackage;
  dom.jimengFeedTitle.textContent = `${feedPackage.shot?.shotNo || '当前镜头'} · ${feedPackage.workspace?.model || 'Seedance 2.0'}`;
  dom.jimengTargetLink.href = feedPackage.targetUrl || 'https://jimeng.jianying.com/';
  renderJimengAutomationStatus('');
  setJimengPackageActionsEnabled(true);
  dom.jimengPromptText.value = feedPackage.prompt || '';
  renderJimengReferences(feedPackage.references || []);
  renderJimengGates(feedPackage.gates || []);
  renderJimengWarnings(feedPackage.warnings || []);
}

function renderJimengAutomationPending(task) {
  state.jimengFeedPackage = null;
  const shotLabel = state.shotNo ? `镜头 ${state.shotNo}` : '当前镜头';
  dom.jimengFeedTitle.textContent = `${shotLabel} · 即梦自动化准备中`;
  dom.jimengTargetLink.href = 'https://jimeng.jianying.com/';
  dom.jimengPromptText.value = '正在读取当前镜头的视频任务、参考图顺序和全局即梦模型配置…';
  renderJimengReferences([]);
  renderJimengGates([
    'reference_asset_gate',
    'resource_mention_binding_gate',
    'pre_submit_confirmation'
  ]);
  renderJimengWarnings([]);
  setJimengPackageActionsEnabled(false);
  renderJimengAutomationStatus(task
    ? '正在打开 Drama Creator 托管的即梦窗口，并准备提示词和参考图顺序…\n这个窗口独立于你平时打开的 Chrome/即梦标签。'
    : '当前镜头没有可启动即梦自动化的视频任务。');
}

function setJimengPackageActionsEnabled(enabled) {
  // 投喂包尚未返回前禁止复制旧内容，避免用户把上一镜头的清单误投到即梦。
  dom.copyJimengPrompt.disabled = !enabled;
  dom.copyJimengUploadList.disabled = !enabled;
  dom.copyJimengJson.disabled = !enabled;
}

function renderJimengAutomationStatus(message, tone = 'info') {
  const text = String(message || '').trim();
  dom.jimengAutomationStatus.hidden = !text;
  dom.jimengAutomationStatus.textContent = text;
  dom.jimengAutomationStatus.dataset.tone = text ? tone : '';
}

function formatJimengAutomationStatus(automation = {}, feedPackage = null) {
  const pageAutomation = automation.pageAutomation || {};
  const status = pageAutomation.status || automation.status || '';
  const referenceTotal = Array.isArray(feedPackage?.references) ? feedPackage.references.length : 0;
  const lines = [
    jimengAutomationLead(status),
    // 托管窗口和日常 Chrome 在 macOS 上都显示为 Google Chrome；这里必须把验收位置说清楚，避免用户看错空白标签。
    '请检查 Drama Creator 托管的即梦窗口；你平时打开的 Chrome/即梦标签可能仍是空输入框。',
    formatJimengReferenceStatus(pageAutomation, referenceTotal),
    formatJimengPageSetupStatus(pageAutomation),
    automation.nextAction ? `下一步：${automation.nextAction}` : ''
  ];
  const extraNotes = Array.isArray(pageAutomation.notes)
    ? pageAutomation.notes.filter((note) => !/页面已进入|当前即梦参数|参考资源|引用参考绑定|当前 chip/.test(String(note || ''))).slice(0, 2)
    : [];
  return [...lines, ...extraNotes].filter(Boolean).join('\n');
}

function jimengAutomationLead(status) {
  if (status === 'pre_submit_confirmation') {
    return '已把当前镜头的提示词填入 Drama Creator 托管的即梦窗口，并停在提交前确认。';
  }
  if (status === 'manual_reference_binding_required') {
    return '托管的即梦窗口已打开，但仍有引用资源需要你在提交前手动绑定。';
  }
  if (status === 'manual_upload_required') {
    return '托管的即梦窗口已打开，但参考图仍需要你按上传清单手动补齐。';
  }
  if (status === 'login_required') {
    return '托管的即梦窗口已打开，需要先在这个窗口完成即梦登录。';
  }
  if (status === 'script_failed') {
    return '托管的即梦窗口已打开，但页面自动填入没有完成。';
  }
  return '已打开 Drama Creator 托管的即梦窗口。';
}

function formatJimengReferenceStatus(pageAutomation = {}, referenceTotal = 0) {
  const uploaded = numberOrNull(pageAutomation.filesAttached);
  const bound = numberOrNull(pageAutomation.boundReferenceCount ?? pageAutomation.chipCount);
  const rawMentionCount = numberOrNull(pageAutomation.rawMentionCount);
  const parts = [];
  if (uploaded !== null) parts.push(`参考图已上传 ${formatJimengCount(uploaded, referenceTotal)}`);
  if (bound !== null) parts.push(`引用标签已绑定 ${formatJimengCount(bound, referenceTotal)}`);
  if (rawMentionCount !== null) parts.push(`未绑定 @图片N：${rawMentionCount} 个`);
  return parts.length ? `${parts.join('，')}。` : '';
}

function formatJimengPageSetupStatus(pageAutomation = {}) {
  const toolbarText = String(pageAutomation.pageSetup?.toolbarText || '').replace(/\s+/g, ' / ').trim();
  return toolbarText ? `页面参数：${toolbarText}` : '';
}

function formatJimengCount(count, total) {
  return total > 0 ? `${count}/${total}` : `${count}`;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function jimengAutomationStatusTone(automation = {}) {
  const status = automation.pageAutomation?.status || automation.status || '';
  if (status === 'pre_submit_confirmation') return 'success';
  if (/manual_|failed|error|required/.test(status)) return 'warning';
  return 'info';
}

function renderJimengReferences(references) {
  dom.jimengReferenceList.replaceChildren();
  if (!references.length) {
    appendListText(dom.jimengReferenceList, '当前任务没有参考图，自动化执行器将只投喂提示词。');
    return;
  }
  for (const ref of references) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${ref.placeholder} · ${ref.role || '参考图'} · `;
    const code = document.createElement('code');
    code.textContent = ref.uploadPath || ref.path || '';
    li.append(label, code);
    dom.jimengReferenceList.appendChild(li);
  }
}

function renderJimengGates(gates) {
  dom.jimengGateList.replaceChildren();
  const labels = {
    reference_asset_gate: '确认上传的参考图可见、无错误裁切',
    resource_mention_binding_gate: '确认提示词里的 @图片N 与上传图片一一绑定',
    pre_submit_confirmation: '点击生成前停下等待用户确认',
    submission_success_gate: '提交后确认页面进入生成队列或生成中状态',
    download_validation: '下载后确认文件可播放，再导入当前镜头'
  };
  for (const gate of gates) appendListText(dom.jimengGateList, labels[gate] || gate);
}

function renderJimengWarnings(warnings) {
  dom.jimengWarningList.replaceChildren();
  dom.jimengWarningSection.hidden = warnings.length === 0;
  for (const warning of warnings) appendListText(dom.jimengWarningList, warning.message || warning.code);
}

function appendListText(list, text) {
  const li = document.createElement('li');
  li.textContent = text;
  list.appendChild(li);
}

function openJimengFeedDialog() {
  if (dom.jimengFeedDialog.open) return;
  if (typeof dom.jimengFeedDialog.showModal === 'function') {
    dom.jimengFeedDialog.showModal();
  } else {
    dom.jimengFeedDialog.setAttribute('open', '');
  }
}

async function copyJimengPromptText() {
  await copyToClipboard(dom.jimengPromptText.value, '提示词已复制');
}

async function copyJimengUploadChecklist() {
  await copyToClipboard(buildJimengUploadChecklist(state.jimengFeedPackage), '上传清单已复制');
}

async function startJimengAutomationRun() {
  const task = findCurrentVideoTask();
  if (!task) {
    renderJimengAutomationPending(null);
    openJimengFeedDialog();
    return;
  }

  renderJimengAutomationPending(task);
  openJimengFeedDialog();
  setJimengAutomationBusy(true);
  try {
    const response = await fetch('/api/jimeng/automation/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, taskId: task.id })
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      const missingRefs = Array.isArray(payload?.missingReferences) && payload.missingReferences.length
        ? `\n缺失参考：${payload.missingReferences.map((item) => item.placeholder || item.uploadPath).join('、')}`
        : '';
      renderJimengAutomationStatus(`${payload?.message || payload?.error || `启动即梦自动化失败：HTTP ${response.status}`}${missingRefs}`);
      return;
    }

    const automation = payload.automation || {};
    if (payload.package) renderJimengFeedPackage(payload.package);
    // 主流程只展示创作者可执行的验收信息；运行目录等排障细节由后端写入本地运行记录。
    renderJimengAutomationStatus(
      formatJimengAutomationStatus(automation, payload.package),
      jimengAutomationStatusTone(automation)
    );
    openJimengFeedDialog();
  } catch (error) {
    renderJimengAutomationStatus(`启动即梦自动化失败：${error.message}`);
  } finally {
    setJimengAutomationBusy(false);
    renderHeader();
  }
}

function setJimengAutomationBusy(isBusy) {
  // 顶部主按钮和弹窗内按钮走同一条启动链路，避免两个入口状态不一致。
  dom.submitJimengAutomationButton.disabled = isBusy;
  dom.startJimengAutomation.disabled = isBusy;
  dom.submitJimengAutomationButton.textContent = isBusy ? '正在打开即梦…' : '提交到即梦生成';
  dom.startJimengAutomation.textContent = isBusy ? '正在打开即梦…' : '提交到即梦生成';
}

function buildJimengUploadChecklist(feedPackage) {
  if (!feedPackage) return '';
  const shot = feedPackage.shot?.shotNo || '当前镜头';
  const title = feedPackage.shot?.title ? ` · ${feedPackage.shot.title}` : '';
  const references = feedPackage.references || [];
  const lines = [
    `即梦上传清单：${shot}${title}`,
    `目标页面：${feedPackage.targetUrl || 'https://jimeng.jianying.com/'}`,
    `模型：${feedPackage.workspace?.model || 'Seedance 2.0'}`,
    `比例 / 时长：${feedPackage.params?.ratio || '未指定'} / ${feedPackage.params?.duration || '未指定'}s`,
    '',
    '参考图上传顺序：'
  ];
  if (references.length) {
    references.forEach((ref) => {
      lines.push(`${ref.placeholder} · ${ref.title || ref.role || '参考图'} · ${ref.uploadPath || ref.path || ''}`);
    });
  } else {
    lines.push('无参考图，仅复制提示词。');
  }
  lines.push(
    '',
    '提交前检查：',
    '1. 按上传顺序在即梦中选择参考图。',
    '2. 提示词里的 @图片N 必须替换为即梦真实资源 chip，不保留普通文本 @图片N。',
    '3. 点击生成前停下确认模型、比例、时长和参考图绑定。',
    '4. 自动化使用 Drama Creator 托管的浏览器 profile，不复用你的日常 Chrome 登录态。',
    '',
    '生成后回填：',
    '下载 MP4 后回到 Drama Creator 当前镜头页，点击「导入外部资源」，类型选择「视频」，选择下载的 MP4；导入后在资源详情里完成 QC。'
  );
  return lines.join('\n');
}

async function copyJimengPackageJson() {
  const json = JSON.stringify(state.jimengFeedPackage || {}, null, 2);
  await copyToClipboard(json, '投喂包 JSON 已复制');
}

async function copyToClipboard(text, successMessage) {
  if (!navigator.clipboard?.writeText) {
    window.alert('当前环境不支持剪贴板写入，请手动复制。');
    return;
  }
  try {
    await navigator.clipboard.writeText(text || '');
    window.alert(successMessage);
  } catch (error) {
    window.alert(`复制失败：${error.message || error}`);
  }
}

// ---------------------------------------------------------------------------
// 缩放 / 平移 / 拖动
// ---------------------------------------------------------------------------

function bindEvents() {
  dom.feedButton.addEventListener('click', showFeedPackageSummary);
  dom.submitJimengAutomationButton.addEventListener('click', startJimengAutomationRun);
  dom.jimengFeedClose.addEventListener('click', () => dom.jimengFeedDialog.close());
  dom.copyJimengPrompt.addEventListener('click', copyJimengPromptText);
  dom.copyJimengUploadList.addEventListener('click', copyJimengUploadChecklist);
  dom.copyJimengJson.addEventListener('click', copyJimengPackageJson);
  dom.startJimengAutomation.addEventListener('click', startJimengAutomationRun);
  dom.saveQcButton.addEventListener('click', saveQcRecord);
  dom.prevButton.addEventListener('click', () => navigateToShot(dom.prevButton.dataset.target));
  dom.nextButton.addEventListener('click', () => navigateToShot(dom.nextButton.dataset.target));
  dom.referenceManagerButton.addEventListener('click', openReferenceManagerDialog);
  dom.referenceManagerClose.addEventListener('click', () => dom.referenceManagerDialog.close());
  dom.referenceAssetSearch.addEventListener('input', () => {
    state.referenceFilter = dom.referenceAssetSearch.value.trim().toLowerCase();
    renderReferenceManager();
  });
  dom.manualImportButton.addEventListener('click', openManualImportDialog);
  dom.manualImportFileButton.addEventListener('click', pickManualAssetFile);
  dom.manualImportCancel.addEventListener('click', () => dom.manualImportDialog.close());
  dom.manualImportForm.addEventListener('submit', importManualAsset);
  dom.setCurrentVideoButton.addEventListener('click', promoteSelectedVideoVersion);
  dom.deleteResourceButton.addEventListener('click', deleteSelectedResource);
  dom.manualImportKind.addEventListener('change', () => {
    // 类型切换后清空路径，避免把视频路径误按图片导入，反之亦然。
    dom.manualImportPath.value = '';
    clearManualImportError();
  });

  dom.zoomIn.addEventListener('click', () => setZoom(state.zoom * 1.15));
  dom.zoomOut.addEventListener('click', () => setZoom(state.zoom / 1.15));
  dom.zoomReset.addEventListener('click', fitToContent);

  dom.viewport.addEventListener('wheel', onWheel, { passive: false });
  dom.viewport.addEventListener('pointerdown', onViewportPointerDown);
  dom.cards.addEventListener('pointerdown', onCardPointerDown);
  dom.cards.addEventListener('keydown', onCardKeyDown);

  window.addEventListener('resize', () => {
    if (state.clusters.length) renderLinks();
  });
}

function navigateToShot(shotNo) {
  if (!shotNo) return;
  const url = new URL(window.location.href);
  url.searchParams.set('shot', shotNo);
  window.location.href = url.toString();
}

function openManualImportDialog() {
  if (!episodePath || !state.shotNo) return;
  dom.manualImportKind.value = 'image';
  dom.manualImportPath.value = '';
  dom.manualImportTitle.value = '';
  clearManualImportError();
  if (typeof dom.manualImportDialog.showModal === 'function') {
    dom.manualImportDialog.showModal();
  } else {
    dom.manualImportDialog.setAttribute('open', '');
  }
}

async function pickManualAssetFile() {
  const invoke = getTauriInvoke();
  if (!invoke) {
    showManualImportError('桌面端可直接选择文件；浏览器中请粘贴图片或视频的绝对路径。');
    return;
  }
  try {
    // 只接收用户通过系统文件选择器显式选中的路径；实际复制和类型校验仍由 Node API 完成。
    const selectedPath = await invoke('pick_asset_file', { kind: dom.manualImportKind.value });
    if (selectedPath) {
      dom.manualImportPath.value = selectedPath;
      clearManualImportError();
    }
  } catch (error) {
    showManualImportError(`选择文件失败：${error.message || error}`);
  }
}

async function importManualAsset(event) {
  event.preventDefault();
  const sourcePath = dom.manualImportPath.value.trim();
  const kind = dom.manualImportKind.value;
  const title = dom.manualImportTitle.value.trim();
  if (!sourcePath) {
    showManualImportError('请先选择或填写资源文件路径。');
    return;
  }

  setSaveState('saving');
  renderStatus();
  try {
    const response = await fetch('/api/manual-assets/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodePath,
        sourcePath,
        kind,
        shotNo: state.shotNo,
        title: title || undefined
      })
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      showManualImportError(payload?.error || `导入失败：HTTP ${response.status}`);
      setSaveState('error');
      renderStatus();
      return;
    }
    dom.manualImportDialog.close();
    await loadEpisode();
    selectClusterByNodeId(payload?.asset?.id);
  } catch (error) {
    showManualImportError(`导入请求失败：${error.message}`);
    setSaveState('error');
    renderStatus();
  }
}

async function deleteSelectedResource() {
  const nodeId = dom.deleteResourceButton.dataset.nodeId;
  const cluster = state.clusters.find((item) => item.id === state.selectedClusterId);
  const target = deletableNodeForCluster(cluster);
  if (!nodeId || !target) return;

  const label = target.title || nodeId;
  if (state.pendingDeleteResourceNodeId !== nodeId) {
    state.pendingDeleteResourceNodeId = nodeId;
    // 桌面端不使用原生 confirm；确认态留在右侧资源详情内，用户能看清将删除哪个资源。
    dom.deleteResourceButton.textContent = '确认移入回收站';
    dom.resourceDeleteHint.textContent = `再次点击会把 ${label} 移入回收站；未被其他资源引用的文件也会进入回收站。`;
    return;
  }

  state.pendingDeleteResourceNodeId = null;
  dom.deleteResourceButton.disabled = true;
  dom.deleteResourceButton.textContent = '删除中…';
  setSaveState('saving');
  renderStatus();
  try {
    const response = await fetch('/api/episode/resources', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, nodeId })
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      state.errorMessage = payload?.error || `删除资源失败：HTTP ${response.status}`;
      setSaveState('error');
      render();
      return;
    }
    state.selectedClusterId = null;
    await loadEpisode();
  } catch (error) {
    state.errorMessage = `删除资源失败：${error.message}`;
    setSaveState('error');
    render();
  } finally {
    state.pendingDeleteResourceNodeId = null;
  }
}

async function promoteSelectedVideoVersion() {
  const cluster = state.clusters.find((item) => item.id === state.selectedClusterId);
  const target = promotableVideoForCluster(cluster);
  if (!target) return;

  dom.setCurrentVideoButton.disabled = true;
  setSaveState('saving');
  renderStatus();
  try {
    const response = await fetch('/api/episode/video-version/current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, shotNo: state.shotNo, nodeId: target.id })
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      state.errorMessage = payload?.error || `设为当前版本失败：HTTP ${response.status}`;
      setSaveState('error');
      render();
      return;
    }
    await loadEpisode();
    selectClusterByNodeId(target.id);
    state.errorMessage = '';
    setSaveState('saved');
    render();
  } catch (error) {
    state.errorMessage = `设为当前版本失败：${error.message}`;
    setSaveState('error');
    render();
  }
}

function selectClusterByNodeId(nodeId) {
  if (!nodeId) return;
  const cluster = state.clusters.find((item) => item.memberIds?.includes(nodeId));
  if (!cluster) return;
  state.selectedClusterId = cluster.id;
  render();
}

function getTauriInvoke() {
  return window.__TAURI__?.core?.invoke;
}

function showManualImportError(message) {
  dom.manualImportError.hidden = false;
  dom.manualImportError.textContent = message;
}

function clearManualImportError() {
  dom.manualImportError.hidden = true;
  dom.manualImportError.textContent = '';
}

function setZoom(nextZoom, anchor) {
  const clamped = Math.max(0.25, Math.min(2.5, nextZoom));
  if (anchor) {
    // 以光标为缩放中心，保持光标下逻辑坐标不变
    const beforeX = (anchor.x - state.pan.x) / state.zoom;
    const beforeY = (anchor.y - state.pan.y) / state.zoom;
    state.zoom = clamped;
    state.pan.x = anchor.x - beforeX * state.zoom;
    state.pan.y = anchor.y - beforeY * state.zoom;
  } else {
    state.zoom = clamped;
  }
  applyTransform();
  renderLinks();
}

function applyTransform() {
  dom.stage.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  dom.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitToContent() {
  if (!state.clusters.length) return;
  let maxX = 0;
  let maxY = 0;
  for (const cluster of state.clusters) {
    const pos = effectivePosition(cluster);
    maxX = Math.max(maxX, pos.x + LAYOUT_METRICS.cardWidth);
    maxY = Math.max(maxY, pos.y + LAYOUT_METRICS.rowHeight);
  }
  const padding = 80;
  const viewportRect = dom.viewport.getBoundingClientRect();
  const zoomX = (viewportRect.width - padding * 2) / Math.max(maxX, 1);
  const zoomY = (viewportRect.height - padding * 2) / Math.max(maxY, 1);
  state.zoom = Math.max(0.35, Math.min(1, Math.min(zoomX, zoomY)));
  state.pan.x = padding;
  state.pan.y = padding;
  applyTransform();
  renderLinks();
}

function onWheel(event) {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    const rect = dom.viewport.getBoundingClientRect();
    setZoom(state.zoom * (event.deltaY < 0 ? 1.08 : 0.92), {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    });
  } else {
    event.preventDefault();
    state.pan.x -= event.deltaX;
    state.pan.y -= event.deltaY;
    applyTransform();
    renderLinks();
  }
}

function onViewportPointerDown(event) {
  if (event.target.closest('.cluster-card')) return; // 卡片自有 handler
  if (event.button !== 0) return;
  event.preventDefault();
  const startX = event.clientX;
  const startY = event.clientY;
  const startPan = { ...state.pan };
  dom.viewport.dataset.panning = 'true';
  dom.viewport.setPointerCapture(event.pointerId);

  const move = (e) => {
    state.pan.x = startPan.x + (e.clientX - startX);
    state.pan.y = startPan.y + (e.clientY - startY);
    applyTransform();
  };
  const up = (e) => {
    dom.viewport.removeEventListener('pointermove', move);
    dom.viewport.removeEventListener('pointerup', up);
    dom.viewport.removeEventListener('pointercancel', up);
    dom.viewport.dataset.panning = 'false';
    try { dom.viewport.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    renderLinks();
  };
  dom.viewport.addEventListener('pointermove', move);
  dom.viewport.addEventListener('pointerup', up);
  dom.viewport.addEventListener('pointercancel', up);
}

function onCardPointerDown(event) {
  const card = event.target.closest('.cluster-card');
  if (!card) return;
  if (isCardInteractiveTarget(event.target)) return;
  if (event.button !== 0) return;
  const clusterId = card.dataset.clusterId;
  const cluster = state.clusters.find((item) => item.id === clusterId);
  if (!cluster) return;
  event.stopPropagation();

  const startX = event.clientX;
  const startY = event.clientY;
  const startPos = effectivePosition(cluster);
  let dragged = false;

  card.setPointerCapture(event.pointerId);

  const move = (e) => {
    const dx = (e.clientX - startX) / state.zoom;
    const dy = (e.clientY - startY) / state.zoom;
    if (!dragged && Math.hypot(dx, dy) > 4) {
      dragged = true;
      card.classList.add('is-dragging');
    }
    if (!dragged) return;
    const next = { x: startPos.x + dx, y: startPos.y + dy };
    state.positionOverrides.set(cluster.id, next);
    card.style.left = `${next.x}px`;
    card.style.top = `${next.y}px`;
    renderLinks();
  };

  const up = (e) => {
    card.removeEventListener('pointermove', move);
    card.removeEventListener('pointerup', up);
    card.removeEventListener('pointercancel', up);
    try { card.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    card.classList.remove('is-dragging');
    if (!dragged) {
      state.selectedClusterId = state.selectedClusterId === cluster.id ? null : cluster.id;
      render();
    }
  };

  card.addEventListener('pointermove', move);
  card.addEventListener('pointerup', up);
  card.addEventListener('pointercancel', up);
}

function onCardKeyDown(event) {
  if (isCardInteractiveTarget(event.target)) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('.cluster-card');
  if (!card) return;
  event.preventDefault();
  const clusterId = card.dataset.clusterId;
  state.selectedClusterId = state.selectedClusterId === clusterId ? null : clusterId;
  render();
}

function isCardInteractiveTarget(target) {
  // 原生媒体控件、表单控件和按钮拥有自己的交互语义；画布拖拽/选中逻辑必须给它们让路。
  return !!target?.closest?.('video, audio, button, input, textarea, select, a, [contenteditable="true"]');
}

function effectivePosition(cluster) {
  const override = state.positionOverrides.get(cluster.id);
  if (override) return override;
  return { x: cluster.position.x, y: cluster.position.y };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function setSaveState(next) {
  state.saveState = next;
}

function showOverlay({ title, body, hint }) {
  dom.overlay.hidden = false;
  dom.overlayTitle.textContent = title;
  dom.overlayBody.textContent = body;
  dom.overlayHint.textContent = hint || '';
}

async function applyApiError(response, fallback) {
  let message = `${fallback}：HTTP ${response.status}`;
  try {
    const payload = await response.json();
    if (payload?.error) message = payload.error;
  } catch { /* noop */ }
  state.errorMessage = message;
  setSaveState('error');
  render();
}

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

function createEmptyDocument() {
  return {
    schemaVersion: '0.1.0',
    project: { name: '' },
    episode: { id: '', path: '' },
    nodes: [],
    edges: [],
    tasks: [],
    checks: []
  };
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9\-_]/g, (ch) => `\\${ch}`);
}
