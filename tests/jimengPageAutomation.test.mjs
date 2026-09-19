// 公开测试使用虚构示例文本，保留解析与工作流断言，不承载作者作品。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connectCdpPage, runJimengPageAutomation } from '../src/automation/jimengPageAutomation.mjs';

test('Jimeng reference cleanup and submit gate only count external uploaded thumbnails', async () => {
  const source = await readFile(new URL('../src/automation/jimengPageAutomation.mjs', import.meta.url), 'utf8');

  assert.match(source, /reference-item\[\^ \]\*\(\?:exit\|leave\)/);
  assert.match(source, /退场动画节点仍在 DOM 中/);
  const editorChipExclusions = source.match(/\.filter\(\(el\) => !editor\.contains\(el\)\)/g) || [];
  assert.equal(
    editorChipExclusions.length,
    2,
    'cleanup and pre-submit inspection must both ignore reference chips rendered inside the prompt editor'
  );
});

function createFeedPackage(overrides = {}) {
  return {
    platform: 'jimeng',
    targetUrl: 'https://jimeng.jianying.com/ai-tool/generate?type=video',
    prompt: '严格继承 @图片1，生成 10 秒镜头。',
    references: [
      { placeholder: '@图片1', uploadPath: '/tmp/ref-1.png', title: '参考图 1' }
    ],
    ...overrides
  };
}

test('Jimeng page automation uploads references, attempts toolbar binding, and stops if chips are still missing', async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /existingReferencesCleared/.test(params.expression)) {
        return { result: { value: { existingReferencesCleared: 2 } } };
      }
      if (method === 'Runtime.evaluate' && /chipCountDelta/.test(params.expression)) {
        return { result: { value: { ok: false, reason: 'reference_option_not_found', optionText: '', chipCountDelta: 0 } } };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 20, chipCount: 0, rawMentionCount: 1 } } };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { changedInputs: 1 } } };
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [7] };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage(), { cdp });

  assert.equal(result.status, 'manual_reference_binding_required');
  assert.equal(result.promptFilled, true);
  assert.equal(result.fileInputsFound, 1);
  assert.equal(result.filesAttached, 1);
  assert.equal(result.existingReferencesCleared, 2);
  assert.equal(result.referenceBindingAttempted, true);
  assert.equal(result.referenceBindingMethod, 'jimeng_reference_toolbar_stepwise');
  assert.equal(result.boundReferenceCount, 0);
  assert.deepEqual(result.bindingSteps, [{ placeholder: '@图片1', ok: false, reason: 'reference_option_not_found', optionText: '', chipCountDelta: 0 }]);
  assert.deepEqual(result.missingBindingPlaceholders, ['@图片1']);
  assert.equal(result.rawMentionCount, 1);
  assert.match(result.notes.join('\n'), /已清理页面已有参考资源 2 个/);
  assert.match(result.notes.join('\n'), /引用 chip 或参考缩略图未通过提交门禁/);
  const clearCallIndex = calls.findIndex((call) => /existingReferencesCleared/.test(String(call.params.expression || '')));
  const uploadCallIndex = calls.findIndex((call) => call.method === 'DOM.setFileInputFiles');
  assert.ok(clearCallIndex >= 0);
  assert.ok(uploadCallIndex > clearCallIndex);
  assert.equal(calls.some((call) => call.method === 'DOM.setFileInputFiles' && call.params.files[0] === '/tmp/ref-1.png'), true);
  assert.equal(calls.some((call) => call.method === 'Input.dispatchMouseEvent'), false);
  assert.equal(calls.some((call) => /allowAutoSubmit|点击生成|自动提交/.test(String(call.params.expression || ''))), false);
});

