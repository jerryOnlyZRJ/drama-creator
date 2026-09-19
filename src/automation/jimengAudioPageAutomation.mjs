const DEFAULT_TIMEOUT_MS = 30000;

// 即梦音频页和视频页的编辑器结构不同：这里只设置内置音色和实际台词，
// 并在生成按钮前停下。所有 CDP 调用仍只连接 Drama Creator 管理的独立浏览器 profile。
export async function runJimengAudioPageAutomation(feedPackage, { cdp, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!cdp) throw new Error('cdp session is required');

  const spokenText = String(feedPackage?.audio?.spokenText || feedPackage?.prompt || '').trim();
  const voiceSource = feedPackage?.audio?.voiceSource === 'public_reference' ? 'public_reference' : 'built_in';
  const cloneVoiceName = String(feedPackage?.audio?.cloneVoiceName || '').trim();
  const voiceName = String(
    voiceSource === 'public_reference'
      ? cloneVoiceName
      : (feedPackage?.audio?.voiceName || feedPackage?.workspace?.voiceName || '')
  ).trim();
  const publicVoiceReference = (feedPackage?.references || []).find((reference) => (
    reference?.kind === 'audio' && reference?.role === 'public_voice_reference'
  ));
  if (!spokenText) throw new Error('音频任务缺少可输入即梦的台词');
  if (voiceSource === 'built_in' && !voiceName) throw new Error('音频任务缺少即梦内置音色名');

  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.enable');
  const navigation = await ensureJimengAudioPage(cdp, feedPackage?.targetUrl, { timeoutMs });

  const composerState = await waitForAudioComposer(cdp, { timeoutMs });
  if (composerState?.loginLikely) {
    return {
      status: 'login_required',
      loginLikely: true,
      promptFilled: false,
      voiceSet: false,
      submitReady: false,
      navigation,
      notes: ['请先在 Drama Creator 托管的即梦窗口完成登录。']
    };
  }
  if (!composerState?.textareaFound) {
    return {
      status: 'manual_settings_required',
      loginLikely: false,
      promptFilled: false,
      voiceSet: false,
      submitReady: false,
      navigation,
      notes: ['托管窗口还没有加载出即梦「配音生成」输入框，请稍后重试。']
    };
  }

  if (voiceSource === 'public_reference' && (!publicVoiceReference?.uploadPath || !cloneVoiceName)) {
    return {
      status: 'manual_settings_required',
      navigation,
      loginLikely: false,
      promptFilled: false,
      voiceSet: false,
      voiceSource,
      selectedVoice: '',
      targetVoice: cloneVoiceName,
      sourceReferenceVerified: false,
      referenceSourceNodeId: publicVoiceReference?.sourceNodeId || '',
      submitReady: false,
      notes: [
        !publicVoiceReference?.uploadPath
          ? '项目公共音色文件缺失，已阻止回退到即梦内置音色。'
          : '项目公共音色尚未登记即梦克隆音色，已阻止回退到内置音色。'
      ]
    };
  }

  let preparation = await evaluateByValue(cdp, buildAudioPrepareExpression({ spokenText, voiceName, voiceSource }), { timeoutMs });
  if (preparation?.popoverClosed === false && voiceMatches(preparation?.selectedVoice, voiceName)) {
    preparation = await dismissAudioVoicePopover(cdp, { spokenText, voiceName, preparation, timeoutMs });
  }
  const sourceReferenceVerified = voiceSource === 'built_in'
    || (!!publicVoiceReference?.uploadPath && voiceMatches(preparation?.selectedVoice, cloneVoiceName));
  const status = preparation?.promptFilled && preparation?.voiceSet && sourceReferenceVerified && preparation?.submitReady
    ? 'pre_submit_confirmation'
    : 'manual_settings_required';

  return {
    status,
    navigation,
    loginLikely: false,
    promptFilled: !!preparation?.promptFilled,
    voiceSet: !!preparation?.voiceSet,
    voiceSource,
    selectedVoice: preparation?.selectedVoice || '',
    targetVoice: voiceName,
    sourceReferenceVerified,
    referenceSourceNodeId: publicVoiceReference?.sourceNodeId || '',
    submitReady: !!preparation?.submitReady,
    creditCost: preparation?.creditCost || '',
    modeText: preparation?.modeText || '',
    popoverClosed: preparation?.popoverClosed !== false,
    textLength: Number(preparation?.textLength || 0),
    notes: buildAudioAutomationNotes(status, preparation, voiceName, { voiceSource, sourceReferenceVerified })
  };
}

