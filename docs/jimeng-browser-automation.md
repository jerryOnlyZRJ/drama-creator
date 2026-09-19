# 即梦浏览器自动化扩展

即梦自动化是 drama-creator 的外部跳转型素材生产通道，不是 API Key 生成适配器。它面向当前短剧视频生成主路径：用户在即梦 Web 端使用 Seedance，把 drama-creator 中的提示词和参考图快速投喂到页面。

当前版本落地了投喂包 handoff、应用托管浏览器启动器，以及非 MCP 的页面脚本执行器。设置页可以把它作为默认推荐的视频生产路径，但不能把它伪装成 API 模型；用户在镜头页优先点击「提交到即梦生成」，应用会按全局视频模型配置启动托管即梦窗口，仍可通过「投喂信息」手动复制提示词和上传清单到即梦，完成后通过导入外部资源回填。

## 边界

- 使用应用托管浏览器 profile，不要求用户在 drama-creator 里配置即梦 API Key。
- 即梦登录态只保存在 `~/.drama-creator/browser-profiles/jimeng/`，不复用用户日常 Chrome，也不依赖 Codex、Chrome DevTools MCP 或 Agent 侧浏览器登录态。
- 当前版本 drama-creator 通过「提交到即梦生成」直接打开独立即梦窗口，服务端仍会生成投喂包作为自动化输入；自动化随后通过本地 CDP 端口尝试填入提示词和挂载参考文件，并必须在生成按钮前停下。
- 本地 CDP 端口由 Drama Creator 启动的托管浏览器进程创建，只服务该应用 profile，不等同于 Agent 使用 Chrome DevTools MCP 操作用户浏览器。
- `/api/generate` 不执行即梦生成；它会返回 `external_handoff_required`，提示调用投喂包 handoff。
- 自动化执行器负责打开即梦、切到「视频生成 / 用户在设置页选择的 Seedance 页面模型 / 全能参考」、上传参考图，并通过即梦「引用参考」/ toolbar `@` 候选列表把 `@图片N` 替换成真实资源 chip；资源 chip 绑定必须可验证，否则停下交给用户目检处理。
- 音频任务若已绑定项目公共音色，投喂包必须携带已确认的公共音频文件，并选择该文件在即梦「我的音色」中的克隆项。缺少公共文件或克隆项映射时返回 `manual_settings_required`，不得静默退回同类型的即梦内置音色。
- 提交前必须停下等待用户确认；提交成功、生成状态、下载文件都需要可目检证据。
- 下载完成的视频或图片通过「导入外部资源」回填当前镜头。

## 应用托管执行

`POST /api/jimeng/automation/start` 接收与投喂包相同的 `episodePath` 和 `taskId`。服务端会先校验参考文件是否存在，再写入一次运行记录：

- `~/.drama-creator/automation/jimeng/runs/<runId>/feed-package.json`
- `~/.drama-creator/automation/jimeng/runs/<runId>/upload-checklist.txt`
- `~/.drama-creator/automation/jimeng/runs/<runId>/state.json`

默认会打开一个使用 `~/.drama-creator/browser-profiles/jimeng/` 的独立浏览器窗口。首次使用时用户在该窗口登录即梦；后续只复用这个应用 profile。重复启动自动化时，如果托管窗口已经打开且 CDP 端口仍可用，应用会复用现有端口继续检查页面，不再新开第二个即梦窗口，也不会依赖用户日常 Chrome。该机制模拟真实桌面应用流程，不能用用户日常浏览器登录态替代验收。

托管窗口会在视频与音频任务之间复用。每次执行前必须核对当前 URL 的能力类型；视频任务若复用了音频生成页，应先显式导航到投喂包的 `targetUrl`，并把当前 URL 的 `workspace` 参数带到目标能力页。如果当前通用生成页已经丢失 `workspace`，只允许从该受管窗口自己的同域导航历史恢复最近一次项目空间并重新导航；历史中没有可靠记录时继续阻断，不能猜测空间。只有同时确认已进入视频页且仍处于原项目空间，才继续设置模型、比例、时长和参考资源；音频任务反向切换时遵循同一原则。

如果托管 Chrome 被异常结束，profile 里可能残留 `SingletonLock`、`SingletonCookie` 或 `SingletonSocket`。当旧 CDP 端口不可达时，启动器会先清理这些陈旧锁文件再启动新窗口，避免 Chrome 把请求转交给已经不存在的旧进程，导致 `DevToolsActivePort` 无法生成。

页面脚本在填词和上传前必须先处理即梦工作区：

- 关闭不影响生产的营销/剪映绑定弹窗。
- 如果投喂包包含 `workspace.spaceName`，尝试切换到作品元数据指定的即梦空间；空间名必须来自当前激活的即梦会话/空间证据，不能把侧栏或页面正文里出现目标名称当作成功切换；无法确认空间名时返回 `manual_settings_required`。
- 切到「视频生成」。
- 按投喂包里的 `workspace.model` 选择页面模型；当前内置候选为 `Seedance 2.0 mini`、`Seedance 2.0` 和 `Seedance 2.0 Fast`。生成更快的 mini 是普通低风险镜头、短验证片和可后期处理音频镜头的默认值。BGM、歌曲、环境声、画外音和无需可见口型的对白留给后期，不触发模型升级；只有可见角色对白无法后期配音、必须逐字口型同步时，任务才标记 `audioLockRequired: true`、绑定最终 `@音频N` 对白母带，并改用普通 `Seedance 2.0`。`postDubbingAllowed: true` 优先阻止旧锁定标记升级模型；`VIP` 档只能在用户针对当次生成明确授权后选择。
- 音色锁定产物下载后，必须逐项核对公共音色一致性、台词完整性、发声人归属、重复或新增台词、静音边界和口型同步；验收不通过时只导入为候选，不得自动设为当前版本。
- 确认「全能参考」。
- 按投喂包设置比例和时长，例如 `9:16 / 10s`。
- 重复投喂时只清理提示词编辑器外部的上传缩略图。即梦会把编辑器中的 `@图片N` / `@音频N` chip 也渲染成 `reference-item`；这些节点只能由 chip 校验统计，不能当作旧上传素材删除或计入上传数量。