test('Jimeng video automation leaves a reused audio page before configuring the video workspace', async () => {
  const calls = [];
  let navigatedToVideo = false;
  let navigatedUrl = '';
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /jimengVideoLocationProbe/.test(params.expression)) {
        return {
          result: {
            value: {
              url: navigatedToVideo
                ? navigatedUrl
                : 'https://jimeng.jianying.com/ai-tool/generate?ai_feature_name=audio&type=audio&workspace=15071894414604',
              isVideo: navigatedToVideo
            }
          }
        };
      }
      if (method === 'Page.navigate') {
        navigatedToVideo = true;
        navigatedUrl = params.url;
        return { frameId: 'video-frame' };
      }
      if (method === 'Runtime.evaluate' && /jimengSetupTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              modeSet: true,
              modelSet: true,
              referenceModeSet: true,
              spaceSet: true,
              ratioSet: true,
              durationSet: true,
              toolbarText: '视频生成\n即梦 Seedance 2.0\n全能参考\n16:9\n15s'
            }
          }
        };
      }
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /existingReferencesCleared/.test(params.expression)) {
        return { result: { value: { existingReferencesCleared: 0, remainingReferenceCount: 0 } } };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return {
          result: {
            value: {
              textLength: 10,
              chipCount: 0,
              rawMentionCount: 0,
              uploadedReferenceCount: 0,
              uploadedReferenceCountReliable: true
            }
          }
        };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { changedInputs: 1 } } };
      }
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage({
    references: [],
    prompt: '生成一段视频。',
    workspace: {
      mode: '视频生成',
      modelId: 'seedance-2.0',
      model: 'Seedance 2.0',
      referenceMode: '全能参考'
    },
    params: { ratio: '16:9', duration: 15 }
  }), { cdp });

  const navigateIndex = calls.findIndex((call) => call.method === 'Page.navigate');
  const setupIndex = calls.findIndex((call) => /jimengSetupTarget/.test(String(call.params.expression || '')));
  assert.ok(navigateIndex >= 0, 'reused audio page must navigate to the video target URL');
  assert.ok(setupIndex > navigateIndex, 'video setup must run only after the target page navigation');
  assert.match(calls[navigateIndex].params.url, /(?:ai_feature_name|type)=video/);
  assert.match(calls[navigateIndex].params.url, /workspace=15071894414604/, 'cross-capability navigation must preserve the active Jimeng workspace');
  assert.equal(result.navigation.navigated, true);
  assert.equal(result.navigation.videoPageReady, true);
});

test('Jimeng video automation recovers a lost workspace from managed browser navigation history', async () => {
  const calls = [];
  let navigatedUrl = '';
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /jimengVideoLocationProbe/.test(params.expression)) {
        const url = navigatedUrl || 'https://jimeng.jianying.com/ai-tool/generate?ai_feature_name=video';
        return { result: { value: { url, isVideo: true } } };
      }
      if (method === 'Page.getNavigationHistory') {
        return {
          currentIndex: 1,
          entries: [
            { id: 1, url: 'https://jimeng.jianying.com/ai-tool/generate?ai_feature_name=audio&type=audio&workspace=15071894414604' },
            { id: 2, url: 'https://jimeng.jianying.com/ai-tool/generate?ai_feature_name=video' }
          ]
        };
      }
      if (method === 'Page.navigate') {
        navigatedUrl = params.url;
        return { frameId: 'recovered-workspace-frame' };
      }
      if (method === 'Runtime.evaluate' && /jimengSetupTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              modeSet: true,
              modelSet: true,
              referenceModeSet: true,
              spaceSet: true,
              ratioSet: true,
              durationSet: true,
              toolbarText: '视频生成\n即梦 Seedance 2.0\n全能参考\n16:9\n15s'
            }
          }
        };
      }
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /existingReferencesCleared/.test(params.expression)) {
        return { result: { value: { existingReferencesCleared: 0, remainingReferenceCount: 0 } } };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 10, chipCount: 0, rawMentionCount: 0, uploadedReferenceCount: 0, uploadedReferenceCountReliable: true } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage({
    references: [],
    prompt: '生成一段视频。',
    workspace: { mode: '视频生成', modelId: 'seedance-2.0', model: 'Seedance 2.0', referenceMode: '全能参考' },
    params: { ratio: '16:9', duration: 15 }
  }), { cdp });

  const navigateCall = calls.find((call) => call.method === 'Page.navigate');
  assert.ok(navigateCall, 'a generic managed page should recover the last known project workspace');
  assert.match(navigateCall.params.url, /workspace=15071894414604/);
  assert.equal(result.navigation.workspaceRecovered, true);
  assert.equal(result.navigation.videoPageReady, true);
});

