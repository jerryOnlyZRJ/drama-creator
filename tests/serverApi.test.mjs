import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.mjs';
import { getDefaultEpisodeRoots } from '../src/server/episodeRoots.mjs';

test('serves episode JSON through local API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-creator-api-'));
  const episodePath = join(root, 'ep001');
  await mkdir(episodePath, { recursive: true });
  await writeFile(join(episodePath, 'drama-creator.json'), JSON.stringify({
    schemaVersion: '0.1.0',
    project: { name: 'demo' },
    episode: { id: 'ep001', path: episodePath },
    shots: [],
    nodes: [],
    edges: [],
    tasks: [],
    checks: [],
    activityLog: []
  }));

  const server = createServer(createApp({ root }));
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/episode?path=${encodeURIComponent(episodePath)}`);
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.episode.id, 'ep001');
  } finally {
    // Close the ephemeral test server so the test runner never leaves open handles.
    await new Promise((resolve) => server.close(resolve));
  }
});

test('continues serving static files from the configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-creator-static-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Drama Creator</title>');

  const server = createServer(createApp({ root }));
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(text, /Drama Creator/);
  } finally {
    // Keep the static-service regression test side-effect free.
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves an empty favicon response so browsers do not log a static 404', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-creator-favicon-'));
  const server = createServer(createApp({ root }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    const text = await response.text();

    assert.equal(response.status, 204);
    assert.equal(text, '');
  } finally {
    // Close the favicon probe server immediately; the test only verifies routing behavior.
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('serves mjs modules with a JavaScript content type for browser imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-creator-mjs-'));
  await mkdir(join(root, 'src', 'feed'), { recursive: true });
  await writeFile(join(root, 'src', 'feed', 'feedPackage.mjs'), 'export const ok = true;');

  const server = createServer(createApp({ root }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/src/feed/feedPackage.mjs`);
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/javascript/);
    assert.match(text, /ok = true/);
  } finally {
    // Close the module-serving regression server so no test leaves loopback ports open.
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rejects episode API paths outside authorized roots without leaking paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-creator-allowed-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'drama-creator-outside-'));
  const outsideEpisodePath = join(outsideRoot, 'ep001');
  await mkdir(outsideEpisodePath, { recursive: true });
  await writeFile(join(outsideEpisodePath, 'drama-creator.json'), JSON.stringify({ episode: { id: 'ep001' } }));

  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/episode?path=${encodeURIComponent(outsideEpisodePath)}`);
    const json = await response.json();

    assert.equal(response.status, 403);
    assert.equal(json.error, 'Forbidden episode path');
    assert.equal(JSON.stringify(json).includes(outsideEpisodePath), false);
  } finally {
    // Security negative tests also close their loopback server immediately.
    await new Promise((resolve) => server.close(resolve));
  }
});

test('redacts filesystem details from API error responses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-creator-redact-'));
  const episodePath = join(root, 'missing-json-episode');
  await mkdir(episodePath, { recursive: true });

  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/episode?path=${encodeURIComponent(episodePath)}`);
    const json = await response.json();

    assert.equal(response.status, 404);
    assert.equal(json.error, 'Episode state not found');
    assert.equal(JSON.stringify(json).includes(episodePath), false);
    assert.equal(JSON.stringify(json).includes('ENOENT'), false);
  } finally {
    // Avoid leaving a failed-request server running after the redaction assertion.
    await new Promise((resolve) => server.close(resolve));
  }
});

test('returns redacted 404 when the episode directory does not exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-creator-missing-episode-'));
  const missingEpisodePath = join(root, 'does-not-exist');

  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/episode?path=${encodeURIComponent(missingEpisodePath)}`);
    const json = await response.json();

    assert.equal(response.status, 404);
    assert.equal(json.error, 'Episode directory not found');
    assert.equal(JSON.stringify(json).includes(missingEpisodePath), false);
    assert.equal(JSON.stringify(json).includes('ENOENT'), false);
  } finally {
    // Missing-directory tests use only tmpdir fixtures and close the server immediately.
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rejects symlinked episode paths that resolve outside authorized roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-creator-symlink-allowed-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'drama-creator-symlink-outside-'));
  const outsideEpisodePath = join(outsideRoot, 'ep001');
  const linkedEpisodePath = join(root, 'linked-ep001');
  await mkdir(outsideEpisodePath, { recursive: true });
  await writeFile(join(outsideEpisodePath, 'drama-creator.json'), JSON.stringify({
    schemaVersion: '0.1.0',
    project: { name: 'outside' },
    episode: { id: 'ep001', path: outsideEpisodePath },
    shots: [],
    nodes: [],
    edges: [],
    tasks: [],
    checks: [],
    activityLog: []
  }));
  await symlink(outsideEpisodePath, linkedEpisodePath, 'dir');

  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const getResponse = await fetch(`${baseUrl}/api/episode?path=${encodeURIComponent(linkedEpisodePath)}`);
    const patchResponse = await fetch(`${baseUrl}/api/episode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath: linkedEpisodePath, document: { episode: { id: 'patched' } } })
    });
    const importResponse = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath: linkedEpisodePath })
    });

    assert.equal(getResponse.status, 403);
    assert.equal(patchResponse.status, 403);
    assert.equal(importResponse.status, 403);
  } finally {
    // The symlink fixture is under tmpdir and the loopback server is always closed here.
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rejects malformed PATCH JSON without leaking parser details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-creator-malformed-patch-'));
  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/episode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{"episodePath":'
    });
    const json = await response.json();

    assert.equal(response.status, 400);
    assert.equal(json.error, 'Invalid JSON body');
    assert.equal(JSON.stringify(json).includes('SyntaxError'), false);
  } finally {
    // Malformed client input should not leave the loopback test server open.
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid PATCH episode documents before writing JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-creator-invalid-patch-'));
  const episodePath = join(root, 'ep001');
  await mkdir(episodePath, { recursive: true });

  const server = createServer(createApp({ root, allowedEpisodeRoots: [root] }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/episode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodePath, document: { schemaVersion: 'not-supported', nodes: [] } })
    });
    const json = await response.json();

    assert.equal(response.status, 400);
    assert.equal(json.error, 'Invalid episode document');
    assert.deepEqual(json.details, ['Unsupported schemaVersion: not-supported']);
  } finally {
    // Invalid documents are rejected before file writes, then the test server is closed.
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('server entry binds the local app to loopback only', async () => {
  const serverEntry = await readFile('server.mjs', 'utf8');

  assert.match(serverEntry, /127\.0\.0\.1/);
  assert.match(serverEntry, /server\.listen\(port,\s*host/);
});

test('default episode roots include the workspace data root from main repo and worktree cwd', () => {
  const workspaceRoot = join(tmpdir(), 'short-drama-workspace');
  const repoCwd = join(workspaceRoot, 'drama-creator');
  const worktreeCwd = join(repoCwd, '.worktrees', 'drama-creator-redesign');

  assert.deepEqual(getDefaultEpisodeRoots({ cwd: repoCwd, envValue: '' }), [repoCwd, workspaceRoot]);
  assert.deepEqual(getDefaultEpisodeRoots({ cwd: worktreeCwd, envValue: '' }), [worktreeCwd, workspaceRoot]);
});
