import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('shot canvas exposes the QC editor controls', async () => {
  const html = await readFile('shot.html', 'utf8');
  const js = await readFile('shot.js', 'utf8');

  assert.match(html, /id="qcStatus"/);
  assert.match(html, /id="qcNote"/);
  assert.match(html, /id="saveQcButton"/);
  assert.match(js, /saveQcRecord/);
});

test('QC save uses PATCH with JSON document payload', async () => {
  const js = await readFile('shot.js', 'utf8');

  assert.match(js, /fetch\('\/api\/episode'/);
  assert.match(js, /method:\s*'PATCH'/);
  assert.match(js, /'Content-Type':\s*'application\/json'/);
  assert.match(js, /JSON\.stringify\(\{\s*episodePath,\s*document:\s*state\.doc\s*\}\)/);
});

test('QC note stays in form values instead of being rendered as HTML', async () => {
  const js = await readFile('shot.js', 'utf8');

  // QC notes are user-controlled, so they must populate textarea.value and never flow into HTML sinks.
  assert.match(js, /dom\.qcNote\.value\s*=/);
  assert.doesNotMatch(js, /qcNote(?:Element)?\.innerHTML\s*=/);
  assert.doesNotMatch(js, /insertAdjacentHTML\([^)]*qcNote/);
});
