# Drama Creator V1 核心流程验收测试方案

版本：v0.1
日期：2026-06-14
状态：供后续开发完成后执行
范围：覆盖 `docs/prd-drama-creator-redesign.md` 第 13 节验收清单 1-25 项，以及 `docs/v1-production-closed-loop.md` 定义的 V1 生产闭环。

## 1. 依据与边界

本方案基于以下文件：

- `AGENTS.md`
- `README.md`
- `docs/prd-drama-creator-redesign.md`
- `docs/v1-production-closed-loop.md`
- `docs/adapter-contract.md`
- `docs/prompt-best-practices.md`
- `docs/jimeng-browser-automation.md`
- `.agents/skills/drama-creator/SKILL.md`
- `tests/*.test.mjs` 当前测试命名和覆盖范围

执行边界：

- 本阶段只产出测试方案，不创建测试代码，不修改业务实现。
- 后续自动化测试继续使用现有 Node test runner 风格：`tests/<domain>.test.mjs`，`node:test` + `node:assert/strict`。
- API 自动化必须使用临时目录和注入的 `appWorkspaceDir` / `allowedEpisodeRoots`，不能污染用户真实 `~/.drama-creator/`。
- 即梦验收必须使用 Drama Creator 启动的应用托管浏览器 profile：`~/.drama-creator/browser-profiles/jimeng/`。Codex Browser、Chrome DevTools MCP、用户日常 Chrome 登录态都不能作为产品验收依据。
- V1 不自动等待即梦生成完成、不自动下载、不自动回填。即梦生成后的视频下载必须由用户手动完成，再通过应用导入。
- 全应用按钮、输入框、说明文案、状态提示、错误提示和空状态都必须面向非技术用户；项目库、项目工作台、公共资产、分镜视频、单分镜画布、模型设置、回收站、导出都要验证主流程不暴露 `adapter`、`schema`、`JSON`、`CDP`、`localhost`、绝对路径等工程术语，技术详情只能出现在默认收起的高级/排障区域。
- 主工作区不得把操作指引、教程、小贴士或创作教练作为独立常驻模块；测试需要确认流程说明已收敛为 step 状态、就地短提示、空状态、确认弹窗或默认收起帮助。
- 所有 AI 相关入口在未配置模型、未授权或自动化不可用时仍必须可见；测试需要同时验证配置引导和手动替代路径。用户没有保存默认文本模型时，文本能力按订阅授权、API Key 顺序兜底；用户保存默认文本模型后，测试必须确认生成只使用该模型，失败时提示该模型不可用，不得静默切换到其他服务商。两者都不可用时，剧本生成和分镜拆分入口必须有“去配置”按钮跳转 `settings.html`，并保留手动操作。
- 模型与授权设置必须对齐 本文对应页面的文字要求：按文本、图片、视频、音频能力分组，并在每组内只聚类订阅授权、API Key、浏览器自动化等需要配置或执行的方式；API Key 服务商预设必须保留自定义选项；手动外部生成后导入是所有方式不可用或失败后的业务兜底，不作为设置页配置项；业务页“去配置”按钮需要跳转到对应能力锚点，例如 `settings.html#model-text`；不得出现常驻“配置指引”“素材生产模式说明”或大块 Notice 模块，合规说明默认收起。
- 回收站与删除页面必须对齐 本文对应页面的文字要求：作为全局页面展示空间概览、搜索、类型筛选、恢复、单项永久删除、右侧详情和清空回收站页内二次确认；主流程不展示完整文件目录，也不依赖原生 `window.confirm`。

## 2. 当前测试基线

现有测试总体分为 6 类：

