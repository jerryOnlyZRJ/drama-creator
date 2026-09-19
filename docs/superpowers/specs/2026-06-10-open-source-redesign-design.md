# Drama Creator 开源化改造设计

> 本文档由 2026-06-10 的 grill-me 设计访谈收敛而来，作为 `drama-creator` 从「字节内部短剧工具」演进为「通用开源短剧资源管理平台」的设计基线。后续实现计划（plan）与任务拆解以本文档为准。

## 1. 目标（Goal）

把 `drama-creator` 从一个为字节短剧 SOP 深度定制的内部工具，演进为一个**可在 GitHub 开源、任意用户下载到本地即可使用**的独立应用和通用短剧资源维护与管理平台。

核心用户价值：
- 非技术创作者下载即用，在界面里直接创作与管理短剧资源（项目 / 剧集 / 镜头 / 提示词 / 图片 / 音频 / 视频 / QC）。
- 用户可以**不受限制地对接任意 AI 能力或平台**（例如提示词用 GPT、图片/视频用即梦），且不被平台预置的厂商范围限制。
- 应用默认使用 `~/.drama-creator`，也允许用户选择或注册自定义 workspace；用户选择/注册的项目目录是应用 workspace，不再和某个源代码仓库目录强绑定。
- 平台保持轻量内核，AI 能力以**适配器（adapter）生态**的方式由作者与开源社区共建。

## 2. 用户角色模型（User Roles）

平台明确区分三类角色，各自能力与诉求不同。这是所有设计决策的出发点。

| 角色 | 是谁 | 能力 | 诉求 |
|---|---|---|---|
| 适配器开发者 | 作者 + 开源社区技术贡献者 | 会写代码 | 实现 GPT / 即梦等适配器，贡献到生态 |
| 终端创作者（主用户） | 平台真正面向的非技术用户 | 不会命令行 | 简易安装、双击即用、填 key / 授权后选平台即可生成 |
| 高级创作者（少数） | 少量技术用户 | 会配置 | 挑选、组合、扩展社区适配器 |

关键洞察：「面向非技术用户」+「不受限制自定义 AI」+「平台轻量」是一个**不可能三角**。本设计通过「**平台不亲自维护所有厂商集成，而是定义适配器契约 + 由社区共建适配器生态**」（VS Code 扩展模型）来解开它——平台只负责定义契约与提供宿主，适配器由开发者角色提供，终端用户只需安装与启用。

## 3. 核心架构决策（已锁定）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 产品边界 | 轻量资源管理内核 + 适配器生态宿主（VS Code 模型）。平台自身不做端到端编排，但预留适配器 SPI。 |
| D2 | 适配器形态 | **双模并存**：进程级 CLI 契约（社区/技术用户扩展用，语言无关、进程隔离）+ 内置 JS in-process 适配器（官方适配器用，免外部运行时依赖）。 |
| D3 | 任务生命周期 | 异步「已提交即返回」模型。适配器可返回「已完成」或「pending + jobId」；平台标记任务为 `generating`，由用户触发「重新扫描产物目录」推进状态，复用现有 task 状态机。MVP 不引入常驻队列 / 自动轮询。 |
| D4 | 交付形态 | Tauri 桌面端，双击即用，复用现有 Web 前端。本地仍是「Node/Rust 本地服务 + WebView UI」，具备完整本地文件系统与子进程能力。 |
| D5 | 适配器分发 | MVP：内置 2-3 个官方适配器随桌面端打包 + UI 启用；预留 marketplace（远程 registry）接口，但不在 MVP 实现。 |
| D6 | 凭据管理 | 获取双入口：OAuth 浏览器授权（适配器若支持）/ 直接粘贴 key；存储统一进系统钥匙串（Keychain/Credential Manager/libsecret），明文永不落项目目录；环境变量作为技术用户 / CI 旁路。 |
| D7 | 资源来源 | 平台内建 native 创作流（UI 逐个手动创建为主）+ 一个轻量批量素材导入（选目录 / 拖入扫描入库）。**废弃字节 SOP markdown 导入器。** |

