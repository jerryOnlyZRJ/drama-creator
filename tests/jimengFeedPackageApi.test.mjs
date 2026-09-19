// 公开测试使用虚构示例文本，保留解析与工作流断言，不承载作者作品。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.mjs';

function callApp(app, { method, url, body }) {
  return new Promise((resolve) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = {
      method,
      url,
      [Symbol.asyncIterator]: async function* () { if (buf) yield buf; }
    };
    const res = {
      statusCode: 0,
      setHeader() {},
      end(data) {
        const payload = data || '';
        resolve({ statusCode: res.statusCode, json: payload ? JSON.parse(payload) : null });
      }
    };
    app(req, res);
  });
}

function episodeDoc(epDir) {
  return {
    schemaVersion: '0.1.0',
    config: {},
    project: { name: 'Demo' },
    episode: { id: 'ep001', path: epDir },
    adapters: [],
    credentials: [],
    jobs: [],
    nodes: [
      {
        id: 'node:prompt:video:s001:v001',
        type: 'video_prompt',
        shotId: 'shot:s001',
        title: 'S001 视频提示词',
        metadata: { prompt: '@图片1 作为首帧，9:16，5秒，镜头前推。' }
      },
      {
        id: 'node:image:kf:s001',
        type: 'image_asset',
        shotId: 'shot:s001',
        title: 'S001 首帧',
        path: 'manual-assets/images/s001.png',
        metadata: { role: 'first_frame' }
      }
    ],
    edges: [
      { id: 'e1', from: 'node:prompt:video:s001:v001', to: 'node:image:kf:s001', type: 'uses_reference', role: 'first_frame' }
    ],
    tasks: [
      { id: 'task:video:s001:v001', shotId: 'shot:s001', type: 'video', status: 'ready_to_feed', promptNodeId: 'node:prompt:video:s001:v001', fields: { ratio: '9:16', duration: 5 } }
    ],
    shots: [
      { id: 'shot:s001', shotNo: 's001', title: '第一镜', status: 'ready_to_feed' }
    ],
    checks: [],
    activityLog: []
  };
}

