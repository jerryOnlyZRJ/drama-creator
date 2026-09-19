import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliAdapter } from '../src/adapters/cliRunner.mjs';

async function writeScript(dir, name, body) {
  const p = join(dir, name);
  await writeFile(p, body, 'utf8');
  await chmod(p, 0o755);
  return p;
}

test('runCliAdapter passes stdin and parses stdout JSON (completed)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-cli-'));
  try {
    const script = await writeScript(dir, 'ok.sh', '#!/usr/bin/env bash\ncat >/dev/null\necho \'{"status":"completed","outputs":[{"path":"o.mp4","kind":"video","role":"primary"}]}\'\n');
    const result = await runCliAdapter({ entryPath: script, input: { action: 'generate' }, timeoutSec: 5 });
    assert.equal(result.status, 'completed');
    assert.equal(result.outputs[0].path, 'o.mp4');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCliAdapter maps non-JSON stdout to unknown error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-cli-junk-'));
  try {
    const script = await writeScript(dir, 'junk.sh', '#!/usr/bin/env bash\ncat >/dev/null\necho not-json\n');
    const result = await runCliAdapter({ entryPath: script, input: {}, timeoutSec: 5 });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'unknown');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCliAdapter times out a hanging process with timeout error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-cli-hang-'));
  try {
    const script = await writeScript(dir, 'hang.sh', '#!/usr/bin/env bash\nsleep 30\n');
    const result = await runCliAdapter({ entryPath: script, input: {}, timeoutSec: 1 });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'timeout');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