## 4. 不可能三角与取舍声明

本设计是一次**以现有内核为地基的重构级演进**，不是小修补，也不是推倒重来。诚实声明以下代价：

- 一旦面向非技术用户走「UI 填 key / 授权」，平台**必须碰凭据**（D6），「平台永不碰密钥」的理想仅对技术用户的环境变量旁路成立。
- 官方内置适配器（D5）的质量在开源初期≈作者投入，社区共建是中长期才会发生的事。
- 桌面端打包（D4）带来三平台签名 / 公证 / 发布流水线的持续成本。
- 以上代价是「让非技术用户也能用」这一目标的必然开销，已被接受。

## 5. 数据模型演进（Schema）

现有 `src/schema/dramaCreatorSchema.mjs` 的节点 / 边 / 任务状态机设计良好，予以保留并扩展。

### 5.1 保留

- `NODE_TYPES` / `EDGE_TYPES` / `TASK_TYPES` 维持。
- `TASK_STATUSES` 已含 `generating` / `reviewing` / `approved` / `rerun_needed` / `blocked`，直接承载 D3 的异步任务态，无需改动。
- 三层架构（L1 项目库 / L2 项目详情 / L3 分镜画布）与画布单向闭包过滤（`src/layout/clusters.mjs`）维持。

### 5.2 新增结构（document 顶层）

```text
{
  ...existing fields...,
  "config": {
    "defaultRatio": "9:16",        // 从硬编码外置，可由用户改
    "defaultModel": null,          // 不再硬编码 "Seedance 2.0"
    "locale": "zh-CN"
  },
  "adapters": [                    // 项目启用的适配器声明（引用，非实现）
    {
      "id": "adapter:openai-text",          // 平台内部引用 id，带 adapter: 前缀
      "manifestId": "openai-text",          // 对应 manifest 裸 id（Q5）
      "kind": "builtin" | "cli",
      "enabledModels": ["dall-e-3"],        // 用户在该适配器下启用的模型（Q1）
      "credentialRef": "credential:openai"  // 指向 credentials 表，不含明文
    }
  ],
  "credentials": [                 // 凭据引用表（Q6）；敏感明文绝不在此
    {
      "ref": "credential:openai",
      "adapterId": "openai-text",          // manifest 裸 id
      "method": "api_key",                 // 用户实际选用：oauth | api_key | env
      "keychainAccount": "drama-creator:openai-text",  // 全局按 adapterId 共享（Q6）
      "secretFieldKeys": ["apiKey"],       // 哪些 secret 字段存进了钥匙串（仅键名）
      "publicFields": { "endpoint": "https://..." },   // 非 secret 字段可明文落此
      "updatedAt": "..."
    }
  ],
  "jobs": [                        // 异步任务追踪
    {
      "id": "job:...",
      "taskId": "task:video:s001a:v001",
      "adapterId": "adapter:jimeng-video",
      "status": "generating" | "completed" | "failed",  // 三态统一（Q4），无 submitted
      "externalJobId": "...",      // 适配器 generating 时返回，供 poll
      "submittedAt": "...",
      "outputNodeIds": []
    }
  ]
}
```

> `credentials` 中**敏感字段（secret=true）的明文永不进入** `drama-creator.json`；document 仅保留钥匙串 account 引用与非敏感字段。真正的 token/key 存于系统钥匙串。详见 6.4。

## 6. 适配器契约（Adapter Contract）

适配器是平台与任意 AI 能力之间的唯一边界。契约必须稳定、语言无关、文档化（这是 D1「轻量内核」沉淀的核心资产）。

> **契约版本：v1.0（已于 2026-06-10 grill 冻结，Q1-Q6）。** 以下结构为 Phase 1 实现与官方适配器编写的权威依据，字段变更需走 `contractVersion` 升级流程（见 6.6）。

### 6.1 能力声明（manifest）

