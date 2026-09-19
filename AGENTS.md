# drama-creator 项目维护规则

## 交流与执行

- 默认使用中文交流，除非用户明确要求其他语言。
- 所有代码更新都需要补充必要注释；注释解释设计原因、边界和安全约束，避免复述代码动作。
- 新增功能或修复行为缺陷时按 TDD 推进：先写能失败的测试，再实现，再跑相关测试和必要的全量验证。
- 任务完成后说明已验证内容和下一步计划。

## 产品边界

- `drama-creator` 是独立应用，不强绑定任何源码仓库、目录结构或创作 skill。
- 不要把 `short-drama skill` 当成 `drama-creator` 的架构规范；它只适用于短剧内容创作流程，不适用于本应用维护。
- 短剧/Seedance 提示词最佳实践应沉淀在应用内可开源模块与文档中，例如 `src/prompting/bestPractices.mjs` 和 `docs/prompt-best-practices.md`；应用运行时不能读取用户本机 `.agents/skills` 路径。
- 用户在项目库中选择或注册的目录才是外部项目 workspace；应用只读取和写回该 workspace 中的项目数据。
- `scripts/episodes/<episodeId>` 只能作为旧导入布局的兼容 fallback，不能作为新功能的核心假设。

## 工作空间与路径规则

- APP 内部状态默认写入 `~/.drama-creator/`。
- 项目注册表写入 `~/.drama-creator/projects.json`，用于记录用户选择过的外部 workspace。
- 全局设置写入 `~/.drama-creator/settings.json`。
- AI 凭据引用写入 `~/.drama-creator/credentials.json`；API key、OAuth access token、refresh token 等密文只允许写入系统钥匙串。
- 每个注册项目在 APP 侧拥有独立缓存：`~/.drama-creator/projects/<projectKey>/resources/`。
- AI 生成产物默认写入 `~/.drama-creator/projects/<projectKey>/resources/generated/<episodeId>/...`。
- 图谱节点只保存 `app-cache/projects/<projectKey>/resources/...` 形式的相对引用，不保存 APP 缓存绝对路径。
- 如果用户自定义资源缓存根目录，自定义目录下仍必须按 `projects/<projectKey>/resources/...` 隔离项目。
- 即梦自动化登录态写入 `~/.drama-creator/browser-profiles/jimeng/`，运行记录写入 `~/.drama-creator/automation/jimeng/runs/<runId>/`；这是应用托管状态，不属于用户项目目录。

## 即梦自动化边界

- 即梦自动化必须模拟真实桌面应用：Drama Creator 打开应用托管浏览器窗口，用户首次在该窗口登录即梦，后续复用应用 profile。
- 不得复用用户日常 Chrome 登录态，不得把 Codex、Chrome DevTools MCP、Browser 插件或 Agent 侧浏览器会话当作产品能力。
- 页面投喂脚本只能连接 Drama Creator 启动的托管浏览器本地 CDP 端口；它可以尝试填提示词和挂载参考文件，但只要资源 chip 未验证，就必须停下让用户处理。
- 自动化只能作为外部跳转提效通道，提交前必须暂停等待用户确认；生成完成后的下载和回填由用户手动触发。

## 安全边界

- 服务端文件访问必须先 `realpath`，再限定在“用户已注册 workspace 或开发期 dev root”内。
- 显式注册项目目录代表用户授权应用访问该 workspace；未注册且不在 dev root 内的路径必须拒绝。
- 资源代理只能服务允许的媒体扩展名，不能退化成通用文件代理。
- 清理或迁移用户项目目录内文件前必须先列出范围并等待用户确认。

## 文档同步

- 影响产品边界、目录规则、凭据位置、缓存位置、适配器契约或安全模型的改动，必须同步更新 README、相关 spec / plan，以及必要的静态回归测试。
- 项目规范优先沉淀在本文件和 `docs/superpowers/specs/`；不要把 `drama-creator` 应用维护规则写入外部创作 skill。
- 影响用户操作路径、页面入口、模型设置、适配器行为、删除/回收站、导出流程或桌面运行方式的改动，必须同步更新项目本地 `.agents/skills/drama-creator/SKILL.md`；全局 `~/.agents/skills/drama-creator` 只保留指向项目本地 skill 的软链。