async function dismissAudioVoicePopover(cdp, { spokenText, voiceName, preparation, timeoutMs }) {
  // 即梦音色弹层会忽略脚本伪造的 click；CDP 的可信 Escape 只收起面板，不改变已选音色和台词。
  await sendWithTimeout(cdp, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 53
  }, timeoutMs);
  await sendWithTimeout(cdp, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 53
  }, timeoutMs);
  await sleep(350);

  let inspected = await evaluateByValue(cdp, buildAudioInspectExpression({ spokenText, voiceName }), { timeoutMs });
  if (inspected?.popoverClosed === false && voiceMatches(inspected?.selectedVoice, voiceName)) {
    // 部分即梦版本会吞掉 Escape。改用 CDP 可信鼠标事件点击台词输入框的安全区域，
    // 只收起弹层并保留台词，不重新选择音色，也不会触碰生成按钮。
    const safePoint = await evaluateByValue(cdp, buildAudioSafeDismissPointExpression(), { timeoutMs });
    if (Number.isFinite(safePoint?.x) && Number.isFinite(safePoint?.y)) {
      await sendWithTimeout(cdp, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: safePoint.x,
        y: safePoint.y,
        button: 'left',
        clickCount: 1
      }, timeoutMs);
      await sendWithTimeout(cdp, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: safePoint.x,
        y: safePoint.y,
        button: 'left',
        clickCount: 1
      }, timeoutMs);
      await sleep(350);
      inspected = await evaluateByValue(cdp, buildAudioInspectExpression({ spokenText, voiceName }), { timeoutMs });
    }
  }
  return { ...preparation, ...inspected };
}

function buildAudioSafeDismissPointExpression() {
  return `(() => {
    const jimengAudioSafeDismissPoint = true;
    const visible = (el) => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? window.getComputedStyle?.(el) : null;
      return !!rect && rect.width > 8 && rect.height > 8 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const textarea = Array.from(document.querySelectorAll('textarea'))
      .find((el) => visible(el) && /\u8bf4\u8bdd\u5185\u5bb9|\u751f\u6210\u7684\u8bf4\u8bdd/.test(el.getAttribute('placeholder') || ''));
    const rect = textarea?.getBoundingClientRect?.();
    return rect
      ? { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + Math.min(24, rect.height / 2) }
      : null;
  })()`;
}

function buildAudioInspectExpression({ spokenText, voiceName }) {
  return `(() => {
    const jimengAudioInspectTarget = ${JSON.stringify({ spokenText, voiceName })};
    const visible = (el) => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? window.getComputedStyle?.(el) : null;
      return !!rect && rect.width > 8 && rect.height > 8 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const textarea = Array.from(document.querySelectorAll('textarea'))
      .find((el) => visible(el) && /\u8bf4\u8bdd\u5185\u5bb9|\u751f\u6210\u7684\u8bf4\u8bdd/.test(el.getAttribute('placeholder') || ''));
    const selectedVoice = Array.from(document.querySelectorAll('[class*="reference-group"]'))
      .filter(visible)
      .map(textOf)
      .find((text) => text === jimengAudioInspectTarget.voiceName || text.startsWith(jimengAudioInspectTarget.voiceName)) || '';
    const popover = Array.from(document.querySelectorAll('.lv-popover-content,[class*="popover-content"]')).find(visible);
    const submitButtons = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(visible)
      .filter((el) => String(el.className || '').includes('submit-button'));
    const submitButton = submitButtons.find((el) => !String(el.className || '').includes('collapsed')) || submitButtons[0];
    const submitText = [submitButton, submitButton?.parentElement, submitButton?.parentElement?.parentElement]
      .map(textOf)
      .find((text) => /\b\d+\b/.test(text)) || '';
    const priceMatch = submitText.match(/\b(\d+)\b/);
    const currentText = textarea?.value?.trim?.() || '';
    const voiceSet = !popover && (selectedVoice === jimengAudioInspectTarget.voiceName || selectedVoice.startsWith(jimengAudioInspectTarget.voiceName));
    return {
      jimengAudioInspectTarget,
      promptFilled: currentText === jimengAudioInspectTarget.spokenText,
      textLength: currentText.length,
      voiceSet,
      selectedVoice,
      submitReady: !!submitButton && !submitButton.disabled && submitButton.getAttribute('aria-disabled') !== 'true',
      creditCost: priceMatch?.[1] || '',
      modeText: /\u914d\u97f3\u751f\u6210/.test(document.body?.innerText || '') ? '\u914d\u97f3\u751f\u6210' : '',
      popoverClosed: !popover
    };
  })()`;
}