每个适配器提供一个 manifest（内置适配器为 JS 导出对象，CLI 适配器为同目录 `manifest.json`）。`capabilities` 为**结构化能力对象数组**（Q1），每个能力声明其支持的模型与每个模型的可调参数：

```text
{
  "contractVersion": "1.0",          // 适配器契约版本，平台据此判断能否加载（必填）
  "id": "jimeng-video",              // 稳定唯一标识，裸 id，不带 "adapter:" 前缀（必填）
  "displayName": "即梦视频生成",      // UI 展示名（必填）
  "version": "0.1.0",                // 适配器自身版本，作者维护（必填）
  "kind": "builtin" | "cli",         // 加载方式（必填）
  "entry": "builtin://jimeng-video" | "run.sh",  // 入口（必填）
  "async": true,                     // 是否可能返回 generating 态（必填）
  "homepage": "https://...",         // 可选，UI 展示「获取 key 指引」链接
  "timeoutSec": 600,                 // 可选，单次进程调用超时；缺省用平台默认 300s

  "capabilities": [                  // 结构化能力对象数组（Q1）
    {
      "type": "video",               // text_prompt | image | video | audio
      "models": [
        {
          "id": "jimeng-video-2.0",
          "params": {                // 字段描述对象（Q2），平台据此自动渲染表单
            "duration": {
              "type": "number", "min": 1, "max": 12, "step": 1,
              "default": 5, "required": false, "label": "时长(秒)"
            },
            "ratio": {
              "type": "enum", "options": ["9:16", "16:9", "1:1"],
              "default": "9:16", "required": true, "label": "画面比例"
            }
          }
        }
      ]
    }
  ],

  "credential": {                    // 凭据声明（Q6），静态、可进 git
    "required": true,                // 该适配器是否需要凭据（纯本地适配器可 false）
    "methods": ["oauth", "api_key", "env"],  // 支持的获取方式，按 UI 展示优先序
    "fields": [                      // api_key 方式下要让用户填的字段
      { "key": "apiKey", "label": "API Key", "secret": true, "required": true },
      { "key": "endpoint", "label": "自定义 Endpoint", "secret": false, "required": false }
    ],
    "env": [                         // env 旁路：从哪些环境变量读
      { "key": "apiKey", "envVar": "JIMENG_API_KEY" }
    ],
    "oauth": {                       // oauth 方式（适配器支持才有）
      "authorizeUrl": "https://...",
      "scopes": ["..."]
    }
  }
}
```

**`params` 字段集 v1 冻结（Q2）：**
- `type`：`"enum" | "number" | "string" | "boolean"`（v1 仅这 4 种）。
- 通用：`default`、`required`（缺省 false）、`label`。
- `enum` 专属：`options`（数组）。
- `number` 专属：`min`、`max`、`step`（可选）。
- `prompt` **不进 params**，它是 generate 调用的一级字段。

### 6.2 调用契约（CLI 模式）

平台通过子进程调用 CLI 适配器，stdin 传入 JSON，stdout 返回 JSON，退出码表达「适配器是否跑通」。

输入（stdin）—— `generate`（Q3 冻结）：

```text
{
  "action": "generate",
  "capability": "video",                 // 对应 manifest capabilities[].type
  "model": "jimeng-video-2.0",           // 对应该 capability 下 models[].id
  "prompt": "9:16 竖屏，5秒……",           // 一级字段，不进 params
  "references": [                        // 路径 + 语义角色 + 类型（Q3）
    { "path": "/abs/.../char_robot.png", "role": "character_ref", "kind": "image" },
    { "path": "/abs/.../kf_s001.png",     "role": "tail_frame",    "kind": "image" }
  ],
  "outputDir": "/abs/.../episode/raw-videos",   // 平台保证存在且可写
  "params": { "duration": 5, "ratio": "9:16" }, // 对应 model.params 声明的键
  "credential": { "apiKey": "...", "endpoint": "..." }  // env 模式下为 null
}
```

