const DEFAULT_TIMEOUT_MS = 8000;

export async function connectCdpPage({ port, targetUrl = '', fetchImpl = globalThis.fetch, webSocketFactory = defaultWebSocketFactory } = {}) {
  if (!port) throw new Error('CDP port is required');
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, fetchImpl);
  const pageTarget = pickPageTarget(targets, targetUrl);
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error('No debuggable Jimeng page target found');
  }
  return new CdpSession(pageTarget.webSocketDebuggerUrl, { webSocketFactory });
}

export async function runJimengPageAutomation(feedPackage, { cdp, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!cdp) throw new Error('cdp session is required');
  const references = feedPackage.references || [];
  // 同一素材可以在提示词正文中多次出现，但上传区只保留一份物理文件，
  // 避免把重复语义引用误判成需要重复上传的参考缩略图。
  const files = uniqueReferenceFiles(references);
  const setupTarget = buildJimengSetupTarget(feedPackage);

  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  const navigation = await ensureJimengVideoPage(cdp, feedPackage?.targetUrl, { timeoutMs });
  const pageSetup = normalizeJimengPageSetup({
    ...(await configureJimengWorkspace(cdp, setupTarget, { timeoutMs })),
    videoPageReady: navigation.videoPageReady
  }, setupTarget);
  const composerState = await waitForJimengComposer(cdp, { timeoutMs });

  const clearResult = composerState?.loginLikely
    ? { existingReferencesCleared: 0 }
    : await clearExistingReferenceFiles(cdp, { timeoutMs });
  const cleanupBlocked = shouldStopForReferenceCleanup(clearResult, references);
  const uploadResult = composerState?.loginLikely || cleanupBlocked
    ? { fileInputsFound: 0, filesAttached: 0 }
    : await attachReferenceFiles(cdp, files, { timeoutMs });
  const fillResult = composerState?.loginLikely
    ? { promptFilled: false, loginLikely: true, editor: null }
    : cleanupBlocked
      ? { promptFilled: false, loginLikely: false, editor: null, blockedByReferenceCleanup: true }
      : await fillPromptWithReferences(cdp, feedPackage.prompt || '', references, { timeoutMs });
  const gateResult = await evaluateByValue(cdp, buildPreSubmitInspectExpression(), { timeoutMs });
  const status = inferAutomationStatus({ pageSetup, fillResult, uploadResult, gateResult, references, clearResult });

  return {
    status,
    navigation,
    pageSetup,
    promptFilled: !!fillResult?.promptFilled,
    loginLikely: !!fillResult?.loginLikely,
    editor: fillResult?.editor || null,
    existingReferencesCleared: Number(clearResult?.existingReferencesCleared || 0),
    fileInputsFound: uploadResult.fileInputsFound,
    filesAttached: uploadResult.filesAttached,
    referenceBindingAttempted: !!fillResult?.referenceBindingAttempted,
    referenceBindingMethod: fillResult?.referenceBindingMethod || null,
    boundReferenceCount: Number(fillResult?.boundReferenceCount || 0),
    bindingSteps: fillResult?.bindingSteps || [],
    bindingTimedOut: !!fillResult?.bindingTimedOut,
    missingBindingPlaceholders: fillResult?.missingBindingPlaceholders || [],
    rawMentionCount: Number(gateResult?.rawMentionCount || 0),
    chipCount: Number(gateResult?.chipCount || 0),
    uploadedReferenceCount: Number(gateResult?.uploadedReferenceCount || 0),
    uploadedReferenceCountReliable: gateResult?.uploadedReferenceCountReliable !== false,
    remainingReferenceCount: Number(clearResult?.remainingReferenceCount || 0),
    requiresManualBinding: status === 'manual_reference_binding_required',
    notes: buildAutomationNotes({ status, pageSetup, references, clearResult, uploadResult, fillResult, gateResult })
  };
}

async function ensureJimengVideoPage(cdp, targetUrl, { timeoutMs }) {
  const inspect = () => evaluateByValue(cdp, `(() => {
    const url = location.href;
    const isAudio = /(?:ai_feature_name=audio|[?&]type=audio)/.test(url);
    return {
      jimengVideoLocationProbe: true,
      url,
      isVideo: !isAudio && /(?:ai_feature_name=video|[?&]type=video)/.test(url)
    };
  })()`, { timeoutMs: 2000 }).catch(() => ({ url: '', isVideo: false }));
  const initial = (await inspect()) || { url: '', isVideo: false };
  if (!initial.url || !targetUrl) {
    return {
      navigated: false,
      fromUrl: initial.url || '',
      url: initial.url || targetUrl || '',
      workspaceRecovered: false,
      // 旧测试桩或受限页面可能不给 location；此时保留后续页面设置脚本作为实际门禁。
      videoPageReady: !initial.url || !!initial.isVideo
    };
  }

  // 托管窗口会跨视频和音频任务复用；切换能力时必须保留当前项目空间，
  // 否则即梦会落到通用“开启创作”页，后续模型、素材与引用绑定都没有有效宿主。
  let navigationUrl = preserveJimengWorkspace(targetUrl, initial.url);
  let workspaceRecovered = false;
  if (!getJimengWorkspace(navigationUrl, targetUrl)) {
    // 通用视频页可能已经丢失 workspace。只从 Drama Creator 受管窗口自己的
    // 同域导航历史恢复最近项目空间；找不到时不猜测，交给后续空间门禁继续阻断。
    const recoveredWorkspace = await recoverJimengWorkspaceFromHistory(cdp, targetUrl, { timeoutMs });
    if (recoveredWorkspace) {
      navigationUrl = setJimengWorkspace(navigationUrl, recoveredWorkspace);
      workspaceRecovered = true;
    }
  }

  const initialWorkspace = getJimengWorkspace(initial.url, targetUrl);
  const navigationWorkspace = getJimengWorkspace(navigationUrl, targetUrl);
  const workspaceChanged = !!navigationWorkspace && navigationWorkspace !== initialWorkspace;
  if (initial.isVideo && !workspaceChanged) {
    return {
      navigated: false,
      fromUrl: initial.url,
      url: initial.url,
      workspaceRecovered: false,
      videoPageReady: true
    };
  }

  await sendWithTimeout(cdp, 'Page.navigate', { url: navigationUrl }, Math.min(timeoutMs, 5000));
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  let current = initial;
  while (Date.now() < deadline) {
    current = (await inspect()) || { url: '', isVideo: false };
    if (current.isVideo) break;
    await sleep(150);
  }
  return {
    navigated: true,
    fromUrl: initial.url || '',
    url: current.url || navigationUrl,
    workspaceRecovered,
    videoPageReady: !!current.isVideo
  };
}

async function recoverJimengWorkspaceFromHistory(cdp, targetUrl, { timeoutMs }) {
  try {
    const history = await sendWithTimeout(
      cdp,
      'Page.getNavigationHistory',
      {},
      Math.min(timeoutMs, 3000)
    );
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    const currentIndex = Number.isInteger(history?.currentIndex)
      ? Math.min(history.currentIndex, entries.length - 1)
      : entries.length - 1;
    for (let index = currentIndex; index >= 0; index -= 1) {
      const workspace = getJimengWorkspace(entries[index]?.url, targetUrl);
      if (workspace) return workspace;
    }
  } catch {
    // 历史读取失败不能降级为猜测 workspace；后续页面设置门禁会保留失败状态。
  }
  return '';
}

function preserveJimengWorkspace(targetUrl, currentUrl) {
  const activeWorkspace = getJimengWorkspace(currentUrl, targetUrl);
  return activeWorkspace ? setJimengWorkspace(targetUrl, activeWorkspace) : targetUrl;
}

function getJimengWorkspace(candidateUrl, targetUrl) {
  try {
    const candidate = new URL(candidateUrl);
    const target = new URL(targetUrl);
    if (candidate.origin !== target.origin || candidate.pathname !== target.pathname) return '';
    return candidate.searchParams.get('workspace') || '';
  } catch {
    return '';
  }
}

function setJimengWorkspace(targetUrl, workspace) {
  try {
    const target = new URL(targetUrl);
    target.searchParams.set('workspace', workspace);
    return target.toString();
  } catch {
    return targetUrl;
  }
}

async function configureJimengWorkspace(cdp, setupTarget, { timeoutMs }) {
  try {
    return await evaluateByValue(cdp, buildJimengSetupExpression(setupTarget), { timeoutMs });
  } catch (error) {
    return {
      setupAttempted: true,
      ...setupTarget,
      modeSet: false,
      modelSet: false,
      referenceModeSet: false,
      spaceSet: !setupTarget.targetSpaceName,
      ratioSet: false,
      durationSet: false,
      error: error?.message || String(error)
    };
  }
}

function buildJimengSetupTarget(feedPackage) {
  const duration = Number(feedPackage?.params?.duration);
  return {
    targetMode: feedPackage?.workspace?.mode || '视频生成',
    targetModel: feedPackage?.workspace?.model || 'Seedance 2.0 mini',
    targetReferenceMode: feedPackage?.workspace?.referenceMode || '全能参考',
    targetSpaceName: feedPackage?.workspace?.spaceName || '',
    targetRatio: feedPackage?.params?.ratio || '9:16',
    targetDuration: `${Number.isFinite(duration) && duration > 0 ? duration : 5}s`
  };
}

function normalizeJimengPageSetup(pageSetup, setupTarget) {
  if (!pageSetup || typeof pageSetup !== 'object') return pageSetup;
  const normalized = { ...pageSetup };
  if (!normalized.targetModel) normalized.targetModel = setupTarget.targetModel;
  if (normalized.modelSet === undefined && normalized.toolbarText) {
    normalized.modelSet = jimengModelToolbarMatches(normalized.toolbarText, setupTarget.targetModel);
  }
  return normalized;
}

