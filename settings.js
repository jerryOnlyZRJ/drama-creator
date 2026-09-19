// 设置页：面向用户展示“模型类型 + 授权方式”，内部 adapter id 只作为实现细节。
// - 所有 secret 字段用 type="password"，永不在 DOM 之外回显；
// - 通过 fetch 与 /api/adapters、/api/credentials 通讯，默认管理应用级全局凭据；
// - 任何提交后立即 refresh 拉取最新状态，避免本地 state 与后端不一致。
// - 订阅授权属于通用授权方式，ChatGPT 只是当前已接入服务商；API Key 模式可用于 DeepSeek 等服务商。
// - 素材生产模式分为“内置生成”和“外部跳转”，以方法标签呈现，不单独做说明模块。
// - fillCodexTosBanners 把合规文案幂等填入默认收起的 .codex-tos-banner 折叠区。

const $ = (sel) => document.querySelector(sel);
const list = $('#adapter-list');
const trashSummary = $('#trashSummary');
const emptyTrashButton = $('#emptyTrashButton');

let cachedAdapters = [];
let cachedCredentials = [];
let cachedSettings = { modelDefaults: {} };
let cachedTrash = { totalItems: 0, totalBytes: 0, buckets: [] };
let pendingEmptyTrash = false;
// OAuth polling 句柄：避免重复启动 / 卸载时残留定时器。
let oauthPollHandle = null;
const OAUTH_POLL_INTERVAL_MS = 1500;
// 自定义不是后端服务商模板；它只让用户手动填写 endpoint/API Key，避免新增小众平台时改代码。
const CUSTOM_PROVIDER_VALUE = '__custom__';
// 模型下拉里的自定义哨兵值：有 live/catalog 模型时优先选择，确实是新模型或自定义端点时才手填。
const CUSTOM_MODEL_VALUE = '__custom_model__';
// 聚合后的 API Key 表单需要同时区分“服务商模板”和“底层 adapter”，分隔符只用于本地 select value。
const PROVIDER_VALUE_SEPARATOR = '::';
// 页面自动化类模型需要展示平台页面上的真实选项名，避免用户保存后自动化找不到对应模型。
const PAGE_ALIGNED_MODEL_LABELS = {
  'seedance-2.0-mini': 'Seedance 2.0 mini',
  'seedance-2.0': 'Seedance 2.0',
  'seedance-2.0-fast': 'Seedance 2.0 Fast',
  // 音频模型使用独立 ID；这里保留中文兜底名，避免设置页暴露 jimeng-audio 这类内部标识。
  'jimeng-audio': '即梦音频生成'
};

const SETTINGS_ADAPTER_UI = {
  'mock-echo': { showInSettings: false },
  'openai-compatible-text': {
    showInSettings: true,
    formTitle: '文本模型 API Key',
    description: 'OpenAI、Claude、DeepSeek、通义、豆包、Kimi、智谱、Gemini、Grok、Ollama 等服务商'
  },
  'openai-compatible-image': {
    showInSettings: true,
    formTitle: '图片模型 API Key',
    description: 'OpenAI GPT Image、火山方舟 Seedream、其他兼容图片服务'
  },
  'minimax-media': {
    showInSettings: true,
    formTitle: 'MiniMax API Key',
    description: 'MiniMax 多模态图片与视频生成'
  },
  'volcengine-ark-video': {
    showInSettings: true,
    formTitle: '火山方舟 API Key',
    description: '火山方舟 Seedance / 豆包视频生成'
  },
  'jimeng-browser-automation': {
    showInSettings: true,
    description: '默认推荐：启动应用托管的即梦窗口生成视频或音频素材，完成后导入外部资源回填'
  },
  'openai-codex-oauth': {
    showInSettings: true,
    description: '当前支持 ChatGPT Plus/Pro；后续可扩展其他服务商订阅。'
  }
};

const MODEL_SECTIONS = [
  {
    key: 'text',
    title: '文本模型',
    description: '用于改写剧本、扩写提示词、生成分镜文本。',
    methods: [
      { type: 'oauth', label: '订阅授权', adapterId: 'openai-codex-oauth' },
      { type: 'api_key', label: 'API Key（GPT / Claude / 国内常用 / 本地 Ollama）', adapterId: 'openai-compatible-text' }
    ]
  },
  {
    key: 'image',
    title: '图片模型',
    description: '用于生成角色图、场景图和关键帧。',
    methods: [
      { type: 'oauth', label: '订阅授权', disabled: true, unavailableReason: '图片订阅通道暂未开放' },
      {
        type: 'api_key',
        label: 'API Key（GPT Image / Seedream / MiniMax）',
        adapterId: 'openai-compatible-image',
        adapterIds: ['openai-compatible-image', 'minimax-media'],
        customAdapterId: 'openai-compatible-image',
        formTitle: '图片模型 API Key',
        description: '通过 API Key 使用 GPT Image、火山方舟 Seedream、MiniMax 等图片服务。'
      }
    ]
  },
  {
    key: 'video',
    title: '视频模型',
    description: '用于把分镜和关键帧生成视频片段。',
    methods: [
      { type: 'browser_automation', label: '即梦自动化', adapterId: 'jimeng-browser-automation', defaultRecommended: true },
      {
        type: 'api_key',
        label: 'API Key（Seedance / MiniMax）',
        adapterId: 'volcengine-ark-video',
        adapterIds: ['volcengine-ark-video', 'minimax-media'],
        customAdapterId: 'volcengine-ark-video',
        formTitle: '视频模型 API Key',
        description: '通过 API Key 使用火山方舟 Seedance、MiniMax 等视频服务。'
      },
      { type: 'oauth', label: '订阅授权', disabled: true, unavailableReason: '视频订阅通道暂未开放' }
    ]
  },
  {
    key: 'audio',
    title: '音频模型',
    description: '用于生成角色音色、旁白、台词和音效参考。',
    methods: [
      // 即梦音频能力目前与视频一样属于外部自动化通道：应用准备投喂信息，提交前仍由用户确认。
      { type: 'browser_automation', label: '即梦自动化', adapterId: 'jimeng-browser-automation', defaultRecommended: true }
    ]
  }
];