| 类别 | 已有代表文件 | 当前可复用范围 |
|---|---|---|
| 静态 UI / 打包检查 | `tests/workbenchSmoke.test.mjs`, `tests/settingsStatic.test.mjs`, `tests/manualAssetImportStatic.test.mjs`, `tests/qcEditorStatic.test.mjs`, `tests/trashStatic.test.mjs`, `tests/tauriStatic.test.mjs` | 检查页面入口、控件 ID、危险 HTML sink、构建脚本、Tauri shell 基本约束 |
| API 流程 | `tests/projectsApi.test.mjs`, `tests/manualAssetImportApi.test.mjs`, `tests/episodeReferencesApi.test.mjs`, `tests/libraryApi.test.mjs`, `tests/exportApi.test.mjs`, `tests/deleteApi.test.mjs`, `tests/serverApi.test.mjs`, `tests/assetApi.test.mjs` | 项目创建、分集、资产导入、引用、导出、删除、回收站、资源代理和路径安全 |
| 剧本 / 分镜 / prompt | `tests/scriptShotsWorkflow.test.mjs`, `tests/promptBestPractices.test.mjs`, `tests/generateInput.test.mjs`, `tests/preFeedChecks.test.mjs` | 故事源到剧本草稿、分镜拆分、内置提示词最佳实践、投喂前检查 |
| 适配器 / 设置 / 凭据 | `tests/adapterRegistry.test.mjs`, `tests/adapterExecutor.test.mjs`, `tests/generateApi.test.mjs`, `tests/credentialApi.test.mjs`, `tests/modelConnectionApi.test.mjs`, `tests/keychain.test.mjs`, `tests/oauth*.test.mjs` | 内置生成、外部 handoff、API Key/OAuth/keychain、安全注入 |
| 即梦投喂与托管自动化 | `tests/jimengFeedPackage.test.mjs`, `tests/jimengFeedPackageApi.test.mjs`, `tests/jimengScriptExecutor.test.mjs`, `tests/jimengPageAutomation.test.mjs` | 投喂包、运行记录、托管 profile、CDP 连接、登录/绑定/提交前门禁状态模拟 |
| 导出 / 回收站 | `tests/exportApi.test.mjs`, `tests/deleteApi.test.mjs`, `tests/trashStatic.test.mjs` | fake ffmpeg 导出、项目级路径解析、字幕烧录失败降级、资源删除/恢复/永久删除 |

建议把 V1 验收测试分成两层：

- L1 自动化回归：`npm test` 必须覆盖不依赖真实外部平台的功能。
- L2 目检验收：浏览器本地 UI、打包桌面端、即梦托管窗口、用户手动下载/回填。

## 3. 自动化状态分类

| 状态 | 含义 | 后续执行方式 |
|---|---|---|
| 现可自动化 | 现有模块或 API 已足以写成稳定测试，且不依赖真实即梦登录或真实模型额度。 | 可在开发开始前作为 TDD 失败测试，也可在开发完成后补齐为绿色回归。 |
| 等开发完成 | 需要最终 UI、状态字段、API 语义或桌面打包能力稳定后才能执行为绿色。 | 可先记录推荐测试文件名，开发完成后补实现。 |
| 需用户登录即梦 | 必须由用户在 Drama Creator 托管窗口完成登录，并在真实即梦页面上目检。 | 不能用 Agent 浏览器或日常 Chrome 替代。 |
| 需用户手动下载 | 即梦生成完成后的下载动作必须由用户完成。 | 自动化只能覆盖导入回填 API 和 UI，不覆盖外部平台下载。 |

## 4. PRD 验收清单 1-25 映射

