/*
 * 项目库首页脚本：
 * - 读取应用工作区中的最近项目；
 * - 通过 V1 新建项目接口创建首集；
 * - 成功后直接进入该项目，避免用户理解底层目录结构。
 */

// 首页卡片只展示当前 workflow 阶段；公共资产库在 step 上收敛为“公共资产”。
const stepLabels = new Map([
  ['script_shots', '剧本与分镜'],
  ['asset_library', '公共资产'],
  ['shot_videos', '分镜视频'],
  ['export', '成片导出']
]);
// 起步方式与后端 V1_START_MODES 保持同名，避免前端文案调整时传出未知模式。
const startModes = new Set(['idea_text', 'story_text', 'material_text']);
const startModeCopy = {
  idea_text: {
    label: '想法',
    placeholder: '例如：一个被 AI 替代的程序员，用自己做的工具重新证明价值。',
    hint: '只写一句创意即可。生成完整故事后仍可继续编辑；如果暂时不配置文本模型，也可以手动补写完整故事。'
  },
  story_text: {
    label: '故事源',
    placeholder: '粘贴故事梗概、小说片段或口播稿。',
    hint: '粘贴已有故事源，进入项目后可继续改编成剧本。'
  },
  material_text: {
    label: '已有素材文本',
    placeholder: '粘贴已有剧本、分镜说明、提示词或素材清单。',
    hint: '适合已经有剧本、分镜或素材清单的项目。'
  }
};
// 短想法在创建时自动调用文本模型扩写；长文本视为用户已手动补全的故事，直接创建。
const IDEA_AUTO_GENERATE_MAX_LENGTH = 180;
const TEXT_MODEL_SETTINGS_URL = 'settings.html#model-text';
// 新建项目对普通用户只暴露项目名；首集仍按产品规则自动创建为“第 1 集”。
const DEFAULT_FIRST_EPISODE_NAME = '第 1 集';
let pendingDeleteProjectPath = null;
let generatedStoryState = { idea: '', story: '' };

const dom = {
  grid: document.getElementById('projectsGrid'),
  state: document.getElementById('projectsState'),
  discoveryNote: document.getElementById('discoveryNote'),
  newProjectButton: document.getElementById('newProjectButton'),
  dialog: document.getElementById('newProjectDialog'),
  form: document.getElementById('newProjectForm'),
  inputName: document.getElementById('newProjectName'),
  sourceText: document.getElementById('sourceText'),
  sourceTextLabel: document.getElementById('sourceTextLabel'),
  sourceTextHint: document.getElementById('sourceTextHint'),
  generateStoryButton: document.getElementById('generateStoryButton'),
  errorBox: document.getElementById('newProjectError'),
  cancel: document.getElementById('newProjectCancel')
};

dom.newProjectButton.addEventListener('click', () => openDialog());
dom.cancel.addEventListener('click', () => closeDialog());
dom.form.addEventListener('submit', onSubmit);
dom.generateStoryButton.addEventListener('click', () => generateStoryFromIdea({ forSubmit: false }));
dom.sourceText.addEventListener('input', () => {
  if (dom.sourceText.value.trim() !== generatedStoryState.story) {
    generatedStoryState = { idea: generatedStoryState.idea, story: '' };
  }
});
for (const input of dom.form.querySelectorAll('input[name="startMode"]')) {
  input.addEventListener('change', () => updateStartModeUi());
}

await loadProjects();

async function loadProjects() {
  showState({ kind: 'loading' });
  try {
    const response = await fetch('/api/projects');
    if (!response.ok) {
      const payload = await safeReadJson(response);
      showState({ kind: 'error', message: payload?.error || `HTTP ${response.status}` });
      return;
    }
    const json = await response.json();
    renderProjects(json.projects || []);
  } catch (error) {
    showState({ kind: 'error', message: `读取项目列表失败：${error.message}` });
  }
}

function renderProjects(projects) {
  if (!projects.length) {
    showState({
      kind: 'empty',
      title: '还没有项目',
      body: '点击新建项目，从想法、故事或已有素材文本开始。'
    });
    dom.discoveryNote.textContent = '0 个项目';
    return;
  }

  dom.state.hidden = true;
  dom.grid.replaceChildren();
  for (const project of projects) {
    dom.grid.appendChild(buildProjectCard(project));
  }
  const appOwnedCount = projects.filter((project) => project.source === 'app').length;
  dom.discoveryNote.textContent = `${projects.length} 个项目 · 应用项目 ${appOwnedCount}`;
}