const PRODUCTION_MODE_LABELS = {
  in_app: '内置生成',
  external: '外部跳转'
};

emptyTrashButton?.addEventListener('click', emptyTrash);

// 拉取适配器清单（builtin + 外部 CLI 扫描结果合并），不依赖 episodePath。
async function loadAdapters() {
  const res = await fetch('/api/adapters');
  const json = await res.json();
  cachedAdapters = json.adapters || [];
}

// 拉取应用级 credentials.json 里的 publicFields；secret 值永远只在系统钥匙串里。
async function loadCredentials() {
  const res = await fetch('/api/credentials');
  if (!res.ok) { cachedCredentials = []; return; }
  const json = await res.json();
  cachedCredentials = json.credentials || [];
}

// 拉取应用级设置：包含每类模型能力当前默认使用的 adapterId + modelId。
async function loadAppSettings() {
  const res = await fetch('/api/app-settings');
  if (!res.ok) { cachedSettings = { modelDefaults: {} }; return; }
  const json = await res.json();
  cachedSettings = { ...json, modelDefaults: json.modelDefaults || {} };
}

async function loadTrashSummary() {
  const res = await fetch('/api/trash');
  if (!res.ok) {
    cachedTrash = { totalItems: 0, totalBytes: 0, buckets: [] };
    return;
  }
  const json = await res.json();
  cachedTrash = json.trash || { totalItems: 0, totalBytes: 0, buckets: [] };
}

function renderTrashSummary() {
  if (!trashSummary || !emptyTrashButton) return;
  const items = cachedTrash.totalItems || 0;
  const bytes = cachedTrash.totalBytes || 0;
  trashSummary.textContent = items
    ? `${items} 项 · ${formatBytes(bytes)}，清空后才会真正释放磁盘空间。`
    : '当前没有回收站内容。';
  if (!items) pendingEmptyTrash = false;
  emptyTrashButton.disabled = items === 0;
  emptyTrashButton.textContent = pendingEmptyTrash ? `确认清空 ${items} 项` : '清空回收站';
}