function jimengModelToolbarMatches(toolbarText = '', targetModel = '') {
  const text = String(toolbarText || '');
  // 即梦把会员档直接追加在基础模型名后；普通版校验必须排除 VIP，避免静默切到高积分档。
  if (targetModel === 'Seedance 2.0') return /Seedance\s*2\.0(?!\s*(?:Fast|mini|VIP))/i.test(text);
  return !!targetModel && text.includes(targetModel);
}

async function waitForJimengComposer(cdp, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await evaluateByValue(cdp, buildComposerProbeExpression(), { timeoutMs: 1000 }).catch((error) => ({ error: error.message }));
    if (lastState?.editableCount > 0 || lastState?.fileInputCount > 0 || lastState?.loginLikely) return lastState;
    await sleep(150);
  }
  return lastState;
}

function pickPageTarget(targets, targetUrl) {
  const pages = Array.isArray(targets) ? targets.filter((target) => target.type === 'page') : [];
  if (!pages.length) return null;
  const jimeng = pages.find((target) => String(target.url || '').includes('jimeng.jianying.com'));
  if (jimeng) return jimeng;
  if (targetUrl) {
    const host = safeHost(targetUrl);
    const sameHost = pages.find((target) => safeHost(target.url) === host);
    if (sameHost) return sameHost;
  }
  return pages[0];
}

async function attachReferenceFiles(cdp, files, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!files.length) return { fileInputsFound: 0, filesAttached: 0 };
  let lastError = null;

  try {
    const objectResult = await attachReferenceFilesByObjectId(cdp, files, { timeoutMs });
    if (objectResult.filesAttached > 0) return objectResult;
  } catch (error) {
    lastError = error;
  }

  const nodeResult = await attachReferenceFilesByNodeId(cdp, files, { timeoutMs, attempts: 3 });
  if (nodeResult.filesAttached > 0 || nodeResult.fileInputsFound === 0) return nodeResult;
  return {
    ...nodeResult,
    error: nodeResult.error || lastError?.message || '未能把参考资源挂载到即梦 file input'
  };
}

async function clearExistingReferenceFiles(cdp, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    // 即梦逐个移除参考缩略图时每项都需要等待界面状态落盘；复投 7-12 个素材时，
    // 原来的 6 秒上限会中途超时并遗留旧缩略图，下一轮上传后就会表现为重复素材。
    return await evaluateByValue(cdp, buildClearReferenceFilesExpression(), {
      timeoutMs: Math.min(timeoutMs, 20000)
    });
  } catch (error) {
    return { existingReferencesCleared: 0, error: error?.message || String(error) };
  }
}

async function attachReferenceFilesByObjectId(cdp, files, { timeoutMs }) {
  const inputResult = await sendWithTimeout(cdp, 'Runtime.evaluate', {
    expression: `(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      return inputs.find((input) => !input.disabled) || inputs[0] || null;
    })()`,
    objectGroup: 'jimeng-file-input-upload'
  }, timeoutMs);
  const objectId = inputResult?.result?.objectId;
  if (!objectId) return { fileInputsFound: 0, filesAttached: 0 };

  try {
    // 优先使用 Runtime objectId：即梦前端重绘时 DOM nodeId 容易失效，objectId 对当前 JS 对象更稳定。
    await sendWithTimeout(cdp, 'DOM.setFileInputFiles', { objectId, files }, timeoutMs);
    await evaluateByValue(cdp, buildFileInputChangeExpression(), { timeoutMs });
    return { fileInputsFound: 1, filesAttached: files.length, attachMethod: 'objectId' };
  } finally {
    await sendWithTimeout(cdp, 'Runtime.releaseObjectGroup', { objectGroup: 'jimeng-file-input-upload' }, 1000).catch(() => {});
  }
}

async function attachReferenceFilesByNodeId(cdp, files, { timeoutMs, attempts }) {
  let lastError = null;
  let lastInputCount = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const query = await queryFileInputNodeIds(cdp, { timeoutMs });
    lastInputCount = query.fileInputsFound;
    if (!query.nodeIds.length) return { fileInputsFound: 0, filesAttached: 0 };

    try {
      // nodeId 仍作为兜底；失败后重新 query，一些前端框架会在上传控件展开时替换 input。
      await sendWithTimeout(cdp, 'DOM.setFileInputFiles', { nodeId: query.nodeIds[0], files }, timeoutMs);
      await evaluateByValue(cdp, buildFileInputChangeExpression(), { timeoutMs });
      return { fileInputsFound: query.nodeIds.length, filesAttached: files.length, attachMethod: 'nodeId' };
    } catch (error) {
      lastError = error;
      await sleep(180);
    }
  }
  return {
    fileInputsFound: lastInputCount,
    filesAttached: 0,
    attachMethod: 'nodeId',
    error: lastError?.message || 'DOM.setFileInputFiles failed'
  };
}

async function queryFileInputNodeIds(cdp, { timeoutMs }) {
  const documentResult = await sendWithTimeout(cdp, 'DOM.getDocument', { depth: -1, pierce: true }, timeoutMs);
  const rootNodeId = documentResult?.root?.nodeId;
  if (!rootNodeId) return { fileInputsFound: 0, nodeIds: [] };

  const queryResult = await sendWithTimeout(cdp, 'DOM.querySelectorAll', {
    nodeId: rootNodeId,
    selector: 'input[type="file"]'
  }, timeoutMs);
  const nodeIds = queryResult?.nodeIds || [];
  return { fileInputsFound: nodeIds.length, nodeIds };
}

async function fillPromptWithReferences(cdp, prompt, references, { timeoutMs }) {
  try {
    // 单参考镜头也走逐段绑定：这样才能复用文件名 @ 搜索兜底和真实 chip 校验，避免旧的一次性填充路径留下普通 @资源文本。
    if (references.length > 0) {
      return await fillPromptWithReferencesStepwise(cdp, prompt, references, { timeoutMs });
    }
    return await evaluateByValue(cdp, buildPromptFillExpression(prompt, references, timeoutMs), { timeoutMs });
  } catch (error) {
    return {
      promptFilled: false,
      loginLikely: false,
      editor: null,
      referenceBindingAttempted: references.length > 0,
      referenceBindingMethod: references.length ? 'jimeng_reference_toolbar' : null,
      boundReferenceCount: 0,
      missingBindingPlaceholders: expectedPlaceholders(prompt, references),
      sourcePrompt: prompt,
      error: error?.message || String(error)
    };
  }
}

async function fillPromptWithReferencesStepwise(cdp, prompt, references, { timeoutMs }) {
  const startedAt = Date.now();
  const remainingTimeout = () => Math.max(1200, timeoutMs - (Date.now() - startedAt));
  const referenceByPlaceholder = new Map(references.map((ref, index) => [ref.placeholder || `@图片${index + 1}`, ref]));
  const handledPlaceholders = new Set();
  const boundPlaceholders = new Set();
  const bindingSummary = {
    promptFilled: true,
    loginLikely: false,
    editor: null,
    referenceBindingAttempted: true,
    referenceBindingMethod: 'jimeng_reference_toolbar_stepwise',
    boundReferenceCount: 0,
    missingBindingPlaceholders: [],
    bindingTimedOut: false,
    sourcePrompt: prompt,
    bindingSteps: []
  };

  const clearResult = await evaluateByValue(cdp, buildEditorClearExpression(), { timeoutMs: Math.min(8000, remainingTimeout()) });
  bindingSummary.editor = clearResult?.editor || null;

  const tokens = tokenizePromptText(prompt);
  for (const token of tokens) {
    if (remainingTimeout() <= 1500) {
      bindingSummary.bindingTimedOut = true;
      for (const placeholder of expectedPlaceholders(prompt, references)) {
        if (!boundPlaceholders.has(placeholder)) bindingSummary.missingBindingPlaceholders.push(placeholder);
      }
      break;
    }
    if (token.type === 'text') {
      await evaluateByValue(cdp, buildEditorInsertTextExpression(token.value), { timeoutMs: Math.min(8000, remainingTimeout()) });
      continue;
    }

    const placeholder = token.value;
    if (handledPlaceholders.has(placeholder)) {
      // 同一参考可以在提示词里多次被提及，但即梦输入区只保留一个真实 chip，避免参考内容重复上传和重复绑定。
      await evaluateByValue(cdp, buildEditorInsertTextExpression('该参考资源'), { timeoutMs: Math.min(8000, remainingTimeout()) });
      continue;
    }
    handledPlaceholders.add(placeholder);

    const ref = referenceByPlaceholder.get(placeholder);
    if (!ref) {
      bindingSummary.missingBindingPlaceholders.push(placeholder);
      await evaluateByValue(cdp, buildEditorInsertTextExpression(placeholder), { timeoutMs: Math.min(8000, remainingTimeout()) });
      continue;
    }

    // 多参考资源时把每个 chip 绑定拆成独立 CDP 调用，避免一个长 Runtime 脚本被即梦异步 UI 拖到超时。
    const step = await evaluateByValue(cdp, buildReferenceChipInsertExpression(ref), { timeoutMs: Math.min(18000, remainingTimeout()) });
    bindingSummary.bindingSteps.push({
      placeholder,
      ok: !!step?.ok,
      reason: step?.reason || '',
      optionText: step?.optionText || '',
      chipCountDelta: Number(step?.chipCountDelta || 0)
    });
    if (step?.ok) {
      bindingSummary.boundReferenceCount += 1;
      boundPlaceholders.add(placeholder);
    } else {
      bindingSummary.missingBindingPlaceholders.push(placeholder);
      await evaluateByValue(cdp, buildEditorInsertTextExpression(placeholder), { timeoutMs: Math.min(8000, remainingTimeout()) });
    }
  }

  const finalState = await evaluateByValue(cdp, buildPreSubmitInspectExpression(), { timeoutMs: Math.min(5000, remainingTimeout()) });
  return {
    ...bindingSummary,
    rawMentionCount: Number(finalState?.rawMentionCount || 0),
    chipCount: Number(finalState?.chipCount || 0)
  };
}