test('Jimeng page automation configures the Jimeng video workspace before filling prompt', async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /jimengSetupTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              modeSet: true,
              referenceModeSet: true,
              ratioSet: true,
              durationSet: true,
              targetMode: '视频生成',
              targetModel: 'Seedance 2.0 Fast',
              targetReferenceMode: '全能参考',
              targetRatio: '9:16',
              targetDuration: '10s',
              dismissedModals: 1,
              toolbarText: '视频生成\n即梦 Seedance 2.0 Fast VIP\n全能参考\n9:16\n10s'
            }
          }
        };
      }
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /chipCountDelta/.test(params.expression)) {
        return { result: { value: { ok: true, reason: '', optionText: '参考图 1', chipCountDelta: 1 } } };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 20, chipCount: 0, rawMentionCount: 1 } } };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { changedInputs: 1 } } };
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [7] };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage({
    workspace: { mode: '视频生成', modelId: 'seedance-2.0-fast', model: 'Seedance 2.0 Fast', referenceMode: '全能参考' },
    params: { ratio: '9:16', duration: 10 }
  }), { cdp });

  assert.equal(result.pageSetup.modeSet, true);
  assert.equal(result.pageSetup.modelSet, true);
  assert.equal(result.pageSetup.targetModel, 'Seedance 2.0 Fast');
  assert.equal(result.pageSetup.referenceModeSet, true);
  assert.equal(result.pageSetup.ratioSet, true);
  assert.equal(result.pageSetup.durationSet, true);
  assert.equal(result.pageSetup.targetRatio, '9:16');
  assert.equal(result.pageSetup.targetDuration, '10s');
  const setupCallIndex = calls.findIndex((call) => /jimengSetupTarget/.test(String(call.params.expression || '')));
  const fillCallIndex = calls.findIndex((call) => /deleteContentBackward|chipCountDelta/.test(String(call.params.expression || '')));
  assert.ok(setupCallIndex >= 0);
  assert.ok(fillCallIndex > setupCallIndex);
});

test('Jimeng page automation reports manual settings when the configured Jimeng space is not selected', async () => {
  const cdp = {
    async send(method, params = {}) {
      if (method === 'Runtime.evaluate' && /jimengSetupTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              setupAttempted: true,
              modeSet: true,
              modelSet: true,
              referenceModeSet: true,
              ratioSet: true,
              durationSet: true,
              spaceSet: false,
              targetSpaceName: '机器人送信',
              toolbarText: '视频生成\nSeedance 2.0 Fast\n全能参考\n16:9\n10s'
            }
          }
        };
      }
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /chipCountDelta/.test(params.expression)) {
        return { result: { value: { ok: true, reason: '', optionText: '参考图 1', chipCountDelta: 1 } } };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 24, chipCount: 1, rawMentionCount: 0 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [7] };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage({
    workspace: {
      mode: '视频生成',
      modelId: 'seedance-2.0-fast',
      model: 'Seedance 2.0 Fast',
      referenceMode: '全能参考',
      spaceName: '机器人送信'
    },
    params: { ratio: '16:9', duration: 10 }
  }), { cdp });

  assert.equal(result.status, 'manual_settings_required');
  assert.equal(result.pageSetup.spaceSet, false);
  assert.match(result.notes.join('\n'), /即梦空间/);
});