| # | PRD 验收动作 | API / 自动化测试 | 静态测试 | 浏览器目检 | 桌面端目检 | 即梦托管窗口 / 人工门禁 | 状态 |
|---:|---|---|---|---|---|---|---|
| 1 | 打开桌面应用进入项目库 | `tests/tauriStatic.test.mjs` 覆盖 sidecar 启动约束；后续可增加 packaged app smoke 记录 | `tests/workbenchSmoke.test.mjs` 检查首页只保留 V1 项目库入口 | `npm run dev` 后打开 `/`，确认首屏是项目库 | 安装 `.app` 后确认无需 Node 即进入项目库 | 无 | 等开发完成桌面包后执行 |
| 2 | 新建项目，默认进入第 1 集 | `tests/projectsApi.test.mjs` 已覆盖 `POST /api/projects/create` 创建 `ep001`，并覆盖 `idea_text` 来源元数据 | `tests/workbenchSmoke.test.mjs` 检查新建项目控件、从想法开始入口和无目录选择主流程 | 浏览器走新建项目向导，确认一句想法可生成完整故事后进入项目工作台和第 1 集 chip | 桌面端重复同路径，确认写入应用工作空间 | 无 | 现可自动化，桌面目检等包 |
| 3 | 粘贴故事源或导入本地文本 | 建议扩展 `tests/projectsApi.test.mjs` 或新增 `tests/v1CoreFlowApi.test.mjs`，断言 `storySources` 保存粘贴文本和本地文本导入结果 | `tests/workbenchSmoke.test.mjs` 已检查 Step 1 的作品元数据 + 故事源、分镜剧本两卡片对照工作台，并检查桌面两栏、同高工作区、内部滚动、`storySourceEditor`、`storySourceFile`、`FileReader` | 浏览器粘贴一段故事、导入 `.txt`，刷新后仍存在 | 桌面端用系统文件选择器导入 `.txt` | 无 | 粘贴现可自动化；桌面文件选择等开发完成 |
| 4 | 未配置 AI 时入口仍可见并引导配置或手动操作 | `tests/storyGenerationApi.test.mjs` 覆盖从想法生成故事、生成剧本草稿在未配置文本模型时返回 `settings.html#model-text` 和手动兜底；`tests/libraryApi.test.mjs` 覆盖公共资产页可在不依赖文本模型的情况下从已保存剧本生成候选，空剧本时给出明确保存剧本提示；后续可扩展视频生成入口 | 静态检查“需配置/当前不可用”“去配置”“继续手动/导入外部资源”等文案；`tests/workbenchSmoke.test.mjs` 覆盖公共资产页“从剧本生成公共资产”入口 | 浏览器清空模型配置后检查 Step 1、公共资产、分镜画布仍有 AI 入口和手动路径 | 桌面端同测，关注非技术用户可理解性 | 无 | 文本入口和公共资产生成入口已覆盖；其余入口持续补齐 |
| 5 | 生成或手动编辑结构化剧本 | `tests/storyGenerationApi.test.mjs` 覆盖 `POST /api/script-draft/generate` 可通过 API Key 文本模型生成剧本草稿；`tests/scriptShotsWorkflow.test.mjs` 后续扩展结构化字段：`dialogue`、`narration`、`action`、`scene_heading`、`on_screen_text` | `tests/workbenchSmoke.test.mjs` 检查剧本草稿编辑、保存按钮、文本模型生成入口和配置链接 | 浏览器生成/手动编辑剧本，确认字段可见且不是一整段 Markdown | 桌面端同测，关注非技术文案 | 无 | 文本生成链路已自动化；结构化字段仍待开发 |
| 6 | 确认剧本 | 建议 `tests/scriptDraftApi.test.mjs` 断言只有确认版进入分镜拆分输入，且只保留当前版和上一版 | 静态检查确认/恢复按钮与不可拆分空剧本提示 | 浏览器确认剧本后再拆分；未确认时拆分按钮应禁用或提示 | 桌面端同测 | 无 | 等开发完成确认语义 |
| 7 | 拆分并确认分镜 | `tests/scriptShotsWorkflow.test.mjs` 已覆盖拆分基础、每镜 `durationSec <= 15`、每个分镜携带 `scriptText` 并对应 `script_segment` 节点；同时覆盖旧分镜缺少剧本时可从视频提示词补齐；后续需补确认版和上一版 | `tests/workbenchSmoke.test.mjs` 检查分镜列表、分镜剧本片段、拆分按钮，以及手动拆分入口的“每个分镜默认不超过 15 秒”强提示 | 浏览器确认分镜后进入公共资产，确认每个分镜都能看到对应剧本片段，回滚上一版可用 | 桌面端同测 | 无 | 现可自动化字段；确认/回滚等开发完成 |
| 8 | 公共资产库看到角色、场景、道具等候选资产 | `tests/scriptShotsWorkflow.test.mjs` 覆盖从已保存剧本直接提取角色、场景、道具候选且不拆分镜头，并要求候选资产带可编辑提示词和引用资源列表；`tests/libraryApi.test.mjs` 覆盖 `POST /api/library/generate-from-script` 写回分集文档；`GET /api/library` 已覆盖公共资产分类 | `tests/workbenchSmoke.test.mjs` 检查 tabs、搜索、候选卡片容器、资产详情 inspector、“从剧本生成公共资产”入口，并确认公共资产 step 不展示“已绑定 / 未绑定”等状态标签 | 浏览器进入公共资产 step，点击“从剧本生成公共资产”，确认角色/场景/道具候选来自已保存剧本；顶部不出现分集 list；点击资产后右侧展示详情并可编辑名称、分类、状态、必需性、描述、提示词、引用资源、标签、关联分镜、参考用途和素材来源 | 桌面端同测 | 无 | API 与静态入口已自动化；仍需桌面目检 |
| 9 | 搜索公共资产 | 建议扩展 `tests/libraryApi.test.mjs` 或新增 `tests/publicAssetLibraryApi.test.mjs` 覆盖标题、标签、备注、提示词、引用资源、关联分镜编号搜索，以及类型 tabs 分类结果 | `tests/publicAssetLibraryStatic.test.mjs` 检查 tabs、搜索框，并确认不出现“已绑定 / 未绑定”等状态标签 | 浏览器分别搜索角色名、标签、提示词关键词、引用资源和分镜号，切换类型 tabs | 桌面端同测，确认控件不遮挡 | 无 | 等开发完成 |
| 10 | 分镜视频 step 看到分镜卡片和状态角标 | 建议新增 `tests/shotVideosStatic.test.mjs` 或扩展 `tests/workbenchSmoke.test.mjs`，检查卡片网格而非任务表格、状态枚举文案齐全、分集下拉存在且不出现 ep001/ep002 分集 chip/icon 列表，并检查剧本未确认/未拆分时的“返回剧本与分镜”兜底卡片 | `tests/workbenchSmoke.test.mjs` 已有 step 基础入口，可扩展状态角标、分集入口去重与前置兜底；主界面状态角标应收敛为未生成、准备投喂、处理中、待质检、需重跑、已通过 | 浏览器切到分镜视频 step：无分镜时看到兜底卡；有分镜时卡片包含缩略图/编号/标题/比例/时长/当前版本/状态；分集入口只有下拉和靠右的新建分集按钮 | 桌面端同测 | 无 | 等开发完成状态 UI |
| 11 | 打开某个分镜画布 | `tests/serverApi.test.mjs` / `tests/assetApi.test.mjs` 保证数据和资源可读 | `tests/workbenchSmoke.test.mjs` 已检查 `shot.html` 画布、inspector、前后镜头入口 | 浏览器点击分镜卡片进入 `/shot.html`，确认只显示目标分镜上下文 | 桌面端同测 | 无 | 现可自动化，UI 目检等开发完成 |
| 12 | 添加或引用参考资源 | `tests/manualAssetImportApi.test.mjs` 已覆盖导入图片/视频；`tests/episodeReferencesApi.test.mjs` 已覆盖引用、排序、替换、移除且不复制公共资产；`tests/promptReferences.test.mjs` 覆盖阅读态资源名展示且不改写原始 `@图片N` | `tests/manualAssetImportStatic.test.mjs` 已检查导入与引用管理控件；`tests/workbenchSmoke.test.mjs` 检查提示词区“编辑提示词”“引用资源”按钮和“上传顺序”文案 | 浏览器导入图片、引用公共资产、调整顺序，确认上传顺序变化，且提示词可编辑保存，阅读态显示资源名而不是仅显示 `@图片N` 占位 | 桌面端同测，确认本地文件选择器可用 | 无 | 现可自动化；桌面文件选择等包 |
| 13 | 生成即梦投喂包 | `tests/jimengFeedPackage.test.mjs`、`tests/jimengFeedPackageApi.test.mjs` 已覆盖投喂包、项目级即梦空间、单镜头 prompt、清理转场元信息、参考图顺序 | `tests/manualAssetImportStatic.test.mjs` 已检查投喂包控件，可补复制提示词/上传清单/JSON 按钮 | 浏览器点击生成投喂包，复制三类内容并核对空间、路径、参数和门禁 | 桌面端同测 | 无 | 现可自动化 |
| 14 | 打开 Drama Creator 托管即梦窗口 | `tests/jimengScriptExecutor.test.mjs` 已覆盖托管 profile、run package、CDP 端口复用、陈旧锁清理、缺失参考图拦截 | 静态检查设置页把即梦展示为浏览器自动化视频通道而非 API Key | 浏览器本地 UI 只能检查按钮触发 API，不可作为真实即梦登录证据 | 桌面端点击启动，确认打开应用托管窗口 | 首次需用户在托管窗口登录即梦；必须确认 profile 位于 `~/.drama-creator/browser-profiles/jimeng/` | 需用户登录即梦 |
| 15 | 自动化到达提交前确认点，或明确停在人工处理门禁 | `tests/jimengPageAutomation.test.mjs` 已覆盖 `login_required`、项目级即梦空间设置门禁、`manual_reference_binding_required`、`pre_submit_confirmation`、raw `@图片N` 不能提交；后续补真实状态落盘断言 | 无 | 本地 UI 显示自动化结果和可理解说明 | 桌面端托管窗口验证即梦空间、工作区、比例、时长、上传参考、chip 数量、raw `@图片N=0` 或明确人工门禁 | 用户必须目检真实即梦页面；自动化不得点击生成按钮 | 需用户登录即梦 |
| 16 | 用户从即梦下载视频后，通过导入外部资源回填分镜 | `tests/manualAssetImportApi.test.mjs` 已覆盖视频导入并绑定到 video task；建议新增 `tests/shotVideoVersionsApi.test.mjs` 断言默认进入候选版本 | 静态检查导入外部资源按钮和候选版本 UI | 浏览器用本地 mp4 模拟导入，确认候选版本出现 | 桌面端从 Finder 选择用户下载的 mp4 | 即梦下载必须用户手动完成，自动化不覆盖下载 | 需用户手动下载 |
| 17 | 视频资源卡可播放 | `tests/assetApi.test.mjs` 覆盖允许媒体代理；后续浏览器测试可用小 mp4 fixture 检查 `<video>` source 可加载 | `tests/workbenchSmoke.test.mjs` 已检查 `document.createElement('video')` 和 `controls=true` | 浏览器播放导入的视频，确认控制条、时长、不卡死 | 桌面端播放同一个 mp4 | 无 | 静态现可自动化；真实播放需目检 |
| 17A | 音频参考不会重复播放，且卡片有音频视觉封面 | `tests/assetApi.test.mjs` 覆盖允许音频代理；后续可补浏览器级 fixture 检查 `play` 事件互斥 | `tests/workbenchSmoke.test.mjs` 已检查公共资产页和分镜画布注册音频互斥播放管理，并检查公共资产音频卡片/详情使用音频封面样式 | 浏览器在公共资产页连续播放两个音频，确认第一个被暂停；同时确认音频卡片和右侧详情不是通用占位块 | 桌面端同测，确认暂停按钮能停止当前音频，反复点击不会叠加多路声音，音频资源显示为声纹/波形封面 | 无 | 静态现可自动化；真实播放需目检 |
| 18 | 将候选视频设为当前版本 | 建议新增 `tests/shotVideoVersionsApi.test.mjs` 覆盖最多保留当前+候选、候选设当前、旧当前退候选、新候选覆盖旧候选 | 建议 `tests/shotVideosStatic.test.mjs` 检查设为当前按钮和当前/候选标签 | 浏览器点击设为当前，回到分镜卡片确认当前版本更新 | 桌面端同测 | 无 | 等开发完成版本语义 |
| 19 | 保存 QC | 建议扩展 `tests/qcEditorStatic.test.mjs` 并新增 `tests/shotQcApi.test.mjs`，断言状态 `pending_review` / `rerun_required` / `approved` 与备注保存 | `tests/qcEditorStatic.test.mjs` 已检查 QC 控件和 JSON PATCH 安全 | 浏览器保存待质检、需重跑、已通过三种状态和备注 | 桌面端同测 | 无 | 静态现可自动化；完整 API 等开发完成 |
| 20 | 进入成片导出 step | `tests/workbenchSmoke.test.mjs` 已检查导出独立 step、分镜顺序、分镜拼接预览入口、字幕预览、导出设置、结果列表、进度/取消控件，以及主流程不暴露英文模块名或工程术语 | 已覆盖导出页结构与非技术中文文案 | 浏览器点击成片导出 step，确认分镜顺序、分镜拼接预览、字幕预览、导出设置、导出结果区域 | 桌面端同测 | 无 | 现可自动化 |
| 21 | 缺失视频时导出被阻塞 | `tests/exportApi.test.mjs` 已覆盖缺失当前视频返回 409，错误文案为中文创作者提示，且不暴露 `Missing videos` 等英文工程错误 | 静态检查缺失视频提示区域 | 浏览器删除/不设置某镜当前视频后点击导出，确认阻塞且说明缺失镜头 | 桌面端同测 | 无 | API 现可自动化 |
| 21A | 缺失视频时仍可生成分镜拼接预览 | `tests/exportApi.test.mjs` 已覆盖 `/api/export/preview` 只拼接可用视频、保留正式导出阻塞、局部精选剪辑作为已固化时间线片段替换对应分镜区间，并能只读恢复已有预览 | `tests/workbenchSmoke.test.mjs` 已检查预览按钮、状态、播放器样式和已有预览恢复逻辑 | 浏览器点击“生成分镜拼接预览”，确认播放器出现且缺失分镜不进入预览；刷新后确认已生成预览仍可播放 | 桌面端同测 | 无 | API/静态现可自动化；真实播放需目检 |
| 22 | 所有分镜有视频后，导出原片、烧录字幕版和 SRT | `tests/exportApi.test.mjs` 已覆盖 fake ffmpeg 原片/字幕版/SRT、项目级路径解析、字幕滤镜缺失 warning、QC 全通过正式版命名、未质检/需重跑草稿版命名；`tests/shotVideoVersionsApi.test.mjs` 已覆盖旧数据空 current 可导出、候选版本不可直接导出；统一转码参数由导出模块固定 | 静态检查导出结果列表和 warning 展示 | 浏览器导出后确认 3 个文件路径、warning、字幕内容 | 桌面端用打包内置 ffmpeg 导出并播放 mp4 | 如视频来自即梦，下载仍为用户手动前置动作 | API 现可自动化；内置 ffmpeg 桌面验证等包 |
| 23 | 删除一个资源后可在回收站看到 | `tests/deleteApi.test.mjs` 已覆盖资源删除移动到 trash、公共资产删除移动到 trash、被分镜引用的公共资产禁止删除，以及分镜资源删除清理图谱引用 | `tests/trashStatic.test.mjs` 已检查回收站列表、筛选、恢复和永久删除入口；`tests/workbenchSmoke.test.mjs` 检查公共资产详情删除按钮和二次确认 | 浏览器在公共资产详情或分镜画布删除资源，再打开回收站看到条目、路径、大小、删除时间；被分镜引用的公共资产应提示先移除引用 | 桌面端同测 | 无 | 现可自动化，UI细节等开发完成 |
| 24 | 从回收站恢复资源 | `tests/deleteApi.test.mjs` 已覆盖资源文件和图谱快照恢复；需补恢复冲突行为 | `tests/trashStatic.test.mjs` 检查恢复按钮 | 浏览器恢复资源，回到原分镜确认资源和引用尽量恢复 | 桌面端同测 | 无 | 现可自动化，冲突场景等开发完成 |
| 25 | 从回收站永久删除资源并释放空间 | `tests/deleteApi.test.mjs` 已覆盖单项永久删除；建议补释放空间数字变化和二次确认 | `tests/trashStatic.test.mjs` 检查永久删除、清空、预计释放空间和二次确认文案 | 浏览器永久删除，确认列表消失、空间统计减少、不能恢复 | 桌面端同测，并清理验收项目产生的垃圾 | 无 | 现可自动化部分；空间统计等开发完成 |