function buildProjectCard(project) {
  const card = document.createElement('article');
  card.className = 'project-card';
  card.tabIndex = 0;
  card.role = 'button';
  card.setAttribute('aria-label', `打开项目 ${project.name || '未命名项目'}`);
  card.dataset.path = project.path;
  const openProject = () => {
    location.href = `/project.html?path=${encodeURIComponent(project.path)}`;
  };
  card.addEventListener('click', (event) => {
    if (event.target.closest('button, a, input, textarea, select')) return;
    openProject();
  });
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openProject();
  });

  const top = document.createElement('div');
  top.className = 'project-card__top';
  const title = document.createElement('h3');
  title.className = 'project-card__title';
  title.textContent = project.name || '(未命名项目)';
  top.appendChild(title);
  const source = document.createElement('span');
  source.className = 'project-card__source';
  source.dataset.source = project.source || 'app';
  source.textContent = project.source === 'app' ? '应用项目' : '兼容项目';
  top.appendChild(source);
  card.appendChild(top);

  const currentStep = project.currentStep || project.episodes?.[0]?.currentStep || 'script_shots';
  const step = document.createElement('p');
  step.className = 'project-card__step';
  step.textContent = `当前步骤：${stepLabels.get(currentStep) || '剧本与分镜'}`;
  card.appendChild(step);

  const progress = document.createElement('div');
  progress.className = 'project-card__progress';
  const row = document.createElement('div');
  row.className = 'progress-row';
  const total = project.progress?.total || 0;
  const approved = project.progress?.approved || 0;
  const ratio = total ? Math.min(1, approved / total) : 0;
  const labelLeft = document.createElement('span');
  labelLeft.textContent = total ? `分镜视频 ${approved} / ${total}` : '等待拆分分镜';
  const labelRight = document.createElement('span');
  labelRight.textContent = total ? `${Math.round(ratio * 100)}%` : '未开始';
  row.appendChild(labelLeft);
  row.appendChild(labelRight);
  progress.appendChild(row);
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const fill = document.createElement('span');
  fill.className = 'progress-bar__fill';
  fill.style.transform = `scaleX(${ratio})`;
  bar.appendChild(fill);
  progress.appendChild(bar);
  card.appendChild(progress);

  const meta = document.createElement('div');
  meta.className = 'project-card__meta';
  const episodes = document.createElement('span');
  episodes.textContent = `${project.episodes?.length || 0} 集`;
  meta.appendChild(episodes);
  const updated = document.createElement('span');
  updated.textContent = project.updatedAt ? `更新于 ${formatTime(project.updatedAt)}` : '刚刚创建';
  meta.appendChild(updated);
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'project-card__actions';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger-button project-card__delete project-card__icon-button';
  remove.disabled = project.source === 'auto';
  const removeLabel = project.source === 'app' ? '移入回收站' : '移除记录';
  const removeTitle = project.source === 'auto'
    ? '自动发现的兼容项目不能在应用内删除'
    : (project.source === 'app' ? '移动到应用回收站' : '从最近项目中移除，不删除磁盘文件');
  remove.title = removeTitle;
  remove.setAttribute('aria-label', removeLabel);
  remove.dataset.defaultLabel = removeLabel;
  remove.dataset.defaultTitle = removeTitle;
  remove.appendChild(createTrashIcon());
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    deleteProject(project, remove);
  });
  actions.appendChild(remove);
  card.appendChild(actions);

  return card;
}