**`references[].role` 枚举 v1 冻结（Q3）：** `character_ref` / `location_ref` / `prop_ref` / `style_ref` / `first_frame` / `tail_frame` / `generic`。适配器**必须忽略**不认识的 role（向前兼容）。`references[].kind`：`image | video | audio`。

输出（stdout）+ 退出码（Q4 冻结）：

```text
{
  "status": "completed" | "generating" | "failed",   // 三态统一，贯穿适配器与 job
  "outputs": [                          // status=completed 时必填，其余为空数组
    {
      "path": "raw-videos/ep001_s001a_v001.mp4",  // 相对 episode 根（Q3）
      "kind": "video",                            // image | video | audio
      "role": "primary"                           // primary | variant（缺省 primary）
    }
  ],
  "externalJobId": "jm-abc123",         // status=generating 时必填，供后续 poll
  "error": {                            // status=failed 时必填
    "code": "quota_exceeded",           // 标准错误码或自定义；平台不认识的归 unknown
    "message": "余额不足，请充值"          // 给终端用户看的可读信息
  },
  "progress": 0.4                       // 可选，0~1，generating 时供 UI 显示进度
}
```

**退出码与 status 解耦（Q4）：**
- `exit 0` = 适配器**正常执行完毕并产出合法 JSON**（无论 status 是 completed/generating/failed，都属业务级结论）。
- `exit ≠ 0` = 适配器**自身崩溃**（未产出合法 JSON），平台兜底判为「适配器执行异常」，区别于业务级 `failed`。

**`error.code` 标准枚举 v1（Q4）：** `quota_exceeded` / `auth_failed` / `timeout` / `invalid_params` / `unknown`，外加允许适配器自定义 code（平台不认识的按 `unknown` 处理；`auth_failed` 会引导用户重新授权）。

轮询（CLI 模式，D3 的 MVP 阶段不自动调用，由用户触发「刷新/重扫」时执行）：

```text
// stdin
{ "action": "poll", "externalJobId": "jm-abc123", "outputDir": "/abs/..." }
// stdout —— 与 generate 输出结构完全一致（status/outputs/error/progress）
{ "status": "completed", "outputs": [ { "path": "...", "kind": "video", "role": "primary" } ] }
```

### 6.3 内置 JS 适配器（in-process 模式）

官方适配器为一个导出 `manifest` 和 `generate(input)` / `poll(input)` 的 JS 模块，由平台直接 `import()` 调用，避免要求用户机器装 Python 等运行时。契约语义与 CLI 完全一致，只是传输方式从 stdin/stdout 变为函数入参/返回值；函数正常 `return` 合法结果对象等价于 `exit 0`，抛异常等价于 `exit ≠ 0`。

### 6.4 凭据声明、存储与注入（Q6 冻结）

三层概念分离：
- **manifest.credential**：适配器*声明*需要什么凭据、支持哪些方式——静态、随适配器分发、可进 git（结构见 6.1）。
- **document.credentials**：项目*记录*凭据存在哪个钥匙串条目下——**只存引用，绝无敏感明文**（结构见 5.2）。
- **运行时注入**：平台从钥匙串解出明文塞进 `generate` 入参的 `credential` 字段——只在内存 / 子进程 stdin。

**分级存储（Q6）：** `fields[].secret = true` 的字段（如 apiKey）UI 用密码框、存系统钥匙串；`secret = false` 的字段（如 endpoint）可明文落 document.credentials。

**钥匙串 account 命名（Q6）：** 全局按 adapterId 共享 —— `drama-creator:<adapterId>`。用户填一次 OpenAI key，所有项目共用；需隔离的高级用户走 env 旁路。

**注入与优先级（Q6 / D6）：**
1. 若 manifest.credential.env 声明的环境变量**全部存在** → 走 env 模式：平台不读钥匙串、不注入，`credential` 置 null，适配器自读环境变量（技术用户 / CI 旁路）。
2. 否则平台从钥匙串按 account 解出 secret 字段 + 从 document 取非 secret 字段，合并注入到 `credential` 入参。
3. 明文仅存在于内存与子进程入参，**不写盘、不进 document、不进日志**。