test('Jimeng page automation does not treat Seedance 2.0 mini as the configured Seedance 2.0 model', async () => {
  const cdp = {
    async send(method, params = {}) {
      if (method === 'Runtime.evaluate' && /jimengSetupTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              setupAttempted: true,
              modeSet: true,
              referenceModeSet: true,
              ratioSet: true,
              durationSet: true,
              targetMode: '视频生成',
              targetModel: 'Seedance 2.0',
              targetReferenceMode: '全能参考',
              targetRatio: '16:9',
              targetDuration: '15s',
              toolbarText: '视频生成\n即梦 Seedance 2.0 mini\n全能参考\n16:9\n15s'
            }
          }
        };
      }
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /chipCountDelta/.test(params.expression)) {
        return {
          result: { value: { ok: true, reason: '', optionText: '参考图 1', chipCountDelta: 1 } }
        };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 24, chipCount: 1, rawMentionCount: 0 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [7] };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage({
    workspace: { mode: '视频生成', modelId: 'seedance-2.0', model: 'Seedance 2.0', referenceMode: '全能参考' },
    params: { ratio: '16:9', duration: 15 }
  }), { cdp });

  assert.equal(result.pageSetup.modelSet, false);
  assert.equal(result.status, 'manual_settings_required');
  assert.match(result.notes.join('\n'), /手动确认/);
});

test('Jimeng page automation does not treat Seedance 2.0 VIP as the standard Seedance 2.0 model', async () => {
  const cdp = {
    async send(method, params = {}) {
      if (method === 'Runtime.evaluate' && /jimengSetupTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              setupAttempted: true,
              modeSet: true,
              referenceModeSet: true,
              ratioSet: true,
              durationSet: true,
              targetMode: '视频生成',
              targetModel: 'Seedance 2.0',
              targetReferenceMode: '全能参考',
              targetRatio: '16:9',
              targetDuration: '10s',
              toolbarText: '视频生成\n即梦 Seedance 2.0 VIP\n全能参考\n16:9\n10s'
            }
          }
        };
      }
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /chipCountDelta/.test(params.expression)) {
        return {
          result: { value: { ok: true, reason: '', optionText: '参考图 1', chipCountDelta: 1 } }
        };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 24, chipCount: 1, rawMentionCount: 0 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [7] };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage({
    workspace: { mode: '视频生成', modelId: 'seedance-2.0', model: 'Seedance 2.0', referenceMode: '全能参考' },
    params: { ratio: '16:9', duration: 10 }
  }), { cdp });

  assert.equal(result.pageSetup.modelSet, false);
  assert.equal(result.status, 'manual_settings_required');
});

test('Jimeng page automation treats Seedance 2.0 mini as its own configured model', async () => {
  const cdp = {
    async send(method, params = {}) {
      if (method === 'Runtime.evaluate' && /jimengSetupTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              setupAttempted: true,
              modeSet: true,
              referenceModeSet: true,
              ratioSet: true,
              durationSet: true,
              targetMode: '视频生成',
              targetModel: 'Seedance 2.0 mini',
              targetReferenceMode: '全能参考',
              targetRatio: '16:9',
              targetDuration: '15s',
              toolbarText: '视频生成\n即梦 Seedance 2.0 mini\n全能参考\n16:9\n15s'
            }
          }
        };
      }
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /chipCountDelta/.test(params.expression)) {
        return {
          result: { value: { ok: true, reason: '', optionText: '参考图 1', chipCountDelta: 1 } }
        };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 24, chipCount: 1, rawMentionCount: 0 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [7] };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage({
    workspace: { mode: '视频生成', modelId: 'seedance-2.0-mini', model: 'Seedance 2.0 mini', referenceMode: '全能参考' },
    params: { ratio: '16:9', duration: 15 }
  }), { cdp });

  assert.equal(result.pageSetup.modelSet, true);
  assert.notEqual(result.status, 'manual_settings_required');
});