async function emptyTrash() {
  const items = cachedTrash.totalItems || 0;
  if (!items) return;
  if (!pendingEmptyTrash) {
    pendingEmptyTrash = true;
    // 设置页没有详情面板，采用两次点击确认来替代桌面端不稳定的原生 confirm。
    emptyTrashButton.textContent = `确认清空 ${items} 项`;
    showOAuthToast('再次点击会永久清空回收站，清空后不能在应用内恢复。');
    return;
  }

  pendingEmptyTrash = false;
  emptyTrashButton.disabled = true;
  emptyTrashButton.textContent = '清空中…';
  try {
    const res = await fetch('/api/trash', { method: 'DELETE' });
    if (!res.ok) {
      showOAuthToast(await readResponseError(res, `清空回收站失败 (HTTP ${res.status})`));
      return;
    }
    await loadTrashSummary();
    renderTrashSummary();
    showOAuthToast('回收站已清空');
  } catch (error) {
    showOAuthToast(`清空回收站失败：${error.message}`);
  } finally {
    pendingEmptyTrash = false;
    emptyTrashButton.textContent = '清空回收站';
    emptyTrashButton.disabled = (cachedTrash.totalItems || 0) === 0;
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  for (const unit of units) {
    if (size < 1024 || unit === 'GB') return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
    size /= 1024;
  }
  return `${value} B`;
}

function findAdapter(adapterId) {
  const adapter = cachedAdapters.find((item) => item.id === adapterId);
  const ui = SETTINGS_ADAPTER_UI[adapterId] || {};
  if (!adapter || ui.showInSettings === false) return null;
  // 展示层覆盖 displayName，避免把内部适配器术语带到表单标题里。
  return { ...adapter, displayName: ui.formTitle || adapter.displayName, uiDescription: ui.description || '' };
}

function findCredential(adapterId) {
  return cachedCredentials.find((item) => item.adapterId === adapterId) || null;
}

function isCredentialUsable(credential) {
  return !!credential && credential.secretStatus !== 'missing';
}

function isCredentialStale(credential) {
  return !!credential && credential.secretStatus === 'missing';
}

function buildModelSections() {
  return MODEL_SECTIONS.map((section) => {
    const currentDefault = cachedSettings.modelDefaults?.[section.key] || null;
    const methods = section.methods.map((method) => {
      const adapterChoices = buildMethodAdapterChoices(method);
      const selectedChoice = adapterChoices.find((choice) => currentDefault?.adapterId === choice.adapter.id) || null;
      const configuredChoice = adapterChoices.find((choice) => isCredentialUsable(choice.credential)) || null;
      const primaryChoice = selectedChoice || configuredChoice || adapterChoices[0] || null;
      const adapter = primaryChoice?.adapter || null;
      const credential = primaryChoice?.credential || null;
      const selected = !!selectedChoice;
      const browserAutomationReady = method.type === 'browser_automation' && isBrowserAutomationReady(adapter);
      const productionMode = resolveProductionMode(method, adapter);
      const defaultRecommended = !!(method.defaultRecommended || adapter?.execution?.defaultRecommended);
      const configured = method.type === 'browser_automation'
        ? browserAutomationReady
        : adapterChoices.some((choice) => isCredentialUsable(choice.credential));
      const available = adapterChoices.length > 0 && !method.disabled;
      return {
        ...method,
        capabilityKey: section.key,
        adapter,
        adapterChoices,
        credential,
        selected,
        selectedModelId: selected ? currentDefault.modelId : '',
        productionMode,
        defaultRecommended,
        configured,
        available,
        verification: credential?.publicFields?.verification || null,
        unavailableReason: method.unavailableReason || adapter?.execution?.unavailableReason || adapter?.automation?.unavailableReason || '',
        description: method.description || adapter?.uiDescription || method.unavailableReason || adapter?.execution?.unavailableReason || adapter?.automation?.unavailableReason || ''
      };
    });
    const hasAvailable = methods.some((method) => method.available);
    const hasConfigured = methods.some((method) => method.configured);
    const hasDefault = methods.some((method) => method.selected);
    const hasStaleDefault = methods.some((method) => method.selected && isCredentialStale(method.credential));
    const hasExternalDefault = methods.some((method) => method.selected && method.productionMode === 'external');
    return { ...section, methods, hasAvailable, hasConfigured, hasDefault, hasStaleDefault, hasExternalDefault };
  });
}

function buildMethodAdapterChoices(method) {
  const adapterIds = (method.adapterIds || [method.adapterId]).filter(Boolean);
  return adapterIds
    .map((adapterId) => {
      const adapter = findAdapter(adapterId);
      if (!adapter) return null;
      return { adapter, credential: findCredential(adapter.id) };
    })
    .filter(Boolean);
}

function isBrowserAutomationReady(adapter) {
  return ['browser', 'managed_browser'].includes(adapter?.automation?.type) && adapter.automation.available === true;
}

function resolveProductionMode(method, adapter) {
  if (adapter?.productionMode) return adapter.productionMode;
  if (method.type === 'browser_automation') return 'external';
  return 'in_app';
}

// 渲染模型类型卡片；授权方式作为卡片内部选项，而不是独立适配器卡片。
function renderList() {
  list.removeAttribute('aria-busy');
  list.innerHTML = '';
  const sections = buildModelSections();
  if (sections.length === 0) {
    list.innerHTML = '<li class="adapter-list__empty">未发现可用适配器。</li>';
    return;
  }
  for (const section of sections) {
    const li = document.createElement('li');
    const statusText = section.hasDefault
      ? (section.hasStaleDefault ? '默认待重配' : (section.hasExternalDefault && !section.hasConfigured ? '默认待启用' : '已设默认'))
      : (section.hasConfigured ? '已配置' : (section.hasAvailable ? '未配置' : '待接入'));
    const statusClass = section.hasConfigured
      ? 'adapter-card--configured'
      : (section.hasStaleDefault ? 'adapter-card--stale' : '');
    li.innerHTML = `
      <header>
        <div class="adapter-card__heading">
          <strong>${section.title}</strong>
          <p class="adapter-card__summary">${section.description}</p>
        </div>
        <span class="adapter-card__status ${section.hasConfigured ? 'adapter-card__status--configured' : (section.hasAvailable ? 'adapter-card__status--missing' : 'adapter-card__status--disabled')}">${statusText}</span>
      </header>
    `;
    li.className = `adapter-card ${statusClass}`;
    const methods = document.createElement('div');
    methods.className = 'model-methods';
    for (const method of section.methods) {
      methods.appendChild(renderCredentialMethod(method, li));
    }
    li.appendChild(methods);
    list.appendChild(li);
  }
  // 渲染收尾后统一向所有 banner 占位填入双语 ToS 文案（包含 settings.html 中的硬编码占位与本函数动态插入的占位）。
  fillCodexTosBanners();
}

function renderCredentialMethod(method, card) {
  const row = document.createElement('div');
  const stale = isCredentialStale(method.credential);
  row.className = `credential-method ${method.configured ? 'credential-method--configured' : ''} ${method.selected ? 'credential-method--selected' : ''} ${stale ? 'credential-method--stale' : ''} ${method.available ? '' : 'credential-method--disabled'}`;
  const copy = document.createElement('div');
  copy.className = 'credential-method__copy';
  const title = document.createElement('strong');
  title.textContent = method.label;
  const desc = document.createElement('span');
  desc.textContent = renderMethodSummary(method);
  const nextStep = renderCredentialNextStep(method);
  const meta = document.createElement('div');
  meta.className = 'credential-method__meta';
  const mode = document.createElement('span');
  mode.className = `credential-method__mode credential-method__mode--${method.productionMode}`;
  mode.textContent = PRODUCTION_MODE_LABELS[method.productionMode] || '内置生成';
  meta.appendChild(mode);
  if (method.defaultRecommended) {
    const recommended = document.createElement('span');
    recommended.className = 'credential-method__mode credential-method__mode--recommended';
    recommended.textContent = '默认推荐';
    meta.appendChild(recommended);
  }
  copy.append(title, desc);
  if (nextStep) {
    const next = document.createElement('span');
    next.className = 'credential-method__next-step';
    next.textContent = nextStep;
    copy.appendChild(next);
  }
  copy.appendChild(meta);
  row.appendChild(copy);

  const actions = document.createElement('div');
  actions.className = 'credential-method__actions';
  let banner = null;
  if (!method.available) {
    const disabled = document.createElement('span');
    disabled.className = 'credential-method__badge';
    disabled.textContent = method.unavailableReason || '暂未接入';
    actions.appendChild(disabled);
  } else if (method.type === 'oauth') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'adapter-card__primary-btn adapter-card__oauth-btn';
    btn.dataset.oauthAdapter = method.adapter.id;
    btn.textContent = stale || method.configured ? '重新登录订阅账号' : '登录订阅账号';
    btn.addEventListener('click', () => startOAuthLogin(method.adapter.id, btn));
    actions.appendChild(btn);
    appendDefaultChannelControl(actions, method);
    if (method.configured || method.credential) {
      actions.appendChild(createDeleteButton(method.adapter.id));
    }
    banner = document.createElement('details');
    banner.className = 'codex-tos-banner codex-tos-disclosure';
    banner.dataset.adapterId = method.adapter.id;
  } else if (method.type === 'browser_automation') {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'credential-method__secondary-btn';
    open.textContent = '打开即梦';
    open.addEventListener('click', () => window.open(method.adapter.automation?.targetUrl || 'https://jimeng.jianying.com/', '_blank'));
    actions.appendChild(open);
    appendDefaultChannelControl(actions, method);
    if (!isBrowserAutomationReady(method.adapter)) {
      const pending = document.createElement('span');
      pending.className = 'credential-method__badge';
      pending.textContent = '自动化脚本未安装';
      actions.appendChild(pending);
    }
  } else {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'adapter-card__primary-btn';
    btn.textContent = stale || method.configured ? '更新 API Key' : '配置 API Key';
    btn.addEventListener('click', () => openCredentialForm(method.adapter, method.credential, card, method));
    actions.appendChild(btn);
    appendDefaultChannelControl(actions, method);
    if (method.configured) {
      actions.appendChild(createTestButton(method));
    }
    if (method.configured || method.credential) {
      actions.appendChild(createDeleteButton(method.adapter.id));
    }
  }
  row.appendChild(actions);
  if (method.selected && method.configured) row.appendChild(renderModelDefaultEditor(method));
  if (banner) row.appendChild(banner);
  return row;
}

