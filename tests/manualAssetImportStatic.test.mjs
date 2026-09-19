import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// 手动导入入口必须出现在镜头级页面，因为用户外部生成的关键帧/成片通常需要绑定到当前镜头。
test('shot page exposes manual image and video import controls', async () => {
  const html = await readFile(join(root, 'shot.html'), 'utf8');
  const js = await readFile(join(root, 'shot.js'), 'utf8');
  const css = await readFile(join(root, 'shot.css'), 'utf8');

  assert.match(html, /id="manualImportButton"/);
  assert.match(html, /id="manualImportDialog"/);
  assert.match(html, /导入外部资源/);
  assert.match(js, /\/api\/manual-assets\/import/);
  assert.match(js, /pick_asset_file/);
  assert.match(js, /manualImportKind/);
  assert.match(css, /\.manual-import/);
});

// 参考资源管理是 S002 这类“先补关键帧/角色图，再投喂即梦”的必要入口；
// 它操作的是 prompt->asset 引用边，不删除或复制公共资产本体。
test('shot page exposes existing reference asset management controls', async () => {
  const html = await readFile(join(root, 'shot.html'), 'utf8');
  const js = await readFile(join(root, 'shot.js'), 'utf8');
  const css = await readFile(join(root, 'shot.css'), 'utf8');

  assert.match(html, /id="referenceManagerButton"/);
  assert.match(html, /id="referenceManagerDialog"/);
  assert.match(html, /添加参考资源/);
  const dialogHtml = html.match(/<dialog id="referenceManagerDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  assert.match(dialogHtml, /<header class="modal__header reference-manager__header">[\s\S]*id="referenceManagerClose"[\s\S]*aria-label="关闭添加参考资源"/);
  assert.doesNotMatch(dialogHtml, /<footer class="modal__footer">[\s\S]*id="referenceManagerClose"/);
  assert.match(js, /\/api\/episode\/references/);
  assert.match(js, /renderReferenceManager/);
  assert.match(js, /replaceReference/);
  assert.match(js, /referenceReplaceEdgeId/);
  assert.match(css, /\.reference-manager/);
  assert.match(css, /\.reference-manager__close/);
  assert.match(css, /\.is-replacing/);
});

// 即梦入口必须在镜头页，因为它依赖当前镜头的视频任务、参考图顺序和提示词绑定。
test('shot page exposes Jimeng feed package controls', async () => {
  const html = await readFile(join(root, 'shot.html'), 'utf8');
  const js = await readFile(join(root, 'shot.js'), 'utf8');
  const css = await readFile(join(root, 'shot.css'), 'utf8');

  assert.match(html, /id="jimengFeedDialog"/);
  assert.match(html, /即梦投喂信息/);
  assert.match(html, /id="submitJimengAutomationButton"/);
  assert.match(html, /id="jimengAutomationStatus"/);
  assert.match(html, /id="copyJimengUploadList"/);
  assert.match(html, /id="startJimengAutomation"/);
  assert.match(html, /复制上传清单/);
  assert.match(html, /提交到即梦生成/);
  assert.match(html, /生成后通过「导入外部资源」回填/);
  assert.match(js, /\/api\/jimeng\/feed-package/);
  assert.match(js, /\/api\/jimeng\/automation\/start/);
  assert.match(js, /renderJimengFeedPackage/);
  assert.match(js, /renderJimengAutomationStatus/);
  assert.match(js, /formatJimengAutomationStatus/);
  assert.match(js, /buildJimengUploadChecklist/);
  assert.match(js, /startJimengAutomationRun/);
  assert.match(js, /托管的即梦窗口/);
  assert.match(js, /平时打开的 Chrome\/即梦标签可能仍是空输入框/);
  assert.match(js, /未绑定 @图片N/);
  assert.match(js, /navigator\.clipboard\.writeText/);
  assert.match(css, /\.jimeng-feed/);
  assert.match(css, /\.jimeng-feed__status\[data-tone="warning"\]/);
});