function tokenizePromptText(prompt = '') {
  const tokens = [];
  const regex = /(@(?:图片|视频|音频)\d+)/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(String(prompt || ''))) !== null) {
    if (match.index > lastIndex) tokens.push({ type: 'text', value: String(prompt).slice(lastIndex, match.index) });
    tokens.push({ type: 'placeholder', value: match[1] });
    lastIndex = match.index + match[1].length;
  }
  if (lastIndex < String(prompt || '').length) tokens.push({ type: 'text', value: String(prompt).slice(lastIndex) });
  return tokens;
}

function buildEditorCommonExpressionBody() {
  return `
    const visible = (el) => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? window.getComputedStyle?.(el) : null;
      return !!rect && rect.width > 8 && rect.height > 8 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const editor = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'))
      .filter(visible)
      .sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height))[0];
    if (!editor) return { ok: false, reason: 'editor_not_found', editor: null };
    const editorInfo = () => ({ tag: editor.tagName, role: editor.getAttribute('role') || '', contenteditable: editor.getAttribute('contenteditable') || '' });
    const focusEnd = () => {
      editor.focus();
      if (editor.matches('textarea, input[type="text"]')) {
        editor.selectionStart = editor.selectionEnd = editor.value.length;
        return;
      }
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const insertText = (text) => {
      if (!text) return;
      focusEnd();
      if (editor.matches('textarea, input[type="text"]')) {
        const start = editor.selectionStart ?? editor.value.length;
        const end = editor.selectionEnd ?? editor.value.length;
        const nextValue = editor.value.slice(0, start) + text + editor.value.slice(end);
        const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(editor, nextValue) : (editor.value = nextValue);
        editor.selectionStart = editor.selectionEnd = start + text.length;
      } else {
        const inserted = document.execCommand('insertText', false, text);
        if (!inserted) editor.textContent = (editor.textContent || '') + text;
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const chipsInEditor = () => Array.from(editor.querySelectorAll('.node-reference-mention-tag, [data-node-type*="mention"], [data-mention]'));
  `;
}

function buildEditorClearExpression() {
  return `(() => {
    ${buildEditorCommonExpressionBody()}
    editor.focus();
    if (editor.matches('textarea, input[type="text"]')) {
      const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter ? setter.call(editor, '') : (editor.value = '');
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete', false);
      if ((editor.innerText || '').trim()) editor.textContent = '';
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: null, inputType: 'deleteContentBackward' }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, editor: editorInfo() };
  })()`;
}

function buildEditorInsertTextExpression(text) {
  const textJson = JSON.stringify(text);
  return `(() => {
    const text = ${textJson};
    ${buildEditorCommonExpressionBody()}
    insertText(text);
    return { ok: true, textLength: (editor.innerText || editor.value || '').length, chipCount: chipsInEditor().length, editor: editorInfo() };
  })()`;
}

function buildReferenceChipInsertExpression(ref) {
  const refJson = JSON.stringify(ref);
  return `(() => {
    const ref = ${refJson};
    ${buildEditorCommonExpressionBody()}
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clickElement = (el, { callNativeClick = false } = {}) => {
      if (!el) return false;
      el.scrollIntoView?.({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const EventClass = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new EventClass(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2
        }));
      }
      if (callNativeClick && typeof el.click === 'function') el.click();
      return true;
    };
    const optionLabelCandidates = () => {
      const path = ref.uploadPath || ref.path || '';
      const basename = String(path).split(/[\\\\/]/).pop() || '';
      const stem = basename.replace(/\\.[^.]+$/, '');
      return [ref.title, ref.name, ref.id, ref.placeholder, basename, stem]
        .filter(Boolean)
        .map((item) => String(item).trim())
        .filter(Boolean);
    };
    const referenceSearchQuery = () => {
      const path = ref.uploadPath || ref.path || '';
      const basename = String(path).split(/[\\\\/]/).pop() || '';
      const stem = basename.replace(/\\.[^.]+$/, '');
      return (stem || optionLabelCandidates().find((label) => label !== ref.placeholder) || '')
        .replace(/^@/, '')
        .slice(0, 64);
    };
    const removeInsertedSearchText = (searchText) => {
      if (!searchText) return;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let node;
      let found = null;
      while ((node = walker.nextNode())) {
        const index = node.nodeValue.lastIndexOf(searchText);
        if (index >= 0) found = { node, index };
      }
      if (!found) return;
      const range = document.createRange();
      range.setStart(found.node, found.index);
      range.setEnd(found.node, found.index + searchText.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete', false);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: null, inputType: 'deleteContentBackward' }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const normalizedOptionText = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g, '');
    const genericLabelTokens = new Set(['png', 'jpg', 'jpeg', 'char', 'scene', 'asset', 'image', 'picture', 'reference', 'tail', 'for', '01', '02', '03', '04', '05']);
    const labelTokens = (value) => String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9\\u4e00-\\u9fa5]+/g)
      .filter((token) => token.length > 1 && !genericLabelTokens.has(token) && !/^\\d+$/.test(token));
    const scoreReferenceOption = (optionText, labels) => {
      const optionNorm = normalizedOptionText(optionText);
      if (!optionNorm || /创建主体/.test(optionText)) return 0;
      let best = 0;
      for (const label of labels) {
        const labelNorm = normalizedOptionText(label);
        if (!labelNorm) continue;
        if (optionNorm === labelNorm) best = Math.max(best, 100);
        if (optionNorm.includes(labelNorm) || labelNorm.includes(optionNorm)) best = Math.max(best, 80);
        if (labelNorm.length > 4 && optionNorm.includes(labelNorm.slice(1))) best = Math.max(best, 72);
        const tokens = labelTokens(label);
        const tokenHits = tokens.filter((token) => optionNorm.includes(token) || optionNorm.includes(token.slice(1))).length;
        // Never let shared weak tokens such as "char" or "01" bind to the wrong uploaded resource.
        const requiredHits = tokens.length <= 1 ? tokens.length : Math.min(2, tokens.length);
        if (requiredHits > 0 && tokenHits >= requiredHits) best = Math.max(best, 40 + tokenHits * 12);
      }
      return best;
    };
    const visibleOptions = () => Array.from(document.querySelectorAll('[role="option"],li,.lv-select-option'))
      .filter(visible)
      .filter((el) => textOf(el));
    const candidateMenuHasReferences = () => {
      const menuText = Array.from(document.querySelectorAll('[role="listbox"],.lv-select-popup,.lv-trigger-popup,.lv-popover'))
        .filter(visible)
        .map(textOf)
        .join('\\n');
      return /可能@的内容/.test(menuText) || optionLabelCandidates().some((label) => label && menuText.includes(label));
    };
    const findReferenceMenuButtons = () => {
      const labelled = Array.from(document.querySelectorAll('button,[role="button"],span,div'))
        .filter(visible)
        .filter((el) => {
          const semantic = textOf(el) + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
          if (!/引用参考|@/.test(semantic)) return false;
          return !!el.closest('.toolbar-ejS5ZW,[role="toolbar"],[class*="toolbar"]');
        });
      const toolbarIconButtons = Array.from(document.querySelectorAll('[role="toolbar"] button,[class*="toolbar"] button'))
        .filter(visible)
        .filter((el) => {
          const cls = String(el.className || '');
          if (cls.includes('submit-button') || cls.includes('scroll-button')) return false;
          if (textOf(el)) return false;
          return cls.includes('toolbar-button') && cls.includes('icon-only');
        });
      return [...new Set([...labelled, ...toolbarIconButtons])];
    };
    const openInlineReferenceMenu = async () => {
      const query = referenceSearchQuery();
      if (!query) return { opened: false, method: 'inline_mention', searchText: '' };
      const searchText = '@' + query;
      // 工具栏入口缺失时再走输入 @ 搜索候选；这只是打开即梦原生候选，成功仍以真实 chip 校验为准。
      insertText(searchText);
      await sleep(650);
      if (candidateMenuHasReferences() && visibleOptions().length) {
        return { opened: true, method: 'inline_mention', searchText };
      }
      removeInsertedSearchText(searchText);
      return { opened: false, method: 'inline_mention', searchText };
    };
    const openReferenceMenu = async () => {
      focusEnd();
      for (const button of findReferenceMenuButtons()) {
        clickElement(button, { callNativeClick: true });
        await sleep(450);
        if (candidateMenuHasReferences() && visibleOptions().length) return { opened: true, method: 'toolbar', searchText: '' };
      }
      return openInlineReferenceMenu();
    };
    return (async () => {
      const beforeChipCount = chipsInEditor().length;
      let menu = await openReferenceMenu();
      if (!menu.opened) {
        // 即梦在刚完成多图上传时会短暂晚于缩略图渲染引用菜单；首个引用等待后重试，
        // 避免把可恢复的 UI 就绪延迟误判成手工绑定，同时仍以真实 chip 增量作为成功条件。
        await sleep(900);
        menu = await openReferenceMenu();
      }
      if (!menu.opened) return { ok: false, reason: 'reference_menu_not_found', chipCountDelta: 0, menu };
      const labels = optionLabelCandidates();
      const option = visibleOptions()
        .map((candidate) => ({ candidate, score: scoreReferenceOption(textOf(candidate), labels) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)[0]?.candidate || null;
      const optionText = textOf(option);
      if (!option) {
        removeInsertedSearchText(menu.searchText);
        return { ok: false, reason: 'reference_option_not_found', optionText: '', chipCountDelta: 0, menu };
      }
      // 候选项只走一套鼠标事件；额外调用 native click 会让即梦插入两个同名 chip。
      clickElement(option);
      await sleep(900);
      const afterChipCount = chipsInEditor().length;
      if (afterChipCount <= beforeChipCount) removeInsertedSearchText(menu.searchText);
      return {
        ok: afterChipCount > beforeChipCount,
        reason: afterChipCount > beforeChipCount ? '' : 'chip_not_inserted',
        optionText,
        menu,
        chipCountDelta: afterChipCount - beforeChipCount
      };
    })();
  })()`;
}