function renderCredentialNextStep(method) {
  if (!isCredentialStale(method.credential)) return '';
  if (method.type === 'oauth') {
    return '下一步：点击“重新登录订阅账号”，完成授权后回到项目生成草稿。';
  }
  if (method.type === 'api_key') {
    return '下一步：点击“更新 API Key”，保存并通过测试连接后回到项目生成草稿。';
  }
  return '';
}

function renderMethodSummary(method) {
  if (isCredentialStale(method.credential)) {
    return method.type === 'oauth'
      ? '订阅登录密钥不在系统钥匙串中，请重新登录订阅账号。'
      : 'API Key 密钥不在系统钥匙串中，请重新配置 API Key。';
  }
  if (method.type === 'browser_automation') return renderBrowserAutomationSummary(method);
  if (method.configured && method.type === 'oauth') return renderOAuthSummary(method.credential);
  const verification = method.verification;
  if (method.configured && verification?.status === 'verified') {
    const count = Array.isArray(verification.modelIds) ? verification.modelIds.length : 0;
    return count > 0 ? `已验证，可选择 ${count} 个模型` : '已验证';
  }
  if (method.configured && verification?.status === 'failed') {
    return `验证失败：${verification.message || '请检查服务地址和 API Key'}`;
  }
  if (method.configured && isGroupedApiKeyMethod(method)) return renderGroupedCredentialSummary(method);
  return method.description;
}

function isGroupedApiKeyMethod(method) {
  return method.type === 'api_key' && Array.isArray(method.adapterChoices) && method.adapterChoices.length > 1;
}

function renderGroupedCredentialSummary(method) {
  const labels = method.adapterChoices
    .filter((choice) => isCredentialUsable(choice.credential))
    .map((choice) => providerLabelForCredential(choice.adapter, choice.credential) || choice.adapter.displayName);
  return labels.length ? `已配置：${labels.join('、')}` : method.description;
}

function providerLabelForCredential(adapter, credential) {
  const template = templateForCredential(adapter, credential);
  return template?.label || '';
}

function renderBrowserAutomationSummary(method) {
  const target = method.adapter?.automation?.platform === 'jimeng' ? '即梦' : '目标平台';
  if (!isBrowserAutomationReady(method.adapter)) {
    return `外部跳转到${target}生成素材；当前可生成投喂包，完成后导入外部资源回填。`;
  }
  return `启动应用托管的${target}窗口；首次登录后复用应用 profile，提交前仍需用户确认。`;
}

function appendDefaultChannelControl(actions, method) {
  if (method.selected) {
    const badge = document.createElement('span');
    badge.className = 'credential-method__badge credential-method__badge--default';
    badge.textContent = isCredentialStale(method.credential) ? '默认待重配' : '当前默认';
    actions.appendChild(badge);
    return;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'credential-method__secondary-btn';
  btn.textContent = '设为默认';
  btn.addEventListener('click', () => setDefaultModelChannel(method.capabilityKey, method));
  actions.appendChild(btn);
}

function createTestButton(method) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'credential-method__secondary-btn';
  btn.textContent = '测试连接';
  btn.addEventListener('click', () => testModelConnection(method));
  return btn;
}

function createDeleteButton(adapterId) {
  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = '清除';
  del.className = 'adapter-card__delete';
  del.addEventListener('click', () => deleteCredential(adapterId));
  return del;
}

function renderModelDefaultEditor(method) {
  const editor = document.createElement('div');
  editor.className = 'model-default-editor';
  const field = document.createElement('label');
  field.className = 'model-default-editor__field';
  const label = document.createElement('span');
  const inputId = `model-default-${method.capabilityKey}-${method.adapter.id}`;
  const control = renderModelDefaultSelect(method, inputId);
  // 与 SecretaryMachine 对齐：服务商已返回模型目录时用下拉，自定义模型只作为兜底。
  label.textContent = shouldRenderModelSelect(method) ? '模型' : '模型 ID';
  field.append(label, control);

  const meta = document.createElement('span');
  meta.className = `model-default-editor__meta model-default-editor__meta--${method.verification?.status || 'unknown'}`;
  meta.textContent = renderVerificationMeta(method);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'credential-method__secondary-btn';
  save.textContent = '保存模型';
  save.addEventListener('click', () => setDefaultModelChannel(method.capabilityKey, method, { modelId: readModelControlValue(control) }));

  editor.append(field, meta, save);
  return editor;
}

