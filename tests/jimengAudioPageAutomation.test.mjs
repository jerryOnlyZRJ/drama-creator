// 公开测试使用虚构示例文本，保留解析与工作流断言，不承载作者作品。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runJimengAudioPageAutomation } from '../src/automation/jimengAudioPageAutomation.mjs';

function audioFeedPackage() {
  return {
    platform: 'jimeng',
    capability: 'audio',
    prompt: '奶奶，我知道了。我会认真练习。',
    workspace: { mode: '配音生成', voiceName: '阳光小男孩' },
    audio: {
      spokenText: '奶奶，我知道了。我会认真练习。',
      voiceName: '阳光小男孩'
    }
  };
}

function publicVoiceAudioFeedPackage() {
  return {
    ...audioFeedPackage(),
    workspace: { mode: '配音生成', voiceName: '小邮童年 B' },
    references: [{
      placeholder: '@音频1',
      kind: 'audio',
      role: 'public_voice_reference',
      sourceNodeId: 'node:audio:char_xwsboy_voice_v001',
      uploadPath: '/project/scripts/assets/voices/references/char_xwsboy_voice_v001_jimeng.wav'
    }],
    audio: {
      spokenText: '我试试。',
      voiceName: '阳光小男孩',
      voiceSource: 'public_reference',
      cloneVoiceName: '小邮童年 B',
      linkedVoiceAssetId: 'public:voice-char-xwsboy-v001',
      referenceSourceNodeId: 'node:audio:char_xwsboy_voice_v001'
    }
  };
}

test('Jimeng audio automation fills only spoken text, selects voice, and stops before submit', async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /jimengAudioComposerProbe/.test(params.expression)) {
        return { result: { value: { textareaFound: true, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /jimengAudioPrepareTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              promptFilled: true,
              textLength: 20,
              voiceSet: true,
              selectedVoice: '阳光小男孩',
              submitReady: true,
              creditCost: '1',
              modeText: '配音生成',
              popoverClosed: true
            }
          }
        };
      }
      return {};
    }
  };

  const result = await runJimengAudioPageAutomation(audioFeedPackage(), { cdp });

  assert.equal(result.status, 'pre_submit_confirmation');
  assert.equal(result.promptFilled, true);
  assert.equal(result.voiceSet, true);
  assert.equal(result.selectedVoice, '阳光小男孩');
  assert.equal(result.creditCost, '1');
  assert.match(result.notes.join('\n'), /没有自动提交/);
  const preparationCall = calls.find((call) => /jimengAudioPrepareTarget/.test(String(call.params.expression || '')));
  assert.ok(preparationCall);
  assert.match(preparationCall.params.expression, /奶奶，我知道了/);
  // 音色候选列表只负责触发选择；最终状态必须在弹层关闭后从输入区触发器重新读取。
  assert.match(preparationCall.params.expression, /popover\.querySelectorAll/);
  // 即梦音色库是虚拟列表，目标音色不在首屏时必须滚动查找，不能直接误报缺失。
  assert.match(preparationCall.params.expression, /ReactVirtualized__Grid/);
  assert.match(preparationCall.params.expression, /grid\.dispatchEvent\(new Event\('scroll'/);
  // 已经选择过其他内置音色时，入口不再显示“音色”；自动化仍需从已选音色卡重新打开选择器。
  assert.match(preparationCall.params.expression, /reference-group-content/);
  assert.match(preparationCall.params.expression, /overlay-label/);
  assert.match(preparationCall.params.expression, /!String\(el\.className \|\| ''\)\.includes\('collapsed'\)/);
  assert.match(preparationCall.params.expression, /await sleep\(350\);\s*selectedVoice = selectedVoiceText\(\)/);
  assert.doesNotMatch(preparationCall.params.expression, /\[class\*="reference-"\]\[class\*="active"\].*overlay-container/);
  assert.doesNotMatch(preparationCall.params.expression, /\.click\(\).*submit|submitButton\.click/);
});

test('Jimeng audio automation reports login requirement without changing the composer', async () => {
  let preparationAttempted = false;
  const cdp = {
    async send(method, params = {}) {
      if (method === 'Runtime.evaluate' && /jimengAudioComposerProbe/.test(params.expression)) {
        return { result: { value: { textareaFound: false, loginLikely: true } } };
      }
      if (method === 'Runtime.evaluate' && /jimengAudioPrepareTarget/.test(params.expression)) preparationAttempted = true;
      return {};
    }
  };

  const result = await runJimengAudioPageAutomation(audioFeedPackage(), { cdp });

  assert.equal(result.status, 'login_required');
  assert.equal(result.promptFilled, false);
  assert.equal(preparationAttempted, false);
});