### 6.5 OAuth 入口（D6，MVP 视适配器支持情况启用）

凭据获取支持两种入口，由 manifest.credential.methods 声明，UI 据此展示：
- **粘贴 key**（`api_key`）：MVP 主路径，多数平台（OpenAI/即梦）现状只有此方式。
- **OAuth 授权**（`oauth`）：仅当目标平台开放 OAuth 且适配器声明 `oauth` 配置时可用。OAuth 拿到的 token 同样存入钥匙串，存储/注入规则与 api_key 一致。

### 6.6 契约版本演进（Q5）

- `contractVersion` 必填，v1 固定 `"1.0"`。
- 平台采用 **major 兼容策略**：`1.x` 平台可加载所有 `1.y` 适配器，拒绝 `2.x` 并给出明确提示，而非运行中静默崩溃。
- 破坏性字段变更必须升 major；新增可选字段升 minor。

## 7. 组件级裁决（现有代码命运）

| 现有模块 | 命运 | 说明 |
|---|---|---|
| `src/schema/dramaCreatorSchema.mjs` | 保留 + 扩展 | 增加 `config` / `adapters` / `jobs`；外置字节默认值 |
| `src/layout/clusters.mjs` | 保留 | 画布闭包核心资产，几乎不动 |
| `src/server/app.mjs` | 保留 + 扩展 | 增加适配器调用、job 轮询、凭据路由；`realpath + allowlist` 安全基线保留 |
| L1/L2/L3 前端 | 保留 + 大改 | 增加 native CRUD 表单、适配器设置页、生成按钮、job 状态可视化 |
| `src/feed/feedPackage.mjs` | 重构 | 从「拼纯文本手动复制」改为「组装适配器调用入参」 |
| `src/import/importEpisode.mjs` | 废弃大部分 | 仅保留「扫描目录建 image/audio asset 节点」的批量入库逻辑 |
| `src/import/markdownParsers.mjs` | 废弃 | SOP markdown 解析全部移除 |

约 50%（schema / 画布 / 安全代理）可复用；用户接入面（导入器 + 投喂）需重写；并新增适配器执行内核、凭据管理、桌面端外壳、native 创作流。

## 8. 安全设计（Security）

- 本地服务沿用 `realpath + allowedEpisodeRoots` 越界防护（现有 `app.mjs` 已实现）。
- 凭据明文仅入系统钥匙串，绝不写入 `drama-creator.json` / 普通配置文件 / 日志。
- CLI 适配器为子进程，崩溃 / 超时不拖垮平台主进程；需定义超时与终止策略。
- 开源仓库必须含 `.gitignore` 屏蔽任何本地凭据缓存；文档明确警告不要把 key 提交进 git。
- 第三方 CLI 适配器在用户机器上以用户权限运行，文档需提示「仅安装可信适配器」（与 VS Code 扩展同等风险模型）。

## 9. 分阶段路线图（Roadmap）

### Phase 0 — 内核解耦（为开源扫清硬编码）
1. 外置字节默认值（`Seedance 2.0` / `9:16` / 中文）→ `config` + i18n 骨架。
2. schema 扩展：新增 `config` / `adapters` / `jobs` 三类结构。
3. 移除 `markdownParsers`，`importEpisode` 瘦身为「批量素材扫描入库」。
4. 补 `LICENSE`（建议 Apache-2.0）、`CONTRIBUTING.md`、适配器契约文档。

### Phase 1 — 适配器执行内核（最大工程量）
5. 定义并文档化适配器契约（manifest + generate/poll + 退出码 + pending/jobId）。
6. 双模加载器：内置 JS in-process + 外部 CLI spawn。
7. 异步执行器：调用 → 标记 `generating` → 用户触发重扫产物 → 回写 `video_output` / 状态（复用 `addVideoOutputs`）。
8. `feedPackage` 重构为适配器入参组装。