function shouldStopForReferenceCleanup(clearResult, references) {
  if (!references.length) return false;
  // Runtime.evaluate 超时不会取消页面里仍在执行的异步清理脚本。此时继续上传会与旧脚本并发，
  // 造成参考素材刚上传又被删除，或新旧素材同时残留；清理状态不确定时必须阻断本轮上传。
  if (clearResult?.error) return true;
  if (!clearResult?.scopedToComposer) return false;
  return Number(clearResult.remainingReferenceCount || 0) > 0;
}

function inferAutomationStatus({ pageSetup, fillResult, uploadResult, gateResult, references, clearResult }) {
  if (fillResult?.loginLikely) return 'login_required';
  if (pageSetup?.setupAttempted && pageSetup.loginLikely) return 'login_required';
  if (pageSetup?.videoPageReady === false || (pageSetup?.setupAttempted && (!pageSetup.modeSet || !pageSetup.modelSet || !pageSetup.referenceModeSet || pageSetup.spaceSet === false || !pageSetup.ratioSet || !pageSetup.durationSet))) {
    return 'manual_settings_required';
  }
  if (shouldStopForReferenceCleanup(clearResult, references)) return 'manual_reference_binding_required';
  if (!fillResult?.promptFilled) return 'manual_required';
  if (references.length && uploadResult.filesAttached === 0) return 'manual_upload_required';
  if (references.length && fillResult?.missingBindingPlaceholders?.length) return 'manual_reference_binding_required';
  if (references.length && Number(gateResult?.rawMentionCount || 0) > 0) return 'manual_reference_binding_required';
  if (references.length && Number(gateResult?.chipCount || 0) < expectedReferenceCount(references, feedPackagePlaceholderSource(fillResult))) {
    return 'manual_reference_binding_required';
  }
  const hasUploadedReferenceCount = Object.prototype.hasOwnProperty.call(gateResult || {}, 'uploadedReferenceCount');
  const uploadedReferenceCountReliable = gateResult?.uploadedReferenceCountReliable !== false;
  const expectedUploadCount = expectedUploadedReferenceCount(references);
  if (references.length && hasUploadedReferenceCount && uploadedReferenceCountReliable && Number(gateResult?.uploadedReferenceCount || 0) !== expectedUploadCount) {
    return 'manual_reference_binding_required';
  }
  return 'pre_submit_confirmation';
}

function expectedReferenceCount(references, prompt = '') {
  return expectedPlaceholders(prompt, references).length;
}

function expectedUploadedReferenceCount(references = []) {
  return uniqueReferenceFiles(references).length;
}

function uniqueReferenceFiles(references = []) {
  return [...new Set(
    references
      .map((ref) => ref?.uploadPath || ref?.path || '')
      .filter(Boolean)
  )];
}

function expectedPlaceholders(prompt = '', references = []) {
  const matches = String(prompt || '').match(/@(?:图片|视频|音频)\d+/g) || [];
  const placeholders = matches.length ? matches : references.map((ref, index) => ref.placeholder || `@图片${index + 1}`);
  // 门禁按唯一参考计数；正文重复提及不应要求页面生成重复 chip。
  return [...new Set(placeholders)];
}

function feedPackagePlaceholderSource(fillResult) {
  return fillResult?.sourcePrompt || '';
}

function buildAutomationNotes({ status, pageSetup, references, clearResult, uploadResult, fillResult, gateResult }) {
  const notes = [];
  if (status === 'login_required') notes.push('需要先在应用托管窗口登录即梦。');
  if (status === 'manual_settings_required') notes.push('未能自动完成即梦空间、视频生成模式、目标模型、全能参考、比例或时长设置，需要用户在即梦中手动确认后再继续。');
  if (pageSetup?.targetSpaceName && pageSetup?.spaceSet === false) {
    notes.push(`目标即梦空间是「${pageSetup.targetSpaceName}」，当前激活项识别为「${pageSetup.activeSpaceName || '未识别'}」，已停止提交前流程。`);
  }
  if (status === 'manual_required') notes.push('未找到可编辑的提示词输入框，需要用户手动粘贴投喂包提示词。');
  if (status === 'manual_upload_required') notes.push('未找到可用 file input，需要用户按上传清单手动上传参考资源。');
  if (status === 'manual_reference_binding_required') notes.push('即梦当前输入区的引用 chip 或参考缩略图未通过提交门禁，提交前必须修复。');
  if (status === 'pre_submit_confirmation') notes.push('页面已进入提交前确认状态，仍需用户确认后手动点击生成。');
  if (pageSetup?.dismissedModals) notes.push(`已关闭 ${pageSetup.dismissedModals} 个非生产弹窗。`);
  if (pageSetup?.setupAttempted && pageSetup.toolbarText) {
    notes.push(`当前即梦参数：${pageSetup.toolbarText.replace(/\s+/g, ' / ')}`);
  }
  if (fillResult?.error) notes.push(`页面填词脚本失败：${fillResult.error}`);
  if (references.length) {
    if (clearResult?.existingReferencesCleared) {
      notes.push(`已清理页面已有参考资源 ${clearResult.existingReferencesCleared} 个，避免复投时绑定到旧资源。`);
    }
    if (shouldStopForReferenceCleanup(clearResult, references)) {
      notes.push(`当前输入区仍残留 ${Number(clearResult.remainingReferenceCount || 0)} 个旧参考资源，已停止上传本次资源，避免继续叠加重复素材。`);
    }
    if (clearResult?.error) notes.push(`清理旧参考资源时遇到问题：${clearResult.error}`);
    notes.push(`参考资源：${uploadResult.filesAttached}/${references.length} 已挂到 file input。`);
    if (uploadResult.error) notes.push(`参考资源上传失败：${uploadResult.error}`);
    if (fillResult?.referenceBindingAttempted) {
      notes.push(`引用参考绑定：${Number(fillResult.boundReferenceCount || 0)}/${expectedReferenceCount(references, fillResult.sourcePrompt)} 已插入 chip。`);
      if (fillResult.bindingTimedOut) notes.push('引用参考绑定接近超时，已停止继续绑定并保留剩余原始占位符。');
    }
    const hasUploadedReferenceCount = Object.prototype.hasOwnProperty.call(gateResult || {}, 'uploadedReferenceCount');
    const uploadedReferenceCountReliable = gateResult?.uploadedReferenceCountReliable !== false;
    const expectedUploadCount = expectedUploadedReferenceCount(references);
    if (hasUploadedReferenceCount && uploadedReferenceCountReliable && Number(gateResult?.uploadedReferenceCount || 0) !== expectedUploadCount) {
      notes.push(`当前输入区参考缩略图数量为 ${gateResult.uploadedReferenceCount}，本次投喂应为 ${expectedUploadCount} 个；需要清空页面后重新投喂。`);
    }
  }
  notes.push(`当前 chip 数：${Number(gateResult?.chipCount || 0)}，原始 @ 标记数：${Number(gateResult?.rawMentionCount || 0)}。`);
  return notes;
}