async function deleteProject(project, triggerButton) {
  const isAppProject = project.source === 'app';
  if (pendingDeleteProjectPath !== project.path) {
    // 桌面壳里的原生 confirm 不够明显；改用按钮内二次确认，删除意图始终留在页面上。
    resetPendingDeleteButtons();
    pendingDeleteProjectPath = project.path;
    triggerButton.dataset.confirming = 'true';
    triggerButton.setAttribute('aria-label', isAppProject ? '确认移入回收站' : '确认移除记录');
    triggerButton.title = isAppProject
      ? '再次点击后，项目会移入应用回收站'
      : '再次点击后，只从最近项目中移除记录';
    return;
  }

  try {
    triggerButton.disabled = true;
    triggerButton.setAttribute('aria-label', isAppProject ? '正在移入回收站' : '正在移除记录');
    triggerButton.title = isAppProject ? '正在移入回收站…' : '正在移除记录…';
    const response = await fetch('/api/projects', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: project.path })
    });
    const payload = await safeReadJson(response);
    if (!response.ok) {
      showState({ kind: 'error', message: payload?.error || `删除失败：HTTP ${response.status}` });
      return;
    }
    pendingDeleteProjectPath = null;
    await loadProjects();
  } catch (error) {
    showState({ kind: 'error', message: `删除请求失败：${error.message}` });
  } finally {
    if (triggerButton.isConnected) {
      resetDeleteButton(triggerButton);
    }
  }
}

function resetPendingDeleteButtons() {
  for (const button of dom.grid.querySelectorAll('.project-card__delete[data-confirming="true"]')) {
    resetDeleteButton(button);
  }
}

function resetDeleteButton(button) {
  delete button.dataset.confirming;
  button.disabled = false;
  button.setAttribute('aria-label', button.dataset.defaultLabel || '移入回收站');
  button.title = button.dataset.defaultTitle || '';
  button.replaceChildren(createTrashIcon());
}

function createTrashIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('project-card__delete-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  // 项目未引入图标库；这里内置一个简化 trash-2 图标，避免为单个图标增加运行时依赖。
  const paths = [
    'M3 6h18',
    'M8 6V4h8v2',
    'M6 6l1 15h10l1-15',
    'M10 11v6',
    'M14 11v6'
  ];
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function showState({ kind, title, body, message }) {
  dom.state.hidden = false;
  dom.state.replaceChildren();
  const card = document.createElement('div');
  card.className = 'state-card';
  const heading = document.createElement('h2');
  heading.textContent = title || (kind === 'loading' ? '正在读取项目…' : kind === 'error' ? '加载失败' : '没有项目');
  card.appendChild(heading);
  const para = document.createElement('p');
  para.textContent = body || message || '';
  card.appendChild(para);
  dom.state.appendChild(card);
  dom.grid.replaceChildren();
}

function openDialog() {
  clearDialogMessage();
  generatedStoryState = { idea: '', story: '' };
  dom.form.reset();
  updateStartModeUi();
  if (typeof dom.dialog.showModal === 'function') {
    dom.dialog.showModal();
  } else {
    dom.dialog.setAttribute('open', '');
  }
  dom.inputName.focus();
}

function closeDialog() {
  if (typeof dom.dialog.close === 'function') {
    dom.dialog.close();
  } else {
    dom.dialog.removeAttribute('open');
  }
}

async function onSubmit(event) {
  event.preventDefault();
  const formData = new FormData(dom.form);
  const startMode = normalizeStartMode(formData.get('startMode'));
  const payload = {
    name: String(formData.get('name') || '').trim(),
    firstEpisodeName: DEFAULT_FIRST_EPISODE_NAME,
    startMode,
    sourceText: String(formData.get('sourceText') || '').trim()
  };
  if (!payload.name) {
    showDialogMessage('请先填写项目名称。');
    return;
  }

  setSubmitting(true);
  clearDialogMessage();
  try {
    if (payload.startMode === 'idea_text' && shouldAutoGenerateStory(payload.sourceText)) {
      const generated = await generateStoryFromIdea({ forSubmit: true });
      if (!generated) return;
      payload.sourceText = generated.story;
      payload.ideaText = generated.idea;
      payload.storyGeneratedBy = generated.adapterId ? `${generated.adapterId}:${generated.modelId || ''}` : 'text_model';
    } else if (payload.startMode === 'idea_text' && generatedStoryState.story && payload.sourceText === generatedStoryState.story) {
      payload.ideaText = generatedStoryState.idea;
      payload.storyGeneratedBy = 'text_model';
    }

    const response = await fetch('/api/projects/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await safeReadJson(response);
    if (!response.ok) {
      showDialogMessage(json?.error || `创建失败：HTTP ${response.status}`);
      return;
    }
    const firstEpisodePath = json.project?.episodes?.[0]?.path;
    closeDialog();
    if (firstEpisodePath) {
      location.href = `/project.html?path=${encodeURIComponent(json.project.path)}`;
      return;
    }
    await loadProjects();
  } catch (error) {
    showDialogMessage(`创建请求失败：${error.message}`);
  } finally {
    setSubmitting(false);
  }
}

function normalizeStartMode(value) {
  const candidate = String(value || 'story_text');
  return startModes.has(candidate) ? candidate : 'story_text';
}

function selectedStartMode() {
  return normalizeStartMode(new FormData(dom.form).get('startMode'));
}

function updateStartModeUi() {
  const mode = selectedStartMode();
  const copy = startModeCopy[mode] || startModeCopy.story_text;
  dom.sourceTextLabel.textContent = copy.label;
  dom.sourceText.placeholder = copy.placeholder;
  dom.sourceTextHint.textContent = copy.hint;
  dom.generateStoryButton.hidden = mode !== 'idea_text';
}

function shouldAutoGenerateStory(text) {
  if (!text) return false;
  if (generatedStoryState.story && text === generatedStoryState.story) return false;
  return text.length <= IDEA_AUTO_GENERATE_MAX_LENGTH;
}

async function generateStoryFromIdea({ forSubmit }) {
  const idea = dom.sourceText.value.trim();
  if (!idea) {
    showDialogMessage('请先输入一个故事想法。');
    return null;
  }
  if (generatedStoryState.story && idea === generatedStoryState.story) {
    return { idea: generatedStoryState.idea, story: generatedStoryState.story };
  }

  setStoryGenerating(true, { forSubmit });
  clearDialogMessage();
  try {
    const response = await fetch('/api/story/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idea,
        projectName: dom.inputName.value.trim(),
        firstEpisodeName: DEFAULT_FIRST_EPISODE_NAME
      })
    });
    const json = await safeReadJson(response);
    if (!response.ok) {
      showDialogMessage(json?.message || json?.error || `生成故事失败：HTTP ${response.status}`, {
        settingsUrl: json?.settingsUrl || TEXT_MODEL_SETTINGS_URL
      });
      return null;
    }
    const story = String(json?.story || '').trim();
    if (!story) {
      showDialogMessage('文本模型没有返回故事内容，请稍后再试，或先手动补写完整故事。');
      return null;
    }
    generatedStoryState = { idea, story };
    dom.sourceText.value = story;
    showDialogMessage('已生成完整故事，你可以继续编辑后创建项目。', { kind: 'success' });
    return { idea, story, adapterId: json.adapterId, modelId: json.modelId };
  } catch (error) {
    showDialogMessage(`生成故事请求失败：${error.message}`);
    return null;
  } finally {
    setStoryGenerating(false, { forSubmit });
  }
}

function setSubmitting(isSubmitting, text = '创建中…') {
  const submitButton = dom.form.querySelector('button[type="submit"]');
  submitButton.disabled = isSubmitting;
  submitButton.textContent = isSubmitting ? text : '创建并进入';
}

function setStoryGenerating(isGenerating, { forSubmit }) {
  dom.generateStoryButton.disabled = isGenerating;
  dom.generateStoryButton.textContent = isGenerating ? '生成中…' : '生成完整故事';
  if (forSubmit && isGenerating) setSubmitting(true, '生成故事并创建…');
}

function showDialogMessage(message, { kind = 'error', settingsUrl = null } = {}) {
  dom.errorBox.hidden = false;
  dom.errorBox.dataset.kind = kind;
  dom.errorBox.replaceChildren(document.createTextNode(message));
  if (settingsUrl) {
    const link = document.createElement('a');
    link.className = 'modal__error-link';
    link.href = settingsUrl;
    link.textContent = '去配置文本模型';
    dom.errorBox.appendChild(document.createTextNode(' '));
    dom.errorBox.appendChild(link);
  }
}

function clearDialogMessage() {
  dom.errorBox.hidden = true;
  delete dom.errorBox.dataset.kind;
  dom.errorBox.replaceChildren();
}

async function safeReadJson(response) {
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