function voiceMatches(selectedVoice, targetVoice) {
  const selected = String(selectedVoice || '').trim();
  const target = String(targetVoice || '').trim();
  return !!target && (selected === target || selected.startsWith(target));
}

async function ensureJimengAudioPage(cdp, targetUrl, { timeoutMs }) {
  const state = (await evaluateByValue(cdp, `(() => ({
    jimengAudioLocationProbe: true,
    url: location.href,
    isAudio: /(?:ai_feature_name=audio|[?&]type=audio)/.test(location.href)
  }))()`, { timeoutMs: 2000 }).catch(() => null)) || { url: '', isAudio: false };
  if (state.isAudio || !targetUrl) return { navigated: false, url: state.url || targetUrl || '' };

  // 重用已打开的托管窗口时，进程启动参数仍可能是上一次的视频页；必须显式切到音频页。
  await sendWithTimeout(cdp, 'Page.navigate', { url: targetUrl }, Math.min(timeoutMs, 5000));
  await sleep(500);
  return { navigated: true, url: targetUrl };
}

async function waitForAudioComposer(cdp, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await evaluateByValue(cdp, buildAudioComposerProbeExpression(), { timeoutMs: 1500 })
      .catch((error) => ({ error: error?.message || String(error) }));
    if (lastState?.textareaFound || lastState?.loginLikely) return lastState;
    await sleep(250);
  }
  return lastState;
}

function buildAudioComposerProbeExpression() {
  return `(() => {
    const visible = (el) => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? window.getComputedStyle?.(el) : null;
      return !!rect && rect.width > 8 && rect.height > 8 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const textarea = Array.from(document.querySelectorAll('textarea'))
      .find((el) => visible(el) && /\u8bf4\u8bdd\u5185\u5bb9|\u751f\u6210\u7684\u8bf4\u8bdd/.test(el.getAttribute('placeholder') || ''));
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
    return {
      jimengAudioComposerProbe: true,
      textareaFound: !!textarea,
      placeholder: textarea?.getAttribute('placeholder') || '',
      loginLikely: !textarea && /\u767b\u5f55|\u9a8c\u8bc1\u7801|\u626b\u7801/.test(bodyText) && !/\u914d\u97f3\u751f\u6210/.test(bodyText)
    };
  })()`;
}

