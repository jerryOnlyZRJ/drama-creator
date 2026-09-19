# 贡献指南（Contributing to drama-creator）

感谢你对 drama-creator 的关注。本项目的目标是成为一个**通用、可开源的短剧资源管理工具**：非技术创作者可以下载即用地维护与管理短剧素材，技术贡献者可以通过「适配器」自由对接任意 AI 能力（提示词生成、图片/视频生成等）。

本文档面向两类贡献者：

- **核心贡献者** —— 改进内核（资源图谱、画布、导入、校验、服务端）。
- **适配器作者** —— 为某个 AI 平台编写适配器（如 OpenAI 文本、即梦视频），无需改动内核。

---

## 1. 开发环境

开发需要 Node.js/npm；依赖包括 keytar 原生模块，桌面构建另需 Rust 和系统构建工具。当前验证版本见 docs/release-validation.md。

```bash
# 启动本地开发服务器（默认 http://localhost:5173/）
npm run dev

# 运行全量单元测试
npm test

# 构建静态产物到 dist/
npm run build
```

---

## 2. 工程约定

- **模块格式**：全部使用 ESM（`.mjs`）。
- **测试框架**：Node 内置 `node:test` + `node:assert/strict`，测试文件放在 `tests/*.test.mjs`。
- **TDD 优先**：新增功能或修 Bug 时，先写失败测试，再实现，最后确认通过。
- **小步提交**：每个 commit 聚焦单一改动，commit message 采用 Conventional Commits 风格（`feat:` / `fix:` / `refactor:` / `chore:` / `test:` / `docs:`）。
- **注释**：所有代码更新都需完善注释，注释解释「为什么」而非「是什么」；保持单个文件内注释语言风格一致。
- **YAGNI / DRY**：只实现当前需要的功能，不为假设的未来需求过度设计。

提交 PR 前请确保：

```bash
npm test      # 全部通过，0 fail / 0 skipped
npm run build # 构建成功
```

---

## 3. 仓库结构速览

```
src/
  schema/      资源图谱的唯一真理源（节点/边/任务/校验，含适配器契约相关结构）
  import/      素材导入（注：SOP markdown 解析为 legacy，将随 native CRUD 落地移除）
  layout/      画布单向闭包过滤
  feed/        生成入参组装
  checks/      预投喂校验
  server/      零依赖本地服务（含 realpath + registered workspace / dev roots 资源代理安全基线）
docs/
  superpowers/specs/   设计基线（含适配器契约 v1.0 冻结定义）
  adapter-contract.md  适配器契约面向作者的文档（见下）
```

---

## 4. 编写适配器

适配器是平台与任意 AI 能力之间的**唯一边界**，契约稳定且语言无关。两种形态：

- **内置 JS 适配器（builtin）**：导出 `manifest` 与 `generate`/`poll` 的 JS 模块，由平台直接 `import()`，适合官方集成。
- **进程级 CLI 适配器（cli）**：任意语言编写的可执行程序，通过 stdin/stdout 交换 JSON，适合社区用任意技术栈实现。

完整字段定义、调用契约、退出码语义、凭据声明与版本演进规则见 **[docs/adapter-contract.md](docs/adapter-contract.md)**。

> 安全提示：第三方 CLI 适配器在用户机器上以用户权限运行（与浏览器扩展同等风险模型）。请仅安装可信适配器，凭据明文绝不写入项目文件或日志。

---

## 5. 安全红线

- **凭据**：API key / token 等敏感凭据只存系统钥匙串，**绝不**写入 `drama-creator.json`、普通配置文件或日志。提交前请确认 diff 中无任何明文密钥。
- **路径安全**：服务端资源代理必须经过 `realpath` 校验，并限定在用户已注册 workspace 或开发期 dev roots 内，不要绕过该校验。
- **`.gitignore`**：不要提交本地凭据缓存、`node_modules` 或个人环境产物。

---

## 6. 提交 Issue / PR

- 提 Issue 时请描述复现步骤、期望行为与实际行为。
- 提 PR 时请关联对应 Issue，并在描述中说明改动范围与验证方式（贴出 `npm test` 结果）。
- 涉及适配器契约字段变更的 PR，必须同步更新 `docs/adapter-contract.md` 并遵循契约版本演进规则（破坏性变更升 major）。

---

## 许可

本项目以 [Apache License 2.0](LICENSE) 开源。提交贡献即表示你同意你的贡献以同一许可发布。

## 公开内容边界

不要提交作品工程、真实提示词、原始视频、登录态、个人路径或含作品内容的设计图。成果只在 docs/showcase.md 中登记经作者选择的平台观看链接。测试使用虚构最小素材；Mock 结果不能作为真实平台验收依据。
