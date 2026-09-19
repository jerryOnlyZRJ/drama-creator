// 包体体积回归守卫（Phase 3 P3Q2 决策落地）。
//
// 衡量口径：仅 drama-creator/dist/ 下静态资源的总字节数（HTML/CSS/JS + 浏览器侧 ESM 模块）。
// 这部分是开发者通过写代码可直接影响的部分；Tauri 二进制 / 原生 WebView 不计入。
//
// 触发逻辑：超阈值 → 退出码 1（硬阻断）。CI 与本地共用同一脚本：
//   - GitHub Actions 在 PR/push 触发时跑 `npm run check:bundle-size`
//   - 开发者本地任意时刻可手动跑同一命令做提交前自检
//
// 调阈值的方式：改下面 BUNDLE_SIZE_LIMIT_BYTES 常量，强制让人意识到代价。

import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const distDir = join(projectRoot, 'dist');

// 360 KB 上限：覆盖 V1 PRD 已确认的工作台、公共资产详情、分镜筛选与设置/回收站页面。
// 这个阈值仍只允许轻量手写前端；后续若继续增长，必须先拆分页面或懒加载。
// 若需要调整，必须同步更新 docs/superpowers/specs/2026-06-10-open-source-redesign-design.md 第 9 节。
const BUNDLE_SIZE_LIMIT_BYTES = 360 * 1024;

// 1. 触发 build：保证丈量的是当前代码状态产出的真实 dist，而非缓存的旧版本。
const buildResult = spawnSync('node', ['scripts/build.mjs'], { cwd: projectRoot, stdio: 'inherit' });
if (buildResult.status !== 0) {
  console.error('[check-bundle-size] build failed; aborting size check.');
  process.exit(buildResult.status || 1);
}

// 2. 递归收集所有 dist/ 下文件的体积，按降序排序方便定位增长来源。
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      const { size } = await stat(full);
      files.push({ path: relative(distDir, full), size });
    }
  }
  return files;
}

const files = await walk(distDir);
files.sort((a, b) => b.size - a.size);
const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

// 3. 报告 + 硬阻断。
const formatKB = (bytes) => `${(bytes / 1024).toFixed(2)} KB`;
console.log(`\n[bundle size] dist total: ${formatKB(totalBytes)} / limit: ${formatKB(BUNDLE_SIZE_LIMIT_BYTES)}`);
console.log('[bundle size] top 10 files:');
for (const f of files.slice(0, 10)) {
  console.log(`  ${formatKB(f.size).padStart(10)}  ${f.path}`);
}

if (totalBytes > BUNDLE_SIZE_LIMIT_BYTES) {
  const overage = totalBytes - BUNDLE_SIZE_LIMIT_BYTES;
  console.error(`\n[bundle size] FAIL: dist exceeds limit by ${formatKB(overage)}.`);
  console.error('  - 若属于必要新增，请显式调高 BUNDLE_SIZE_LIMIT_BYTES 并同步更新设计文档。');
  console.error('  - 否则请瘦身（拆分懒加载 / 移除未使用模块 / 选用更轻的依赖）。');
  process.exit(1);
}

const headroom = BUNDLE_SIZE_LIMIT_BYTES - totalBytes;
console.log(`[bundle size] OK: ${formatKB(headroom)} headroom remaining.\n`);