function buildAudioPrepareExpression({ spokenText, voiceName, voiceSource = 'built_in' }) {
  return `(async () => {
    const jimengAudioPrepareTarget = ${JSON.stringify({ spokenText, voiceName, voiceSource })};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (el) => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? window.getComputedStyle?.(el) : null;
      return !!rect && rect.width > 8 && rect.height > 8 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
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
      return true;
    };
    const textarea = Array.from(document.querySelectorAll('textarea'))
      .find((el) => visible(el) && /\u8bf4\u8bdd\u5185\u5bb9|\u751f\u6210\u7684\u8bf4\u8bdd/.test(el.getAttribute('placeholder') || ''));
    if (!textarea) return { jimengAudioPrepareTarget, promptFilled: false, voiceSet: false, submitReady: false, reason: 'textarea_not_found' };

    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter ? setter.call(textarea, jimengAudioPrepareTarget.spokenText) : (textarea.value = jimengAudioPrepareTarget.spokenText);
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: jimengAudioPrepareTarget.spokenText, inputType: 'insertText' }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(350);

    const selectedVoiceText = () => {
      // 最终选中态以输入区音色触发器为准；弹层中的 active 候选可能只是悬停或试听态，
      // 不能据此宣称页面已经切换音色。
      const selected = Array.from(document.querySelectorAll('[class*="reference-group"]'))
        .filter(visible)
        .map(textOf)
        .find((text) => text === jimengAudioPrepareTarget.voiceName || text.startsWith(jimengAudioPrepareTarget.voiceName));
      return selected || '';
    };
    const voiceOptions = () => {
      const popover = Array.from(document.querySelectorAll('.lv-popover-content,[class*="popover-content"]')).find(visible);
      if (!popover) return [];
      return Array.from(popover.querySelectorAll('[class*="voice-grid-cell-label"],button,[role="button"],li,[role="option"],div'))
        .filter(visible)
        .filter((el) => {
          const text = textOf(el);
          return text === jimengAudioPrepareTarget.voiceName || text.startsWith(jimengAudioPrepareTarget.voiceName + ' ');
        })
        .map((el) => el.closest?.('[class*="voice-grid-cell-content"]') || el)
        .filter((el, index, all) => all.indexOf(el) === index)
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (ar.width * ar.height) - (br.width * br.height);
        });
    };
    const activateVoiceCategory = async () => {
      if (jimengAudioPrepareTarget.voiceSource !== 'public_reference') return;
      const popover = Array.from(document.querySelectorAll('.lv-popover-content,[class*="popover-content"]')).find(visible);
      const myVoiceTab = Array.from(popover?.querySelectorAll?.('button,[role="button"]') || [])
        .filter(visible)
        .find((el) => textOf(el) === '我的音色');
      if (myVoiceTab && !String(myVoiceTab.className || '').includes('active')) {
        clickElement(myVoiceTab);
        await sleep(350);
      }
    };
    const findVoiceOptionWithScroll = async () => {
      let option = voiceOptions()[0];
      if (option) return option;
      const popover = Array.from(document.querySelectorAll('.lv-popover-content,[class*="popover-content"]')).find(visible);
      const grid = popover?.querySelector?.('.ReactVirtualized__Grid,[class*="voice-grid"]');
      if (!grid) return null;

      // 即梦音色库使用虚拟滚动，目标音色可能不在首屏 DOM；逐屏滚动后再匹配真实候选卡片。
      const maxScrollTop = Math.max(0, Number(grid.scrollHeight || 0) - Number(grid.clientHeight || 0));
      const step = Math.max(80, Math.floor(Number(grid.clientHeight || 220) * 0.72));
      for (let scrollTop = 0; scrollTop <= maxScrollTop; scrollTop += step) {
        grid.scrollTop = Math.min(scrollTop, maxScrollTop);
        grid.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(120);
        option = voiceOptions()[0];
        if (option) return option;
      }
      if (grid.scrollTop !== maxScrollTop) {
        grid.scrollTop = maxScrollTop;
        grid.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(120);
      }
      return voiceOptions()[0] || null;
    };
    const findVoiceTrigger = () => {
      // 选中音色后触发器文案会从「音色」变成具体名称。此时必须点击整个音色组，
      // 不能点击组内的 reference-upload；后者是上传自定义音色入口，不会打开内置音色列表。
      const expandedGroup = Array.from(document.querySelectorAll('[class*="reference-group"].lv-popover-open,[class*="reference-group"][class*="popover-open"]'))
        .find(visible);
      if (expandedGroup) return expandedGroup;
      const selectedGroup = Array.from(document.querySelectorAll('[class*="reference-group"]'))
        .filter(visible)
        .find((el) => Array.from(el.children || []).some((child) => String(child.className || '').includes('reference-group-content'))
          && !!el.querySelector('[class*="overlay-label"]'));
      if (selectedGroup) return selectedGroup;
      const openGroup = Array.from(document.querySelectorAll('[class*="reference-group"]')).find((el) => visible(el) && /\u97f3\u8272/.test(textOf(el)));
      if (openGroup) return openGroup;
      const label = Array.from(document.querySelectorAll('button,[role="button"],div,span'))
        .filter(visible)
        .find((el) => textOf(el) === '\u97f3\u8272');
      return label?.closest?.('button,[role="button"],[class*="reference-upload"],[class*="reference-group"]') || label;
    };

    let selectedVoice = selectedVoiceText();
    if (!selectedVoice) {
      let option = voiceOptions()[0];
      if (!option) {
        clickElement(findVoiceTrigger());
        await sleep(500);
        // 公共音色只能从「我的音色」中选择；不能在全量列表里命中同名内置音色。
        await activateVoiceCategory();
        option = await findVoiceOptionWithScroll();
      }
      if (option) {
        clickElement(option);
        await sleep(550);
      }
      selectedVoice = selectedVoiceText();
    }

    // 有些即梦版本选中音色后不会自动收起面板；收起它才能让用户看清提交按钮和积分。
    let popover = Array.from(document.querySelectorAll('.lv-popover-content,[class*="popover-content"]')).find(visible);
    if (popover) {
      clickElement(findVoiceTrigger());
      await sleep(300);
      popover = Array.from(document.querySelectorAll('.lv-popover-content,[class*="popover-content"]')).find(visible);
    }

    // 关闭弹层后再次读取触发器，确保选中结果已经持久化到真实输入状态。
    await sleep(350);
    selectedVoice = selectedVoiceText();

    const submitButtons = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(visible)
      .filter((el) => String(el.className || '').includes('submit-button'));
    // 页面同时保留折叠态和主输入区按钮；积分只显示在主按钮的操作组里。
    const submitButton = submitButtons.find((el) => !String(el.className || '').includes('collapsed')) || submitButtons[0];
    // 提交按钮是纯图标，积分数在外层操作组中，所以向上取两层文本。
    const submitText = [submitButton, submitButton?.parentElement, submitButton?.parentElement?.parentElement]
      .map(textOf)
      .find((text) => /\\b\\d+\\b/.test(text)) || '';
    const priceMatch = submitText.match(/\\b(\\d+)\\b/);
    const currentText = textarea.value.trim();
    const voiceSet = !popover && (selectedVoice === jimengAudioPrepareTarget.voiceName || selectedVoice.startsWith(jimengAudioPrepareTarget.voiceName));
    return {
      jimengAudioPrepareTarget,
      promptFilled: currentText === jimengAudioPrepareTarget.spokenText,
      textLength: currentText.length,
      voiceSet,
      selectedVoice,
      submitReady: !!submitButton && !submitButton.disabled && submitButton.getAttribute('aria-disabled') !== 'true',
      creditCost: priceMatch?.[1] || '',
      modeText: /\u914d\u97f3\u751f\u6210/.test(document.body?.innerText || '') ? '\u914d\u97f3\u751f\u6210' : '',
      popoverClosed: !popover
    };
  })()`;
}

