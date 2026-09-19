# 适配器契约 v1.0（Adapter Contract）

> 本文档面向**适配器作者**，是编写一个 drama-creator 适配器的权威依据。
> 契约已于 2026-06-10 冻结为 **v1.0**。字段变更须遵循第 7 节的版本演进规则。
> 设计背景与决策推导见 [`superpowers/specs/2026-06-10-open-source-redesign-design.md`](superpowers/specs/2026-06-10-open-source-redesign-design.md) 第 6 节。

---

## 0. 什么是适配器

适配器是 drama-creator 平台与**任意 AI 素材生产能力**之间的唯一边界。平台内核只管理资源图谱与画布；具体「文本提示词 → 图片」「图片 → 视频」等生成能力，全部由适配器提供。

drama-creator 把素材生产分成两种并列模式：

| 模式 | `productionMode` | 含义 | 典型例子 |
|---|---|---|---|
| 内置生成 | `in_app` | 应用直接调用 AI 平台或订阅端点生成素材，产物由应用写回项目 | API Key、OAuth/订阅登录、env 凭据 |
| 外部跳转 | `external` | 用户跳到外部 AI 平台完成生成，再把素材导入/回填到应用；应用可提供投喂包或自动化脚本提效 | 即梦 Web、用户手动使用第三方平台 |

两种模式都可由用户自由选择。应用只提供“默认推荐”的最佳实践，例如视频默认推荐即梦 Seedance，但这不代表强制绑定。

两种形态，语义完全一致，只是传输方式不同：

| 形态 | `kind` | 适用 | 传输方式 |
|---|---|---|---|
| 内置 JS | `builtin` | 官方集成，免装额外运行时 | 平台 `import()`，函数入参/返回值 |
| 进程级 CLI | `cli` | 社区任意语言实现 | 子进程，stdin/stdout 交换 JSON |

### 0.1 浏览器自动化扩展

即梦这类 Web 平台当前主路径依赖 **应用托管浏览器 profile + 页面上传 + 提交前确认**，不是 API Key 适配器。它应声明 `productionMode = "external"` 和 `execution.type = "browser_automation"`，用来把该能力展示为外部跳转型视频/音频通道；实际执行必须通过投喂包 handoff 完成，不能把它伪装成普通 `generate` 调用。执行器可用时，manifest 应声明 `execution.startEndpoint` 和 `automation.startEndpoint`；执行器不可用时，UI 仍要保留投喂包与人工 fallback。

首个内置浏览器自动化扩展是「即梦自动化（Seedance）」。视频目标模型不是自由文本，应来自即梦页面可见模型候选；当前内置 `Seedance 2.0 mini`、`Seedance 2.0` 和 `Seedance 2.0 Fast`。推荐视频默认值仍为生成更快的 `Seedance 2.0 mini`，用于低风险镜头、验证片，以及声音可通过后期添加或替换的镜头；只有可见角色对白必须严格音画同步且无法后期配音时，投喂包才升级为普通 `Seedance 2.0`。音频目标模型使用独立的 `jimeng-audio`（显示为「即梦音频生成」），避免和 Seedance 视频模型 ID 混用。设置页保存的模型必须写入投喂包，并由自动化脚本在页面上切换到同一项。它的职责边界：

- 平台生成投喂包：提示词、参考资源上传顺序、目标 URL、项目级即梦空间和检查门禁；图片引用使用 `@图片N`，音频引用使用独立的 `@音频N` 编号。
- BGM、歌曲、环境声、画外音、画外对白和无可见口型对白默认后期处理，不设置 `audioLockRequired`；`postDubbingAllowed = true` 必须覆盖旧锁定标记并保留全局视频默认值。
- 只有无法后期配音的可见角色对白任务才能设置 `audioLockRequired = true`、绑定最终通过的 `@音频N` 对白母带，并由投喂包覆盖全局 mini 默认值。普通 `Seedance 2.0` 与 `Seedance 2.0 VIP` 必须严格区分，未经本次明确授权不得选择 VIP。
- 音色锁定产物的回填前验收至少覆盖：公共音色一致性、台词完整性、发声人归属、重复或新增台词、静音边界和口型同步；不通过时只能保留为候选版本。
- 投喂包给外部平台的 `prompt` 必须是单镜头安全提示词；剪辑/转场元信息可以记录在清理结果里，但不能作为当前镜头正文提交。
- 审核/风控验证片应使用即梦页面当前可见的最低视频时长档位；2026-07 实测页面提供 `4s` 到 `15s`。验证片只用于隔离审核或参考素材问题，不得把验证片时长误写成正式分镜正片时长。
- 自动化执行器消费投喂包：使用 `~/.drama-creator/browser-profiles/jimeng/` 打开即梦，先按 `workspace.spaceName` 尝试切换目标空间，再通过应用本地 CDP 脚本尝试填入提示词、挂载参考文件，并在空间、设置或 @ 资源绑定未验证时停下。空间验证必须读取当前激活会话/空间的强证据；页面正文或侧栏列表里出现目标名称不能作为已切换成功的依据。
- 自动化不得复用用户日常 Chrome 登录态，不得把 Codex、Chrome DevTools MCP 或 Agent 侧浏览器会话当作产品能力。
- 提交前必须等待用户确认；提交成功和下载产物都要有可验证证据。
- 产物下载后再通过「导入外部资源」回填到当前镜头。
- `/api/generate` 遇到 `productionMode = "external"` 的适配器时必须返回 `external_handoff_required`，不能创建失败 job。