音频页面另有一条独立门禁：公共音色首次进入即梦时，通过托管窗口的「克隆声音」上传大于 5 秒的已确认干净人声；克隆完成后把页面可见的「我的音色」名称记录到公共资产。后续对白任务直接选择该克隆项，既复用公共音色，又避免每次生成都重复创建克隆音色。

页面脚本会返回可读状态：

- `login_required`：托管窗口需要用户先登录即梦。
- `manual_settings_required`：脚本未能自动完成视频生成模式、目标模型、全能参考、比例或时长设置，需要用户先手动确认参数。
- `manual_upload_required`：提示词已尝试填入，但页面没有可用 file input，需要用户按上传清单手动上传。
- `manual_reference_binding_required`：脚本已尝试通过「引用参考」绑定资源，但 `@图片N` 仍是普通文本或 chip 数不足，用户需要在即梦中修复为真实资源 chip。
- `pre_submit_confirmation`：已到提交前确认点，仍需用户人工确认并手动点击生成。


## V1 稳定路径验收要求

当前已验证通过的即梦主链路到 `pre_submit_confirmation` 为止：

1. 镜头页主入口「提交到即梦生成」调用 `POST /api/jimeng/automation/start`；服务端内部生成同一份投喂包，`prompt` 使用单镜头安全提示词，`promptSanitization` 记录被移除的转场/剪辑元信息，且不反写项目里的原始提示词。
2. 自动化使用应用托管 profile 打开或复用即梦窗口，不能复用用户日常 Chrome 或 Agent 侧浏览器；`POST /api/jimeng/feed-package` 仍作为「投喂信息」和人工 fallback 的只读入口。
3. 页面脚本设置「视频生成 / 投喂包指定 Seedance 模型 / 全能参考 / 比例 / 时长」。
4. 页面脚本上传投喂包中的参考图，并通过即梦页面自己的「引用参考」入口把每个 `@图片N` 绑定成真实资源 chip。
5. 自动化返回 `pre_submit_confirmation` 时，必须满足编辑器外部上传缩略图数量与投喂包一致、`chip` 数量与全部参考资源数量一致、raw `@图片N` / `@音频N` 数量为 0；编辑器内部 chip 自带的小图不能重复计入上传缩略图。
6. 当前版本不会自动点击生成按钮。用户目检 prompt、参数和资源 chip 后，手动点击即梦生成。
7. 生成后用户手动下载视频，再回到 Drama Creator 通过「导入外部资源」回填到当前分镜。

这条路径是 V1 的可维护基线。后续如果即梦页面 DOM 变化导致 chip 绑定失败，执行器必须降级到 `manual_reference_binding_required`，不能把普通文本 `@图片N` 当成已绑定资源提交。

## 投喂包

`POST /api/jimeng/feed-package` 接收：

```json
{
  "episodePath": "/abs/path/to/episode",
  "taskId": "task:video:s001:v001"
}
```

返回的 `package` 包含：

- `targetUrl`：即梦视频生成入口。
- `workspace`：固定目标模式为「视频生成 / 全能参考」，模型通常来自设置页的即梦页面模型选择；仅当任务明确要求无法后期解决的可见角色对白口型锁定、确实绑定对白母带且 `postDubbingAllowed` 不为 `true` 时，模型策略才写为 `forced_audio_lock_prefers_seedance_2_0` 并选择普通 `Seedance 2.0`。页面校验必须把普通版与 `Seedance 2.0 VIP` 严格区分；`spaceName` 来自作品元数据的项目级「即梦空间」。
- `prompt`：面向单镜头生成的安全提示词。投喂包会移除独立成行的剪辑/转场元信息，例如 `转场到 s003` 或 `Transition to ...`，但不会反写项目里的原始提示词。
- `promptSanitization`：记录本次是否移除了非单镜头元信息，以及被移除的原文，便于目检和排查。
- `references`：视频任务按图谱边顺序生成 `@图片1`、`@图片2` 等上传清单；已绑定公共音色的音频任务包含一条 `public_voice_reference` 音频证据，供克隆音色门禁校验。
- `warnings`：提示词缺少 `@图片N` 绑定时给出人工确认提示。
- `gates`：参考图检查、绑定检查、提交前确认、提交成功检查、下载校验。

镜头页主按钮是「提交到即梦生成」；「投喂信息」弹窗同时提供「复制提示词」「复制上传清单」「复制投喂包 JSON」三种操作。「复制上传清单」面向人工 fallback，会展开目标页面、模型、比例/时长、每个 `@图片N` 的本地文件路径、提交前检查，以及生成后通过「导入外部资源」回填 MP4 的步骤。

这个设计让用户可以先目检投喂内容，也让应用托管自动化执行器有稳定输入格式。