function buildAudioAutomationNotes(status, preparation, voiceName, { voiceSource = 'built_in', sourceReferenceVerified = true } = {}) {
  const notes = [];
  if (preparation?.promptFilled) notes.push('台词已填入即梦配音输入框。');
  else notes.push('台词未能稳定填入，需要在托管窗口检查。');
  if (voiceSource === 'public_reference') {
    if (preparation?.voiceSet && sourceReferenceVerified) notes.push(`已选择由项目公共音色参考克隆的「${voiceName}」。`);
    else notes.push(`未能确认项目公共音色参考对应的「${voiceName}」，已阻止回退到内置音色。`);
  } else if (preparation?.voiceSet) notes.push(`已选择内置音色「${voiceName}」。`);
  else notes.push(`未能确认内置音色「${voiceName}」，请手动检查。`);
  if (preparation?.creditCost) notes.push(`当前页面显示本次生成消耗 ${preparation.creditCost} 积分。`);
  if (status === 'pre_submit_confirmation') notes.push('已停在生成按钮前，Drama Creator 没有自动提交。');
  return notes;
}

async function evaluateByValue(cdp, expression, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await sendWithTimeout(cdp, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }, timeoutMs);
  if (response?.exceptionDetails) {
    throw new Error(response.exceptionDetails?.exception?.description || response.exceptionDetails?.text || 'Runtime.evaluate failed');
  }
  return response?.result?.value;
}

async function sendWithTimeout(cdp, method, params, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      cdp.send(method, params),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
