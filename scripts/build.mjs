import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { transform } from 'esbuild';

const root = process.cwd();
const dist = join(root, 'dist');
// 先清空 dist 再 build：避免历史遗留文件（旧版样式表 / 设计参考截图等）越攒越多，
// 也保证包体回归 CI 每次丈量的都是当前 build.mjs 真实产出的资源集合。
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 三层信息架构（L1 首页 / L2 项目详情 / L3 分镜画布）的静态资源全部写入 dist。
// 这里保留源文件可读性，但在 dist 侧做压缩，避免手写多页应用随着页面数增长持续顶爆包体阈值。
await copyHtmlAsset('index.html');
await copyCssAsset('shared.css');
await copyCssAsset('home.css');
await copyJsAsset('home.js');
await copyHtmlAsset('project.html');
await copyCssAsset('project.css');
await copyJsAsset('project.js');
await copyHtmlAsset('shot.html');
await copyCssAsset('shot.css');
await copyJsAsset('shot.js');
// Phase 2 设置页：凭据管理 UI，与三层主流程独立但共用 shared.css。
await copyHtmlAsset('settings.html');
await copyCssAsset('settings.css');
await copyJsAsset('settings.js');
// 回收站管理页独立于设置页，负责恢复与单项彻底删除。
await copyHtmlAsset('trash.html');
await copyCssAsset('trash.css');
await copyJsAsset('trash.js');

// 浏览器侧 ESM 模块只复制真实 import 链路需要的文件。
// 服务端专用模块（如 generateInput / videoVersions）不进入 dist，避免桌面包体被无关逻辑拖大。
await copyBrowserModule('src/feed/feedPackage.mjs');
await copyBrowserModule('src/checks/preFeedChecks.mjs');
await copyBrowserModule('src/layout/clusters.mjs');
await copyBrowserModule('src/workflow/scriptShots.mjs');
await copyBrowserModule('src/workflow/shotScripts.mjs');
await copyBrowserModule('src/workflow/storyboardDisplay.mjs');
await copyBrowserModule('src/workflow/promptReferences.mjs');
await copyBrowserModule('src/schema/dramaCreatorSchema.mjs');
await copyBrowserModule('src/prompting/bestPractices.mjs');
// 项目页导出预览会复用服务端 SRT 抽取规则，避免桌面包里预览和真实导出不一致。
await copyBrowserModule('src/export/subtitles.mjs');

console.log('Built static prototype into dist/');

async function copyBrowserModule(relativePath) {
  const target = join(dist, relativePath);
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(join(root, relativePath), 'utf8');
  // 浏览器侧 ESM 模块不做 bundle，只做语法保真的最小压缩；这样可以继续保留多页面按需加载结构。
  const result = await transform(source, { loader: 'js', minify: true, format: 'esm' });
  await writeFile(target, result.code, 'utf8');
}

async function copyJsAsset(relativePath) {
  const source = await readFile(join(root, relativePath), 'utf8');
  const result = await transform(source, { loader: 'js', minify: true, format: 'esm' });
  await writeFile(join(dist, relativePath), result.code, 'utf8');
}

async function copyCssAsset(relativePath) {
  const source = await readFile(join(root, relativePath), 'utf8');
  const result = await transform(source, { loader: 'css', minify: true });
  await writeFile(join(dist, relativePath), result.code, 'utf8');
}

async function copyHtmlAsset(relativePath) {
  const source = await readFile(join(root, relativePath), 'utf8');
  await writeFile(join(dist, relativePath), minifyHtml(source), 'utf8');
}

function minifyHtml(source) {
  // 当前页面都是静态模板，没有内联脚本；只做安全的空白折叠，避免引入 HTML 构建依赖。
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