function buildClearReferenceFilesExpression() {
  return `(() => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (el) => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? window.getComputedStyle?.(el) : null;
      return !!rect && rect.width > 3 && rect.height > 3 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title') || '').trim();
    const areaOf = (el) => {
      const rect = el?.getBoundingClientRect?.();
      return rect ? rect.width * rect.height : 0;
    };
    const clickElement = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const EventClass = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new EventClass(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2
        }));
      }
      if (typeof el.click === 'function') el.click();
      return true;
    };
    const hoverElement = (el) => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) {
        const EventClass = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new EventClass(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2
        }));
      }
    };
    const activeEditor = () => {
      const selector = 'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]';
      const focused = document.activeElement?.matches?.(selector) ? document.activeElement : null;
      const editors = Array.from(document.querySelectorAll(selector)).filter(visible).sort((a, b) => areaOf(b) - areaOf(a));
      return focused || editors[0] || null;
    };
    const composerRoot = () => {
      const editor = activeEditor();
      if (!editor) return null;
      // 参考缩略图只清当前输入区，不能扫全页；历史生成记录也有 reference-item，误扫会影响回看和 QC。
      // 不能直接用 closest('[class*="content-"]')，它会命中过近的 prompt-editor-container，漏掉左侧参考缩略图区。
      let node = editor;
      let layoutFallback = null;
      let contentFallback = null;
      while (node && node !== document.body) {
        const className = String(node.className || '');
        if (/content-generator|dimension-layout/.test(className)) return node;
        if (!layoutFallback && /layout-/.test(className)) layoutFallback = node;
        if (!contentFallback && /content-/.test(className)) contentFallback = node;
        node = node.parentElement;
      }
      return layoutFallback || contentFallback || editor.parentElement;
    };
    const referenceItems = () => {
      const editor = activeEditor();
      const root = composerRoot();
      if (!root || !editor) return [];
      return [...new Set(Array.from(root.querySelectorAll('[class*="reference-item"]')))]
        .filter(visible)
        // 即梦移除素材时会暂留 exit 动画节点；这些节点已经不属于当前输入，不能继续计数或再次点击。
        .filter((el) => !/reference-item[^ ]*(?:exit|leave)|(?:exit|leave)-(?:active|to)/i.test(String(el.className || '')))
        .filter((el) => !/reference-upload/i.test(String(el.className || '')))
        .filter((el) => !el.querySelector('[class*="reference-upload"]'))
        // 提示词编辑器会把 @图片/@音频渲染成带缩略图的 reference-item；它们是引用标签，不是上传素材。
        .filter((el) => !editor.contains(el))
        .filter((el) => el.querySelector('img,video,canvas,[style*="background-image"],[class*="reference-r"]'));
    };
    const referenceItemCount = () => referenceItems().length;
    const withinComposer = (el) => {
      const root = composerRoot();
      if (!root || !visible(el)) return false;
      const rr = root.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      return er.right >= rr.x - 96 && er.x <= rr.right + 96 && er.bottom >= rr.y - 96 && er.y <= rr.bottom + 96;
    };
    const removeButtons = () => {
      const explicitButtons = Array.from(document.querySelectorAll('[class*="remove-button"],[class*="close"],[class*="Close"],[class*="delete"],[aria-label*="移除"],[aria-label*="删除"],[title*="移除"],[title*="删除"]'))
        .filter(withinComposer)
        .filter((el) => /remove-button|×|x|close|remove|delete|移除|删除|关闭/i.test(String(el.className || '') + ' ' + textOf(el)));
      const pointButtons = referenceItems().flatMap((item) => {
        hoverElement(item);
        const rect = item.getBoundingClientRect();
        return [
          document.elementFromPoint(rect.right - 6, rect.top + 6),
          document.elementFromPoint(rect.right - 12, rect.top + 12),
          document.elementFromPoint(rect.right + 4, rect.top - 4)
        ].filter(Boolean);
      }).filter(withinComposer);
      return [...new Set([...explicitButtons, ...pointButtons])]
        .filter((el) => !el.closest('[class*="record-header"]'))
        .sort((a, b) => areaOf(a) - areaOf(b));
    };
    return (async () => {
      let existingReferencesCleared = 0;
      const root = composerRoot();
      if (!root) return { existingReferencesCleared: 0, remainingReferenceCount: 0, scopedToComposer: false };
      for (let i = 0; i < 40; i += 1) {
        const before = referenceItemCount();
        if (!before) break;
        hoverElement(root);
        referenceItems().forEach(hoverElement);
        await sleep(80);
        let removed = false;
        for (const target of removeButtons().slice(0, 24)) {
          if (!clickElement(target)) continue;
          await sleep(220);
          const after = referenceItemCount();
          if (after < before) {
            existingReferencesCleared += before - after;
            removed = true;
            break;
          }
        }
        // 当前输入区仍有旧参考但没有任何按钮能删时，停止本轮自动投喂，让状态机阻断提交。
        if (!removed) break;
      }
      return { existingReferencesCleared, remainingReferenceCount: referenceItemCount(), scopedToComposer: true };
    })();
  })()`;
}