test('Jimeng audio automation closes the virtual voice picker with trusted CDP input before confirming', async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /jimengAudioComposerProbe/.test(params.expression)) {
        return { result: { value: { textareaFound: true, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /jimengAudioPrepareTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              promptFilled: true,
              textLength: 20,
              voiceSet: false,
              selectedVoice: '阳光小男孩',
              submitReady: true,
              creditCost: '1',
              modeText: '配音生成',
              popoverClosed: false
            }
          }
        };
      }
      if (method === 'Runtime.evaluate' && /jimengAudioInspectTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              promptFilled: true,
              textLength: 20,
              voiceSet: true,
              selectedVoice: '阳光小男孩',
              submitReady: true,
              creditCost: '1',
              modeText: '配音生成',
              popoverClosed: true
            }
          }
        };
      }
      return {};
    }
  };

  const result = await runJimengAudioPageAutomation(audioFeedPackage(), { cdp });

  assert.equal(result.status, 'pre_submit_confirmation');
  assert.equal(result.popoverClosed, true);
  assert.equal(result.voiceSet, true);
  assert.equal(calls.filter((call) => call.method === 'Input.dispatchKeyEvent').length, 2);
  assert.ok(calls.some((call) => call.params.key === 'Escape'));
});

test('Jimeng audio automation clicks the composer safely when Escape does not close the picker', async () => {
  const calls = [];
  let inspectCount = 0;
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /jimengAudioComposerProbe/.test(params.expression)) {
        return { result: { value: { textareaFound: true, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /jimengAudioPrepareTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              promptFilled: true,
              textLength: 4,
              voiceSet: false,
              selectedVoice: '小邮童年 B',
              submitReady: true,
              creditCost: '1',
              modeText: '配音生成',
              popoverClosed: false
            }
          }
        };
      }
      if (method === 'Runtime.evaluate' && /jimengAudioSafeDismissPoint/.test(params.expression)) {
        return { result: { value: { x: 420, y: 708 } } };
      }
      if (method === 'Runtime.evaluate' && /jimengAudioInspectTarget/.test(params.expression)) {
        inspectCount += 1;
        return {
          result: {
            value: {
              promptFilled: true,
              textLength: 4,
              voiceSet: inspectCount > 1,
              selectedVoice: '小邮童年 B',
              submitReady: true,
              creditCost: '1',
              modeText: '配音生成',
              popoverClosed: inspectCount > 1
            }
          }
        };
      }
      return {};
    }
  };

  const result = await runJimengAudioPageAutomation(publicVoiceAudioFeedPackage(), { cdp });

  assert.equal(result.status, 'pre_submit_confirmation');
  assert.equal(result.popoverClosed, true);
  assert.equal(result.selectedVoice, '小邮童年 B');
  const mouseEvents = calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
  assert.equal(mouseEvents.length, 2);
  assert.deepEqual(mouseEvents.map((call) => call.params.type), ['mousePressed', 'mouseReleased']);
  assert.ok(mouseEvents.every((call) => call.params.x === 420 && call.params.y === 708));
});

test('Jimeng audio automation selects the cloned public voice and never falls back to the built-in voice', async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && /jimengAudioComposerProbe/.test(params.expression)) {
        return { result: { value: { textareaFound: true, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /jimengAudioPrepareTarget/.test(params.expression)) {
        return {
          result: {
            value: {
              promptFilled: true,
              textLength: 4,
              voiceSet: true,
              selectedVoice: '小邮童年 B',
              submitReady: true,
              creditCost: '1',
              modeText: '配音生成',
              popoverClosed: true
            }
          }
        };
      }
      return {};
    }
  };

  const result = await runJimengAudioPageAutomation(publicVoiceAudioFeedPackage(), { cdp });

  assert.equal(result.status, 'pre_submit_confirmation');
  assert.equal(result.voiceSource, 'public_reference');
  assert.equal(result.sourceReferenceVerified, true);
  assert.equal(result.selectedVoice, '小邮童年 B');
  assert.match(result.notes.join('\n'), /公共音色参考/);
  const preparationCall = calls.find((call) => /jimengAudioPrepareTarget/.test(String(call.params.expression || '')));
  assert.ok(preparationCall);
  assert.match(preparationCall.params.expression, /voiceSource/);
  assert.match(preparationCall.params.expression, /我的音色/);
  assert.match(preparationCall.params.expression, /小邮童年 B/);
  assert.doesNotMatch(preparationCall.params.expression, /submitButton\.click/);
});

test('Jimeng audio automation blocks a public voice task without a cloned voice mapping', async () => {
  const feed = publicVoiceAudioFeedPackage();
  feed.workspace.voiceName = '';
  feed.audio.cloneVoiceName = '';
  let preparationAttempted = false;
  const cdp = {
    async send(method, params = {}) {
      if (method === 'Runtime.evaluate' && /jimengAudioComposerProbe/.test(params.expression)) {
        return { result: { value: { textareaFound: true, loginLikely: false } } };
      }
      if (method === 'Runtime.evaluate' && /jimengAudioPrepareTarget/.test(params.expression)) preparationAttempted = true;
      return {};
    }
  };

  const result = await runJimengAudioPageAutomation(feed, { cdp });

  assert.equal(result.status, 'manual_settings_required');
  assert.equal(result.voiceSource, 'public_reference');
  assert.equal(result.sourceReferenceVerified, false);
  assert.match(result.notes.join('\n'), /未登记即梦克隆音色/);
  assert.equal(preparationAttempted, false);
});
