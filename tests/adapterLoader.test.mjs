import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isContractCompatible, loadManifest, discoverCliAdapters } from '../src/adapters/loader.mjs';

test('isContractCompatible accepts 1.x and rejects 2.x', () => {
  assert.equal(isContractCompatible('1.0'), true);
  assert.equal(isContractCompatible('1.9'), true);
  assert.equal(isContractCompatible('2.0'), false);
  assert.equal(isContractCompatible('0.9'), false);
  assert.equal(isContractCompatible(undefined), false);
});

test('discoverCliAdapters reads valid manifests and skips incompatible/broken ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-adapters-'));
  try {
    await mkdir(join(dir, 'good'), { recursive: true });
    await writeFile(join(dir, 'good', 'manifest.json'), JSON.stringify({
      contractVersion: '1.0', id: 'good', displayName: 'Good', version: '0.1.0',
      kind: 'cli', entry: 'run.sh', async: false, capabilities: []
    }));
    await mkdir(join(dir, 'future'), { recursive: true });
    await writeFile(join(dir, 'future', 'manifest.json'), JSON.stringify({
      contractVersion: '2.0', id: 'future', displayName: 'Future', version: '0.1.0',
      kind: 'cli', entry: 'run.sh', async: false, capabilities: []
    }));
    await mkdir(join(dir, 'broken'), { recursive: true });
    await writeFile(join(dir, 'broken', 'manifest.json'), '{not json');

    const result = await discoverCliAdapters(dir);
    const ids = result.available.map((a) => a.id);
    assert.deepEqual(ids, ['good']);
    assert.equal(result.skipped.some((s) => s.id === 'future' && s.reason === 'incompatible_contract'), true);
    assert.equal(result.skipped.some((s) => s.reason === 'invalid_manifest'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('discoverCliAdapters returns empty when dir is missing', async () => {
  const result = await discoverCliAdapters(join(tmpdir(), 'definitely-missing-xyz'));
  assert.deepEqual(result.available, []);
  assert.deepEqual(result.skipped, []);
});