> **Phase 1 工程决策冻结（2026-06-10 grill，P1Q1-P1Q5）：**
> - **P1Q1 适配器发现 = 双来源约定式目录**：内置 JS 在仓库 `src/adapters/<id>/index.mjs`（随平台分发、启动静态注册）；外部 CLI 在用户数据目录 `~/.drama-creator/adapters/<id>/manifest.json`（拖入即被发现）。平台启动扫描两处合并出「可用适配器清单」；用户在设置页启用后才写入 `document.adapters[]` 引用。
> - **P1Q2 CLI 超时与终止 = SIGTERM→SIGKILL 两阶段**：墙钟超时 = `manifest.timeoutSec || 300s`；超时先 `SIGTERM` 给 3s 优雅退出窗口，仍不退再 `SIGKILL`，记业务级 `failed` + `error.code:"timeout"`。`exit 0` 但 stdout 非合法 JSON / 缺 `status` → 判执行异常（等价 exit≠0），记 `error.code:"unknown"`，原始 stdout 截断存 job 供排查；stderr 始终捕获仅作诊断日志，不解析为结果。
> - **P1Q3 job 状态机 = 提交即返回 + 用户重扫**：同步适配器（返回 completed）立即按 outputs 落产物 → 复用 `addVideoOutputs` 建 `video_output` 节点 + `generates` 边 → job 标 completed 写 outputNodeIds；异步适配器（返回 generating）存 externalJobId，用户在画布点「刷新/重扫」时平台对 generating job 调 `poll`，completed 才回填推进。回填按 outputs[].path 幂等去重（ensureNode/ensureEdge）。MVP 不引入常驻轮询/队列。
> - **P1Q4 feedPackage 重构边界 = 增量**：保留预投喂校验闸门；新增纯函数 `buildGenerateInput(doc, taskId, adapterRef)`，组装 prompt（一级字段）+ references（带 role/kind，从画布闭包 image_asset/audio_asset 边推导）+ params（model.params 默认值合并用户输入）+ outputDir 为契约 generate 入参；原 `buildFeedPackagePreview` 纯文本路径降级保留为「无适配器时手动复制兜底」，不删除。
> - **P1Q5 交付边界 = 纯逻辑层 + 薄路由，不含前端**：Phase 1 交付「加载器 + 执行器 + buildGenerateInput」三个纯逻辑模块 + 内置 mock 适配器（测试用，不调真实 AI）+ 全套单测；server 加薄封装路由 `POST /api/generate`、`POST /api/jobs/refresh`，但前端按钮/状态可视化留 Phase 3。验收 = 用 mock 适配器跑通「generate → 落产物 → 回填节点 → job completed」全链路单测，不依赖真实 API key。

### Phase 2 — 凭据与官方适配器
9. 系统钥匙串集成 + OAuth 回调 + 粘贴 key UI + 环境变量旁路。
10. 写 2-3 个官方适配器参考实现（建议：OpenAI 文本 / 图片、即梦视频）。

