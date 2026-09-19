import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('trash page exposes search, filters, restore and permanent delete hooks', async () => {
  const html = await readFile('trash.html', 'utf8');
  assert.match(html, /回收站管理/);
  assert.match(html, /id="trashSearch"/);
  assert.match(html, /id="trashFilters"/);
  assert.match(html, /id="trashList"/);
  assert.match(html, /id="trashDetail"/);
  assert.match(html, /id="trashDetailTitle"/);
  assert.match(html, /id="trashDetailBody"/);
  assert.match(html, /id="trashConfirmPanel"/);
  assert.match(html, /id="trashConfirmActionButton"/);
  assert.match(html, /id="emptyTrashButton"/);
  assert.match(html, /trash\.css/);
  assert.match(html, /trash\.js/);
});

test('trash.js wires list, restore, single permanent delete and empty APIs without HTML sinks', async () => {
  const js = await readFile('trash.js', 'utf8');
  assert.match(js, /\/api\/trash/);
  assert.match(js, /\/api\/trash\/restore/);
  assert.match(js, /\/api\/trash\/item/);
  assert.match(js, /method:\s*'POST'/);
  assert.match(js, /method:\s*'DELETE'/);
  assert.match(js, /restoreItem/);
  assert.match(js, /deleteItem/);
  assert.match(js, /emptyTrash/);
  assert.match(js, /selectedItemId/);
  assert.match(js, /renderTrashDetail/);
  assert.match(js, /requestTrashAction/);
  assert.match(js, /confirmTrashAction/);
  assert.match(js, /textContent/);
  assert.doesNotMatch(js, /innerHTML/);
  assert.doesNotMatch(js, /window\.confirm/);
});

test('trash.css keeps recycle-bin controls readable in the desktop shell', async () => {
  const css = await readFile('trash.css', 'utf8');
  assert.match(css, /\.trash-toolbar/);
  assert.match(css, /\.trash-filter/);
  assert.match(css, /\.trash-workspace/);
  assert.match(css, /\.trash-item/);
  assert.match(css, /\.trash-item--selected/);
  assert.match(css, /\.trash-item__actions/);
  assert.match(css, /\.trash-detail/);
  assert.match(css, /\.trash-confirm/);
  assert.match(css, /@media/);
});