## 5. 推荐新增或修改的测试文件

当前阶段不要创建这些测试代码；以下是开发完成后建议落地的文件和范围。

### 5.1 建议修改现有测试

| 文件 | 建议补充 |
|---|---|
| `tests/workbenchSmoke.test.mjs` | 拆清 L1/L2/L3/L4 页面静态断言：4-step、无旧导入入口、公共资产库 tabs、分镜卡片角标、导出独立 step、视频播放控件、AI 入口未配置状态 |
| `tests/projectSpecStatic.test.mjs` | 守住 PRD、设计规范、测试计划和项目 skill 的全局非技术文案要求，避免把该要求误收敛到设置页 |
| `tests/projectsApi.test.mjs` | 强化新建项目默认 `ep001`、`project.json`、`workflow.currentStep`、默认第 1 集、故事源保存，以及“从想法开始”的原始想法元数据 |
| `tests/storyGenerationApi.test.mjs` | 覆盖一句想法调用文本模型生成完整故事；无文本模型时返回配置入口和手动补写兜底 |
| `tests/scriptShotsWorkflow.test.mjs` | 覆盖结构化剧本字段、确认版/上一版、分镜字段、`durationSec <= 15`、资产依赖候选 |
| `tests/libraryApi.test.mjs` | 覆盖公共资产分类、搜索、必需资产阻塞关联分镜而非全局阻塞 |
| `tests/manualAssetImportApi.test.mjs` | 覆盖视频导入默认进入候选版本，图片/视频/音频/文本的类型校验和错误提示 |
| `tests/episodeReferencesApi.test.mjs` | 覆盖引用边顺序稳定映射到 Jimeng `@图片N`，移除引用不删除公共资产 |
| `tests/jimengFeedPackage.test.mjs` | 覆盖上传清单文案、`promptGuidance`、gates、warnings、prompt sanitization 不反写源项目 |
| `tests/jimengScriptExecutor.test.mjs` | 补 run `state.json` 对真实门禁状态的记录，确保缺失参考图时不启动浏览器 |
| `tests/jimengPageAutomation.test.mjs` | 补真实 chip 顺序校验失败、manual settings/upload gate、永不自动点击生成按钮的回归 |
| `tests/exportApi.test.mjs` | 已覆盖缺失视频阻塞、未质检/需重跑草稿导出、QC 全通过正式导出、导出命名、项目级路径解析、字幕烧录失败降级；后续可继续细化统一转码参数断言 |
| `tests/deleteApi.test.mjs` | 已覆盖公共资产文件删除、引用保护、分镜资源删除、资源恢复；后续补恢复冲突、永久删除释放空间 |
| `tests/settingsStatic.test.mjs` | 强化非技术文案、按文本/图片/视频能力分组、订阅授权/API Key/浏览器自动化分组，检查手动外部生成只作为失败兜底和导入回填路径，并检查模型与授权设置原型引用和 `#model-text` 等能力锚点 |
| `tests/tauriStatic.test.mjs` | 强化 sidecar、loopback、无 Node 前置依赖、打包资源包含浏览器侧 ESM 和 ffmpeg 的静态检查 |

