import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('settings page exposes core sections and adapter slots', async () => {
  const html = await readFile(join(root, 'settings.html'), 'utf8');
  assert.match(html, /<title>[^<]*设置/);
  assert.match(html, /id="adapter-list"/);
  assert.match(html, /id="trashSummary"/);
  assert.match(html, /id="emptyTrashButton"/);
  assert.match(html, /trash\.html/);
  assert.match(html, /模型与授权/);
  assert.match(html, /存储管理/);
  assert.doesNotMatch(html, /AI 适配器与凭据/);
  assert.doesNotMatch(html, /episode-path/);
  assert.doesNotMatch(html, /drama-creator\.json 路径/);
  // imports its own JS and shared CSS
  assert.match(html, /shared\.css/);
  assert.match(html, /settings\.css/);
  assert.match(html, /settings\.js/);
});

test('settings.js fetches adapters and credentials on load', async () => {
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  assert.match(js, /\/api\/adapters/);
  assert.match(js, /\/api\/credentials/);
  assert.match(js, /\/api\/trash/);
  assert.match(js, /emptyTrash/);
  assert.doesNotMatch(js, /episodePath:\s*pathInput/);
  assert.doesNotMatch(js, /请先填写剧集/);
  // PUT/DELETE routes wired
  assert.match(js, /method:\s*['"]PUT['"]/);
  assert.match(js, /method:\s*['"]DELETE['"]/);
});

test('home page links to settings', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /settings\.html/);
});

// Phase 3 Task 5：保证设置页 OAuth 入口的关键 hook 在静态资产中存在。
// 通过 grep settings.js 找 OAuth 路径关键字，确保后续重构不悄悄丢掉登录入口。
test('settings.js wires up OAuth login hooks', async () => {
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  // /api/credentials/oauth/start 是后端 OAuth 启动路由
  assert.match(js, /\/api\/credentials\/oauth\/start/);
  // /api/credentials/oauth/status 是前端 polling 入口
  assert.match(js, /\/api\/credentials\/oauth\/status/);
  // 桌面端不能只依赖 window.open；必须通过 Tauri 壳打开订阅登录页，并在失败时给用户反馈。
  assert.match(js, /openOAuthAuthorizeUrl/);
  assert.match(js, /open_oauth_authorize_url/);
  assert.match(js, /正在打开登录页/);
  assert.match(js, /已打开订阅登录页面/);
  assert.doesNotMatch(js, /window\.open\(json\.authorizeUrl/);
  // 至少出现一次非技术化中文文案，避免被重构回内部适配器术语
  assert.match(js, /订阅授权/);
  assert.match(js, /当前支持 ChatGPT/);
});

// OAuth 合规说明需要默认收起，避免设置页出现大块常驻 Notice 说明。
test('settings keeps OAuth compliance copy in a collapsed disclosure', async () => {
  const css = await readFile(join(root, 'settings.css'), 'utf8');
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  assert.match(css, /\.oauth-toast\s*[\{,]/);
  assert.match(css, /\.codex-tos-banner/);
  assert.match(css, /\.codex-tos-banner summary/);
  assert.match(css, /\.codex-tos-banner__body/);
  assert.match(js, /document\.createElement\('details'\)/);
  assert.match(js, /合规说明/);
  assert.doesNotMatch(js, /使用须知 \/ Notice/);
});

// 设置页是用户配置 API Key / OAuth 的主入口；按钮、状态和表单必须在暗色主题下清晰可见。
test('settings page keeps credential controls visible and inline', async () => {
  const css = await readFile(join(root, 'settings.css'), 'utf8');
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  assert.match(css, /\.adapter-card__primary-btn/);
  assert.match(css, /\.adapter-card__status--missing/);
  assert.match(css, /\.credential-form__submit/);
  assert.match(css, /\.storage-card/);
  assert.match(css, /\.storage-card__actions/);
  assert.match(js, /openCredentialForm\(method\.adapter,\s*method\.credential,\s*card,\s*method\)/);
  assert.match(js, /card\.appendChild\(form\)/);
  assert.doesNotMatch(js, /list\.appendChild\(form\)/);
});

// 设置页面向非技术用户展示“模型类型”，内部 adapter id / 测试适配器只保留在系统实现里。
test('settings page presents model types and hides internal adapter wording', async () => {
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  const html = await readFile(join(root, 'settings.html'), 'utf8');
  assert.match(js, /文本模型/);
  assert.match(js, /图片模型/);
  assert.match(js, /视频模型/);
  assert.match(js, /音频模型/);
  assert.match(js, /订阅授权/);
  assert.match(js, /当前支持 ChatGPT/);
  assert.doesNotMatch(js, /label:\s*'ChatGPT 订阅'/);
  assert.match(html, /按文本、图片、视频、音频选择模型能力/);
  assert.match(html, /订阅授权或服务商 API Key/);
  assert.match(js, /API Key/);
  assert.match(js, /DeepSeek/);
  assert.match(js, /通义/);
  assert.match(js, /豆包/);
  assert.match(js, /Gemini/);
  assert.match(js, /Grok/);
  assert.match(js, /Ollama/);
  assert.match(js, /Claude/);
  assert.doesNotMatch(js, /Claude API Key/);
  assert.match(js, /火山方舟/);
  assert.match(js, /MiniMax/);
  assert.match(js, /API Key（GPT Image \/ Seedream \/ MiniMax）/);
  assert.match(js, /API Key（Seedance \/ MiniMax）/);
  assert.match(js, /adapterIds:\s*\['openai-compatible-image', 'minimax-media'\]/);
  assert.match(js, /adapterIds:\s*\['volcengine-ark-video', 'minimax-media'\]/);
  assert.match(js, /buildProviderOptions/);
  assert.match(js, /providerOptionValue/);
  assert.match(js, /服务商/);
  assert.match(js, /服务地址/);
  assert.match(js, /自定义/);
  assert.match(js, /CUSTOM_PROVIDER_VALUE/);
  assert.match(js, /请自行填写服务地址和 API Key/);
  assert.match(js, /获取 API Key/);
  assert.match(js, /查看接入文档/);
  assert.match(js, /buildModelSections/);
  assert.match(js, /showInSettings:\s*false/);
  assert.doesNotMatch(js, /Mock Echo（测试用）/);
  assert.doesNotMatch(js, /OpenAI 兼容文本/);
  assert.doesNotMatch(js, /OpenAI 兼容图片/);
  assert.doesNotMatch(js, /label:\s*'MiniMax',\s*adapterId:\s*'minimax-media'/);
  assert.doesNotMatch(js, /视频生成服务待接入/);
});

test('settings page can select default model channels and verify API connections', async () => {
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  const css = await readFile(join(root, 'settings.css'), 'utf8');
  assert.match(js, /\/api\/app-settings/);
  assert.match(js, /modelDefaults/);
  assert.match(js, /setDefaultModelChannel/);
  assert.match(js, /testModelConnection/);
  assert.match(js, /\/api\/model-connections\/test/);
  assert.match(js, /模型 ID/);
  assert.match(js, /shouldRenderModelSelect\(method\) \? '模型' : '模型 ID'/);
  assert.match(js, /const inputId = `model-default-/);
  assert.match(js, /select\.className = 'model-default-editor__select'/);
  assert.match(js, /readModelControlValue\(control\)/);
  assert.match(js, /input\.id = inputId/);
  assert.match(js, /input\.name = `modelId-/);
  assert.match(js, /input\.autocomplete = 'off'/);
  assert.match(js, /sel\.name = 'providerTemplate'/);
  assert.match(js, /defaultModelId/);
  assert.match(js, /templateForCredential/);
  assert.match(js, /设为默认/);
  assert.match(js, /测试连接/);
  assert.match(css, /\.model-default-editor/);
  assert.match(css, /\.credential-method__badge--default/);
});

test('settings page treats missing keychain secrets as stale credentials', async () => {
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  const css = await readFile(join(root, 'settings.css'), 'utf8');
  assert.match(js, /secretStatus !== 'missing'/);
  assert.match(js, /secretStatus === 'missing'/);
  assert.match(js, /默认待重配/);
  assert.match(js, /密钥不在系统钥匙串中/);
  assert.match(js, /需要重新配置 API Key|需要重新登录/);
  assert.match(js, /下一步：点击/);
  assert.match(js, /credential-method--stale/);
  assert.match(css, /\.credential-method--stale/);
  assert.match(css, /\.credential-method__next-step/);
});

test('settings page renders verified API Key model catalogs as a select with custom fallback', async () => {
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  const css = await readFile(join(root, 'settings.css'), 'utf8');
  assert.match(js, /const CUSTOM_MODEL_VALUE = '__custom_model__'/);
  assert.match(js, /function shouldRenderModelSelect\(method\)/);
  assert.match(js, /knownModelIds\(method\)\.length > 0/);
  assert.match(js, /method\.verification\?\.modelIds/);
  assert.match(js, /supportsCustomModelId\(method\)/);
  assert.match(js, /自定义模型 ID/);
  assert.match(js, /model-default-editor__custom-input/);
  assert.match(css, /\.model-default-editor__control/);
  assert.match(css, /\.model-default-editor__custom-input/);
});

test('settings page separates in-app generation from external handoff recommendations', async () => {
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  const css = await readFile(join(root, 'settings.css'), 'utf8');
  assert.match(js, /内置生成/);
  assert.match(js, /外部跳转/);
  assert.match(js, /默认推荐/);
  assert.match(js, /productionMode/);
  assert.match(js, /defaultRecommended/);
  assert.match(js, /导入外部资源/);
  assert.doesNotMatch(js, /renderProductionModeLegend/);
  assert.doesNotMatch(css, /\.production-mode-legend/);
});

test('settings page exposes Jimeng as a browser automation video channel without API Key fields', async () => {
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  const css = await readFile(join(root, 'settings.css'), 'utf8');
  assert.match(js, /即梦自动化/);
  assert.match(js, /即梦音频生成/);
  assert.match(js, /jimeng-browser-automation/);
  assert.match(js, /browser_automation/);
  assert.match(js, /isBrowserAutomationReady/);
  assert.match(js, /renderBrowserAutomationSummary/);
  assert.match(js, /renderModelDefaultSelect/);
  assert.match(js, /resolveModelDisplayLabel/);
  assert.match(js, /Seedance 2\.0 Fast/);
  assert.match(js, /model-default-editor__select/);
  assert.doesNotMatch(js, /input\.setAttribute\('list', listId\)/);
  assert.match(css, /\.model-default-editor__select/);
  assert.match(js, /应用托管/);
  assert.match(js, /可先生成投喂包人工操作/);
});

test('settings page exposes audio model defaults through Jimeng automation', async () => {
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  assert.match(js, /key:\s*'audio'/);
  assert.match(js, /title:\s*'音频模型'/);
  assert.match(js, /用于生成角色音色、旁白、台词和音效参考/);
  assert.match(js, /adapterId:\s*'jimeng-browser-automation'/);
  assert.match(js, /defaultRecommended:\s*true/);
});

test('settings page does not render duplicate default controls for one credential method', async () => {
  const js = await readFile(join(root, 'settings.js'), 'utf8');
  const duplicateDefaultControl = /appendDefaultChannelControl\(actions,\s*method\);\s*appendDefaultChannelControl\(actions,\s*method\);/;
  assert.doesNotMatch(js, duplicateDefaultControl);
});