function buildJimengSetupExpression(setupTarget) {
  const targetJson = JSON.stringify(setupTarget);
  return `(() => {
    const jimengSetupTarget = ${targetJson};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (el) => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? window.getComputedStyle?.(el) : null;
      return !!rect && rect.width > 3 && rect.height > 3 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const textOf = (el) => (el?.innerText || el?.textContent || '').trim();
    const clickElement = (el) => {
      if (!el) return false;
      el.scrollIntoView?.({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const EventClass = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new EventClass(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2
        }));
      }
      if (typeof el.click === 'function') el.click();
      return true;
    };
    const areaOf = (el) => {
      const rect = el?.getBoundingClientRect?.();
      return rect ? rect.width * rect.height : Number.MAX_SAFE_INTEGER;
    };
    const findVisibleExact = (selector, label) => Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .filter((el) => textOf(el) === label)
      .sort((a, b) => areaOf(a) - areaOf(b))[0];
    const preferredToolbars = () => Array.from(document.querySelectorAll('[role="toolbar"],[class*="toolbar"]'))
      .filter(visible)
      .filter((el) => /Agent 模式|视频生成|Seedance|全能参考|16:9|9:16|\\d+s/.test(textOf(el)))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      });
    const toolbarText = () => {
      const toolbar = preferredToolbars()[0];
      return textOf(toolbar);
    };
    const modelMatchesToolbar = (targetLabel) => {
      const text = toolbarText();
      // 普通档和 VIP 档共享基础名称，必须以完整变体判断，不能只用 includes。
      if (targetLabel === 'Seedance 2.0') return /Seedance\\s*2\\.0(?!\\s*(?:Fast|mini|VIP))/i.test(text);
      return text.includes(targetLabel);
    };
    const labelMatchesOption = (optionText, targetLabel) => {
      if (optionText === targetLabel) return true;
      if (targetLabel === 'Seedance 2.0') return /Seedance\\s*2\\.0(?!\\s*(?:Fast|mini|VIP))/i.test(optionText);
      return optionText.includes(targetLabel);
    };
    const findToolbarValue = (values, selector = '[role="combobox"],button,span,div') => {
      for (const toolbar of preferredToolbars()) {
        const match = Array.from(toolbar.querySelectorAll(selector))
          .filter(visible)
          .filter((el) => values.some((value) => textOf(el) === value || textOf(el).includes(value)))
          .sort((a, b) => areaOf(a) - areaOf(b))[0];
        if (match) return match.closest('[role="combobox"],button') || match;
      }
      return null;
    };
    const findCompositeToolbarButton = (values) => {
      for (const toolbar of preferredToolbars()) {
        const match = Array.from(toolbar.querySelectorAll('button,[role="button"]'))
          .filter(visible)
          .filter((el) => values.some((value) => textOf(el).includes(value)))
          .sort((a, b) => areaOf(a) - areaOf(b))[0];
        if (match) return match;
      }
      return null;
    };
    const clickOption = async (label) => {
      await sleep(120);
      const option = Array.from(document.querySelectorAll('[role="option"],li,button,[role="button"],span,div,.home-type-select-option-LeJEgy,[class*="radio"],[class*="option"],[class*="dropdown"],[class*="popover"]'))
        .filter(visible)
        .filter((el) => labelMatchesOption(textOf(el), label))
        .sort((a, b) => areaOf(a) - areaOf(b))[0] || findVisibleExact('[role="option"],li,button,[role="button"],span,div,.home-type-select-option-LeJEgy,[class*="radio"],[class*="option"],[class*="dropdown"],[class*="popover"]', label);
      const target = option?.closest('[role="option"],li,button,[role="button"],[class*="radio"],[class*="option"]') || option;
      const clicked = clickElement(target);
      await sleep(300);
      return clicked;
    };
    const closeBlockingModals = async () => {
      let dismissed = 0;
      // 即梦会不定期弹新功能介绍；先关闭这些非生产弹窗，否则配置栏点击会被遮挡。
      const modalTexts = ['继续绑定', '剪映专业版', '即梦资产支持剪映查看', 'SeedMusic', '音乐模型首发上线', '立即体验'];
      for (let i = 0; i < 3; i += 1) {
        const modal = Array.from(document.querySelectorAll('[role="dialog"],.lv-modal,.lv-modal-wrapper'))
          .filter(visible)
          .find((el) => modalTexts.some((text) => textOf(el).includes(text)));
        if (!modal) break;
        const close = modal.querySelector('[class*="close"],[class*="Close"],[aria-label*="关闭"],[aria-label*="close" i]') ||
          document.querySelector('[class*="close-icon"],[class*="Close"],[aria-label*="关闭"],[aria-label*="close" i]');
        if (!close || !clickElement(close)) break;
        dismissed += 1;
        await sleep(300);
      }
      return dismissed;
    };
    const setSelectLikeValue = async (labels, targetLabel, alreadySelected = () => toolbarText().includes(targetLabel)) => {
      if (alreadySelected()) return true;
      const control = findToolbarValue(labels);
      if (!control || !clickElement(control)) return false;
      const clicked = await clickOption(targetLabel);
      // 即梦的工具栏由前端异步重绘；选择项点击成功不代表新模式/模型已经挂载完成。
      for (let i = 0; i < 8; i += 1) {
        if (alreadySelected()) return true;
        await sleep(150);
      }
      return clicked && alreadySelected();
    };
    const setRatio = async (targetRatio) => {
      if (toolbarText().includes(targetRatio)) return true;
      const ratios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
      // 即梦新版把比例、清晰度和数量合并在一个 toolbar 按钮里，需先打开复合弹层再选目标比例。
      const control = findToolbarValue(ratios, 'button,span,div') || findCompositeToolbarButton(ratios);
      if (!control || !clickElement(control)) return false;
      return clickOption(targetRatio);
    };
    const setDuration = async (targetDuration) => {
      if (toolbarText().includes(targetDuration)) return true;
      // 控件定位必须包含“当前可能显示的时长”和目标时长；否则上一镜为 12s、下一镜为 15s 时，
      // 找不到承载 12s 文案的工具栏按钮，后续刻度和数值输入逻辑都不会执行。
      const durations = [...new Set([
        targetDuration,
        // 即梦当前滑杆覆盖 4-15 秒，3 秒用于兼容历史页面。
        '3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'
      ])];
      const control = findToolbarValue(durations, 'button,[role="button"],[role="combobox"],span,div');
      if (!control || !clickElement(control)) return false;
      // 时长滑杆通过 portal 异步挂载；等待面板出现后再查刻度和输入框，避免仍读到旧的 7s。
      await sleep(250);

      // 即梦页面同时保留历史结果卡片的“15s”标签；必须把选择范围锁在当前打开的时长面板，
      // 否则通用选项查找可能误点历史卡片，并把未生效的点击误判成设置成功。
      const durationPanel = Array.from(document.querySelectorAll('[class*="duration-panel"], [class*="duration-trigger"]'))
        .filter(visible)
        .sort((a, b) => areaOf(a) - areaOf(b))[0];

      // 即梦新版把时长改为 4-15 秒滑杆，刻度文案不带 s；先点击当前面板提供的精确刻度。
      const targetSeconds = String(Number.parseInt(targetDuration, 10));
      const tick = Array.from((durationPanel || document).querySelectorAll('button,[role="button"]'))
        .filter(visible)
        .find((el) => textOf(el).trim() === targetSeconds && /tick-button|duration/i.test(String(el.className || '')));
      if (tick && clickElement(tick)) {
        for (let i = 0; i < 8; i += 1) {
          if (toolbarText().includes(targetDuration)) return true;
          await sleep(150);
        }
      }

      // 12s 等非 5 秒刻度只能通过时长面板内的数值输入框设置；使用原生 setter 触发受控输入事件。
      const durationInput = Array.from((durationPanel || document).querySelectorAll('input[role="spinbutton"],input[type="number"]'))
        .filter(visible)
        .find((el) => {
          const semantic = [
            el.getAttribute('placeholder'),
            el.getAttribute('aria-label'),
            String(el.className || ''),
            String(el.closest('[class*="duration"], [class*="Duration"]')?.className || '')
          ].filter(Boolean).join(' ');
          return /4-15|duration/i.test(semantic);
        });
      if (durationInput) {
        durationInput.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(durationInput, targetSeconds);
        else durationInput.value = targetSeconds;
        const InputEventCtor = window.InputEvent || window.Event;
        durationInput.dispatchEvent(new InputEventCtor('input', { bubbles: true, inputType: 'insertText', data: targetSeconds }));
        durationInput.dispatchEvent(new Event('change', { bubbles: true }));
        durationInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        durationInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        durationInput.blur();
        for (let i = 0; i < 8; i += 1) {
          if (toolbarText().includes(targetDuration)) return true;
          await sleep(150);
        }
      }

      // 兼容仍使用下拉菜单的旧版页面；点击后也必须回读工具栏，不能把“点击到了某个同名元素”当成成功。
      const genericDurationOptionClicked = await clickOption(targetDuration);
      if (genericDurationOptionClicked) {
        for (let i = 0; i < 8; i += 1) {
          if (toolbarText().includes(targetDuration)) return true;
          await sleep(150);
        }
      }
      return toolbarText().includes(targetDuration);
    };
    const compactText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const spaceNameMatches = (candidate, spaceName) => {
      const current = compactText(candidate);
      const target = compactText(spaceName);
      return !!target && (current === target || current.includes(target));
    };
    const activeClassLike = (el) => {
      const semantic = [
        el?.getAttribute?.('aria-current'),
        el?.getAttribute?.('aria-selected'),
        el?.getAttribute?.('data-active'),
        el?.getAttribute?.('data-selected'),
        el?.getAttribute?.('title'),
        el?.getAttribute?.('aria-label'),
        String(el?.className || '')
      ].filter(Boolean).join(' ');
      return /active|selected|current|true|page/i.test(semantic);
    };
    const spaceItemLike = (el) => {
      const semantic = [
        String(el?.className || ''),
        el?.getAttribute?.('role'),
        el?.getAttribute?.('aria-label'),
        el?.getAttribute?.('title')
      ].filter(Boolean).join(' ');
      if (/toolbar|menu-item|select|option|popover|modal|button|input|editor/i.test(semantic)) return false;
      return /conversation|workspace|space|session|chat|history|side|sider|item/i.test(semantic);
    };
    const activeSpaceState = (spaceName) => {
      if (!spaceName) return { matched: true, activeSpaceName: '', method: 'no_target_space', candidates: [] };
      const seen = new Set();
      const candidates = Array.from(document.querySelectorAll('[aria-current],[aria-selected="true"],[data-active],[data-selected],[class*="active"],[class*="selected"],[class*="current"]'))
        .filter(visible)
        .map((el) => el.closest('[class*="conversation"],[class*="workspace"],[class*="space"],[class*="session"],[class*="chat"],[class*="history"],li,a,button,[role="button"],[role="option"]') || el)
        .filter((el) => {
          if (!el || seen.has(el)) return false;
          seen.add(el);
          return activeClassLike(el) && spaceItemLike(el);
        })
        .map((el) => ({
          text: compactText(textOf(el)),
          className: String(el.className || ''),
          role: el.getAttribute?.('role') || '',
          title: el.getAttribute?.('title') || '',
          ariaLabel: el.getAttribute?.('aria-label') || ''
        }))
        .filter((item) => item.text && !/^(生成|灵感|资产|画布|视频生成|图片生成)$/.test(item.text));
      const matched = candidates.find((item) => spaceNameMatches(item.text, spaceName));
      return {
        matched: !!matched,
        activeSpaceName: matched?.text || candidates[0]?.text || '',
        method: matched ? 'active_sidebar_item' : 'active_sidebar_item_mismatch',
        candidates: candidates.slice(0, 5)
      };
    };
    const findSpaceOption = (spaceName) => Array.from(document.querySelectorAll('button,a,[role="button"],[role="option"],li,span,div,[class*="conversation"],[class*="workspace"],[class*="space"]'))
      .filter(visible)
      .map((el) => {
        const text = compactText(textOf(el));
        const semantic = [
          String(el.className || ''),
          el.getAttribute?.('role'),
          el.getAttribute?.('aria-label'),
          el.getAttribute?.('title')
        ].filter(Boolean).join(' ');
        const exact = text === compactText(spaceName);
        const matched = exact || text.includes(compactText(spaceName));
        const score = (exact ? 100 : matched ? 60 : 0) +
          (/conversation|workspace|space|session|chat|history/i.test(semantic) ? 30 : 0) -
          (/toolbar|menu|popover|modal|editor|input/i.test(semantic) ? 40 : 0);
        return { el, text, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || areaOf(a.el) - areaOf(b.el))[0]?.el || null;
    const setSpace = async (spaceName) => {
      if (!spaceName) return { ok: true, evidence: activeSpaceState(spaceName), action: 'no_target_space' };
      const before = activeSpaceState(spaceName);
      if (before.matched) return { ok: true, evidence: before, action: 'already_active' };
      const switcher = Array.from(document.querySelectorAll('button,a,[role="button"],[role="combobox"],span,div'))
        .filter(visible)
        .filter((el) => {
          const label = [textOf(el), el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ');
          if (!/空间|项目|工作区|我的空间/.test(label)) return false;
          return !/视频生成|图片生成|全能参考|Seedance|\\d+s|16:9|9:16/.test(label);
        })
        .sort((a, b) => areaOf(a) - areaOf(b))[0];
      if (switcher) {
        clickElement(switcher);
        await sleep(350);
      }
      const option = findSpaceOption(spaceName);
      if (option) {
        clickElement(option.closest('[role="option"],li,button,a,[role="button"],[class*="option"]') || option);
        // 空间名在侧栏列表里出现不代表已经选中；必须等“当前激活项”也变成目标空间才允许继续投喂。
        for (let i = 0; i < 12; i += 1) {
          await sleep(180);
          const state = activeSpaceState(spaceName);
          if (state.matched) return { ok: true, evidence: state, action: 'clicked_and_verified', optionText: compactText(textOf(option)) };
        }
      }
      return {
        ok: false,
        evidence: activeSpaceState(spaceName),
        action: option ? 'clicked_but_not_verified' : 'target_option_not_found',
        optionText: option ? compactText(textOf(option)) : ''
      };
    };

    return (async () => {
      const bodyText = document.body?.innerText || '';
      const hasVisibleLoginEntry = Array.from(document.querySelectorAll('button,a,[role="button"],div,span'))
        .some((el) => visible(el) && textOf(el) === '登录');
      const loginLikely = hasVisibleLoginEntry || /立即登录|手机号|验证码/.test(bodyText);
      const result = {
        setupAttempted: true,
        ...jimengSetupTarget,
        loginLikely,
        dismissedModals: 0,
        modeSet: false,
        modelSet: false,
        referenceModeSet: false,
        spaceSet: !jimengSetupTarget.targetSpaceName,
        activeSpaceName: '',
        spaceEvidence: null,
        ratioSet: false,
        durationSet: false,
        toolbarText: ''
      };
      if (loginLikely) return result;

      result.dismissedModals = await closeBlockingModals();
      const spaceResult = await setSpace(jimengSetupTarget.targetSpaceName);
      result.spaceSet = !!spaceResult.ok;
      result.activeSpaceName = spaceResult.evidence?.activeSpaceName || '';
      result.spaceEvidence = spaceResult;
      await setSelectLikeValue(['Agent 模式', '图片生成', '视频生成', '数字人', '配音生成', '动作模仿'], jimengSetupTarget.targetMode);
      // 即梦下拉里普通 2.0、Fast、mini 名称相近；把 mini 显式列为独立候选，避免误选普通 2.0。
      await setSelectLikeValue(['Seedance 2.0 mini', 'Seedance 2.0 Fast', 'Seedance 2.0'], jimengSetupTarget.targetModel, () => modelMatchesToolbar(jimengSetupTarget.targetModel));
      await setSelectLikeValue(['全能参考', '动作参考', '首尾帧', '图生视频', '文生视频'], jimengSetupTarget.targetReferenceMode);
      await setRatio(jimengSetupTarget.targetRatio);
      await setDuration(jimengSetupTarget.targetDuration);

      const currentToolbarText = toolbarText();
      result.toolbarText = currentToolbarText;
      result.modeSet = currentToolbarText.includes(jimengSetupTarget.targetMode);
      result.modelSet = modelMatchesToolbar(jimengSetupTarget.targetModel);
      result.referenceModeSet = currentToolbarText.includes(jimengSetupTarget.targetReferenceMode);
      const finalSpaceState = activeSpaceState(jimengSetupTarget.targetSpaceName);
      result.spaceSet = jimengSetupTarget.targetSpaceName ? finalSpaceState.matched : true;
      result.activeSpaceName = finalSpaceState.activeSpaceName || result.activeSpaceName;
      result.spaceEvidence = { ...(result.spaceEvidence || {}), final: finalSpaceState };
      result.ratioSet = currentToolbarText.includes(jimengSetupTarget.targetRatio);
      result.durationSet = currentToolbarText.includes(jimengSetupTarget.targetDuration);
      return result;
    })();
  })()`;
}