test('POST /api/jimeng/feed-package returns a side-effect-free browser automation handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-jimeng-api-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(epDir, { recursive: true });
    await writeFile(join(root, 'project.json'), JSON.stringify({
      id: 'demo',
      name: 'Demo',
      jimengSpaceName: '机器人送信'
    }, null, 2));
    const docPath = join(epDir, 'drama-creator.json');
    await writeFile(docPath, JSON.stringify(episodeDoc(epDir), null, 2));
    const before = await readFile(docPath, 'utf8');

    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      appWorkspaceDir: join(root, '.drama-creator'),
      settingsFile: join(root, '.drama-creator', 'settings.json')
    });

    await callApp(app, {
      method: 'PATCH',
      url: '/api/app-settings',
      body: {
        modelDefaults: {
          video: {
            adapterId: 'jimeng-browser-automation',
            modelId: 'seedance-2.0-fast'
          }
        }
      }
    });

    const res = await callApp(app, {
      method: 'POST',
      url: '/api/jimeng/feed-package',
      body: { episodePath: epDir, taskId: 'task:video:s001:v001' }
    });

    assert.equal(res.statusCode, 200);
    const safeEpDir = await realpath(epDir);
    assert.equal(res.json.package.platform, 'jimeng');
    assert.equal(res.json.package.automationType, 'browser');
    assert.equal(res.json.package.workspace.modelId, 'seedance-2.0-fast');
    assert.equal(res.json.package.workspace.model, 'Seedance 2.0 Fast');
    assert.equal(res.json.package.workspace.spaceName, '机器人送信');
    assert.equal(res.json.package.references[0].uploadPath, join(safeEpDir, 'manual-assets/images/s001.png'));
    assert.equal(res.json.package.submitPolicy.requireExplicitUserConfirmation, true);
    assert.equal(await readFile(docPath, 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/jimeng/feed-package rejects missing identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-jimeng-api-missing-'));
  try {
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir: join(root, '.drama-creator') });
    const res = await callApp(app, {
      method: 'POST',
      url: '/api/jimeng/feed-package',
      body: { taskId: 'task:video:s001:v001' }
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json.error, /Missing episodePath\/taskId/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/jimeng/automation/start prepares an app-managed browser run without mutating the episode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-jimeng-automation-api-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(join(epDir, 'manual-assets/images'), { recursive: true });
    await writeFile(join(epDir, 'manual-assets/images/s001.png'), 'fake image');
    const docPath = join(epDir, 'drama-creator.json');
    await writeFile(docPath, JSON.stringify(episodeDoc(epDir), null, 2));
    const before = await readFile(docPath, 'utf8');
    const appWorkspaceDir = join(root, '.drama-creator');
    await writeFile(join(root, 'project.json'), JSON.stringify({
      id: 'demo',
      name: 'Demo',
      jimengSpaceName: '机器人送信'
    }, null, 2));

    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      appWorkspaceDir
    });

    const res = await callApp(app, {
      method: 'POST',
      url: '/api/jimeng/automation/start',
      body: { episodePath: epDir, taskId: 'task:video:s001:v001', launchBrowser: false }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.package.platform, 'jimeng');
    assert.equal(res.json.package.taskId, 'task:video:s001:v001');
    assert.equal(res.json.automation.status, 'prepared');
    assert.equal(res.json.automation.mode, 'managed_browser_profile');
    assert.match(res.json.automation.profileDir, /\.drama-creator[/\\]browser-profiles[/\\]jimeng$/);
    assert.match(res.json.automation.runDir, /\.drama-creator[/\\]automation[/\\]jimeng[/\\]runs[/\\]/);
    assert.equal(res.json.automation.submitPolicy.allowAutoSubmit, false);
    assert.equal(res.json.automation.submitPolicy.requireExplicitUserConfirmation, true);
    assert.equal(JSON.parse(await readFile(res.json.automation.feedPackagePath, 'utf8')).taskId, 'task:video:s001:v001');
    const checklist = await readFile(res.json.automation.checklistPath, 'utf8');
    assert.match(checklist, /应用托管浏览器/);
    assert.match(checklist, /即梦空间：机器人送信/);
    assert.equal(await readFile(docPath, 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/jimeng/automation/start reports missing reference files before browser launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-jimeng-automation-missing-api-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(epDir, { recursive: true });
    await writeFile(join(epDir, 'drama-creator.json'), JSON.stringify(episodeDoc(epDir), null, 2));

    const app = createApp({
      root,
      allowedEpisodeRoots: [root],
      appWorkspaceDir: join(root, '.drama-creator')
    });

    const res = await callApp(app, {
      method: 'POST',
      url: '/api/jimeng/automation/start',
      body: { episodePath: epDir, taskId: 'task:video:s001:v001', launchBrowser: false }
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json.error, 'missing_reference_file');
    assert.equal(res.json.missingReferences.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /api/library/audio-generation/start persists a public voice task and uses the audio default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-jimeng-public-audio-api-'));
  try {
    const epDir = join(root, 'ep001');
    await mkdir(epDir, { recursive: true });
    const doc = episodeDoc(epDir);
    doc.publicAssets = [
      {
        id: 'public:voice-char-xwsboy-v001',
        title: '小邮（12岁）角色音色参考',
        category: 'voices',
        kind: 'audio',
        status: 'pending',
        prompt: '12 岁男孩，声线清亮、克制，不朗诵。',
        spokenText: '奶奶，我知道了。我会认真练习。',
        voiceName: '阳光小男孩',
        outputTarget: 'scripts/assets/voices/references/char_xwsboy_voice_v001_jimeng.m4a'
      }
    ];
    const docPath = join(epDir, 'drama-creator.json');
    await writeFile(docPath, JSON.stringify(doc, null, 2));
    const appWorkspaceDir = join(root, '.drama-creator');
    const settingsFile = join(appWorkspaceDir, 'settings.json');
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir, settingsFile });

    await callApp(app, {
      method: 'PATCH',
      url: '/api/app-settings',
      body: {
        modelDefaults: {
          audio: { adapterId: 'jimeng-browser-automation', modelId: 'jimeng-audio' }
        }
      }
    });
    const res = await callApp(app, {
      method: 'POST',
      url: '/api/library/audio-generation/start',
      body: {
        episodePath: epDir,
        assetId: 'public:voice-char-xwsboy-v001',
        launchBrowser: false
      }
    });

    assert.equal(res.statusCode, 200, JSON.stringify(res.json));
    assert.equal(res.json.package.capability, 'audio');
    assert.equal(res.json.package.workspace.modelId, 'jimeng-audio');
    assert.equal(res.json.package.workspace.voiceName, '阳光小男孩');
    assert.equal(res.json.package.prompt, '奶奶，我知道了。我会认真练习。');
    assert.equal(res.json.automation.status, 'prepared');
    const saved = JSON.parse(await readFile(docPath, 'utf8'));
    assert.equal(saved.tasks.find((item) => item.id === res.json.taskId)?.type, 'audio');
    assert.equal(saved.nodes.find((item) => item.id === res.json.promptNodeId)?.type, 'audio_prompt');
    assert.equal(saved.publicAssets[0].metadata.generationTaskId, res.json.taskId);
    const checklist = await readFile(res.json.automation.checklistPath, 'utf8');
    assert.match(checklist, /音色：阳光小男孩/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