### 0.2 订阅授权

订阅授权是与 API Key 并列的通用授权方式，不等同于某个具体模型服务商。设置页应展示为「订阅授权」，再在说明或服务商选择中标明当前已接入的平台。当前首个实现是 `openai-codex-oauth`，使用 ChatGPT Plus/Pro 订阅调用 OpenAI Codex 文本能力；未来可以继续接入其他服务商的订阅授权，但不能把尚未接入的平台展示成可用能力。

订阅授权和已验证 API Key 的模型选择必须来自应用侧验证过的候选列表，设置页用下拉选择，不让用户手动输入模型 ID。自由模型 ID 只属于 API Key 的自定义端点或服务商临时未返回模型目录场景，避免界面显示一个模型、运行时却因别名不可用而失败或切换到其他服务商。

OpenAI Codex OAuth 的回调端口固定为 `1455`，因为其 `redirect_uri` 由上游 OAuth 客户端注册信息约束。应用内重复点击订阅登录时，平台必须先取消上一次仍在等待回调的应用内监听，再启动新的授权流程；只有端口被应用外进程占用时，才向用户提示端口占用。

### 0.3 未配置能力的产品语义

未配置凭据、未完成订阅授权或自动化执行器不可用时，平台不得把对应 AI 能力从用户界面移除。适配器和 UI 必须把状态表达为「需配置」「当前不可用」或 `external_handoff_required` 这类可处理结果，并在同一操作上下文提供配置入口和手动替代路径，例如手动编辑、复制投喂信息、外部生成后导入回填。文本能力在用户未保存默认文本模型时优先尝试订阅授权，再用 API Key；如果用户已经保存默认文本模型，生成来源必须以该默认模型为准，失败时直接提示该模型不可用，不得静默切换到另一个服务商。如果订阅授权和 API Key 都不可用，剧本生成、分镜拆分等文本入口必须提供“去配置”按钮跳转 `settings.html` 的模型配置页面，同时保留手动路径。

运行时如果非显式默认候选通道的钥匙串密文缺失、损坏、已失效或适配器返回 `auth_failed`，平台应把该通道视为当前不可用，并继续尝试同能力下的后续候选通道。若失败的是用户保存的默认文本模型，必须停止本次生成并返回配置入口、重新授权入口或手动兜底路径，避免界面显示 GPT 但实际使用 DeepSeek 等错误来源；不得因为单个坏凭据让业务入口返回 500。

桌面发布包必须保证系统钥匙串后端在 sidecar 二进制内可用。当前 Node sidecar 通过 `keytar` 访问 macOS Keychain / Windows Credential Manager / Linux libsecret，`pkg` 构建时必须显式包含平台对应的 `keytar.node` 原生扩展；否则设置页可能显示凭据已存在，但运行时 AI 入口无法读取密钥。

---

## 1. 能力声明（manifest）

每个适配器提供一个 manifest：内置适配器为 JS 导出对象，CLI 适配器为同目录 `manifest.json`。