function buildPromptFillExpression(prompt, references = [], timeoutMs = DEFAULT_TIMEOUT_MS) {
  const promptJson = JSON.stringify(prompt);
  const referencesJson = JSON.stringify(references);
  const internalTimeoutMs = Math.max(1000, Number(timeoutMs || DEFAULT_TIMEOUT_MS) - 1000);
  return `(() => {
    const prompt = ${promptJson};
    const references = ${referencesJson};
    const internalTimeoutMs = ${internalTimeoutMs};
    const startedAt = Date.now();
    const visible = (el) => {
      const rect = el.getBoundingClientRect?.();
      const style = window.getComputedStyle?.(el);
      return !!rect && rect.width > 8 && rect.height > 8 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const hasTime = () => Date.now() - startedAt < internalTimeoutMs;
    const remainingTime = () => Math.max(0, internalTimeoutMs - (Date.now() - startedAt));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, remainingTime())));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const hasVisibleLoginEntry = Array.from(document.querySelectorAll('button,a,[role="button"],div,span'))
      .some((el) => visible(el) && (el.innerText || el.textContent || '').trim() === '登录');
    const bodyText = document.body?.innerText || '';
    const loginLikely = hasVisibleLoginEntry || /立即登录|手机号|验证码/.test(bodyText);
    const candidates = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'))
      .filter(visible)
      .sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height));
    const editor = candidates[0];
    if (!editor) return { promptFilled: false, loginLikely, editor: null };
    const selectAll = () => {
      editor.focus();
      if (editor.matches('textarea, input[type="text"]')) {
        editor.select();
        return;
      }
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const focusEnd = () => {
      editor.focus();
      if (editor.matches('textarea, input[type="text"]')) {
        editor.selectionStart = editor.selectionEnd = editor.value.length;
        return;
      }
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const insertText = (text) => {
      if (!text) return;
      focusEnd();
      if (editor.matches('textarea, input[type="text"]')) {
        const start = editor.selectionStart ?? editor.value.length;
        const end = editor.selectionEnd ?? editor.value.length;
        const nextValue = editor.value.slice(0, start) + text + editor.value.slice(end);
        const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(editor, nextValue) : (editor.value = nextValue);
        editor.selectionStart = editor.selectionEnd = start + text.length;
      } else {
        const inserted = document.execCommand('insertText', false, text);
        if (!inserted) editor.textContent = (editor.textContent || '') + text;
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const clearEditor = () => {
      selectAll();
      if (editor.matches('textarea, input[type="text"]')) {
        const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(editor, '') : (editor.value = '');
      } else {
        document.execCommand('delete', false);
        if ((editor.innerText || '').trim()) editor.textContent = '';
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: null, inputType: 'deleteContentBackward' }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const fillPlainPrompt = () => {
      clearEditor();
      const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      if (editor.matches('textarea, input[type="text"]')) {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(editor, prompt) : (editor.value = prompt);
      } else {
        const inserted = document.execCommand('insertText', false, prompt);
        if (!inserted) editor.textContent = prompt;
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt, inputType: 'insertText' }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const clickElement = (el, { callNativeClick = false } = {}) => {
      if (!el) return false;
      el.scrollIntoView?.({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const EventClass = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new EventClass(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2
        }));
      }
      if (callNativeClick && typeof el.click === 'function') el.click();
      return true;
    };
    const optionLabelCandidates = (ref) => {
      const path = ref.uploadPath || ref.path || '';
      const basename = String(path).split(/[\\\\/]/).pop() || '';
      const stem = basename.replace(/\\.[^.]+$/, '');
      return [ref.title, ref.name, ref.id, ref.placeholder, basename, stem]
        .filter(Boolean)
        .map((item) => String(item).trim())
        .filter(Boolean);
    };
    const referenceByPlaceholder = new Map(references.map((ref, index) => {
      const placeholder = ref.placeholder || ('@图片' + (index + 1));
      return [placeholder, { ...ref, placeholder, optionLabels: optionLabelCandidates({ ...ref, placeholder }) }];
    }));
    const chipsInEditor = () => Array.from(editor.querySelectorAll('.node-reference-mention-tag, [data-node-type*="mention"], [data-mention]'));
    const rawMentionCount = () => ((editor.innerText || editor.value || '').match(/@图片\\d+|@视频\\d+|@音频\\d+/g) || []).length;
	    const visibleOptions = () => Array.from(document.querySelectorAll('[role="option"],li,.lv-select-option'))
	      .filter(visible)
	      .filter((el) => textOf(el));
	    const normalizedOptionText = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g, '');
	    const genericLabelTokens = new Set(['png', 'jpg', 'jpeg', 'char', 'scene', 'asset', 'image', 'picture', 'reference', 'tail', 'for', '01', '02', '03', '04', '05']);
	    const labelTokens = (value) => String(value || '')
	      .toLowerCase()
	      .split(/[^a-z0-9\\u4e00-\\u9fa5]+/g)
	      .filter((token) => token.length > 1 && !genericLabelTokens.has(token) && !/^\\d+$/.test(token));
	    const scoreReferenceOption = (optionText, labels) => {
	      const optionNorm = normalizedOptionText(optionText);
	      if (!optionNorm || /创建主体/.test(optionText)) return 0;
	      let best = 0;
	      for (const label of labels) {
	        const labelNorm = normalizedOptionText(label);
	        if (!labelNorm) continue;
	        if (optionNorm === labelNorm) best = Math.max(best, 100);
	        if (optionNorm.includes(labelNorm) || labelNorm.includes(optionNorm)) best = Math.max(best, 80);
	        // 即梦候选项会因为缩略图遮挡或字体截断丢失个别字母，允许文件名去头/分词后继续匹配。
	        if (labelNorm.length > 4 && optionNorm.includes(labelNorm.slice(1))) best = Math.max(best, 72);
	        const tokens = labelTokens(label);
	        const tokenHits = tokens.filter((token) => optionNorm.includes(token) || optionNorm.includes(token.slice(1))).length;
	        // Weak shared fragments are not enough evidence for a real Jimeng reference binding.
	        const requiredHits = tokens.length <= 1 ? tokens.length : Math.min(2, tokens.length);
	        if (requiredHits > 0 && tokenHits >= requiredHits) best = Math.max(best, 40 + tokenHits * 12);
	      }
	      return best;
	    };
	    const optionForReference = (ref) => {
	      const labels = ref.optionLabels || [];
	      return visibleOptions()
	        .map((option) => ({ option, score: scoreReferenceOption(textOf(option), labels) }))
	        .filter((item) => item.score > 0)
	        .sort((a, b) => b.score - a.score)[0]?.option || null;
	    };
    const closeFloatingMenus = () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    };
    const selectPlaceholder = (placeholder) => {
      editor.focus();
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const index = node.nodeValue.indexOf(placeholder);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + placeholder.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      }
      return false;
    };
    const candidateMenuHasReferences = () => {
      const menuText = Array.from(document.querySelectorAll('[role="listbox"],.lv-select-popup,.lv-trigger-popup,.lv-popover'))
        .filter(visible)
        .map(textOf)
        .join('\\n');
      return /可能@的内容/.test(menuText) || references.some((ref) => optionLabelCandidates(ref).some((label) => label && menuText.includes(label)));
    };
    const findReferenceMenuButtons = () => {
      const labelled = Array.from(document.querySelectorAll('button,[role="button"],span,div'))
        .filter(visible)
        .filter((el) => {
          const semantic = textOf(el) + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
          if (!/引用参考|@/.test(semantic)) return false;
          return !!el.closest('.toolbar-ejS5ZW,[role="toolbar"],[class*="toolbar"]');
        });
      const toolbarIconButtons = Array.from(document.querySelectorAll('[role="toolbar"] button,[class*="toolbar"] button'))
        .filter(visible)
        .filter((el) => {
          const cls = String(el.className || '');
          if (cls.includes('submit-button') || cls.includes('scroll-button')) return false;
          if (textOf(el)) return false;
          return cls.includes('toolbar-button') && cls.includes('icon-only');
        });
      // 即梦当前版本的引用入口是无文本 toolbar icon；点击后必须出现“可能@的内容”才算命中。
      return [...new Set([...labelled, ...toolbarIconButtons])];
    };
    const openReferenceMenu = async () => {
      for (const button of findReferenceMenuButtons()) {
        if (!hasTime()) return { opened: false, buttonText: '', buttonClass: '', timedOut: true };
        clickElement(button, { callNativeClick: true });
        await sleep(450);
        if (candidateMenuHasReferences() && visibleOptions().length) {
          return { opened: true, buttonText: textOf(button), buttonClass: String(button.className || '') };
        }
        closeFloatingMenus();
        await sleep(100);
      }
      return { opened: false, buttonText: '', buttonClass: '' };
    };
	    const insertReferenceChip = async (ref) => {
	      if (!hasTime()) return { ok: false, reason: 'binding_timeout' };
	      focusEnd();
	      const beforeChipCount = chipsInEditor().length;
      const menu = await openReferenceMenu();
      if (!menu.opened) return { ok: false, reason: 'reference_menu_not_found', menu };
      if (!hasTime()) return { ok: false, reason: 'binding_timeout', menu };
      const option = optionForReference(ref);
      const optionText = textOf(option);
      if (!option) {
        closeFloatingMenus();
        return { ok: false, reason: 'reference_option_not_found', menu, optionText: '' };
      }
      option.click?.();
      await sleep(650);
      if (!hasTime()) return { ok: false, reason: 'binding_timeout_after_click', menu, optionText };
      const afterChipCount = chipsInEditor().length;
      return {
        ok: afterChipCount > beforeChipCount,
        reason: afterChipCount > beforeChipCount ? '' : 'chip_not_inserted',
        menu,
        optionText,
        chipCountDelta: afterChipCount - beforeChipCount
      };
    };
    const tokenizePrompt = () => {
      const tokens = [];
      const regex = /(@(?:图片|视频|音频)\\d+)/g;
      let lastIndex = 0;
      let match;
      while ((match = regex.exec(prompt)) !== null) {
        if (match.index > lastIndex) tokens.push({ type: 'text', value: prompt.slice(lastIndex, match.index) });
        tokens.push({ type: 'placeholder', value: match[1] });
        lastIndex = match.index + match[1].length;
      }
      if (lastIndex < prompt.length) tokens.push({ type: 'text', value: prompt.slice(lastIndex) });
      return tokens;
    };

    return (async () => {
      const bindingSummary = {
        referenceBindingAttempted: false,
        referenceBindingMethod: references.length ? 'jimeng_reference_toolbar' : null,
        boundReferenceCount: 0,
        missingBindingPlaceholders: [],
        bindingTimedOut: false,
        sourcePrompt: prompt,
        bindingSteps: []
      };
	      if (!references.length) {
	        fillPlainPrompt();
	      } else {
	        clearEditor();
	        bindingSummary.referenceBindingAttempted = true;
	        const tokens = tokenizePrompt();
	        const handledPlaceholders = new Set();
	        const boundPlaceholders = new Set();
	        for (const token of tokens) {
	          if (!hasTime()) {
	            bindingSummary.bindingTimedOut = true;
	            for (const placeholder of [...new Set(tokens.filter((item) => item.type === 'placeholder').map((item) => item.value))]) {
	              if (!boundPlaceholders.has(placeholder)) bindingSummary.missingBindingPlaceholders.push(placeholder);
	            }
	            break;
	          }
	          if (token.type === 'text') {
	            insertText(token.value);
	            continue;
	          }
	          const placeholder = token.value;
	          if (handledPlaceholders.has(placeholder)) {
	            // 正文可重复描述同一参考，但页面只插入一次真实 chip，后续使用自然语言继续指代。
	            insertText('该参考资源');
	            continue;
	          }
	          handledPlaceholders.add(placeholder);
	          closeFloatingMenus();
	          await sleep(80);
	          const ref = referenceByPlaceholder.get(placeholder);
	          if (!ref) {
	            bindingSummary.missingBindingPlaceholders.push(placeholder);
	            insertText(placeholder);
	            continue;
	          }
	          // 按正文片段顺序插入真实引用 chip，避免先写 @图片N 再替换时被 ProseMirror 富文本节点打乱顺序。
	          const step = await insertReferenceChip(ref);
	          bindingSummary.bindingSteps.push({
            placeholder,
            ok: !!step.ok,
            reason: step.reason || '',
            optionText: step.optionText || '',
            chipCountDelta: Number(step.chipCountDelta || 0)
          });
          if (step.ok) {
            bindingSummary.boundReferenceCount += 1;
	            boundPlaceholders.add(placeholder);
	          } else {
	            bindingSummary.missingBindingPlaceholders.push(placeholder);
	            insertText(placeholder);
	          }
	        }
	      }
      return {
        promptFilled: true,
        loginLikely,
        ...bindingSummary,
        rawMentionCount: rawMentionCount(),
        chipCount: chipsInEditor().length,
        editor: {
          tag: editor.tagName,
          role: editor.getAttribute('role') || '',
          contenteditable: editor.getAttribute('contenteditable') || ''
        }
      };
    })();
  })()`;
}

