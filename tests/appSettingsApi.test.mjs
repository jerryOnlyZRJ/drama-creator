import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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

test('GET /api/app-settings reports the app workspace as the default cache root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-app-settings-default-'));
  try {
    const appWorkspaceDir = join(root, '.drama-creator');
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir });

    const res = await callApp(app, { method: 'GET', url: '/api/app-settings' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.appWorkspaceDir, appWorkspaceDir);
    assert.equal(res.json.resourceCacheDir, appWorkspaceDir);
    assert.equal(res.json.resourceCacheDirSource, 'default');
    assert.deepEqual(res.json.modelDefaults.video, {
      adapterId: 'jimeng-browser-automation',
      modelId: 'seedance-2.0-mini'
    });
    assert.deepEqual(res.json.modelDefaults.audio, {
      adapterId: 'jimeng-browser-automation',
      modelId: 'jimeng-audio'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/app-settings bootstraps app-owned workspace directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-app-settings-bootstrap-'));
  try {
    const appWorkspaceDir = join(root, '.drama-creator');
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir });

    const res = await callApp(app, { method: 'GET', url: '/api/app-settings' });

    assert.equal(res.statusCode, 200);
    assert.equal((await stat(appWorkspaceDir)).isDirectory(), true);
    assert.equal((await stat(join(appWorkspaceDir, 'projects'))).isDirectory(), true);
    assert.equal((await stat(join(appWorkspaceDir, 'adapters'))).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PATCH /api/app-settings persists and resets a custom resource cache directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-app-settings-custom-'));
  try {
    const appWorkspaceDir = join(root, '.drama-creator');
    const settingsFile = join(appWorkspaceDir, 'settings.json');
    const customResourceCacheDir = join(root, 'custom-cache');
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir, settingsFile });

    const patched = await callApp(app, {
      method: 'PATCH',
      url: '/api/app-settings',
      body: { resourceCacheDir: customResourceCacheDir }
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json.resourceCacheDir, customResourceCacheDir);
    assert.equal(patched.json.resourceCacheDirSource, 'custom');

    const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.equal(saved.paths.resourceCacheDir, customResourceCacheDir);

    const reset = await callApp(app, {
      method: 'PATCH',
      url: '/api/app-settings',
      body: { resourceCacheDir: null }
    });
    assert.equal(reset.statusCode, 200);
    assert.equal(reset.json.resourceCacheDir, appWorkspaceDir);
    assert.equal(reset.json.resourceCacheDirSource, 'default');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PATCH /api/app-settings rejects relative custom resource cache paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-app-settings-relative-'));
  try {
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir: join(root, '.drama-creator') });

    const res = await callApp(app, {
      method: 'PATCH',
      url: '/api/app-settings',
      body: { resourceCacheDir: 'relative/cache' }
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json.error, /absolute path/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PATCH /api/app-settings persists model defaults per capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-app-settings-model-defaults-'));
  try {
    const appWorkspaceDir = join(root, '.drama-creator');
    const settingsFile = join(appWorkspaceDir, 'settings.json');
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir, settingsFile });

    const patched = await callApp(app, {
      method: 'PATCH',
      url: '/api/app-settings',
      body: {
        modelDefaults: {
          text: {
            adapterId: 'openai-compatible-text',
            modelId: 'deepseek-chat',
            providerId: 'deepseek'
          }
        }
      }
    });

    assert.equal(patched.statusCode, 200);
    assert.deepEqual(patched.json.modelDefaults.text, {
      adapterId: 'openai-compatible-text',
      modelId: 'deepseek-chat',
      providerId: 'deepseek'
    });

    const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.deepEqual(saved.modelDefaults.text, {
      adapterId: 'openai-compatible-text',
      modelId: 'deepseek-chat',
      providerId: 'deepseek'
    });

    const listed = await callApp(app, { method: 'GET', url: '/api/app-settings' });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json.modelDefaults.text, {
      adapterId: 'openai-compatible-text',
      modelId: 'deepseek-chat',
      providerId: 'deepseek'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PATCH /api/app-settings rejects defaults whose adapter does not provide the capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-app-settings-model-invalid-'));
  try {
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir: join(root, '.drama-creator') });

    const res = await callApp(app, {
      method: 'PATCH',
      url: '/api/app-settings',
      body: {
        modelDefaults: {
          image: {
            adapterId: 'openai-compatible-text',
            modelId: 'deepseek-chat'
          }
        }
      }
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json.error, /does not support image/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PATCH /api/app-settings allows external handoff channels as freely selected defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-app-settings-external-default-'));
  try {
    const appWorkspaceDir = join(root, '.drama-creator');
    const settingsFile = join(appWorkspaceDir, 'settings.json');
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir, settingsFile });

    const patched = await callApp(app, {
      method: 'PATCH',
      url: '/api/app-settings',
      body: {
        modelDefaults: {
          video: {
            adapterId: 'jimeng-browser-automation',
            modelId: 'seedance-2.0-mini'
          }
        }
      }
    });

    assert.equal(patched.statusCode, 200);
    assert.deepEqual(patched.json.modelDefaults.video, {
      adapterId: 'jimeng-browser-automation',
      modelId: 'seedance-2.0-mini'
    });

    const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.deepEqual(saved.modelDefaults.video, {
      adapterId: 'jimeng-browser-automation',
      modelId: 'seedance-2.0-mini'
    });

    const reset = await callApp(app, {
      method: 'PATCH',
      url: '/api/app-settings',
      body: { modelDefaults: { video: null } }
    });

    assert.equal(reset.statusCode, 200);
    assert.deepEqual(reset.json.modelDefaults.video, {
      adapterId: 'jimeng-browser-automation',
      modelId: 'seedance-2.0-mini'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PATCH /api/app-settings allows Jimeng automation as the default audio channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dc-app-settings-audio-default-'));
  try {
    const appWorkspaceDir = join(root, '.drama-creator');
    const settingsFile = join(appWorkspaceDir, 'settings.json');
    const app = createApp({ root, allowedEpisodeRoots: [root], appWorkspaceDir, settingsFile });

    const patched = await callApp(app, {
      method: 'PATCH',
      url: '/api/app-settings',
      body: {
        modelDefaults: {
          audio: {
            adapterId: 'jimeng-browser-automation',
            modelId: 'jimeng-audio'
          }
        }
      }
    });

    assert.equal(patched.statusCode, 200);
    assert.deepEqual(patched.json.modelDefaults.audio, {
      adapterId: 'jimeng-browser-automation',
      modelId: 'jimeng-audio'
    });

    const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.deepEqual(saved.modelDefaults.audio, {
      adapterId: 'jimeng-browser-automation',
      modelId: 'jimeng-audio'
    });

    const reset = await callApp(app, {
      method: 'PATCH',
      url: '/api/app-settings',
      body: { modelDefaults: { audio: null } }
    });

    assert.equal(reset.statusCode, 200);
    assert.deepEqual(reset.json.modelDefaults.audio, {
      adapterId: 'jimeng-browser-automation',
      modelId: 'jimeng-audio'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
