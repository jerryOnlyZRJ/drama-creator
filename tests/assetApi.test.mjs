import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.mjs';

// /api/asset proxies episode-scoped media bytes to the canvas, so the security
// surface (authorized roots, extension, symlink escape) needs explicit regression tests.

async function startServer(allowedRoot) {
  const server = createServer(createApp({ root: allowedRoot, allowedEpisodeRoots: [allowedRoot] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function makeEpisode() {
  const allowedRoot = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-asset-')));
  const episodePath = join(allowedRoot, 'ep001');
  await mkdir(join(episodePath, 'frames'), { recursive: true });
  return { allowedRoot, episodePath };
}

test('serves an in-episode image through /api/asset', async () => {
  const { allowedRoot, episodePath } = await makeEpisode();
  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  await writeFile(join(episodePath, 'frames', 's001.png'), pngBytes);

  const server = await startServer(allowedRoot);
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/asset?episode=${encodeURIComponent(episodePath)}&path=${encodeURIComponent('frames/s001.png')}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(buffer.length, pngBytes.length);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(allowedRoot, { recursive: true, force: true });
  }
});

test('rejects path traversal that resolves outside the allowed root', async () => {
  const { allowedRoot, episodePath } = await makeEpisode();
  const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-outside-')));
  await writeFile(join(outsideRoot, 'leak.png'), Buffer.from('00', 'hex'));

  const server = await startServer(allowedRoot);
  try {
    const { port } = server.address();
    // Climb out of the allowed root using "..": the path resolves inside outsideRoot.
    const relativeOutside = `../../${outsideRoot.split('/').pop()}/leak.png`;
    const url = `http://127.0.0.1:${port}/api/asset?episode=${encodeURIComponent(episodePath)}&path=${encodeURIComponent(relativeOutside)}`;
    const response = await fetch(url);

    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(allowedRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('serves project-relative assets that climb out of episodes/epNNN with ..', async () => {
  // The real episode JSON stores paths relative to the project root (e.g. "scripts/assets/...").
  // The proxy must accept ".." segments as long as the realpath stays inside the authorized root.
  const allowedRoot = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-projrel-')));
  const projectRoot = join(allowedRoot, 'project');
  const episodePath = join(projectRoot, 'scripts', 'episodes', 'ep001');
  const assetDir = join(projectRoot, 'scripts', 'assets');
  await mkdir(episodePath, { recursive: true });
  await mkdir(assetDir, { recursive: true });
  await writeFile(join(assetDir, 'hero.png'), Buffer.from('00', 'hex'));

  const server = createServer(createApp({ root: allowedRoot, allowedEpisodeRoots: [allowedRoot] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/asset?episode=${encodeURIComponent(episodePath)}&path=${encodeURIComponent('../../assets/hero.png')}`;
    const response = await fetch(url);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(allowedRoot, { recursive: true, force: true });
  }
});

test('serves generated resources from the app cache namespace', async () => {
  const { allowedRoot, episodePath } = await makeEpisode();
  const resourceCacheDir = join(allowedRoot, '.drama-creator');
  const cachedPath = join(resourceCacheDir, 'projects', 'demo-123456789abc', 'resources', 'generated', 'ep001');
  await mkdir(cachedPath, { recursive: true });
  await writeFile(join(cachedPath, 'frame.png'), Buffer.from('00', 'hex'));

  const server = createServer(createApp({
    root: allowedRoot,
    allowedEpisodeRoots: [allowedRoot],
    resourceCacheDir
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/asset?episode=${encodeURIComponent(episodePath)}&path=${encodeURIComponent('app-cache/projects/demo-123456789abc/resources/generated/ep001/frame.png')}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(buffer.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(allowedRoot, { recursive: true, force: true });
  }
});

test('rejects app cache traversal outside the configured resource cache directory', async () => {
  const { allowedRoot, episodePath } = await makeEpisode();
  const resourceCacheDir = join(allowedRoot, '.drama-creator');
  await mkdir(resourceCacheDir, { recursive: true });
  await writeFile(join(allowedRoot, 'leak.png'), Buffer.from('00', 'hex'));

  const server = createServer(createApp({
    root: allowedRoot,
    allowedEpisodeRoots: [allowedRoot],
    resourceCacheDir
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/asset?episode=${encodeURIComponent(episodePath)}&path=${encodeURIComponent('app-cache/../../leak.png')}`;
    const response = await fetch(url);

    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(allowedRoot, { recursive: true, force: true });
  }
});

test('rejects symlinks that escape the episode directory', async () => {
  const { allowedRoot, episodePath } = await makeEpisode();
  const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'drama-creator-outside-')));
  await writeFile(join(outsideRoot, 'leak.png'), Buffer.from('00', 'hex'));
  await symlink(join(outsideRoot, 'leak.png'), join(episodePath, 'frames', 'leak.png'));

  const server = await startServer(allowedRoot);
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/asset?episode=${encodeURIComponent(episodePath)}&path=${encodeURIComponent('frames/leak.png')}`;
    const response = await fetch(url);

    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(allowedRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('refuses unsupported extensions even inside the episode', async () => {
  const { allowedRoot, episodePath } = await makeEpisode();
  await writeFile(join(episodePath, 'notes.txt'), 'not media');

  const server = await startServer(allowedRoot);
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/asset?episode=${encodeURIComponent(episodePath)}&path=${encodeURIComponent('notes.txt')}`;
    const response = await fetch(url);

    assert.equal(response.status, 415);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(allowedRoot, { recursive: true, force: true });
  }
});

test('HEAD returns the asset size without a body so the canvas can probe before rendering', async () => {
  const { allowedRoot, episodePath } = await makeEpisode();
  const bytes = Buffer.alloc(2048, 7);
  await writeFile(join(episodePath, 'frames', 'big.webp'), bytes);

  const server = await startServer(allowedRoot);
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/asset?episode=${encodeURIComponent(episodePath)}&path=${encodeURIComponent('frames/big.webp')}`;
    const response = await fetch(url, { method: 'HEAD' });
    const buffer = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('content-length'), String(bytes.length));
    assert.equal(buffer.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(allowedRoot, { recursive: true, force: true });
  }
});
