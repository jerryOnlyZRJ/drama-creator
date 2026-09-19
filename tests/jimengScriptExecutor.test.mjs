// 公开测试使用虚构示例文本，保留解析与工作流断言，不承载作者作品。
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jimengManagedProfileDir, prepareJimengAutomationRun } from '../src/automation/jimengScriptExecutor.mjs';

function feedPackage(uploadPath) {
  return {
    schemaVersion: 'jimeng-feed-package.v1',
    platform: 'jimeng',
    automationType: 'browser',
    targetUrl: 'https://jimeng.jianying.com/ai-tool/generate',
    taskId: 'task:video:s001:v001',
    shot: { shotNo: 's001', title: '权限被收回' },
    workspace: { model: 'Seedance 2.0' },
    prompt: '@图片1 作为首帧，9:16，5秒，镜头前推。',
    params: { ratio: '9:16', duration: 5 },
    references: [
      { order: 1, placeholder: '@图片1', title: '首帧', uploadPath }
    ],
    gates: ['pre_submit_confirmation'],
    submitPolicy: { requireExplicitUserConfirmation: true, allowAutoSubmit: false }
  };
}

test('Jimeng script executor prepares an app-owned browser profile and run package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-jimeng-executor-'));
  const appWorkspaceDir = join(root, '.drama-creator');
  const imagePath = join(root, 's001.png');
  await mkdir(root, { recursive: true });
  await writeFile(imagePath, 'fake image');

  try {
    const result = await prepareJimengAutomationRun(feedPackage(imagePath), {
      appWorkspaceDir,
      launchBrowser: false,
      now: () => new Date('2026-06-13T10:00:00.000Z')
    });

    assert.equal(result.status, 'prepared');
    assert.equal(result.mode, 'managed_browser_profile');
    assert.equal(result.pageAutomation.status, 'not_attempted');
    assert.deepEqual(result.pageAutomation.notes, []);
    assert.equal(result.submitPolicy.allowAutoSubmit, false);
    assert.equal(result.submitPolicy.requireExplicitUserConfirmation, true);
    assert.match(result.profileDir, /\.drama-creator[/\\]browser-profiles[/\\]jimeng$/);
    assert.doesNotMatch(result.profileDir, /Application Support[/\\]Google[/\\]Chrome/);
    assert.match(result.runDir, /\.drama-creator[/\\]automation[/\\]jimeng[/\\]runs[/\\]/);

    const savedPackage = JSON.parse(await readFile(result.feedPackagePath, 'utf8'));
    const state = JSON.parse(await readFile(result.statePath, 'utf8'));
    const checklist = await readFile(result.checklistPath, 'utf8');

    assert.equal(savedPackage.taskId, 'task:video:s001:v001');
    assert.equal(state.status, 'prepared');
    assert.match(checklist, /应用托管浏览器/);
    assert.match(checklist, /@图片1/);
    assert.match(checklist, /提交前暂停/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Jimeng script executor runs page automation through the managed browser CDP port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-jimeng-executor-cdp-'));
  const appWorkspaceDir = join(root, '.drama-creator');
  const imagePath = join(root, 's001.png');
  await writeFile(imagePath, 'fake image');

  try {
    const result = await prepareJimengAutomationRun(feedPackage(imagePath), {
      appWorkspaceDir,
      launchBrowser: true,
      platform: 'linux',
      env: { DRAMA_CREATOR_CHROME_PATH: '/bin/echo' },
      spawnImpl: (command, args) => {
        assert.equal(command, '/bin/echo');
        const profileArg = args.find((item) => String(item).startsWith('--user-data-dir='));
        const profileDir = profileArg.slice('--user-data-dir='.length);
        queueMicrotask(() => writeFile(join(profileDir, 'DevToolsActivePort'), '9333\n/devtools/browser/mock\n'));
        return { unref() {}, on() {} };
      },
      connectCdpPageImpl: async ({ port, targetUrl }) => {
        assert.equal(port, 9333);
        assert.match(targetUrl, /jimeng/);
        return { close() {} };
      },
      runPageAutomationImpl: async (pkg, { cdp, timeoutMs }) => {
	        assert.equal(pkg.taskId, 'task:video:s001:v001');
	        assert.ok(cdp);
	        assert.equal(timeoutMs, 30000);
        return {
          status: 'manual_reference_binding_required',
          promptFilled: true,
          fileInputsFound: 1,
          filesAttached: 1,
          rawMentionCount: 1,
          chipCount: 0,
          notes: ['提示词已填入，但需要人工绑定 chip。']
        };
      }
    });

    assert.equal(result.status, 'manual_reference_binding_required');
    assert.equal(result.browserLaunch.devtoolsPort, 9333);
    assert.equal(result.pageAutomation.promptFilled, true);
    assert.match(result.nextAction, /真实资源引用/);
    const state = JSON.parse(await readFile(result.statePath, 'utf8'));
    assert.equal(state.pageAutomation.status, 'manual_reference_binding_required');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Jimeng script executor reuses an already-open managed browser CDP port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-jimeng-executor-existing-cdp-'));
  const appWorkspaceDir = join(root, '.drama-creator');
  const imagePath = join(root, 's001.png');
  const profileDir = jimengManagedProfileDir(appWorkspaceDir);
  await mkdir(profileDir, { recursive: true });
  await writeFile(imagePath, 'fake image');
  await writeFile(join(profileDir, 'DevToolsActivePort'), '9444\n/devtools/browser/existing\n');

  try {
    const result = await prepareJimengAutomationRun(feedPackage(imagePath), {
      appWorkspaceDir,
      launchBrowser: true,
      platform: 'linux',
      env: { DRAMA_CREATOR_CHROME_PATH: '/bin/echo' },
      fetchImpl: async (url) => {
        assert.match(url, /127\.0\.0\.1:9444\/json\/version/);
        return { ok: true };
      },
      spawnImpl: () => {
        throw new Error('should not spawn a second Jimeng browser when an existing app-owned CDP port is reachable');
      },
      connectCdpPageImpl: async ({ port }) => {
        assert.equal(port, 9444);
        return { close() {} };
      },
      runPageAutomationImpl: async () => ({
        status: 'pre_submit_confirmation',
        promptFilled: true,
        fileInputsFound: 1,
        filesAttached: 1,
        rawMentionCount: 0,
        chipCount: 1,
        notes: ['页面已进入提交前确认状态。']
      })
    });

    assert.equal(result.status, 'pre_submit_confirmation');
    assert.equal(result.browserLaunch.devtoolsPort, 9444);
    assert.equal(result.browserLaunch.reusedExistingPort, true);
    assert.equal(result.browserLaunch.command, null);
    assert.deepEqual(result.browserLaunch.args, []);
    assert.match(result.nextAction, /手动点击生成/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Jimeng script executor dispatches audio packages to the audio page runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-jimeng-executor-audio-'));
  const appWorkspaceDir = join(root, '.drama-creator');
  const profileDir = jimengManagedProfileDir(appWorkspaceDir);
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, 'DevToolsActivePort'), '9777\n/devtools/browser/audio\n');
  const pkg = {
    ...feedPackage(''),
    capability: 'audio',
    targetUrl: 'https://jimeng.jianying.com/ai-tool/generate?type=audio',
    taskId: 'task:audio:voice-xwsboy:v001',
    shot: { shotNo: '', title: '小邮童年音色' },
    workspace: { mode: '配音生成', model: '即梦音频生成', voiceName: '阳光小男孩' },
    prompt: '奶奶，我知道了。',
    params: { duration: 8 },
    references: [],
    audio: { voiceName: '阳光小男孩', spokenText: '奶奶，我知道了。' }
  };
  let videoRunnerCalled = false;

  try {
    const result = await prepareJimengAutomationRun(pkg, {
      appWorkspaceDir,
      launchBrowser: true,
      platform: 'linux',
      env: { DRAMA_CREATOR_CHROME_PATH: '/bin/echo' },
      fetchImpl: async () => ({ ok: true }),
      connectCdpPageImpl: async ({ port }) => {
        assert.equal(port, 9777);
        return { close() {} };
      },
      runVideoPageAutomationImpl: async () => {
        videoRunnerCalled = true;
        return { status: 'script_failed' };
      },
      runAudioPageAutomationImpl: async (feed, { timeoutMs }) => {
        assert.equal(feed.capability, 'audio');
        assert.equal(timeoutMs, 30000);
        return {
          status: 'pre_submit_confirmation',
          promptFilled: true,
          voiceSet: true,
          selectedVoice: '阳光小男孩',
          submitReady: true,
          creditCost: '1',
          notes: ['已停在生成前。']
        };
      }
    });

    assert.equal(videoRunnerCalled, false);
    assert.equal(result.status, 'pre_submit_confirmation');
    assert.match(result.nextAction, /阳光小男孩/);
    const checklist = await readFile(result.checklistPath, 'utf8');
    assert.match(checklist, /输入框台词：奶奶，我知道了/);
    assert.match(checklist, /提交前暂停/);
    assert.doesNotMatch(checklist, /MP4/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Jimeng script executor clears stale Chrome singleton files before a fresh launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-jimeng-executor-stale-singleton-'));
  const appWorkspaceDir = join(root, '.drama-creator');
  const imagePath = join(root, 's001.png');
  const profileDir = jimengManagedProfileDir(appWorkspaceDir);
  await mkdir(profileDir, { recursive: true });
  await writeFile(imagePath, 'fake image');
  await writeFile(join(profileDir, 'DevToolsActivePort'), '9555\n/devtools/browser/stale\n');
  await writeFile(join(profileDir, 'SingletonLock'), 'old-pid');
  await writeFile(join(profileDir, 'SingletonCookie'), 'old-cookie');
  await writeFile(join(profileDir, 'SingletonSocket'), 'old-socket');

  try {
    const result = await prepareJimengAutomationRun(feedPackage(imagePath), {
      appWorkspaceDir,
      launchBrowser: true,
      platform: 'linux',
      env: { DRAMA_CREATOR_CHROME_PATH: '/bin/echo' },
      fetchImpl: async () => ({ ok: false }),
      spawnImpl: (command, args) => {
        assert.equal(command, '/bin/echo');
        const profileArg = args.find((item) => String(item).startsWith('--user-data-dir='));
        const launchedProfileDir = profileArg.slice('--user-data-dir='.length);
        return {
          unref() {
            queueMicrotask(() => writeFile(join(launchedProfileDir, 'DevToolsActivePort'), '9666\n/devtools/browser/new\n'));
          },
          on() {}
        };
      },
      connectCdpPageImpl: async ({ port }) => {
        assert.equal(port, 9666);
        return { close() {} };
      },
      runPageAutomationImpl: async () => ({
        status: 'pre_submit_confirmation',
        promptFilled: true,
        fileInputsFound: 1,
        filesAttached: 1,
        rawMentionCount: 0,
        chipCount: 1,
        notes: ['页面已进入提交前确认状态。']
      })
    });

    assert.equal(result.browserLaunch.devtoolsPort, 9666);
    assert.equal(result.browserLaunch.reusedExistingPort, false);
    await assert.rejects(() => access(join(profileDir, 'SingletonLock')));
    await assert.rejects(() => access(join(profileDir, 'SingletonCookie')));
    await assert.rejects(() => access(join(profileDir, 'SingletonSocket')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Jimeng script executor rejects missing reference files before opening the browser', async () => {
  const root = join(tmpdir(), `dc-jimeng-executor-missing-${Date.now()}`);
  const appWorkspaceDir = join(root, '.drama-creator');
  await mkdir(root, { recursive: true });

  try {
    await assert.rejects(
      () => prepareJimengAutomationRun(feedPackage(join(root, 'missing.png')), {
        appWorkspaceDir,
        launchBrowser: false
      }),
      (error) => {
        assert.equal(error.code, 'missing_reference_file');
        assert.equal(error.statusCode, 409);
        assert.equal(error.missingReferences.length, 1);
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