test('Jimeng page automation setup script uses resilient toolbar and modal selectors', async () => {
  const source = await readFile(new URL('../src/automation/jimengPageAutomation.mjs', import.meta.url), 'utf8');

  assert.match(source, /\[role=["']toolbar["']\],\[class\*=["']toolbar["']\]/);
  assert.match(source, /Agent 模式\\|视频生成\\|Seedance\\|全能参考/);
  assert.match(source, /findCompositeToolbarButton/);
  assert.match(source, /比例、清晰度和数量合并/);
  assert.match(source, /SeedMusic/);
  assert.match(source, /音乐模型首发上线/);
  assert.match(source, /\[role=["']toolbar["']\] button,\[class\*=["']toolbar["']\] button/);
  assert.match(source, /referenceItemCount/);
  assert.match(source, /当前输入区仍有旧参考但没有任何按钮能删/);
  assert.match(source, /remainingReferenceCount/);
  assert.match(source, /'Seedance 2\.0 mini', 'Seedance 2\.0 Fast', 'Seedance 2\.0'/);
  assert.match(source, /clientX: rect\.x \+ rect\.width \/ 2/);
  assert.match(source, /选择项点击成功不代表新模式\/模型已经挂载完成/);
  assert.match(source, /input\[role=["']spinbutton["']\],input\[type=["']number["']\]/);
  assert.match(source, /'3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'/);
  assert.match(source, /时长滑杆通过 portal 异步挂载[\s\S]*await sleep\(250\)/);
  assert.match(source, /const durationPanel = Array\.from\(document\.querySelectorAll\('\[class\*="duration-panel"\], \[class\*="duration-trigger"\]'\)\)/);
  assert.match(source, /Array\.from\(\(durationPanel \|\| document\)\.querySelectorAll\('button,\[role="button"\]'\)\)/);
  assert.match(source, /const genericDurationOptionClicked = await clickOption\(targetDuration\)/);
  assert.ok(source.indexOf('const durationPanel =') < source.indexOf('const genericDurationOptionClicked = await clickOption(targetDuration)'));
  assert.match(source, /12s 等非 5 秒刻度只能通过时长面板内的数值输入框设置/);
  assert.match(source, /Object\.getOwnPropertyDescriptor\(HTMLInputElement\.prototype, 'value'\)/);
  assert.match(source, /scoreReferenceOption/);
  assert.match(source, /文件名去头\/分词后继续匹配/);
  assert.match(source, /按正文片段顺序插入真实引用 chip/);
  assert.match(source, /工具栏入口缺失时再走输入 @ 搜索候选/);
  assert.match(source, /native click 会让即梦插入两个同名 chip/);
});

test('Jimeng reference binding retries the first menu while uploaded references are still settling', async () => {
  const source = await readFile(new URL('../src/automation/jimengPageAutomation.mjs', import.meta.url), 'utf8');

  // The first reference menu can lag behind uploaded thumbnails; keep the retry local to chip binding.
  assert.match(source, /let menu = await openReferenceMenu\(\);[\s\S]*if \(!menu\.opened\) \{[\s\S]*await sleep\(900\);[\s\S]*menu = await openReferenceMenu\(\);/);
});

test('Jimeng page automation requires active Jimeng space evidence instead of sidebar text presence', async () => {
  const source = await readFile(new URL('../src/automation/jimengPageAutomation.mjs', import.meta.url), 'utf8');

  assert.match(source, /activeSpaceState/);
  assert.match(source, /activeSpaceName/);
  assert.match(source, /spaceEvidence/);
  assert.doesNotMatch(
    source,
    /pageContainsSpace[\s\S]*document\.body\?\.innerText[\s\S]*includes\(spaceName\)/
  );
});

test('Jimeng page automation reaches pre-submit confirmation after toolbar chip binding succeeds', async () => {
  const cdp = {
    async send(method, params = {}) {
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /chipCountDelta/.test(params.expression)) {
        return {
          result: {
            value: {
              ok: true,
              reason: '',
              optionText: '参考图 1',
              chipCountDelta: 1
            }
          }
        };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 24, chipCount: 1, rawMentionCount: 0 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [7] };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage(), { cdp });

  assert.equal(result.status, 'pre_submit_confirmation');
  assert.equal(result.requiresManualBinding, false);
  assert.equal(result.boundReferenceCount, 1);
  assert.equal(result.chipCount, 1);
  assert.equal(result.rawMentionCount, 0);
  assert.match(result.notes.join('\n'), /提交前确认状态/);
});

test('Jimeng page automation allows repeated prompt mentions without duplicating uploaded references', async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /chipCountDelta/.test(params.expression)) {
        return {
          result: {
            value: {
              ok: true,
              reason: '',
              optionText: params.expression.includes('参考图 2') ? '参考图 2' : '参考图 1',
              chipCountDelta: 1
            }
          }
        };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return {
          result: {
            value: {
              textLength: 48,
              chipCount: 2,
              rawMentionCount: 0,
              uploadedReferenceCount: 2,
              uploadedReferenceCountReliable: true
            }
          }
        };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [7] };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage({
    prompt: '先继承 @图片1，转入 @图片2，尾帧继续保持 @图片1 的人物身份。',
    references: [
      { placeholder: '@图片1', uploadPath: '/tmp/ref-1.png', title: '参考图 1' },
      { placeholder: '@图片2', uploadPath: '/tmp/ref-2.png', title: '参考图 2' }
    ]
  }), { cdp });

  assert.equal(result.status, 'pre_submit_confirmation');
  assert.equal(result.filesAttached, 2);
  assert.equal(result.boundReferenceCount, 2);
  assert.equal(result.chipCount, 2);
  assert.equal(result.uploadedReferenceCount, 2);
  assert.equal(
    calls.some((call) => call.method === 'DOM.setFileInputFiles'
      && call.params.files.length === 2
      && new Set(call.params.files).size === 2),
    true
  );
  assert.match(result.notes.join('\n'), /引用参考绑定：2\/2/);
  assert.doesNotMatch(result.notes.join('\n'), /参考缩略图数量/);
});

test('Jimeng page automation stops before upload when old composer references cannot be cleared', async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /existingReferencesCleared/.test(params.expression)) {
        return { result: { value: { existingReferencesCleared: 1, remainingReferenceCount: 2, scopedToComposer: true } } };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return {
          result: {
            value: {
              textLength: 0,
              chipCount: 0,
              rawMentionCount: 0,
              uploadedReferenceCount: 2,
              uploadedReferenceCountReliable: true
            }
          }
        };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage(), { cdp });

  assert.equal(result.status, 'manual_reference_binding_required');
  assert.equal(result.promptFilled, false);
  assert.equal(result.filesAttached, 0);
  assert.equal(result.remainingReferenceCount, 2);
  assert.equal(calls.some((call) => call.method === 'DOM.setFileInputFiles'), false);
  assert.equal(calls.some((call) => /chipCountDelta/.test(String(call.params?.expression || ''))), false);
  assert.match(result.notes.join('\n'), /仍残留 2 个旧参考资源/);
});

test('Jimeng page automation stops before upload when reference cleanup times out', async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /existingReferencesCleared/.test(params.expression)) {
        throw new Error('Runtime.evaluate timed out after 20000ms');
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return {
          result: {
            value: {
              textLength: 0,
              chipCount: 0,
              rawMentionCount: 0,
              uploadedReferenceCount: 1,
              uploadedReferenceCountReliable: true
            }
          }
        };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage(), { cdp });

  assert.equal(result.status, 'manual_reference_binding_required');
  assert.equal(result.promptFilled, false);
  assert.equal(result.filesAttached, 0);
  assert.equal(calls.some((call) => call.method === 'DOM.setFileInputFiles'), false);
  assert.equal(calls.some((call) => /chipCountDelta/.test(String(call.params?.expression || ''))), false);
  assert.match(result.notes.join('\n'), /清理旧参考资源时遇到问题/);
});

test('Jimeng page automation blocks pre-submit when uploaded reference thumbnails are duplicated', async () => {
  const cdp = {
    async send(method, params = {}) {
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /chipCountDelta/.test(params.expression)) {
        return { result: { value: { ok: true, reason: '', optionText: '参考图 1', chipCountDelta: 1 } } };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 24, chipCount: 1, rawMentionCount: 0, uploadedReferenceCount: 4 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [7] };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage(), { cdp });

  assert.equal(result.status, 'manual_reference_binding_required');
  assert.equal(result.uploadedReferenceCount, 4);
  assert.equal(result.chipCount, 1);
  assert.equal(result.rawMentionCount, 0);
  assert.match(result.notes.join('\n'), /当前输入区参考缩略图数量为 4/);
});

test('Jimeng page automation prefers stable file input objectId upload when available', async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /document\.querySelectorAll\('input\[type="file"\]'\)/.test(params.expression || '')) {
        return { result: { objectId: 'file-input-object-1', subtype: 'node' } };
      }
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /chipCountDelta/.test(params.expression)) {
        return { result: { value: { ok: true, reason: '', optionText: '参考图 1', chipCountDelta: 1 } } };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 24, chipCount: 1, rawMentionCount: 0 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage(), { cdp });

  assert.equal(result.filesAttached, 1);
  assert.equal(calls.some((call) => call.method === 'DOM.setFileInputFiles' && call.params.objectId === 'file-input-object-1'), true);
  assert.equal(calls.some((call) => call.method === 'DOM.getDocument'), false);
});