### 5.2 建议新增测试

| 新文件 | 类型 | 目的 |
|---|---|---|
| `tests/v1CoreFlowApi.test.mjs` | API 集成 | 在临时 app workspace 内跑“新建项目 → 保存故事源 → 生成/保存分镜剧本 → 资产候选 → 分镜状态”的核心数据闭环 |
| `tests/aiFallbackStatic.test.mjs` | 静态 | 覆盖无模型配置时 AI 入口仍可见、显示配置引导，并在同一上下文提供手动编辑、复制投喂信息、导入回填等替代路径 |
| `tests/scriptDraftApi.test.mjs` | API / 单元 | 覆盖剧本确认、恢复上一版、未确认剧本不能作为拆分默认输入 |
| `tests/publicAssetLibraryStatic.test.mjs` | 静态 | 检查公共资产库 tabs、搜索、资产详情 inspector、质量风险提示和必需资产阻塞提示入口，并确认不出现“已绑定 / 未绑定”等状态标签 |
| `tests/publicAssetLibraryApi.test.mjs` | API | 覆盖公共资产搜索/分类/必需资产局部阻塞/分镜资产提升为公共资产 |
| `tests/shotVideosStatic.test.mjs` | 静态 | 检查分镜视频卡片网格、状态角标全集、当前/候选版本 UI、分集下拉去重、禁用任务表格主视图 |
| `tests/shotVideoVersionsApi.test.mjs` | API | 覆盖候选视频默认写入、设为当前、最多两版、版本替换规则 |
| `tests/shotQcApi.test.mjs` | API | 覆盖 QC 三态、备注保存、卡片状态同步 |
| `tests/exportReadinessApi.test.mjs` | API | 覆盖缺失视频阻塞、未质检/需重跑 warning、draft/final 决策，不依赖真实 ffmpeg |
| `tests/v1AcceptanceStatic.test.mjs` | 静态守门 | 防止 PRD 明确禁止的旧项目导入、目录主流程、Agent skill runtime 读取、用户日常 Chrome 复用等入口回流 |

