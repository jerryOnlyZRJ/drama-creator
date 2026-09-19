import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runJimengAudioPageAutomation } from './jimengAudioPageAutomation.mjs';
import { connectCdpPage, runJimengPageAutomation } from './jimengPageAutomation.mjs';

export class JimengAutomationError extends Error {
  constructor(message, { code = 'jimeng_automation_error', statusCode = 500, missingReferences = [] } = {}) {
    super(message);
    this.name = 'JimengAutomationError';
    this.code = code;
    this.statusCode = statusCode;
    this.missingReferences = missingReferences;
  }
}

// 即梦自动化必须模拟真实桌面应用：应用拥有自己的浏览器 profile，
// 不能复用用户日常 Chrome，也不能依赖 Codex/Chrome DevTools MCP。
export function jimengManagedProfileDir(appWorkspaceDir) {
  return join(resolve(appWorkspaceDir), 'browser-profiles', 'jimeng');
}

export function jimengAutomationRunsDir(appWorkspaceDir) {
  return join(resolve(appWorkspaceDir), 'automation', 'jimeng', 'runs');
}

export async function prepareJimengAutomationRun(feedPackage, {
  appWorkspaceDir,
  launchBrowser = true,
  now = () => new Date(),
  spawnImpl = spawn,
  platform = process.platform,
  env = process.env,
  fetchImpl = globalThis.fetch,
  connectCdpPageImpl = connectCdpPage,
  runPageAutomationImpl = null,
  runVideoPageAutomationImpl = runJimengPageAutomation,
  runAudioPageAutomationImpl = runJimengAudioPageAutomation
} = {}) {
  if (!feedPackage || feedPackage.platform !== 'jimeng') {
    throw new JimengAutomationError('Invalid Jimeng feed package', { code: 'invalid_feed_package', statusCode: 400 });
  }
  if (!appWorkspaceDir) {
    throw new JimengAutomationError('appWorkspaceDir is required', { code: 'invalid_params', statusCode: 400 });
  }

  const missingReferences = await collectMissingReferences(feedPackage.references || []);
  if (missingReferences.length) {
    throw new JimengAutomationError('Some Jimeng reference files are missing', {
      code: 'missing_reference_file',
      statusCode: 409,
      missingReferences
    });
  }

  const profileDir = jimengManagedProfileDir(appWorkspaceDir);
  const runsDir = jimengAutomationRunsDir(appWorkspaceDir);
  const runId = createRunId(now());
  const runDir = join(runsDir, runId);
  const feedPackagePath = join(runDir, 'feed-package.json');
  const checklistPath = join(runDir, 'upload-checklist.txt');
  const statePath = join(runDir, 'state.json');

  await mkdir(profileDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(feedPackagePath, `${JSON.stringify(feedPackage, null, 2)}\n`, 'utf8');
  await writeFile(checklistPath, buildJimengAutomationChecklist(feedPackage, { profileDir }), 'utf8');

  const targetUrl = feedPackage.targetUrl || 'https://jimeng.jianying.com/';
  const launch = launchBrowser
    ? await launchManagedBrowser({ targetUrl, profileDir, spawnImpl, platform, env, fetchImpl })
    : { launched: false, command: null, args: [], error: null };
  const pageAutomation = launchBrowser && launch.launched && launch.devtoolsPort
    ? await runPageAutomationWithCdp(feedPackage, {
      devtoolsPort: launch.devtoolsPort,
      targetUrl,
      connectCdpPageImpl,
      runPageAutomationImpl,
      runVideoPageAutomationImpl,
      runAudioPageAutomationImpl
    })
    : { status: 'not_attempted', notes: launchBrowser && launch.launched && !launch.devtoolsPort ? ['未拿到浏览器 CDP 端口，已降级为人工投喂清单。'] : [] };
  const status = resolveRunStatus({ launchBrowser, launch, pageAutomation });

  const state = {
    runId,
    status,
    mode: 'managed_browser_profile',
    createdAt: now().toISOString(),
    targetUrl,
    profileDir,
    feedPackagePath,
    checklistPath,
    submitPolicy: normalizeSubmitPolicy(feedPackage.submitPolicy),
    browserLaunch: launch,
    pageAutomation
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  return {
    ...state,
    runDir,
    statePath,
    nextAction: nextActionForStatus(status, pageAutomation, launch, feedPackage)
  };
}

async function collectMissingReferences(references) {
  const missing = [];
  for (const ref of references) {
    const uploadPath = ref.uploadPath || ref.path;
    if (!uploadPath) {
      missing.push({ placeholder: ref.placeholder, title: ref.title || '', uploadPath: '' });
      continue;
    }
    try {
      const info = await stat(uploadPath);
      if (!info.isFile()) missing.push({ placeholder: ref.placeholder, title: ref.title || '', uploadPath });
    } catch {
      missing.push({ placeholder: ref.placeholder, title: ref.title || '', uploadPath });
    }
  }
  return missing;
}

async function launchManagedBrowser({ targetUrl, profileDir, spawnImpl, platform, env, fetchImpl }) {
  const command = browserCommandForPlatform(platform, env);
  if (!command) {
    return { launched: false, command: null, args: [], error: `Unsupported platform: ${platform}` };
  }
  const existingPort = command.supportsDevtoolsPort
    ? await readDevtoolsPort(profileDir).catch(() => null)
    : null;
  // 用户可能重复点击自动化按钮；已有托管窗口可用时复用 CDP 端口，
  // 避免删除 DevToolsActivePort 后新 Chrome 只转交给旧进程而不重写端口文件。
  const reuseExistingPort = existingPort
    ? await isDevtoolsPortReachable(existingPort, fetchImpl).catch(() => false)
    : false;
  if (reuseExistingPort) {
    return {
      launched: true,
      command: null,
      args: [],
      devtoolsPort: existingPort,
      reusedExistingPort: true,
      error: null
    };
  }
  if (command.supportsDevtoolsPort) {
    await rm(join(profileDir, 'DevToolsActivePort'), { force: true });
    await clearChromeSingletonFiles(profileDir);
  }
  const child = spawnImpl(command.command, command.args({ targetUrl, profileDir }), {
    detached: true,
    stdio: 'ignore'
  });
  child.on?.('error', () => {});
  child.unref?.();
  const devtoolsPort = command.supportsDevtoolsPort
    ? await waitForDevtoolsPort(profileDir).catch(() => null)
    : null;
  return {
    launched: true,
    command: command.command,
    args: command.args({ targetUrl, profileDir }),
    devtoolsPort,
    reusedExistingPort: false,
    error: null
  };
}

async function clearChromeSingletonFiles(profileDir) {
  // Chrome profile 被 kill 后可能留下 Singleton* 锁文件；不清理时新 Chrome 会转交给
  // 已不存在的旧进程，导致 DevToolsActivePort 不再生成。
  await Promise.all(['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map((file) => (
    rm(join(profileDir, file), { force: true })
  )));
}

function browserCommandForPlatform(platform, env) {
  if (platform === 'darwin') {
    const executable = firstExistingPath([
      env.DRAMA_CREATOR_CHROME_PATH,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      env.HOME ? join(env.HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome') : ''
    ]);
    if (executable) {
      return {
        command: executable,
        supportsDevtoolsPort: true,
        args: ({ targetUrl, profileDir }) => [
          `--user-data-dir=${profileDir}`,
          '--remote-debugging-port=0',
          '--remote-allow-origins=*',
          '--no-first-run',
          '--new-window',
          targetUrl
        ]
      };
    }
    return {
      command: 'open',
      supportsDevtoolsPort: false,
      args: ({ targetUrl, profileDir }) => [
        '-na',
        'Google Chrome',
        '--args',
        `--user-data-dir=${profileDir}`,
        '--new-window',
        targetUrl
      ]
    };
  }
  if (platform === 'win32') {
    return {
      command: env.DRAMA_CREATOR_CHROME_PATH || 'chrome',
      supportsDevtoolsPort: true,
      args: ({ targetUrl, profileDir }) => [
        `--user-data-dir=${profileDir}`,
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
        '--no-first-run',
        '--new-window',
        targetUrl
      ]
    };
  }
  if (platform === 'linux') {
    return {
      command: env.DRAMA_CREATOR_CHROME_PATH || 'google-chrome',
      supportsDevtoolsPort: true,
      args: ({ targetUrl, profileDir }) => [
        `--user-data-dir=${profileDir}`,
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
        '--no-first-run',
        '--new-window',
        targetUrl
      ]
    };
  }
  return null;
}

async function runPageAutomationWithCdp(feedPackage, {
  devtoolsPort,
  targetUrl,
  connectCdpPageImpl,
  runPageAutomationImpl,
  runVideoPageAutomationImpl,
  runAudioPageAutomationImpl
}) {
  let cdp;
  try {
    cdp = await connectCdpPageImpl({ port: devtoolsPort, targetUrl });
    // 调用方可用 runPageAutomationImpl 注入通用测试替身；生产环境按投喂包 capability 选择对应页面脚本。
    const pageRunner = runPageAutomationImpl || (feedPackage.capability === 'audio'
      ? runAudioPageAutomationImpl
      : runVideoPageAutomationImpl);
    return await pageRunner(feedPackage, { cdp, timeoutMs: jimengPageAutomationTimeoutMs(feedPackage) });
  } catch (error) {
    return {
      status: 'script_failed',
      error: error?.message || String(error),
      notes: [`页面脚本执行失败：${error?.message || error}；请使用上传清单人工投喂。`]
    };
  } finally {
    await cdp?.close?.();
  }
}

function jimengPageAutomationTimeoutMs(feedPackage) {
  // 音色弹层首次加载可能慢于纯文本输入，给予固定 30 秒但仍严格停在生成前。
  if (feedPackage?.capability === 'audio') return 30000;
  const referenceCount = Array.isArray(feedPackage?.references) ? feedPackage.references.length : 0;
  // 多参考资源时每个 @ 占位符都要打开即梦引用面板、选择候选并等待 chip 落盘，4 图以上镜头在真实页面会明显慢于单测环境。
  return Math.min(90000, 15000 + referenceCount * 15000);
}

async function waitForDevtoolsPort(profileDir, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = await readDevtoolsPort(profileDir).catch(() => null);
    if (port) return port;
    await delay(100);
  }
  throw new Error('Timed out waiting for Chrome DevToolsActivePort');
}

async function readDevtoolsPort(profileDir) {
  const activePortPath = join(profileDir, 'DevToolsActivePort');
  const text = await readFile(activePortPath, 'utf8');
  const port = Number(String(text).split(/\r?\n/)[0]);
  if (Number.isInteger(port) && port > 0) return port;
  return null;
}

async function isDevtoolsPortReachable(port, fetchImpl) {
  if (typeof fetchImpl !== 'function') return false;
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
  return !!response?.ok;
}

function resolveRunStatus({ launchBrowser, launch, pageAutomation }) {
  if (!launchBrowser) return 'prepared';
  if (!launch.launched) return 'prepared';
  if (pageAutomation?.status && !['not_attempted', 'script_failed'].includes(pageAutomation.status)) {
    return pageAutomation.status;
  }
  return 'login_required';
}

function nextActionForStatus(status, pageAutomation, launch, feedPackage) {
  // 这些句子会直接显示在镜头页状态里，必须提醒用户去托管窗口验收，避免误看日常 Chrome 的旧即梦标签。
  if (!launch.launched) return '已准备投喂运行目录；启动浏览器后继续登录、上传和提交前确认。';
  if (status === 'login_required') return '在 Drama Creator 托管的即梦窗口完成登录；不要使用平时打开的 Chrome 旧标签。登录后可重新启动自动化或按上传清单人工投喂。';
  if (status === 'manual_upload_required') return '提示词已尝试填入；请按上传清单手动上传参考资源并绑定 @ 资源。';
  if (status === 'manual_reference_binding_required') return 'Drama Creator 已尝试通过即梦「引用参考」入口绑定资源；仍有 @图片N/@音频N 普通文本或缺失引用标签时，提交前请在托管窗口修复为真实资源引用。';
  if (status === 'pre_submit_confirmation' && feedPackage?.capability === 'audio') {
    const voiceName = pageAutomation?.selectedVoice || feedPackage?.audio?.voiceName || '当前音色';
    const sourceText = feedPackage?.audio?.voiceSource === 'public_reference' ? '项目公共音色克隆' : '内置音色';
    return `托管即梦窗口已填入台词并选择${sourceText}「${voiceName}」；确认后由用户手动点击生成。`;
  }
  if (status === 'pre_submit_confirmation') return '托管即梦窗口已到提交前确认状态；确认模型、比例、时长和资源引用后，由用户手动点击生成。';
  if (pageAutomation?.status === 'script_failed') return '应用托管窗口已打开，但页面脚本失败；请使用投喂包和上传清单人工操作。';
  return '在 Drama Creator 托管的即梦窗口继续登录、上传和提交前确认。';
}

function firstExistingPath(paths) {
  return paths.filter(Boolean).find((item) => existsSync(item)) || '';
}

function createRunId(date) {
  const timestamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `jimeng-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSubmitPolicy(policy = {}) {
  return {
    requireExplicitUserConfirmation: policy.requireExplicitUserConfirmation !== false,
    allowAutoSubmit: false
  };
}

function buildJimengAutomationChecklist(feedPackage, { profileDir }) {
  if (feedPackage.capability === 'audio') return buildJimengAudioAutomationChecklist(feedPackage, { profileDir });
  const lines = [
    `即梦自动化运行：${feedPackage.shot?.shotNo || '当前镜头'}${feedPackage.shot?.title ? ` · ${feedPackage.shot.title}` : ''}`,
    `目标页面：${feedPackage.targetUrl || 'https://jimeng.jianying.com/'}`,
    `浏览器：应用托管浏览器 profile（${profileDir}）`,
    ...(feedPackage.workspace?.spaceName ? [`即梦空间：${feedPackage.workspace.spaceName}`] : []),
    // 与全局推荐默认值保持一致；缺省投喂清单也不应回退到普通 2.0。
    `模型：${feedPackage.workspace?.model || 'Seedance 2.0 mini'}`,
    `比例 / 时长：${feedPackage.params?.ratio || '未指定'} / ${feedPackage.params?.duration || '未指定'}s`,
    '',
    '参考资源上传顺序：'
  ];
  const refs = feedPackage.references || [];
  if (refs.length) {
    for (const ref of refs) {
      lines.push(`${ref.placeholder} · ${ref.title || ref.role || '参考资源'} · ${ref.uploadPath || ref.path || ''}`);
    }
  } else {
    lines.push('无参考资源，仅投喂提示词。');
  }
  lines.push(
    '',
    '执行边界：',
    '1. 首次使用时在应用托管浏览器中登录即梦；登录态只保存在该 profile 内。',
    '2. 不复用用户日常 Chrome 登录态，不依赖 Codex/Chrome DevTools MCP。',
    '3. @图片N/@音频N 必须通过即梦「引用参考」入口绑定成真实资源 chip。',
    '4. 提交前暂停，用户确认模型、比例、时长和参考资源绑定后再手动点击生成。',
    '',
    '生成后回填：',
    '下载 MP4 后回到 Drama Creator 当前镜头页，通过「导入外部资源」回填并完成 QC。'
  );
  return `${lines.join('\n')}\n`;
}

function buildJimengAudioAutomationChecklist(feedPackage, { profileDir }) {
  const publicVoiceReference = (feedPackage.references || []).find((reference) => reference.role === 'public_voice_reference');
  const lines = [
    `即梦音频自动化：${feedPackage.shot?.title || feedPackage.audio?.assetId || '当前音频资产'}`,
    `目标页面：${feedPackage.targetUrl || 'https://jimeng.jianying.com/'}`,
    `浏览器：应用托管浏览器 profile（${profileDir}）`,
    ...(feedPackage.workspace?.spaceName ? [`即梦空间：${feedPackage.workspace.spaceName}`] : []),
    `模式：${feedPackage.workspace?.mode || '配音生成'}`,
    `音色来源：${feedPackage.audio?.voiceSource === 'public_reference' ? '项目公共音色参考' : '即梦内置音色'}`,
    `音色：${feedPackage.audio?.cloneVoiceName || feedPackage.audio?.voiceName || feedPackage.workspace?.voiceName || '未指定'}`,
    ...(publicVoiceReference ? [`公共音色文件：${publicVoiceReference.uploadPath || publicVoiceReference.path || ''}`] : []),
    `输入框台词：${feedPackage.audio?.spokenText || feedPackage.prompt || ''}`,
    '',
    '执行边界：',
    '1. 输入框只放角色实际说出的台词，音色说明和 QC 目标不会被读出。',
    '2. 首次使用时在应用托管浏览器中登录即梦，不复用用户日常 Chrome。',
    '3. 已绑定项目公共音色时，必须选择该文件对应的「我的音色」克隆项；缺失映射时阻断，不回退到内置音色。',
    '4. 提交前暂停，由用户确认音色、台词和页面显示的积分消耗。',
    '',
    '生成后回填：',
    `下载音频后回填到 ${feedPackage.audio?.outputTarget || '项目公共音色资产'}，先标记待音频 QC，用户确认后再作为分镜参考。`
  ];
  return `${lines.join('\n')}\n`;
}