> **Phase 2 工程决策冻结（2026-06-11 grill，P2Q1-P2Q5）：**
> - **P2Q1 凭据存储 = keytar**：用 npm `keytar` 直接调三平台原生钥匙串（macOS Keychain / Windows Credential Manager / Linux libsecret）。service 名固定 `drama-creator`，account 沿用 P1Q6 的 `drama-creator:<adapterId>`。Phase 3 切 Tauri 时只换底层 `keychain.mjs` 一个文件，不动上层契约。
> - **P2Q2 凭据入口 = 仅 api_key + env**：Phase 2 不做 OAuth，`manifest.credential.methods` 只暴露 `api_key` 与 `env` 两条路径。OAuth 整体推迟到 Phase 3 与 Tauri 自定义协议（`drama-creator://callback`）一次到位，避免 loopback 端口实现被重写。多数目标 AI 平台（OpenAI / DeepSeek / 即梦）现状本就只有 api_key，无影响。
> - **P2Q3 官方适配器 = 2 个通用兼容协议适配器**：
>   - `openai-compatible-text`（一套代码覆盖 OpenAI / DeepSeek / 智谱 / Moonshot / 通义等所有兼容 OpenAI Chat Completions 协议的平台）：参数化 `endpoint` + `apiKey`，UI 提供「选模板」预填默认 endpoint。
>   - `openai-compatible-image`（先走 OpenAI Images endpoint，验证「产物下载落盘 + 回填到画布」契约链路）。
>   - 即梦视频适配器**单独立项**，因即梦无开放 API、需逆向或浏览器自动化，复杂度足以独立成 Phase。
> - **P2Q4 注册与注入 = 静态表 + 扫描 + 凭据封装**：内置适配器走 `src/adapters/builtins.mjs` 静态注册表（启动时硬编码 import + export），外部 CLI 适配器仍由 Phase 1 的 `loader.discoverCliAdapters` 扫描 `~/.drama-creator/adapters/`，二者合并成「可用适配器清单」；新增 `src/adapters/credentialResolver.mjs` 封装钥匙串注入（按 P1Q6 优先级：env 全在 → null；否则 keytar 解 secret + document 取 public 合并），server 路由调它。
> - **P2Q5 前端边界 = 加凭据设置页**：新增最简 `/settings` 页面（适配器列表 / 选模板 / 粘贴 key 表单 / 已配置状态），让 Phase 2 可被非技术用户验收。**生成按钮**仍留 Phase 3 与 native CRUD + job 状态可视化一起做。验收 = 用户启动平台 → 打开设置页 → 粘贴 DeepSeek/OpenAI key → 通过 `/api/generate` 真实调通文本提示词生成。

### Phase 3 — 桌面端与原生创作流
11. Tauri 接入 + 三平台打包 / 签名 CI。
12. L2/L3 增加 native CRUD（新建项目 / 镜头 / 提示词）+ 生成按钮 + job 状态可视化。
13. 批量素材导入 UI（选目录 / 拖入）。

> **Phase 3 包体硬约束（2026-06-11 锁定，2026-06-15 调整）：** Tauri 打包时必须裁剪 npm install-only 依赖（`prebuild-install` / `tar` / `glob` 等仅安装期使用的包），最终进桌面安装包的运行时依赖应仅包含 `keytar` 自身 JS（~80 KB）+ 平台对应的 `keytar.node` 预编译 binding（~100 KB）；前端 dist 总体体积控制在 **360 KB 以内**。本次从 300 KB 调整到 360 KB，是为了覆盖 V1 PRD 已确认的工作台、公共资产详情编辑、分镜筛选、设置/回收站/导出页面；该阈值仍作为硬阻断，后续增长需先评估页面拆分或懒加载。若 Phase 3 评估证明 Tauri 内置 keychain 插件能完全替代 keytar，可在 Phase 3 内删除 keytar 依赖、改由 Rust 侧调系统钥匙串，进一步节省体积（与 P2Q1 的「迁移路径已被 schema 隔离」一致，只需替换 `src/credentials/keychain.mjs` 一个文件）。CI 应加入桌面安装包体积回归检查（基线在 Phase 3 首次打包时锁定）。