## 6. 浏览器目检步骤

浏览器目检用于验证本地 Web UI 交互，不用于证明即梦真实登录态或桌面 sidecar。

建议步骤：

1. 启动开发服务器：

   ```bash
   npm run dev
   ```

2. 打开 `http://localhost:5173/`。
3. 新建“V1 验收测试项目”，确认系统自动创建第 1 集。
4. 粘贴一段 3-5 句测试故事，保存并生成/手动编辑结构化剧本。
5. 确认剧本，拆分并确认 2-3 个分镜，确认每个分镜时长不超过 15 秒。
6. 进入公共资产 step，检查 tabs、搜索、缺失资产质量提示，不出现“已绑定 / 未绑定”等状态标签。
7. 进入分镜视频 step，检查卡片网格、状态角标、点击进入分镜画布。
8. 在分镜画布导入一张参考图，引用/排序/移除公共资产引用。
9. 生成即梦投喂包，检查 prompt、上传清单、JSON、warnings、gates。
10. 用本地小 mp4 模拟外部视频回填，确认候选版本出现、视频可播放、可设为当前。
11. 保存 QC：分别验证“待质检”、“需重跑”、“已通过”和备注。
12. 进入成片导出 step，先验证缺失视频阻塞，再补齐视频后验证导出结果和 warning。
13. 删除一个资源，进入回收站验证可见、恢复、永久删除和空间统计。
14. 结束后关闭浏览器标签页，停止 dev server，并通过应用 UI 删除/清空测试项目产生的回收站条目。

