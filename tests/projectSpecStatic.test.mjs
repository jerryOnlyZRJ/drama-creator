import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('project rules keep drama-creator independent from source repos and creation skills', async () => {
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const spec = await readFile(join(root, 'docs/superpowers/specs/2026-06-10-open-source-redesign-design.md'), 'utf8');

  for (const text of [agents, readme, spec]) {
    assert.match(text, /独立应用/);
    assert.match(text, /~\/\.drama-creator/);
    assert.match(text, /注册.*workspace|workspace.*注册/);
  }

  assert.match(agents, /不要.*short-drama skill|short-drama skill.*不要/);
  assert.match(agents, /projects\/<projectKey>\/resources/);
  assert.match(spec, /用户选择\/注册的项目目录/);
});

test('project rules document Jimeng browser automation as an extension, not an API adapter', async () => {
  const adapterContract = await readFile(join(root, 'docs/adapter-contract.md'), 'utf8');
  const jimengDoc = await readFile(join(root, 'docs/jimeng-browser-automation.md'), 'utf8');

  for (const text of [adapterContract, jimengDoc]) {
    assert.match(text, /浏览器自动化扩展/);
    assert.match(text, /即梦/);
    assert.match(text, /Seedance 2\.0/);
    assert.match(text, /提交前.*确认|确认.*提交前/);
  }

  assert.match(jimengDoc, /不是.*API Key.*适配器|API Key.*适配器.*不是/);
  assert.match(jimengDoc, /应用托管浏览器 profile/);
  assert.match(jimengDoc, /不复用用户日常 Chrome/);
  assert.match(jimengDoc, /本地 CDP/);
  assert.match(jimengDoc, /manual_reference_binding_required/);
  assert.match(jimengDoc, /投喂包/);
});

test('adapter contract treats subscription as a provider-agnostic authorization method', async () => {
  const adapterContract = await readFile(join(root, 'docs/adapter-contract.md'), 'utf8');

  assert.match(adapterContract, /订阅授权.*通用授权方式/);
  assert.match(adapterContract, /不等同于某个具体模型服务商/);
  assert.match(adapterContract, /openai-codex-oauth/);
  assert.match(adapterContract, /不能把尚未接入的平台展示成可用能力/);
});

test('Jimeng handoff documents the verified pre-submit automation path', async () => {
  const jimengDoc = await readFile(join(root, 'docs/jimeng-browser-automation.md'), 'utf8');
  const skill = await readFile(join(root, '.agents/skills/drama-creator/SKILL.md'), 'utf8');

  // 用静态测试锁住产品的验收要求，防止后续把验收标准退化为一次性人工经验。
  for (const text of [jimengDoc, skill]) {
    assert.match(text, /稳定路径.*验收要求/);
    assert.match(text, /promptSanitization/);
    assert.match(text, /引用参考.*chip|chip.*引用参考/);
    assert.match(text, /raw `?@图片N`?.*0|raw.*0.*`?@图片N`?/);
    assert.match(text, /pre_submit_confirmation/);
    assert.match(text, /不自动点击生成按钮|不会自动点击生成按钮/);
  }

  assert.match(jimengDoc, /不反写项目里的原始提示词/);
  assert.match(jimengDoc, /生成后.*导入外部资源.*回填/);
});

test('public asset library documents selected asset detail editing', async () => {
  const prd = await readFile(join(root, 'docs/prd-drama-creator-redesign.md'), 'utf8');
  const design = await readFile(join(root, 'docs/design-liquid-glass-product-spec.md'), 'utf8');
  const closedLoop = await readFile(join(root, 'docs/v1-production-closed-loop.md'), 'utf8');
  const testPlan = await readFile(join(root, 'docs/test-plan-v1-core-acceptance.md'), 'utf8');
  const skill = await readFile(join(root, '.agents/skills/drama-creator/SKILL.md'), 'utf8');

  // 锁住公共资产库的详情编辑态，防止后续只保留资产列表而漏掉可编辑详情面板。
  assert.match(prd, /PRD-027A/);
  assert.match(prd, /PRD-027B/);

  for (const text of [prd, design, closedLoop, skill]) {
    assert.match(text, /资产详情|detail inspector/i);
    assert.match(text, /名称|name/i);
    assert.match(text, /分类|category/i);
    assert.match(text, /状态|status/i);
    assert.match(text, /提示词|prompt/i);
    assert.match(text, /引用资源|reference assets/i);
    assert.match(text, /标签|tags/i);
    assert.match(text, /关联分镜|linked shots/i);
    assert.match(text, /不复制|do not copy/i);
  }
});