function buildComposerProbeExpression() {
  return `(() => {
    const text = document.body?.innerText || '';
    const visible = (el) => {
      const rect = el.getBoundingClientRect?.();
      const style = window.getComputedStyle?.(el);
      return !!rect && rect.width > 8 && rect.height > 8 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const hasVisibleLoginEntry = Array.from(document.querySelectorAll('button,a,[role="button"],div,span'))
      .some((el) => visible(el) && (el.innerText || el.textContent || '').trim() === '登录');
    const loginLikely = hasVisibleLoginEntry || /立即登录|手机号|验证码/.test(text);
    const editableCount = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]')).filter((el) => {
      const rect = el.getBoundingClientRect?.();
      const style = window.getComputedStyle?.(el);
      return !!rect && rect.width > 8 && rect.height > 8 && style?.visibility !== 'hidden' && style?.display !== 'none';
    }).length;
    return { url: location.href, editableCount, fileInputCount: document.querySelectorAll('input[type="file"]').length, loginLikely };
  })()`;
}

function buildFileInputChangeExpression() {
  return `(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    for (const input of inputs) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { changedInputs: inputs.length };
  })()`;
}

function buildPreSubmitInspectExpression() {
  return `(() => {
    const visible = (el) => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? window.getComputedStyle?.(el) : null;
      return !!rect && rect.width > 3 && rect.height > 3 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const areaOf = (el) => {
      const rect = el?.getBoundingClientRect?.();
      return rect ? rect.width * rect.height : 0;
    };
    const editorSelector = 'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]';
    const focused = document.activeElement;
    const editor = focused?.matches?.(editorSelector)
      ? focused
      : Array.from(document.querySelectorAll(editorSelector)).filter(visible).sort((a, b) => areaOf(b) - areaOf(a))[0];
    const text = editor?.innerText || editor?.value || '';
    const chipCount = editor
      ? editor.querySelectorAll?.('.node-reference-mention-tag, [data-mention], [data-node-type*="mention"]').length || 0
      : 0;
    const rawMentionCount = (text.match(/@图片\\d+|@视频\\d+|@音频\\d+/g) || []).length;
    const composerRoot = () => {
      if (!editor) return null;
      // 提交前门禁必须同时覆盖左侧参考区和右侧编辑器，避免只看到 chip 而漏掉缩略图重复。
      let node = editor;
      let layoutFallback = null;
      let contentFallback = null;
      while (node && node !== document.body) {
        const className = String(node.className || '');
        if (/content-generator|dimension-layout/.test(className)) return node;
        if (!layoutFallback && /layout-/.test(className)) layoutFallback = node;
        if (!contentFallback && /content-/.test(className)) contentFallback = node;
        node = node.parentElement;
      }
      return layoutFallback || contentFallback || editor.parentElement;
    };
    const root = composerRoot();
    // 以当前输入区的 reference-item 为准：即梦历史记录、chip 内 16px 小图标和页面其它资源都不参与提交门禁。
    const uploadedReferenceCount = root
      ? [...new Set(Array.from(root.querySelectorAll('[class*="reference-item"]')))]
        .filter(visible)
        // 退场动画节点仍在 DOM 中，但已不属于本轮上传；忽略它们可避免提交门禁误报重复素材。
        .filter((el) => !/reference-item[^ ]*(?:exit|leave)|(?:exit|leave)-(?:active|to)/i.test(String(el.className || '')))
        .filter((el) => !/reference-upload/i.test(String(el.className || '')))
        .filter((el) => !el.querySelector('[class*="reference-upload"]'))
        // 只统计编辑器外的上传缩略图；编辑器内的引用 chip 已由 chipCount 单独校验。
        .filter((el) => !editor.contains(el))
        .filter((el) => el.querySelector('img,video,canvas,[style*="background-image"],[class*="reference-r"]')).length
      : 0;
    return {
      textLength: text.length,
      chipCount,
      rawMentionCount,
      uploadedReferenceCount,
      uploadedReferenceCountReliable: !!root,
      sample: text.slice(0, 120)
    };
  })()`;
}

async function evaluateByValue(cdp, expression, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await sendWithTimeout(cdp, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs
  }, timeoutMs);
  if (response?.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return response?.result?.value || null;
}

async function sendWithTimeout(cdp, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let timeoutId;
  try {
    return await Promise.race([
      cdp.send(method, params),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`CDP endpoint failed: HTTP ${response.status}`);
  return response.json();
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultWebSocketFactory(url) {
  if (typeof WebSocket !== 'function') {
    throw new Error('WebSocket is not available in this Node runtime');
  }
  return new WebSocket(url);
}

class CdpSession {
  constructor(webSocketUrl, { webSocketFactory }) {
    this.socket = webSocketFactory(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.openPromise = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.onMessage(event));
  }

  async send(method, params = {}) {
    await this.openPromise;
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(payload);
    return response;
  }

  async close() {
    this.socket.close?.();
  }

  onMessage(event) {
    const raw = typeof event.data === 'string' ? event.data : String(event.data || '');
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message.id || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || 'CDP command failed'));
    } else {
      pending.resolve(message.result || {});
    }
  }
}