> **Phase 3 决策冻结块（2026-06-11 grill 完成）：**
>
> - **P3Q1 Tauri 与 Node server 的关系 = 方案 A（Webview Shell）**：保留现有 `node server.mjs` 不动，Tauri 仅作为 webview shell 指向 `http://localhost:5173`。Phase 3 不把业务逻辑移植到 Rust，最小改动出 MVP；后续若有性能/分发诉求再考虑 sidecar 子进程模式。
> - **P3Q2 包体衡量口径 = 仅前端 dist + 总和限额 + 硬阻断**：360 KB 上限只丈量 `drama-creator/dist/` 下静态资源（HTML/CSS/JS + 浏览器侧 ESM 模块），Tauri Rust 二进制 / 系统 WebView 不计入。dist 内全算（包括未来引入的 Preact 等运行时依赖），keytar 这类后端 native 不算（不进 dist）。超阈值 CI 硬阻断（`exit 1`），调阈值需同步更新本设计文档。
> - **P3Q3 包体回归 CI = `scripts/check-bundle-size.mjs` + GitHub Actions**：本地与 CI 共用同一脚本（先 build、再递归累加 dist 字节、超阈值打印 top 10 增长来源后 exit 1）。Workflow 用 `npm ci --ignore-scripts` 跳过 keytar native build 加速 CI。dist/ 不入 git（`.gitignore` 已加），构建产物每次由 CI 现场产出，避免 PR diff 噪音。
> - **P3Q4 OAuth 入口 = A1，仅本期落地 Codex OAuth**：使用 OpenAI 官方 Codex CLI 的 OAuth app（client_id `app_EMoamEEZ73f0CkXaXp7hrann`，无 client_secret，PKCE 公共 client）。redirect_uri 硬编码为 `http://localhost:1455/auth/callback`（OpenAI 服务端固定，第三方不可改）。Anthropic / Google Gemini / 飞书 等 OAuth 全部不在本期范围。
> - **P3Q4-Q1 适配器拓扑 = 方案 Y（独立适配器）**：新增 `openai-codex-oauth` 适配器，credential.methods 只声明 `oauth`，专调 Codex 兼容端点；P2 已落地的 `openai-compatible-text` 保持纯 api_key 不动。两个适配器在设置页作为两张独立卡片呈现。
> - **P3Q4-Q2 端口冲突策略 = 方案 a（直接 fail）**：1455 端口被占用时直接抛错并提示用户释放该端口，本期不实现 device code flow 兜底（留作 Phase 4 增强）。
> - **P3Q4-Q3 callback server = 方案 P（临时短生命周期）**：每次 OAuth login 临时起 1455 listener，回调命中后立即关闭；前端 polling `/api/credentials` 感知完成状态，不引入 websocket。
> - **P3Q4-Q4 token 刷新 = 自动 + banner 兜底**：`resolveCredential` 内透明刷新（access_token 距过期 < 60s 时用 refresh_token 续约并写回 keychain）；refresh 失败时清除本地 token，不在 generate 路径强行重试，仅在设置页显示 banner 提示用户重新登录。
> - **P3Q4-Q5 ToS 免责声明**：README 与设置页 banner 两处都加，明示「使用 Codex OAuth 受 OpenAI 服务条款约束，订阅模式由用户自担合规风险，drama-creator 不参与任何账号买卖或多账号轮转」。
> - **P3Q4-Q6 测试边界**：单元测试覆盖 PKCE 生成 / authorize URL 构造 / token 交换 / refresh / state 校验（fetch 注入）；集成测试覆盖 callback server 起停 + 错误回调；OAuth 真实账号 E2E 由维护者手测，不进 CI。

### Phase 4 — 生态（开源后）
14. marketplace registry + 适配器签名 / 审核机制。

## 10. MVP 验收口径（Definition of Done）

开源 MVP（覆盖 Phase 0-3）可宣称完成的标准：
- 非技术用户下载桌面端安装包，双击启动，无需命令行。
- 在 UI 中新建项目 / 剧集 / 镜头 / 提示词，无需编写任何 markdown。
- 在设置页粘贴 / 授权一个官方适配器的凭据，点击「生成」能跑通至少一条「文本提示词 → 图片」或「图片 → 视频」链路。
- 生成产物自动回填到画布对应镜头，QC 流程可用。
- 技术用户可按文档放入一个自定义 CLI 适配器并在 UI 启用。
- 凭据不出现在任何项目文件或日志中。

## 11. 开放问题（待后续 grill / plan 细化）

- 适配器超时与终止的具体阈值与 UX。
- 批量素材导入时的资源类型推断规则（按目录名 / 文件名 / 扩展名）。
- OAuth 回调在 Tauri 桌面端的具体落地（本地回环端口 vs 自定义协议）。
- i18n 的范围（仅 UI 文案，还是含适配器 displayName）。

> 注：Phase 1 适配器契约 JSON 字段已于本轮 grill 冻结为 v1.0，见第 6 节。