```jsonc
{
  "contractVersion": "1.0",          // 必填。平台据此判断能否加载
  "id": "jimeng-video",              // 必填。稳定唯一标识，裸 id，不带 "adapter:" 前缀
  "displayName": "即梦视频生成",      // 必填。UI 展示名
  "version": "0.1.0",                // 必填。适配器自身版本，由作者维护
  "kind": "cli",                     // 必填。"builtin" | "cli"
  "entry": "run.sh",                 // 必填。CLI 为可执行入口；builtin 形如 "builtin://jimeng-video"
  "async": true,                     // 必填。是否可能返回 generating 态
  "productionMode": "in_app",         // 必填。"in_app" | "external"
  "execution": {                      // 必填。描述执行方式，不和凭据/模型能力混用
    "type": "api",                    // "api" | "subscription" | "browser_automation" | "local_mock"
    "credentialMethods": ["api_key"],
    "defaultRecommended": false,
    "manualBackfill": false
  },
  "homepage": "https://...",         // 可选。UI 展示「获取 key 指引」链接
  "timeoutSec": 600,                 // 可选。单次进程调用超时；缺省用平台默认 300s

  "capabilities": [                  // 结构化能力对象数组
    {
      "type": "video",               // "text_prompt" | "image" | "video" | "audio"
      "models": [
        {
          "id": "jimeng-video-2.0",
          "params": {                // 字段描述对象，平台据此自动渲染表单
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

  "credential": {                    // 凭据声明，静态、可进 git
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

### `params` 字段集（v1 冻结）

平台根据 `params` 自动渲染参数表单，你**只能**使用以下字段：

- `type`：`"enum" | "number" | "string" | "boolean"`（v1 仅这 4 种）。
- 通用：`default`、`required`（缺省 `false`）、`label`。
- `enum` 专属：`options`（数组）。
- `number` 专属：`min`、`max`、`step`（均可选）。

> **`prompt` 不进 `params`**。它是 generate 调用的一级字段（见第 2 节）。

---

## 2. 调用契约

### 2.1 generate —— 发起一次生成

平台传入的输入对象（CLI 走 stdin，builtin 走函数入参）：

```jsonc
{
  "action": "generate",
  "capability": "video",                 // 对应 manifest capabilities[].type
  "model": "jimeng-video-2.0",           // 对应该 capability 下 models[].id
  "prompt": "9:16 竖屏，5秒……",           // 一级字段，不进 params
  "systemPrompt": "你是 Drama Creator 内置的短剧创作与 AI 素材提示词助手……", // 可选。文本模型应作为 system / instructions 使用
  "promptGuidance": {                     // 可选。应用内置的提示词最佳实践摘要，供适配器日志、UI 或自动化使用
    "version": "drama-creator-prompt-best-practices.v6",
    "source": "app_builtin",
    "runtimePolicy": { "readsLocalAgentSkills": false },
    "flow": "故事源 → 剧本草稿 → 分镜拆分 → 资产依赖矩阵 → 公共资产库 → 分镜参考资源 → 即梦投喂包 → 分镜视频 → 质检 → 成片导出",
    "principles": ["导演判断：进入视频提示词前先明确前2秒钩子、角色气质、空间关系、镜头功能和节奏类型。"],
    "checklist": ["..."]
  },
  "references": [                         // 路径 + 语义角色 + 类型
    { "path": "/abs/.../char_robot.png", "role": "character_ref", "kind": "image" },
    { "path": "/abs/.../kf_s001.png",     "role": "tail_frame",    "kind": "image" }
  ],
  "outputDir": "/abs/.../episode/raw-videos",   // 平台保证存在且可写
  "params": { "duration": 5, "ratio": "9:16" }, // 对应 model.params 声明的键
  "credential": { "apiKey": "...", "endpoint": "..." }  // env 模式下为 null
}
```

**`references[].role` 枚举（v1 冻结）：**
`character_ref` / `location_ref` / `prop_ref` / `style_ref` / `first_frame` / `tail_frame` / `generic`。

> 适配器**必须忽略**不认识的 role（向前兼容）。
> `references[].kind`：`image | video | audio | text`。

### 2.2 输出与退出码

适配器的输出对象（CLI 走 stdout，builtin 为函数返回值）：

```jsonc
{
  "status": "completed" | "generating" | "failed",   // 三态统一
  "outputs": [                          // status=completed 时必填，其余为空数组
    {
      "path": "raw-videos/ep001_s001a_v001.mp4",  // 相对 episode 根
      "kind": "video",                            // image | video | audio | text
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

**退出码与 status 解耦：**

- `exit 0` = 适配器**正常执行完毕并产出合法 JSON**（无论 status 是 completed/generating/failed，都属业务级结论）。
- `exit ≠ 0` = 适配器**自身崩溃**（未产出合法 JSON），平台兜底判为「适配器执行异常」，区别于业务级 `failed`。
- 内置 JS 适配器：函数正常 `return` 合法结果对象等价于 `exit 0`，抛异常等价于 `exit ≠ 0`。

**`error.code` 标准枚举（v1）：**
`quota_exceeded` / `auth_failed` / `timeout` / `invalid_params` / `unknown`。
允许自定义 code（平台不认识的按 `unknown` 处理；`auth_failed` 会引导用户重新授权）。

### 2.3 poll —— 轮询异步任务

仅 `async: true` 的适配器需实现。平台在 MVP 阶段**不自动轮询**，由用户触发「刷新/重扫」时调用：

```jsonc
// 输入
{ "action": "poll", "externalJobId": "jm-abc123", "outputDir": "/abs/..." }
// 输出 —— 与 generate 输出结构完全一致（status/outputs/error/progress）
{ "status": "completed", "outputs": [ { "path": "...", "kind": "video", "role": "primary" } ] }
```

---

## 3. 内置 JS 适配器接口

```js
export const manifest = { /* 见第 1 节 */ };

// 与 CLI generate 语义一致：正常 return 等价 exit 0，throw 等价 exit ≠ 0
export async function generate(input) {
  // ... 返回第 2.2 节的输出对象
}

// 仅 async 适配器需要
export async function poll(input) {
  // ... 返回第 2.2 节的输出对象
}
```

---

## 4. 凭据：声明、存储与注入

三层概念严格分离：

| 层 | 存什么 | 是否进 git | 是否含明文 |
|---|---|---|---|
| `manifest.credential` | 适配器*声明*需要什么凭据、支持哪些方式 | 是 | 否 |
| `document.credentials` | 项目*记录*凭据存在哪个钥匙串条目下 | 是 | **绝无敏感明文** |
| 运行时注入 | 平台从钥匙串解出明文塞进 `credential` 入参 | —— | 仅内存 / 子进程 stdin |

- **分级存储**：`fields[].secret = true` 的字段（如 apiKey）UI 用密码框、存系统钥匙串；`secret = false` 的字段（如 endpoint）可明文落 `document.credentials`。
- **钥匙串 account**：全局按 adapterId 共享 —— `drama-creator:<adapterId>`。用户填一次 key，所有项目共用。
- **注入优先级**：
  1. 若 `manifest.credential.env` 声明的环境变量**全部存在** → 走 env 模式：平台不读钥匙串、不注入，`credential` 入参置 `null`，适配器自读环境变量（技术用户 / CI 旁路）。
  2. 否则平台从钥匙串按 account 解出 secret 字段 + 从 document 取非 secret 字段，合并注入到 `credential` 入参。
  3. 明文仅存在于内存与子进程入参，**不写盘、不进 document、不进日志**。

### OAuth 入口

由 `manifest.credential.methods` 声明，UI 据此展示：

- **粘贴 key**（`api_key`）：MVP 主路径，多数平台现状只有此方式。
- **OAuth 授权**（`oauth`）：仅当目标平台开放 OAuth 且适配器声明 `oauth` 配置时可用。OAuth 拿到的 token 同样存入钥匙串，存储/注入规则与 api_key 一致。

---

## 5. 安全责任

- CLI 适配器在用户机器上以**用户权限**运行（与浏览器扩展同等风险模型）。请勿在适配器中做超出生成职责的事。
- **绝不**把凭据明文写入任何文件、日志或标准输出。`credential` 入参仅用于向上游 AI 平台发起请求。
- 输出路径应落在平台给定的 `outputDir` 内。

---

## 6. 一个最小 CLI 适配器骨架

```bash
#!/usr/bin/env bash
# run.sh —— 读取 stdin JSON，输出 stdout JSON，退出码表达是否跑通
input="$(cat)"
# 解析 action / prompt / credential ... 调用上游 AI 平台
# 成功：
echo '{"status":"completed","outputs":[{"path":"raw-videos/out.mp4","kind":"video","role":"primary"}]}'
exit 0
# 业务失败时仍 exit 0，并输出 {"status":"failed","error":{...}}
# 仅在自身崩溃（无法产出合法 JSON）时 exit 非 0
```

---

## 7. 契约版本演进

- `contractVersion` 必填，v1 固定 `"1.0"`。
- 平台采用 **major 兼容策略**：`1.x` 平台可加载所有 `1.y` 适配器，拒绝 `2.x` 并给出明确提示，而非运行中静默崩溃。
- 破坏性字段变更必须升 major；新增可选字段升 minor。