function renderModelDefaultSelect(method, inputId) {
  if (shouldRenderModelSelect(method)) {
    const control = document.createElement('div');
    control.className = 'model-default-editor__control';
    const select = document.createElement('select');
    select.id = inputId;
    select.name = `modelId-${method.capabilityKey}-${method.adapter.id}`;
    select.className = 'model-default-editor__select';
    const selectedModelId = method.selectedModelId || firstModelId(method) || '';
    const ids = selectableModelIds(method);
    const customEnabled = supportsCustomModelId(method);
    for (const id of ids) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = resolveModelDisplayLabel(method, id);
      option.selected = id === selectedModelId;
      select.appendChild(option);
    }
    const selectedIsKnown = ids.includes(selectedModelId);
    const customInput = document.createElement('input');
    customInput.className = 'model-default-editor__custom-input';
    customInput.type = 'text';
    customInput.autocomplete = 'off';
    customInput.placeholder = '输入自定义模型 ID';
    if (customEnabled) {
      const customOption = document.createElement('option');
      customOption.value = CUSTOM_MODEL_VALUE;
      customOption.textContent = '自定义模型 ID';
      customOption.selected = !!selectedModelId && !selectedIsKnown;
      select.appendChild(customOption);
      customInput.value = selectedIsKnown ? '' : selectedModelId;
      customInput.hidden = select.value !== CUSTOM_MODEL_VALUE;
      select.addEventListener('change', () => {
        customInput.hidden = select.value !== CUSTOM_MODEL_VALUE;
        if (!customInput.hidden) customInput.focus();
      });
    } else {
      customInput.hidden = true;
    }
    control.append(select, customInput);
    return control;
  }

  const input = document.createElement('input');
  input.id = inputId;
  input.name = `modelId-${method.capabilityKey}-${method.adapter.id}`;
  input.className = 'model-default-editor__input';
  input.type = 'text';
  input.autocomplete = 'off';
  input.value = method.selectedModelId || firstModelId(method) || '';
  input.placeholder = '例如 deepseek-chat、gpt-image-2、doubao-seedance、MiniMax-Hailuo';
  return input;
}

function shouldRenderModelSelect(method) {
  return knownModelIds(method).length > 0;
}

function selectableModelIds(method) {
  const ids = knownModelIds(method);
  const selectedModelId = method.selectedModelId || '';
  // 后端目录是首选来源；保留已保存值，避免服务商临时无法列模型时配置突然不可编辑。
  if (selectedModelId && !supportsCustomModelId(method) && !ids.includes(selectedModelId)) ids.unshift(selectedModelId);
  return ids;
}

function supportsCustomModelId(method) {
  const capability = capabilityForMethod(method);
  return capability?.acceptsAnyModel === true;
}

function readModelControlValue(control) {
  const select = control.matches?.('select') ? control : control.querySelector?.('select');
  if (select) {
    if (select.value === CUSTOM_MODEL_VALUE) return (control.querySelector?.('input')?.value || '').trim();
    return select.value.trim();
  }
  return (control.value || '').trim();
}

function resolveModelDisplayLabel(method, modelId) {
  const model = capabilityForMethod(method)?.models?.find((item) => item?.id === modelId);
  return model?.label || model?.displayName || model?.metadata?.jimengLabel || PAGE_ALIGNED_MODEL_LABELS[modelId] || modelId;
}

function renderVerificationMeta(method) {
  if (isCredentialStale(method.credential)) return method.type === 'oauth' ? '需要重新登录' : '需要重新配置 API Key';
  const verification = method.verification;
  if (verification?.status === 'verified') return verification.message || '已验证';
  if (verification?.status === 'failed') return verification.message || '验证失败';
  if (method.type === 'browser_automation') return isBrowserAutomationReady(method.adapter) ? '应用托管登录态，无需 API Key' : '可先生成投喂包人工操作';
  return method.type === 'api_key' ? '未验证，可先测试连接后选择模型' : '授权后可使用订阅通道';
}

function knownModelIds(method) {
  const ids = new Set();
  const template = templateForCredential(method.adapter, method.credential);
  if (template?.defaultModelId) ids.add(template.defaultModelId);
  for (const item of template?.recommendedModels || []) ids.add(item);
  for (const item of method.verification?.modelIds || []) ids.add(item);
  for (const model of capabilityForMethod(method)?.models || []) {
    if (model?.id) ids.add(model.id);
  }
  return [...ids];
}

function capabilityForMethod(method) {
  const capabilityType = method.capabilityKey === 'text' ? 'text_prompt' : method.capabilityKey;
  return method.adapter?.capabilities?.find((item) => item.type === capabilityType) || null;
}

function firstModelId(method) {
  const template = templateForCredential(method.adapter, method.credential);
  return template?.defaultModelId || knownModelIds(method)[0] || '';
}

async function setDefaultModelChannel(capabilityKey, method, options = {}) {
  const modelId = options.modelId || method.selectedModelId || firstModelId(method);
  if (!modelId) {
    showOAuthToast('请先选择或填写模型');
    return;
  }
  const res = await fetch('/api/app-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modelDefaults: {
        [capabilityKey]: {
          adapterId: method.adapter.id,
          modelId,
          ...(resolveProviderId(method.adapter, method.credential) ? { providerId: resolveProviderId(method.adapter, method.credential) } : {})
        }
      }
    })
  });
  if (!res.ok) {
    showOAuthToast(await readResponseError(res, `默认模型保存失败 (HTTP ${res.status})`));
    return;
  }
  await refresh();
  showOAuthToast('默认模型已保存');
}

function resolveProviderId(adapter, credential) {
  const found = templateForCredential(adapter, credential);
  return found?.id || '';
}

function templateForCredential(adapter, credential) {
  const endpoint = credential?.publicFields?.endpoint;
  if (!endpoint || !Array.isArray(adapter?.templates)) return null;
  return adapter.templates.find((item) => item.endpoint === endpoint) || null;
}

async function testModelConnection(method) {
  const res = await fetch('/api/model-connections/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adapterId: method.adapter.id })
  });
  if (!res.ok) {
    showOAuthToast(await readResponseError(res, `测试连接失败 (HTTP ${res.status})`));
    return;
  }
  const json = await res.json();
  await refresh();
  showOAuthToast(json.status === 'verified' ? '连接测试通过' : `连接测试失败：${json.message || '未知错误'}`);
}

