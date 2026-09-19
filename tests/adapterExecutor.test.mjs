import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest, generate } from '../src/adapters/mock-echo/index.mjs';

test('mock-echo manifest declares contract v1.0 and a video capability', () => {
  assert.equal(manifest.contractVersion, '1.0');
  assert.equal(manifest.kind, 'builtin');
  assert.equal(manifest.async, false);
  assert.ok(manifest.capabilities.some((c) => c.type === 'video'));
});

test('mock-echo generate writes a placeholder output and returns completed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-mock-'));
  try {
    const result = await generate({
      action: 'generate', capability: 'video', model: 'echo-video',
      prompt: 'hello', references: [], outputDir: dir, params: {}, credential: null
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.outputs.length, 1);
    const out = result.outputs[0];
    assert.equal(out.kind, 'video');
    assert.equal(out.role, 'primary');
    const content = await readFile(join(dir, out.path.replace(/^.*\//, '')), 'utf8');
    assert.match(content, /hello/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { runGenerate } from '../src/adapters/executor.mjs';

function execDoc() {
  return {
    nodes: [{ id: 'node:prompt:video:s001:v001', type: 'video_prompt', shotId: 'shot:s001', title: 'p', metadata: { prompt: 'hi' } }],
    edges: [],
    tasks: [{ id: 'task:video:s001:v001', shotId: 'shot:s001', type: 'video', promptNodeId: 'node:prompt:video:s001:v001', outputNodeIds: [], fields: {} }],
    jobs: []
  };
}

test('runGenerate (builtin, sync completed) backfills output node, edge, and completes job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-exec-'));
  try {
    const doc = execDoc();
    const adapterRef = { id: 'adapter:mock-echo', manifestId: 'mock-echo', kind: 'builtin', module: await import('../src/adapters/mock-echo/index.mjs') };
    const result = await runGenerate({
      doc, taskId: 'task:video:s001:v001', adapterRef,
      capability: 'video', model: 'echo-video', outputDir: dir, userParams: {}
    });

    assert.equal(result.job.status, 'completed');
    assert.equal(result.job.outputNodeIds.length, 1);
    const outNodeId = result.job.outputNodeIds[0];
    assert.equal(doc.nodes.some((n) => n.id === outNodeId && n.type === 'video_output'), true);
    assert.equal(doc.edges.some((e) => e.type === 'generates' && e.to === outNodeId), true);
    assert.equal(doc.jobs.some((j) => j.id === result.job.id), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runGenerate records failed job when adapter throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-exec-fail-'));
  try {
    const doc = execDoc();
    const adapterRef = {
      id: 'adapter:boom', manifestId: 'boom', kind: 'builtin',
      module: { manifest: { capabilities: [{ type: 'video', models: [{ id: 'm', params: {} }] }] }, generate: async () => { throw new Error('boom'); } }
    };
    const result = await runGenerate({ doc, taskId: 'task:video:s001:v001', adapterRef, capability: 'video', model: 'm', outputDir: dir });
    assert.equal(result.job.status, 'failed');
    assert.equal(result.job.error.code, 'unknown');
    assert.equal(doc.nodes.some((n) => n.type === 'video_output'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { refreshJobs } from '../src/adapters/executor.mjs';

test('refreshJobs advances a generating job to completed via poll and backfills', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-poll-'));
  try {
    const doc = execDoc();
    doc.jobs.push({
      id: 'job:async:1', taskId: 'task:video:s001:v001', adapterId: 'adapter:async-mock',
      status: 'generating', externalJobId: 'ext-1', submittedAt: 'x', outputNodeIds: []
    });
    const resolveAdapter = () => ({
      id: 'adapter:async-mock', kind: 'builtin',
      module: {
        manifest: { capabilities: [] },
        poll: async () => ({ status: 'completed', outputs: [{ path: 'a.mp4', kind: 'video', role: 'primary' }] })
      }
    });

    const summary = await refreshJobs({ doc, outputDir: dir, resolveAdapter });
    assert.equal(summary.advanced, 1);
    const job = doc.jobs.find((j) => j.id === 'job:async:1');
    assert.equal(job.status, 'completed');
    assert.equal(job.outputNodeIds.length, 1);
    assert.equal(doc.nodes.some((n) => n.type === 'video_output'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refreshJobs leaves still-generating jobs untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-poll2-'));
  try {
    const doc = execDoc();
    doc.jobs.push({ id: 'job:async:2', taskId: 'task:video:s001:v001', adapterId: 'a', status: 'generating', externalJobId: 'e', submittedAt: 'x', outputNodeIds: [] });
    const resolveAdapter = () => ({ id: 'a', kind: 'builtin', module: { manifest: { capabilities: [] }, poll: async () => ({ status: 'generating' }) } });
    const summary = await refreshJobs({ doc, outputDir: dir, resolveAdapter });
    assert.equal(summary.advanced, 0);
    assert.equal(doc.jobs.find((j) => j.id === 'job:async:2').status, 'generating');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