## 7. 桌面端目检步骤

桌面端目检用于证明“用户无需安装 Node.js”的 V1 交付目标，以及 Tauri sidecar、应用工作空间、托管即梦窗口和内置 ffmpeg 的真实组合效果。

建议命令：

```bash
npm run check:tauri-env
npm run build
npm run check:bundle-size
npm run build:tauri -- --bundles app
```

安装前先退出正在运行的 Drama Creator。若要替换本机应用，按项目 skill 的路径约定把：

```text
src-tauri/target/release/bundle/macos/Drama Creator.app
```

替换到：

```text
/Applications/Drama Creator.app
```

桌面目检重点：

1. 断开对系统 Node 的依赖后打开 `.app`，确认能进入项目库。
2. 新建项目写入 `~/.drama-creator/projects/<projectId>/`，不要求用户理解目录。
3. 走完浏览器目检中的 1-13 项。
4. 导出时使用打包内置 ffmpeg 生成原片、烧录字幕版和 SRT；若字幕烧录失败，页面必须展示 warning 且保留原片和 SRT。
5. 删除验收项目和资源，进入回收站恢复/永久删除，最后清理本次验收产生的项目、资源和回收站条目。

## 8. 即梦托管窗口人工门禁

即梦验收分两段：自动化可模拟的逻辑门禁，以及真实托管窗口人工门禁。