function renderOAuthSummary(credential) {
  const pf = credential?.publicFields || {};
  const account = pf.accountId ? `账号 ${String(pf.accountId).slice(0, 8)}...` : '账号已授权';
  const expires = typeof pf.expiresAt === 'number' && Number.isFinite(pf.expiresAt)
    ? `，有效期至 ${new Date(pf.expiresAt).toLocaleString()}`
    : '';
  return `${account}${expires}`;
}

// Codex OAuth ToS 双语免责声明。
// - 文案为静态字符串，不混入任何用户输入，因此 innerHTML 注入是 XSS 安全的；
// - 通过 dataset.filled 标记幂等，避免在多次 refresh 渲染时重复填充覆盖；
// - 默认收起，避免把法律说明做成常驻主模块；
// - 文案故意不含任何外部跳转链接，避免被误读成"订阅资源转售"渠道。
function fillCodexTosBanners() {
  const HTML = `<summary>合规说明</summary>
<div class="codex-tos-banner__body">
使用 Codex OAuth 受 OpenAI 服务条款约束。订阅模式由你自担合规风险。drama-creator 不参与账号买卖、多账号轮转或任何形式的订阅资源转售。
<span class="codex-tos-banner__divider"></span>
Using Codex OAuth is subject to OpenAI's Terms of Service. The subscription mode is at your own compliance risk. drama-creator does not engage in account trading, multi-account rotation, or subscription resale.
</div>`;
  document.querySelectorAll('.codex-tos-banner').forEach((el) => {
    if (el.dataset.filled === '1') return; // 防重复填，保证多次渲染幂等。
    el.innerHTML = HTML;
    el.dataset.filled = '1';
  });
}