test('Jimeng page automation recovers when file input nodeId becomes stale', async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /document\.querySelectorAll\('input\[type="file"\]'\)/.test(params.expression || '')) {
        return { result: { value: null, subtype: 'null' } };
      }
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 1, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /chipCountDelta/.test(params.expression)) {
        return { result: { value: { ok: true, reason: '', optionText: '参考图 1', chipCountDelta: 1 } } };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 20, chipCount: 0, rawMentionCount: 1 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { changedInputs: 1 } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [7] };
      if (method === 'DOM.setFileInputFiles') throw new Error('Could not find node with given id');
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage(), { cdp });

  assert.equal(result.status, 'manual_upload_required');
  assert.equal(result.promptFilled, true);
  assert.equal(result.fileInputsFound, 1);
  assert.equal(result.filesAttached, 0);
  assert.equal(calls.filter((call) => call.method === 'DOM.setFileInputFiles').length, 3);
  assert.match(result.notes.join('\n'), /参考资源上传失败：Could not find node with given id/);
});

test('Jimeng page automation reports login gate when no editor is available', async () => {
  const cdp = {
    async send(method, params = {}) {
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 0, fileInputCount: 0, loginLikely: true } } };
      }
      if (method === 'Runtime.evaluate' && /promptFilled/.test(params.expression)) {
        return { result: { value: { promptFilled: false, loginLikely: true, editor: null } } };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 0, chipCount: 0, rawMentionCount: 0 } } };
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [] };
      return {};
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage(), { cdp });

  assert.equal(result.status, 'login_required');
  assert.equal(result.loginLikely, true);
  assert.equal(result.filesAttached, 0);
  assert.match(result.notes.join('\n'), /登录即梦/);
});