### 8.1 自动化可覆盖

通过 `tests/jimeng*.test.mjs` 覆盖：

- 投喂包生成不反写源项目。
- 投喂包携带项目级即梦空间，页面无法确认空间时必须停在人工设置门禁。
- 单镜头 prompt 不含独立转场/剪辑元信息。
- 参考图顺序稳定映射到 `@图片1`、`@图片2`。
- 缺失参考图时不启动浏览器。
- 托管 profile 使用 `~/.drama-creator/browser-profiles/jimeng/`。
- 重复启动复用可达 CDP 端口。
- 旧 CDP 不可达时清理陈旧 `SingletonLock` / `SingletonCookie` / `SingletonSocket`。
- 页面脚本只在 chip 数量、顺序和 raw `@图片N` 都通过时返回 `pre_submit_confirmation`。
- 自动化永不点击生成按钮。

### 8.2 必须人工确认

真实即梦页面验收必须由用户参与：

1. 在 Drama Creator 的分镜画布生成投喂包。
2. 点击启动即梦托管窗口。
3. 首次使用时，用户在该托管窗口登录即梦。
4. 确认窗口不是用户日常 Chrome，也不是 Codex/Chrome DevTools/Browser 插件会话。
5. 确认自动化进入视频生成、Seedance/全能参考、正确比例和时长。
6. 确认参考图已上传。
7. 如果返回 `pre_submit_confirmation`，人工核对：
   - prompt 是单镜头安全提示词。
   - 真实资源 chip 数量等于参考图数量。
   - chip 顺序与上传清单一致。
   - raw `@图片N` 数量为 0。
   - 自动化没有点击生成按钮。
8. 如果返回 `login_required`、`manual_settings_required`、`manual_upload_required` 或 `manual_reference_binding_required`，确认页面说明能指导用户完成下一步。
9. 用户手动点击生成。
10. 用户手动下载视频。
11. 回到 Drama Creator，通过导入外部资源回填当前分镜。

## 9. 最终验收命令建议

开发完成后，建议按以下顺序执行：

```bash
# 1. 全量自动化回归
npm test

# 2. 静态构建
npm run build
npm run check:bundle-size

# 3. 桌面环境和打包
npm run check:tauri-env
npm run build:tauri -- --bundles app
```

随后执行人工验收：

1. 浏览器目检：`npm run dev` + `http://localhost:5173/`，覆盖项目库到回收站的 Web UI。
2. 桌面端目检：安装并打开 `.app`，覆盖无需 Node、sidecar、应用工作空间、内置 ffmpeg。
3. 即梦托管窗口门禁：使用应用托管 profile 登录即梦，验证自动化提交前门禁或可理解人工门禁。
4. 用户手动下载视频并回填：验证候选版本、设为当前、QC、最终导出。

## 10. 核心风险

| 风险 | 影响 | 测试应对 |
|---|---|---|
| 即梦页面 DOM 或交互变化 | chip 绑定失效，自动化不能到达提交前确认 | 自动化测试守住“不验证 chip 就停下”；真实验收必须保留人工上传清单 fallback |
| 桌面打包和 Web dev 行为不一致 | Web 可用但 `.app` 无法启动 server、找不到 ffmpeg 或 ESM 缺包 | `npm run build`、`check:bundle-size`、`build:tauri` 后做桌面目检 |
| UI 状态和 API 文档漂移 | 自动化绿但用户看不到正确步骤或状态 | 静态测试 + 浏览器目检同时覆盖 step、卡片角标、warning、按钮文案 |
| 资源路径和回收站污染用户数据 | 删除/恢复/永久删除误伤真实项目 | API 测试只用临时目录；人工验收使用专门测试项目并从 UI 清理 |
| 视频编码差异导致导出失败 | 多平台 AI mp4 拼接时间轴异常 | API 用 fake ffmpeg 覆盖语义，桌面端用真实打包 ffmpeg 验证转码拼接 |
| 凭据泄露 | API Key/OAuth token 写入项目文件或日志 | keychain/credential 测试继续检查密文只进系统钥匙串，设置文件只保存引用 |
| “无模型配置”路径被忽略 | 非技术用户无法完成手动外部生成和回填 | 验收必须包含无模型配置下的手动导入、投喂包复制和导出 |