// 打开当前模型能力卡片内的凭据表单：模板下拉（可选）+ 字段输入 + 提交按钮。
// 聚合入口会把多个真实 adapter 的模板放进同一个服务商下拉，保存时再写入选中 adapter。
function openCredentialForm(adapter, existing, card, method = null) {
  const formId = method?.adapterIds?.join('|') || adapter.id;
  const alreadyOpen = [...card.querySelectorAll('.credential-form')].find((item) => item.dataset.formId === formId);
  // 页面只保留一个展开中的表单，避免用户在多个卡片之间输入错位。
  document.querySelectorAll('.credential-form').forEach((f) => f.remove());
  if (alreadyOpen) return;

  const adapterChoices = method?.adapterChoices?.length ? method.adapterChoices : [{ adapter, credential: existing }];
  const adaptersForForm = adapterChoices.map((choice) => choice.adapter);
  const customAdapter = adaptersForForm.find((item) => item.id === method?.customAdapterId) || adapter;
  const initialChoice = adapterChoices.find((choice) => choice.adapter.id === adapter.id) || adapterChoices[0] || { adapter, credential: existing };
  const providerOptions = buildProviderOptions(adaptersForForm);
  const existingEndpoint = initialChoice.credential?.publicFields?.endpoint;
  const exactExisting = providerOptions.find((item) => item.adapter.id === initialChoice.adapter.id && item.template.endpoint === existingEndpoint);
  const customOptions = buildCustomProviderOptions(exactExisting ? customAdapter : (initialChoice.adapter || customAdapter));

  const form = document.createElement('form');
  form.className = 'credential-form';
  form.dataset.adapterId = initialChoice.adapter.id;
  form.dataset.formId = formId;
  const header = document.createElement('div');
  header.className = 'credential-form__header';
  const title = document.createElement('strong');
  title.textContent = (existing || initialChoice.credential) ? `更新 ${method?.formTitle || adapter.displayName}` : `配置 ${method?.formTitle || adapter.displayName}`;
  const hint = document.createElement('span');
  hint.textContent = '密钥只写入系统钥匙串，保存后不会回显。';
  header.append(title, hint);
  form.appendChild(header);

  // 服务商模板只负责预填 endpoint / 平台入口；真正写入哪个 adapter 由 option value 中的 adapterId 决定。
  if (providerOptions.length > 0) {
    const templateWrap = document.createElement('label');
    templateWrap.className = 'credential-form__field';
    const templateLabel = document.createElement('span');
    templateLabel.textContent = '服务商';
    const sel = document.createElement('select');
    sel.id = `provider-template-${method?.capabilityKey || 'model'}-${formId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    sel.name = 'providerTemplate';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— 选择服务商 —';
    sel.appendChild(placeholder);
    for (const optionDef of providerOptions) {
      const option = document.createElement('option');
      option.value = optionDef.value;
      option.textContent = optionDef.template.label;
      sel.appendChild(option);
    }
    for (const customDef of customOptions) {
      const option = document.createElement('option');
      option.value = customDef.value;
      option.textContent = customDef.label;
      sel.appendChild(option);
    }
    const providerHelp = createProviderHelp(() => selectedProviderOption([...providerOptions, ...customOptions], sel.value));
    if (exactExisting) {
      sel.value = exactExisting.value;
    } else if (existingEndpoint) {
      sel.value = providerOptionValue(initialChoice.adapter.id, CUSTOM_PROVIDER_VALUE);
    }
    sel.addEventListener('change', () => {
      const ep = form.querySelector('input[name="endpoint"]');
      const template = selectedProviderOption([...providerOptions, ...customOptions], sel.value);
      if (template?.adapter?.id) form.dataset.adapterId = template.adapter.id;
      if (ep && template?.endpoint && !template.custom) ep.value = template.endpoint;
      if (ep && template?.custom) ep.value = '';
      const keyInput = form.querySelector('input[name="apiKey"]');
      if (keyInput && !keyInput.value && template?.defaultApiKey) keyInput.value = template.defaultApiKey;
      syncCredentialFieldState(form);
      syncProviderHelp(providerHelp, template);
    });
    templateWrap.append(templateLabel, sel);
    form.appendChild(templateWrap);
    form.appendChild(providerHelp.wrap);
    syncProviderHelp(providerHelp, selectedProviderOption([...providerOptions, ...customOptions], sel.value));
  }
  const initialCredential = findCredential(form.dataset.adapterId) || initialChoice.credential || existing;
  for (const f of (adapter.credential.fields || [])) {
    const wrap = document.createElement('label');
    wrap.className = 'credential-form__field';
    const labelText = document.createElement('span');
    labelText.textContent = renderCredentialFieldLabel(f);
    const input = document.createElement('input');
    input.name = f.key;
    input.type = f.secret ? 'password' : 'text';
    // 已有 secret 时允许留空保存，表示保留系统钥匙串里的旧值。
    input.required = !!f.required && !(initialCredential && f.secret);
    if (initialCredential && !f.secret && initialCredential.publicFields?.[f.key]) {
      input.value = initialCredential.publicFields[f.key];
    }
    input.placeholder = f.secret
      ? (initialCredential ? '留空保留原密钥，输入新密钥则覆盖' : '输入 API Key')
      : (f.key === 'endpoint' ? '选择服务商后自动填入，或手动粘贴服务地址' : '');
    wrap.append(labelText, input);
    form.appendChild(wrap);
  }
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'credential-form__submit';
  submit.textContent = '保存';
  form.appendChild(submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveCredential(adapter, form);
  });
  card.appendChild(form);
  form.querySelector('input, select')?.focus();
}

function buildProviderOptions(adapters) {
  return adapters.flatMap((adapter) => {
    if (!Array.isArray(adapter?.templates)) return [];
    return adapter.templates.map((template) => ({
      adapter,
      template,
      value: providerOptionValue(adapter.id, template.endpoint),
      ...template
    }));
  });
}

function buildCustomProviderOptions(adapter) {
  return [{
    adapter,
    id: 'custom',
    label: '自定义',
    endpoint: '',
    value: providerOptionValue(adapter.id, CUSTOM_PROVIDER_VALUE),
    defaultModelId: '',
    custom: true
  }];
}

function providerOptionValue(adapterId, endpoint) {
  return `${adapterId}${PROVIDER_VALUE_SEPARATOR}${endpoint}`;
}

function selectedProviderOption(options, value) {
  if (!value) return null;
  return options.find((item) => item.value === value) || null;
}

function syncCredentialFieldState(form) {
  const credential = findCredential(form.dataset.adapterId);
  const keyInput = form.querySelector('input[name="apiKey"]');
  if (!keyInput) return;
  keyInput.required = !credential;
  keyInput.placeholder = credential ? '留空保留原密钥，输入新密钥则覆盖' : '输入 API Key';
}

function createProviderHelp(getTemplate) {
  const wrap = document.createElement('div');
  wrap.className = 'credential-form__provider-help';

  const hint = document.createElement('span');
  hint.className = 'credential-form__provider-hint';
  hint.textContent = '选择服务商后会自动填入服务地址，并提供获取 API Key 的入口。';

  const actions = document.createElement('div');
  actions.className = 'credential-form__provider-actions';

  const keyButton = document.createElement('button');
  keyButton.type = 'button';
  keyButton.className = 'credential-form__link-btn';
  keyButton.textContent = '获取 API Key';
  keyButton.addEventListener('click', () => openTemplateUrl(getTemplate()?.apiKeyUrl));

  const docsButton = document.createElement('button');
  docsButton.type = 'button';
  docsButton.className = 'credential-form__link-btn credential-form__link-btn--ghost';
  docsButton.textContent = '查看接入文档';
  docsButton.addEventListener('click', () => openTemplateUrl(getTemplate()?.docsUrl));

  actions.append(keyButton, docsButton);
  wrap.append(hint, actions);
  return { wrap, hint, keyButton, docsButton };
}

function syncProviderHelp(help, template) {
  const hasKeyUrl = !!template?.apiKeyUrl;
  const hasDocsUrl = !!template?.docsUrl;
  help.keyButton.disabled = !hasKeyUrl;
  help.docsButton.disabled = !hasDocsUrl;
  if (!template) {
    help.hint.textContent = '选择服务商后会自动填入服务地址，并提供获取 API Key 的入口。';
    return;
  }
  if (template.custom) {
    const protocol = template.adapter?.displayName ? `；将使用「${template.adapter.displayName}」的接口协议` : '';
    help.hint.textContent = `自定义已选中。请自行填写服务地址和 API Key；设为默认时再填写模型 ID${protocol}。`;
    return;
  }
  const modelHint = template.defaultModelId ? `推荐模型：${template.defaultModelId}。` : '模型 ID 可在设为默认后手动填写。';
  help.hint.textContent = `${template.label} 已选中。${modelHint}${template.defaultApiKey ? ' 本地服务可保留默认密钥占位。' : ''}`;
}

function openTemplateUrl(url) {
  if (!url) {
    showOAuthToast('请先选择服务商');
    return;
  }
  // URL 来自本地内置 manifest，不接受用户输入；统一新窗口打开平台后台或官方文档。
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function openOAuthAuthorizeUrl(authorizeUrl) {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (typeof invoke === 'function') {
    try {
      // 桌面端通过 Tauri 壳打开系统浏览器；Rust 侧再次校验授权域名，避免任意 URL 跳转。
      await invoke('open_oauth_authorize_url', { url: authorizeUrl });
      return { opened: true, copied: false };
    } catch (error) {
      console.warn('desktop OAuth opener failed', error);
    }
  }

  // 浏览器开发态没有 Tauri bridge，保留 window.open 兜底。
  const opened = window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
  if (opened) {
    if (typeof opened.focus === 'function') opened.focus();
    return { opened: true, copied: false };
  }

  return { opened: false, copied: await copyTextToClipboard(authorizeUrl) };
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn('copy OAuth login link failed', error);
  }
  return false;
}

function renderCredentialFieldLabel(field) {
  if (field.key === 'endpoint') return '服务地址';
  if (field.key === 'apiKey') return 'API Key';
  return field.label || field.key;
}

// PUT 写入：fields 包含本次输入的所有非空字段；后端把 secret 写钥匙串、其它落 publicFields。
async function saveCredential(adapter, form) {
  const fields = {};
  for (const input of form.querySelectorAll('input')) {
    if (input.value) fields[input.name] = input.value;
  }
  const targetAdapterId = form.dataset.adapterId || adapter.id;
  const res = await fetch(`/api/credentials/${targetAdapterId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) {
    showOAuthToast(await readResponseError(res, `保存失败 (HTTP ${res.status})`));
    return;
  }
  await refresh();
  showOAuthToast('凭据已保存');
}

// DELETE 同步清理系统钥匙串 + APP 工作空间中的 publicFields 引用。
async function deleteCredential(adapterId) {
  const res = await fetch(`/api/credentials/${adapterId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  if (!res.ok) {
    showOAuthToast(await readResponseError(res, `清除失败 (HTTP ${res.status})`));
    return;
  }
  await clearDefaultModelChannelForAdapter(adapterId);
  await refresh();
  showOAuthToast('凭据已清除');
}

async function clearDefaultModelChannelForAdapter(adapterId) {
  const patch = {};
  for (const [capabilityKey, value] of Object.entries(cachedSettings.modelDefaults || {})) {
    if (value?.adapterId === adapterId) patch[capabilityKey] = null;
  }
  if (Object.keys(patch).length === 0) return;
  await fetch('/api/app-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelDefaults: patch })
  });
}

// Phase 3 Task 5：触发 OAuth 流程入口。
// - server 立即返回 authorizeUrl + state；浏览器跳到 OpenAI 完成授权；
// - 1455 callback 命中后 server 端写 keychain + APP 工作空间，状态机切到 'completed'；
// - 前端通过 polling /api/credentials/oauth/status 探测最终状态。
async function startOAuthLogin(adapterId, triggerButton) {
  const restoreButton = setOAuthButtonBusy(triggerButton, true);
  let res;
  try {
    res = await fetch('/api/credentials/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapterId })
    });
  } catch (err) {
    showOAuthToast(`启动订阅登录失败：${err.message || err}`);
    restoreButton();
    return;
  }
  if (!res.ok) {
    let msg = `启动订阅登录失败 (HTTP ${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) msg = `启动订阅登录失败：${j.error}`;
    } catch { /* ignore JSON parse errors */ }
    showOAuthToast(msg);
    restoreButton();
    return;
  }
  const json = await res.json();
  if (!json?.authorizeUrl) {
    showOAuthToast('没有拿到登录地址，请稍后重试');
    restoreButton();
    return;
  }
  const launch = await openOAuthAuthorizeUrl(json.authorizeUrl);
  if (launch.opened) {
    showOAuthToast('已打开订阅登录页面，请在浏览器完成登录');
  } else if (launch.copied) {
    showOAuthToast('没有打开登录页面，已复制登录链接，请粘贴到浏览器打开');
  } else {
    showOAuthToast('没有打开登录页面，请稍后重试');
  }
  startOAuthPolling();
  restoreButton();
}

function setOAuthButtonBusy(button, busy) {
  if (!button) return () => {};
  const originalText = button.textContent;
  button.disabled = busy;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (busy) button.textContent = '正在打开登录页…';
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = originalText;
  };
}

