import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAvailableAdapters, resolveAdapter } from '../src/adapters/registry.mjs';

test('listAvailableAdapters always includes builtin mock-echo', async () => {
  const list = await listAvailableAdapters({ cliAdaptersDir: join(tmpdir(), 'definitely-missing') });
  assert.equal(list.some((a) => a.id === 'mock-echo' && a.kind === 'builtin'), true);
});

test('listAvailableAdapters merges builtins with discovered CLI adapters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-reg-'));
  try {
    await mkdir(join(dir, 'good'), { recursive: true });
    await writeFile(join(dir, 'good', 'manifest.json'), JSON.stringify({
      contractVersion: '1.0', id: 'good', displayName: 'Good', version: '0.1.0',
      kind: 'cli', entry: 'run.sh', async: false, capabilities: []
    }));
    const list = await listAvailableAdapters({ cliAdaptersDir: dir });
    const ids = list.map((a) => a.id).sort();
    assert.equal(ids.includes('mock-echo'), true);
    assert.equal(ids.includes('good'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('builtin adapters declare asset production mode and execution type', async () => {
  const list = await listAvailableAdapters({ cliAdaptersDir: join(tmpdir(), 'definitely-missing') });
  const byId = new Map(list.map((adapter) => [adapter.id, adapter]));

  assert.equal(byId.get('openai-compatible-text').productionMode, 'in_app');
  assert.equal(byId.get('openai-compatible-text').execution.type, 'api');
  assert.equal(byId.get('openai-codex-oauth').productionMode, 'in_app');
  assert.equal(byId.get('openai-codex-oauth').execution.type, 'subscription');
  assert.equal(byId.get('jimeng-browser-automation').productionMode, 'external');
  assert.equal(byId.get('jimeng-browser-automation').execution.type, 'browser_automation');
  assert.equal(byId.get('jimeng-browser-automation').execution.defaultRecommended, true);
  assert.equal(byId.get('jimeng-browser-automation').execution.manualBackfill, true);
  assert.equal(byId.get('jimeng-browser-automation').execution.startEndpoint, '/api/jimeng/automation/start');
  assert.equal(byId.get('jimeng-browser-automation').execution.profileMode, 'app_managed');
  assert.equal(byId.get('jimeng-browser-automation').automation.available, true);
  assert.equal(byId.get('jimeng-browser-automation').automation.type, 'managed_browser');
  assert.equal(
    byId.get('jimeng-browser-automation').capabilities.some((capability) => capability.type === 'audio'),
    true
  );
  const jimengVideoDuration = byId.get('jimeng-browser-automation').capabilities
    .find((capability) => capability.type === 'video')
    ?.models?.find((model) => model.id === 'seedance-2.0-mini')
    ?.params?.duration;
  // Jimeng review probes use the page-visible minimum duration to isolate audit issues without burning extra credits.
  assert.deepEqual(
    {
      min: jimengVideoDuration?.min,
      max: jimengVideoDuration?.max,
      default: jimengVideoDuration?.default
    },
    { min: 4, max: 15, default: 4 }
  );
  assert.equal(
    byId.get('jimeng-browser-automation').capabilities
      .find((capability) => capability.type === 'audio')
      ?.models?.some((model) => model.id === 'jimeng-audio'),
    true
  );
});

test('resolveAdapter returns adapterRef shape compatible with executor.runGenerate', async () => {
  const ref = await resolveAdapter('mock-echo', { cliAdaptersDir: join(tmpdir(), 'missing') });
  assert.equal(ref.id, 'adapter:mock-echo');
  assert.equal(ref.manifestId, 'mock-echo');
  assert.equal(ref.kind, 'builtin');
  assert.ok(ref.module && typeof ref.module.generate === 'function');
});

test('resolveAdapter returns null for unknown id', async () => {
  const ref = await resolveAdapter('does-not-exist', { cliAdaptersDir: join(tmpdir(), 'missing') });
  assert.equal(ref, null);
});