test('Jimeng page automation stops at login gate even when the homepage editor is visible', async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /editableCount/.test(params.expression)) {
        return { result: { value: { editableCount: 1, fileInputCount: 2, loginLikely: true } } };
      }
      if (method === 'Runtime.evaluate' && /promptFilled/.test(params.expression)) {
        return { result: { value: { promptFilled: true, loginLikely: true, editor: { tag: 'DIV', contenteditable: 'true' } } } };
      }
      if (method === 'Runtime.evaluate' && /rawMentionCount/.test(params.expression)) {
        return { result: { value: { textLength: 20, chipCount: 0, rawMentionCount: 1 } } };
      }
      return { result: { value: {} } };
    }
  };

  const result = await runJimengPageAutomation(createFeedPackage(), { cdp });

  assert.equal(result.status, 'login_required');
  assert.equal(result.promptFilled, false);
  assert.equal(result.filesAttached, 0);
  assert.equal(calls.some((call) => call.method === 'DOM.setFileInputFiles'), false);
});

test('connectCdpPage picks the Jimeng target from Chrome remote debugging pages', async () => {
  const createdUrls = [];
  const fakeSocket = {
    addEventListener(event, handler) {
      if (event === 'open') queueMicrotask(handler);
    },
    send() {},
    close() {}
  };
  const cdp = await connectCdpPage({
    port: 9222,
    targetUrl: 'https://jimeng.jianying.com/ai-tool/generate',
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:9222/json/list');
      return {
        ok: true,
        async json() {
          return [
            { type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://example' },
            { type: 'page', url: 'https://jimeng.jianying.com/ai-tool/generate', webSocketDebuggerUrl: 'ws://jimeng' }
          ];
        }
      };
    },
    webSocketFactory: (url) => {
      createdUrls.push(url);
      return fakeSocket;
    }
  });

  assert.equal(createdUrls[0], 'ws://jimeng');
  await cdp.close();
});