test('shot video step avoids duplicate episode chip navigation when using a dropdown', async () => {
  const prd = await readFile(join(root, 'docs/prd-drama-creator-redesign.md'), 'utf8');
  const design = await readFile(join(root, 'docs/design-liquid-glass-product-spec.md'), 'utf8');
  const closedLoop = await readFile(join(root, 'docs/v1-production-closed-loop.md'), 'utf8');
  const testPlan = await readFile(join(root, 'docs/test-plan-v1-core-acceptance.md'), 'utf8');
  const skill = await readFile(join(root, '.agents/skills/drama-creator/SKILL.md'), 'utf8');

  // 锁住 Step 3 的分集导航去重：下拉选择和 chip/icon 列表不能同时出现。
  assert.match(prd, /PRD-030B/);
  for (const text of [prd, design, closedLoop, testPlan, skill]) {
    assert.match(text, /分镜视频|Step 3/i);
    assert.match(text, /下拉|dropdown/i);
    assert.match(text, /chip\/icon|chip|icon/i);
    assert.match(text, /不再展示|不出现|do not also show|避免同一页面出现两套导航/i);
    assert.match(text, /新建分集/);
    assert.match(text, /靠右|right-aligned/i);
  }
});

test('single shot canvas prototype is documented as a production workspace', async () => {
  const prd = await readFile(join(root, 'docs/prd-drama-creator-redesign.md'), 'utf8');
  const design = await readFile(join(root, 'docs/design-liquid-glass-product-spec.md'), 'utf8');
  const closedLoop = await readFile(join(root, 'docs/v1-production-closed-loop.md'), 'utf8');
  const testPlan = await readFile(join(root, 'docs/test-plan-v1-core-acceptance.md'), 'utf8');
  const skill = await readFile(join(root, '.agents/skills/drama-creator/SKILL.md'), 'utf8');

  // 锁住单分镜画布原型，防止后续把生产工作页退回调试图谱页。
  assert.match(prd, /PRD-040A/);

  for (const text of [prd, design, closedLoop, skill]) {
    assert.match(text, /单分镜画布|Shot canvas/i);
    assert.match(text, /生产工作页|production workspace/i);
    assert.match(text, /调试图谱|debug graph/i);
    assert.match(text, /剧本.*素材.*产物|script.*assets.*outputs/i);
    assert.match(text, /详情.*QC|detail.*QC/i);
    assert.match(text, /底部.*缩放|status.*zoom/i);
  }
});

test('text AI fallback includes settings navigation when subscription and API key are unavailable', async () => {
  const prd = await readFile(join(root, 'docs/prd-drama-creator-redesign.md'), 'utf8');
  const design = await readFile(join(root, 'docs/design-liquid-glass-product-spec.md'), 'utf8');
  const closedLoop = await readFile(join(root, 'docs/v1-production-closed-loop.md'), 'utf8');
  const adapterContract = await readFile(join(root, 'docs/adapter-contract.md'), 'utf8');
  const testPlan = await readFile(join(root, 'docs/test-plan-v1-core-acceptance.md'), 'utf8');
  const skill = await readFile(join(root, '.agents/skills/drama-creator/SKILL.md'), 'utf8');

  // 锁住文本 AI 的双通道兜底：订阅和 API Key 都不可用时，入口仍在原处，并给出设置页跳转和手动路径。
  for (const text of [prd, design, closedLoop, adapterContract, testPlan, skill]) {
    assert.match(text, /文本|text/i);
    assert.match(text, /订阅授权|subscription authorization/i);
    assert.match(text, /API Key/i);
    assert.match(text, /都不可用|both unavailable|neither.*available/i);
    assert.match(text, /去配置|配置页面|settings\.html|model setup/i);
    assert.match(text, /手动|manual/i);
  }
});