// 每 1.5s 拉一次 /api/credentials/oauth/status；非中间态即停 polling 并 toast。
function startOAuthPolling() {
  stopOAuthPolling();
  oauthPollHandle = setInterval(async () => {
    let snap;
    try {
      const r = await fetch('/api/credentials/oauth/status');
      if (!r.ok) return;
      snap = await r.json();
    } catch {
      return; // polling 期间网络抖动忽略，等下一次
    }
    const s = snap?.state;
    if (s === 'completed') {
      stopOAuthPolling();
      await refresh();
      showOAuthToast('订阅登录成功');
    } else if (s === 'port_in_use') {
      stopOAuthPolling();
      showOAuthToast('1455 端口被占用，请关闭占用程序后重试');
    } else if (s === 'failed') {
      stopOAuthPolling();
      showOAuthToast(`订阅登录失败：${snap.error || '未知错误'}`);
    } else if (s === 'timeout') {
      stopOAuthPolling();
      showOAuthToast('订阅登录超时');
    }
    // 其他状态（idle / awaiting_callback）继续 polling。
  }, OAUTH_POLL_INTERVAL_MS);
}

function stopOAuthPolling() {
  if (oauthPollHandle) {
    clearInterval(oauthPollHandle);
    oauthPollHandle = null;
  }
}

// 顶部 toast：用 CSS class 切换实现淡出（用户偏好：不要 inline style）。
function showOAuthToast(msg) {
  // 移除旧 toast 避免堆叠。
  document.querySelectorAll('.oauth-toast').forEach((el) => el.remove());
  const div = document.createElement('div');
  div.className = 'oauth-toast';
  div.textContent = msg;
  document.body.appendChild(div);
  // 2.7s 后切到 .oauth-toast--leaving 触发 CSS transition；3s 后整体移除。
  setTimeout(() => {
    div.classList.add('oauth-toast--leaving');
  }, 2700);
  setTimeout(() => {
    div.remove();
  }, 3000);
}

// 统一解析后端错误响应；解析失败时使用调用方提供的兜底文案。
async function readResponseError(res, fallback) {
  try {
    const json = await res.json();
    return json?.error || fallback;
  } catch {
    return fallback;
  }
}

// 并行拉取适配器与凭据后重绘。
async function refresh() {
  await Promise.all([loadAdapters(), loadCredentials(), loadAppSettings(), loadTrashSummary()]);
  renderTrashSummary();
  renderList();
}

refresh();