test('model authorization settings prototype is documented across product rules', async () => {
  const prd = await readFile(join(root, 'docs/prd-drama-creator-redesign.md'), 'utf8');
  const design = await readFile(join(root, 'docs/design-liquid-glass-product-spec.md'), 'utf8');
  const testPlan = await readFile(join(root, 'docs/test-plan-v1-core-acceptance.md'), 'utf8');
  const skill = await readFile(join(root, '.agents/skills/drama-creator/SKILL.md'), 'utf8');

  // 锁住模型与授权设置原型，防止后续实现退回按 adapter id 或服务商单独分组。
  assert.match(prd, /PRD-080A/);
  assert.match(prd, /PRD-087A/);
  assert.match(prd, /PRD-087B/);
  assert.match(prd, /PRD-087C/);

  for (const text of [prd, design, testPlan, skill]) {
    assert.match(text, /模型与授权|模型设置|Model settings/i);
    assert.match(text, /文本.*图片.*视频|text.*image.*video/i);
    assert.match(text, /订阅授权|subscription authorization/i);
    assert.match(text, /API Key/i);
    assert.match(text, /浏览器自动化|browser automation/i);
    assert.match(text, /手动外部生成.*(不是|不作为|不需要).*配置|Manual external generation.*not.*settings|not.*settings.*Manual external generation/i);
    assert.match(text, /兜底|fallback/i);
    assert.match(text, /自定义|custom/i);
    assert.match(text, /settings\.html#model-text/);
    assert.match(text, /配置指引|素材生产模式说明|OAuth Notice|production-mode legend|large OAuth notice/i);
    assert.match(text, /合规说明.*默认收起|collapsed.*compliance/i);
  }
});

// 公开文档仍需覆盖各产品阶段，但不得通过内嵌图或图片链接携带私有作品。
test('public PRD retains product requirements without private prototype images', async () => {
  const prd = await readFile(join(root, 'docs/prd-drama-creator-redesign.md'), 'utf8');
  assert.doesNotMatch(prd, /data:image\/|!\[|assets\/prd-redesign\//);
  for (const requirement of ['PRD-027A', 'PRD-030B', 'PRD-040A', 'PRD-080A', 'PRD-090A', 'PRD-100', 'PRD-101']) {
    assert.ok(prd.includes(requirement), requirement);
  }
});

test('trash and deletion prototype is documented as a global recovery page', async () => {
  const prd = await readFile(join(root, 'docs/prd-drama-creator-redesign.md'), 'utf8');
  const design = await readFile(join(root, 'docs/design-liquid-glass-product-spec.md'), 'utf8');
  const testPlan = await readFile(join(root, 'docs/test-plan-v1-core-acceptance.md'), 'utf8');
  const skill = await readFile(join(root, '.agents/skills/drama-creator/SKILL.md'), 'utf8');

  // 锁住回收站与删除原型，防止后续把恢复/永久删除/清空确认退回零散入口。
  assert.match(prd, /PRD-090A/);

  for (const text of [prd, design, testPlan, skill]) {
    assert.match(text, /回收站与删除|Trash/i);
    assert.match(text, /全局|global/i);
    assert.match(text, /空间概览|可释放空间|space summary|releasable space/i);
    assert.match(text, /搜索|search/i);
    assert.match(text, /类型筛选|type filter/i);
    assert.match(text, /恢复|restore/i);
    assert.match(text, /永久删除|permanent delete/i);
    assert.match(text, /清空回收站|clear-trash|empty trash/i);
    assert.match(text, /二次确认|confirmation/i);
    assert.match(text, /完整文件目录|绝对路径|absolute.*path/i);
  }
});

test('non-technical copy requirements apply to the whole app, not only settings', async () => {
  const prd = await readFile(join(root, 'docs/prd-drama-creator-redesign.md'), 'utf8');
  const design = await readFile(join(root, 'docs/design-liquid-glass-product-spec.md'), 'utf8');
  const testPlan = await readFile(join(root, 'docs/test-plan-v1-core-acceptance.md'), 'utf8');
  const skill = await readFile(join(root, '.agents/skills/drama-creator/SKILL.md'), 'utf8');

  // 锁住全局文案规则，避免后续只在模型设置页做非技术化处理。
  assert.match(prd, /PRD-100/);
  for (const text of [prd, design, testPlan, skill]) {
    assert.match(text, /全应用|所有页面|whole app|across the whole app/i);
    assert.match(text, /按钮.*输入框.*说明文案|buttons.*inputs.*descriptions/i);
    assert.match(text, /状态提示.*错误提示|status messages.*error messages/i);
    assert.match(text, /非技术用户|non-technical/i);
    assert.match(text, /项目库.*项目工作台.*公共资产.*分镜视频.*单分镜画布.*模型设置.*回收站.*导出|project library.*project workflow.*public assets.*shot videos.*shot canvas.*settings.*trash.*export/i);
    for (const term of ['adapter', 'schema', 'JSON', 'CDP', 'localhost']) {
      assert.match(text, new RegExp(term, 'i'));
    }
    assert.match(text, /高级.*排障|advanced.*debug/i);
  }
});

test('production workbench does not use standalone operation-guide modules', async () => {
  const prd = await readFile(join(root, 'docs/prd-drama-creator-redesign.md'), 'utf8');
  const design = await readFile(join(root, 'docs/design-liquid-glass-product-spec.md'), 'utf8');
  const closedLoop = await readFile(join(root, 'docs/v1-production-closed-loop.md'), 'utf8');
  const testPlan = await readFile(join(root, 'docs/test-plan-v1-core-acceptance.md'), 'utf8');
  const skill = await readFile(join(root, '.agents/skills/drama-creator/SKILL.md'), 'utf8');
  const projectHtml = await readFile(join(root, 'project.html'), 'utf8');
  const projectJs = await readFile(join(root, 'project.js'), 'utf8');
  const projectCss = await readFile(join(root, 'project.css'), 'utf8');

  // 锁住生产级工作台边界：流程感来自真实工作区和状态，不把教程卡片当作模块常驻。
  assert.match(prd, /PRD-101/);
  for (const text of [prd, design, closedLoop, testPlan, skill]) {
    assert.match(text, /操作指引|operation-guide|tutorial|creator-coach|创作教练/i);
    assert.match(text, /就地|inline|空状态|empty states?|状态角标|badges?/i);
    assert.match(text, /默认收起|collapsed|帮助入口|help entry/i);
  }

  assert.doesNotMatch(design, /right coach panel/i);
  for (const text of [projectHtml, projectJs, projectCss]) {
    assert.doesNotMatch(text, /创作指引|小贴士|操作指引|creator-coach|coach panel|right coach panel/i);
  }
});
