---
name: drama-creator
description: Operate and maintain the local Drama Creator desktop/web app. Use when Codex needs to run, install, inspect, test, debug, or explain drama-creator; work with ~/.drama-creator projects, episodes, shots, resources, model settings, adapters, Jimeng feed packages, trash, or export; or keep the app workflow documentation in sync.
---

# Drama Creator

## First Checks

- Work from the repository root containing this skill.
- Treat `.agents/skills/drama-creator/SKILL.md` inside the project as the source of truth. The global `~/.agents/skills/drama-creator` entry should only be a symlink for agent discovery.

- Treat this skill as a fast operating guide, not the source of truth. If current code or docs disagree with this skill, trust the repo and update this skill in the same task.
- Treat `docs/prd-drama-creator-redesign.md` as the product-level source of truth; use `docs/v1-production-closed-loop.md` and `docs/adapter-contract.md` for lower-level implementation detail.



- Keep `drama-creator` independent from the `short-drama` repo and `short-drama` skill. That skill is for content creation, not for app architecture.
- Do not make the app runtime read local agent skill paths. Short-drama and Seedance best practices belong in app-owned modules/docs such as `src/prompting/bestPractices.mjs`.
- Do not expose API keys, OAuth access tokens, or refresh tokens. Secrets belong in the OS keychain only.

## App Model

- `项目`: one AI video work or series.
- `分集`: one independently exportable episode. New projects create `ep001` by default, but users can add more episodes in the project page.
- `分镜`: the smallest production unit; each shot should map to one video clip of 15 seconds or less.
- `公共资产`: project-level reusable character, location, prop, style, audio, and video references.
- `分镜资产`: shot-local references, generated/imported images, video candidates, and outputs. Manage these in the shot canvas.
- `成片`: one episode exported by concatenating the current video version of each shot.

## UX Copy Rules

- All user-facing buttons, inputs, descriptions, status messages, error messages, empty states, dialogs, and form controls across the whole app must use non-technical creator-facing language. This applies to the project library, project workflow, public assets, shot videos, shot canvas, settings, trash, export, and all setup/fallback flows.
- Do not expose engineering terms such as `adapter`, `schema`, `JSON`, `CDP`, `localhost`, absolute filesystem paths, or internal IDs in the main flow. If technical details are needed for advanced users or debugging, put them in a default-collapsed `高级 / 排障信息` area.
- Do not make standalone always-visible tutorial, operation-guide, tips, or creator-coach modules in production screens. Workflow clarity should come from the step rail, section titles, badges, empty states, inline status/error copy, and direct action buttons. Longer help belongs behind an explicit help entry or collapsed advanced area.
- Top app-bar breadcrumbs must be centered against the full window, not centered within the remaining space between the brand and action buttons. Use symmetric left/right header columns on project, library, trash, and shot-canvas pages.

## Storage Rules

- App state defaults to `~/.drama-creator/`.
- App-owned projects default to `~/.drama-creator/projects/<projectId>/`.
- Project manifest: `<projectRoot>/project.json`.
- Episode document: `<projectRoot>/episodes/<episodeId>/drama-creator.json`.
- Global settings: `~/.drama-creator/settings.json`.
- Credential references: `~/.drama-creator/credentials.json`; this file must not contain secret plaintext.
- Resource cache uses project isolation under `~/.drama-creator/projects/<projectKey>/resources/`, or `<customRoot>/projects/<projectKey>/resources/` when customized.
- Jimeng managed browser profile: `~/.drama-creator/browser-profiles/jimeng/`. This is app-owned login state, not the user's daily Chrome profile.
- Jimeng automation runs: `~/.drama-creator/automation/jimeng/runs/<runId>/`, containing the feed package, upload checklist, and state for inspection/debugging.
- Trash lives under `~/.drama-creator/.trash/`. App deletion moves items there first; permanent deletion happens from the trash page/API.
- Destructive desktop actions must use in-page confirmation UI, not native `window.confirm`: project cards use two-click confirmation, episode/resource deletion uses visible two-click confirmation, and the trash page/settings page use page-owned confirmation panels or buttons.

## Running And Installing

- Web dev server:
  ```bash
  cd /path/to/drama-creator
  npm run dev
  ```
  Open `http://localhost:5173/`.
- Static build: `npm run build`.
- Tauri app build: `npm run build:tauri -- --bundles app`.
- Packaged app does not require the user to install Node. The server runs through the bundled Tauri sidecar `drama-creator-server`; `tauri dev` can still fall back to system Node.
- The packaged Tauri shell declares a hidden `main` window in `tauri.conf.json`, starts the sidecar, waits for `127.0.0.1:5173`, then navigates/shows/focuses that window. Keep `ActivationPolicy::Regular` and `app.show()` so macOS exposes a visible app window.
- The packaged sidecar must include keytar's native addon via `package.json` `pkg.assets`: `node_modules/keytar/build/Release/keytar.node`. If this is missing, settings can show model credentials as configured while AI calls fail because the packaged server cannot read system keychain secrets.
- `scripts/build.mjs` must ship only browser-side ESM files that are actually imported into `dist`; do not copy server-only modules such as `src/workflow/videoVersions.mjs` or `src/feed/generateInput.mjs`.
- Tauri's DMG bundle step may clean `target/release/bundle/macos/Drama Creator.app`. To reinstall locally after `npm run build:tauri`, mount `src-tauri/target/release/bundle/dmg/Drama Creator_0.1.0_aarch64.dmg`, copy `Drama Creator.app` into `/Applications`, then detach the DMG. Do not keep a second `~/Applications/Drama Creator.app` copy because desktop UI inspection can confuse two bundles with the same identifier.
- Before claiming completion, run relevant focused tests plus `npm test` when the change touches shared behavior. For desktop acceptance, also run build and visually inspect the relevant page.

## Page Map

- Project library: `/index.html` or `/`.
  - Shows recent/app projects.
  - Creates new app-owned projects from a compact dialog. The dialog should ask for project name, start mode, and source text/idea only; it must not ask for the first episode name because `第 1 集` is created automatically.
  - Project cards are clickable and navigate into the project directly; do not add a separate `打开` button on each card.
  - Deletes app projects by moving them to trash; external registered projects are only removed from records.
  - Project delete uses a compact trash icon button with in-page two-click confirmation instead of native browser confirm dialogs, so the packaged desktop app keeps destructive actions visible without crowding each card.
- Settings: `/settings.html`.
  - Storage/trash summary.
  - Model settings grouped by capability: text, image, video, audio.
  - Authorization methods that need settings are generic: subscription authorization, API Key, and browser automation. Manual external generation is not a settings method.
  - Do not render a standalone production-mode legend or large OAuth notice banner. Method chips may show `内置生成`, `外部跳转`, and `默认推荐`; longer compliance copy belongs in `合规说明`, and 合规说明默认收起.
  - The PRD prototype is 本文对应页面的文字要求; keep text/image/video/audio capability sections grouped by configurable/executable method, keep provider presets as API Key prefills rather than separate top-level categories, and route business-page setup links to anchors such as `settings.html#model-text`.
- Project workflow: `/project.html?path=<projectRoot>`.
  - Four top steps: `剧本与分镜`, `公共资产`, `分镜视频`, `成片导出`.
  - Opening a project defaults to `剧本与分镜`; only an explicit `step` URL parameter may open another top step. Treat persisted `workflow.currentStep` as production progress metadata, not as the last-view navigation state.
  - Episode controls appear only on episode-scoped steps (`剧本与分镜`, `分镜视频`, `成片导出`). The project-level `公共资产` step must hide episode controls and the `新建分集` button. Step 3 `分镜视频` uses one episode dropdown plus a right-aligned `新建分集` button; do not also show ep001/ep002 chip or icon lists there.
  - Users can create new episodes from episode-scoped steps. The only episode cannot be deleted; delete the project instead.
- Shot canvas: `/shot.html?path=<episodePath>&shot=<shotNo>`.
  - Three columns: script, assets, outputs.
  - The PRD prototype is 本文对应页面的文字要求. Treat it as a production workspace, not a debug graph: top shot actions, three resource-family columns, right detail/QC inspector, and bottom status/zoom must stay visible.
  - The shot-canvas header uses two rows: row 1 keeps brand and centered breadcrumbs only; row 2 is the shot action toolbar split into navigation actions and production actions. Do not put the full button group back into the breadcrumb row, because long Chinese actions will overlap the centered breadcrumb on desktop widths.
  - Supports returning directly to Step 3 `分镜视频` management, previous/next shot, adding/replacing/reordering/removing existing reference images, external resource import, direct Jimeng submission through the globally configured browser-automation video default, Jimeng feed information as manual fallback, media preview/playback, explicit `详情/QC` selection for media cards, resource deletion, and QC.
  - Same-shot historical videos, assembly previews, rejected attempts, and manually imported candidates must not appear as visually orphaned output cards. If they are not formal `generates` outputs, connect them back to the shot script/current production context with a muted same-shot supporting relationship and label them as preview or legacy references without promoting them to the current version. The supporting relationship must be visually legible at normal zoom through card badges or line labels, not only a faint unlabeled edge.
  - The inspector prompt area must be explicitly labeled `提示词`, support inline editing/saving of the raw prompt, provide a direct `引用资源` action, and may translate raw platform placeholders such as `@图片N` / `@音频N` into readable resource-name mentions such as `@镜头 s001` in read mode. Edit mode, stored prompt text, and feed packages must keep the original media placeholders so Jimeng reference binding order remains stable.
- Trash: `/trash.html`.
  - The PRD prototype is 本文对应页面的文字要求; keep this as a global app page, not a project workflow step.
  - Restore trashed projects, episodes, or resources.
  - Permanently delete individual trash items or empty all trash.
  - Keep space summary, search, type filters, item restore, item permanent delete, detail inspector, and clear-trash confirmation visible with non-technical copy.
  - Restoration, permanent deletion, and empty-trash confirmation must stay in the page UI so the packaged desktop app never hides destructive context behind a browser/system dialog.
- Export path resolution:
  - Shot video outputs may be episode-relative, such as `raw-videos/s001.mp4`, or project-root-relative, such as `assets/videos/s001.mp4`.
  - Export must try the episode directory first, then the project root derived from `episodes/<episodeId>`.
  - Rejected, stale, or explicitly unselected shot videos must not be selected by preview/export legacy fallback. Keep them visible as history/evidence in the shot canvas when useful, but do not let them re-enter the episode timeline after a rerun decision.
  - Export normalizes AI clips through ffmpeg before concatenation; do not use raw stream-copy as the primary path because mixed AI outputs can produce broken timestamps.
  - If subtitle burn-in fails because the local ffmpeg lacks the subtitles filter, keep the original MP4 and SRT, return a warning, and surface it in the project page.
  - Subtitle burn-in warnings are shown directly to creators. Keep those warnings non-technical, and do not include raw ffmpeg stderr, filter names, command arguments, or absolute paths in the main export result.
  - Exported filenames use creator-facing labels such as `正式版`, `草稿版`, and `字幕版`; do not expose raw status tokens such as `final`, `draft`, or `subtitled` in files shown to the user.
  - Rebuilding a shot-stitch preview may overwrite the same creator-facing MP4 path. The preview API must return a revision derived from the resulting file, and the project page must append that revision to the `/api/asset` URL so the packaged WebView does not replay a stale full-file or Range cache.

## Product Workflow

1. Start on the project library and create a project. Do not design V1 around importing old `drama-creator.json` projects.
2. Step 1 `剧本与分镜`: `作品元数据` sits above the writing workspace and shows readable project/episode summary plus editable project-level `核心立意`, `全局设定`, and `即梦空间`; save them to the project manifest so every episode shares the same creative intent, character/location/prop overview, and Jimeng target space. Global character tables, location lists, key prop lists, production dependencies, and asset notes belong in metadata or the public-asset flow, not inside every shot script. Below metadata, use a same-height two-card comparison workbench: `故事源` and `分镜剧本`. On desktop, these two cards sit side by side so creators can compare the pure story against the shot-by-shot storyboard script; each card's content area scrolls internally to avoid large blank regions. On medium or narrow screens, collapse the cards to a single column. Paste story/source text or import a local text file in `故事源`; story source must stay as pure narrative prose only, and must not include lens language, shot numbers, scene headings, production notes, video prompts, or asset dependencies. `分镜剧本` is the only visible script surface: each block should read as `## S001 分镜｜10s｜标题`, followed by only that shot's readable script content such as picture/action, dialogue/voice-over, and sound. Do not show `完整剧本上下文`, `分镜执行要求`, `覆盖细分镜`, scene-node IDs, dependency IDs, or generation notes in this card. The visible action should be `生成分镜剧本`; it may internally generate an intermediate draft before splitting, but users should experience one flow from story source to editable storyboard script. When no AI capability is configured, keep the action visible as setup-needed with manual write/paste fallback. Saving the storyboard script synchronizes shot numbers, titles, durations, shot-level `scriptText`, script nodes, video prompts, and video tasks. Deleting a shot must use in-page secondary confirmation and immediately reindex the remaining blocks; manual up/down order controls are intentionally omitted. Downstream shot video/canvas/export flows should use the saved shot-level storyboard script as the source for prompt generation. If old episode data lacks readable shot-level script text but has video prompts, the app may backfill readable shot script text from the existing prompt content without reading external source-repo paths.
3. Step 2 `公共资产`: review the project-level public asset library with type tabs and search only. Do not show `已绑定 / 未绑定` or other second-row status/source filter tags, and do not show episode list/chip controls on this page. The page must provide a direct `从剧本生成公共资产` action that reads the current saved episode script and creates editable character, location, prop, and style candidates before users bind or upload media; if the script has not been saved, show a clear return-to-script/save-script message instead of silently doing nothing. Selecting any public asset opens a detail inspector in the same page; on desktop this inspector must scroll independently so users can inspect/edit the full form without scrolling the asset list to the page bottom. Users must be able to edit name, category, status, required/optional, description, prompt, reference assets, tags, linked shots, usage roles, and source path. Saving updates the public asset record itself; do not copy it into shot-local assets. Reference assets in the public asset record are editable asset-name tokens; only explicit shot/resource binding writes graph edges. Image public asset cards and detail previews must support click-to-enlarge inspection without leaving the page, with an in-page close control and Escape-to-close behavior. Public asset detail must also support moving an asset to trash with an in-page two-click confirmation; if the file is still referenced by shot nodes, block file deletion and tell the user to remove those shot references first. Audio references in public asset cards and the detail inspector must use an audio-themed artwork/voiceprint preview instead of a generic placeholder, and playback must be page-coordinated: one audio plays at a time, audio controls must not bubble into card selection, and re-rendering must pause any active audio so detached elements do not keep playing. This is not a hard gate; missing assets should guide quality, not block all progress. Information-bearing props such as program lists, notebooks, sticky notes, phone notifications, blackboard text, posters, letters, certificates, and title cards must have one real, fictional, readable reference version before they are used for image/video generation. Do not rely on blank carrier images as the main public asset because they weaken Jimeng's semantic understanding; keep blank carriers only as explicit post-production templates. Render exact Chinese text locally or through a controlled design tool when precision matters, and avoid real school names, real platform brands, real private data, logos, or watermark-like UI. For legacy `scripts/assets/style-refs`, only explicitly project-level style anchors belong in the public library; shot keyframes, tail frames, title cards, UI screenshots, and other single-shot generated assets stay in the shot page/canvas unless the user promotes them to public assets.
4. Step 3 `分镜视频`: use shot cards as the main view. Status belongs on each card as a badge, not as a separate task table. Main UI status badges should stay creator-facing and compact: `未生成`, `准备投喂`, `处理中`, `待质检`, `需重跑`, `已通过`; intermediate automation/download/backfill task states can stay internal but must be merged into `处理中` on cards and filters. Shot-card covers must only come from that shot's generated/imported video output or shot-specific keyframe/reference-frame asset; never fall back to public character, location, prop, style, audio, or other prompt references, because ungenerated shots would otherwise display reusable resources as misleading video covers. If this page uses an episode dropdown, do not duplicate it with an episode chip/icon list; keep `新建分集` on the same row, right aligned. If the episode script is missing, unconfirmed, or not split into shots yet, show a fallback state with a primary `返回剧本与分镜` action instead of an empty grid.
5. Open a shot canvas for production work. The primary action should submit the current shot to Jimeng through the globally configured `jimeng-browser-automation` video default; the app still generates a feed package internally and stops before the final generate button for user confirmation. Keep `投喂信息` as the manual copy/checklist fallback, then import the generated image/video back into the current shot. Shot-canvas audio resources must follow the same one-at-a-time playback rule as public assets.
6. Imported shot videos enter `videoVersions.candidate` first. The user must explicitly choose `设为当前版本`; only the current video is used for QC propagation and episode export. The previous current version becomes the candidate comparison version. For legacy data with an empty `current` slot and no candidate, an existing old `video_output` can still be treated as the exportable cut so imported projects do not appear empty.
7. QC the current shot output as `待质检`, `需重跑`, or `已通过`.
8. A single-shot acceptance is complete only after the creator reviews both the current shot and a contiguous `S001`-through-current-shot assembly. Generate the stage assembly after every accepted shot, register it in Drama Creator as an `assembly_preview`, expose it in the app, and also deliver the local video file for direct review. Preserve every source clip's complete head and tail; do not shorten a shot to repair a seam. A short overlap transition is allowed only when it keeps complete decoded-frame coverage and the creator confirms the result. Do not begin producing the next shot until both the current shot and the updated stage assembly have been accepted.
9. Step 4 `成片导出`: export only from the export step. Missing video blocks final/draft file export with creator-facing Chinese copy such as `缺少 N 个分镜视频，补齐后才能导出成片`; never surface raw English errors like `Missing videos`. While videos are still missing, the page may generate a `分镜拼接预览` for review by stitching every currently available shot video in storyboard order. If a manually tuned assembly video is marked with `metadata.role = "assembly_preview"` and `metadata.exportPreferred = true`, it becomes a solidified timeline repair: full-episode assemblies can replace auto-stitching directly, while partial transition fixes such as `S001-S002` must replace their covered shot range inside the preview timeline before later shots are appended. This preserves historical edit fixes without letting partial cuts hide the rest of the storyboard. This must not mark the episode exportable or bypass the missing-video gate. Existing preview files should be restored as playable previews when the export page is reopened, and users can explicitly regenerate them. Unreviewed or rerun-needed shots can export draft outputs with warnings, while all-approved shots export final outputs.
   SRT and subtitle preview must extract only explicit `旁白` / `对白` / `台词` / `字幕` lines. Do not burn video prompts such as duration, lens, `@图片N`, camera movement, or sound-effect notes into the user's subtitle file.

## Model And Adapter Rules

- Prompting best practices are built into the app, not loaded from external agent skills:
  - `src/prompting/bestPractices.mjs` owns the versioned production flow, system prompt, and quality checklist.
  - `PROMPT_BEST_PRACTICES_VERSION` is currently `drama-creator-prompt-best-practices.v6`; it distills short-drama production, Seedance/Jimeng prompting rules, model selection and visible-dialogue lip-sync policy, positive-first stability locks, and information-bearing prop reference gates into app-owned, open-source-friendly guidance.
  - Storyboard splitting uses those rules to create Seedance/Jimeng-ready video prompts.
  - `buildGenerateInput()` includes `systemPrompt` and `promptGuidance`; text adapters must pass `systemPrompt` as system/instructions.
  - `promptGuidance.source` must be `app_builtin`, and `promptGuidance.runtimePolicy.readsLocalAgentSkills` must be `false`.
  - The built-in V2 flow is `故事源 → 剧本草稿 → 分镜拆分 → 资产依赖矩阵 → 公共资产库 → 分镜参考资源 → 提交到即梦生成（投喂信息兜底） → 分镜视频 → 质检 → 成片导出`.
  - Video guidance must cover the first-2-second hook, director judgment, spatial staging, @ resource chip binding, prompt-pollution scan, positive stability locks, and narrow platform-layer constraints such as no BGM, subtitles, logo, or watermark.
  - Jimeng feed packages include `promptGuidance` alongside ordered references, warnings, and gates.
- The adapter layer has two production modes:
  - `in_app`: the app calls an AI platform or subscription endpoint directly.
  - `external`: the user jumps to an external platform and imports results back; the app may provide feed packages or automation.
- Never hide AI-related actions just because credentials, subscription authorization, provider setup, or browser automation are missing. Show a setup-needed or unavailable state in the same UI context, link to the relevant model/provider setup, and provide a manual fallback such as manual editing, prompt/feed-package copy, external generation, manual import, or resource backfill.
- Manual external generation/import is the final fallback after all configured or executable paths are unavailable or fail. Do not model it as a credential/provider setting, and do not require users to configure it on the settings page.
- Subscription authorization is a generic authorization method, not synonymous with ChatGPT. Current text subscription implementation is `openai-codex-oauth`.
- Subscription authorization and verified API Key model choices must come from app/provider-verified candidates and render as a model dropdown in settings. Do not ask creators to type model IDs when a catalog is available; free-form model IDs are only a fallback for API Key custom endpoints or providers that cannot list models.
- New project creation supports `idea_text`, `story_text`, and `material_text`. `idea_text` is the shortest path: the user can enter one idea, then the app expands it into a complete story with the text model before creating the first episode; if no text model is configured, keep the button visible, link to `settings.html#model-text`, and let the user manually write the complete story.
- Text defaults should prioritize subscription authorization when no user-saved text default exists, then API Key providers such as OpenAI, Claude, DeepSeek, Qwen, Doubao, Kimi, GLM, Gemini, Grok, and local Ollama. If the user explicitly saves a text default, that default is a source-of-generation promise: text generation must use that selected model or report why it cannot, and must not silently switch to another provider. If every available text channel is unavailable / 订阅授权和 API Key 都不可用, text AI entry points such as idea-to-story generation, script draft generation and storyboard splitting must stay visible with a `去配置` button to `settings.html#model-text` plus manual writing/splitting fallbacks.
- A broken or missing keychain secret for a non-explicit text candidate is not a fatal app error. Treat that candidate as unavailable and continue to the next configured text channel. For a user-saved default text model, surface the unavailable/failed state directly instead of falling back to another provider.
- When a model credential record exists but its keychain secret is missing, the settings page must not present it as usable. Highlight it as needing reconfiguration, show a concrete `下一步：...` recovery sentence, and keep the direct action button visible (`重新登录订阅账号` for subscription authorization, `更新 API Key` for API-key channels). AI entry-point failures such as `生成草稿` must likewise show a real button to the settings page, not only inline text that desktop accessibility may merge into non-actionable copy.
- `openai-codex-oauth` must keep the fixed `1455` callback port required by the upstream OAuth redirect URI. Repeated subscription-login clicks should cancel the previous app-owned pending callback listener before starting a new one; show a port-occupied error only when an external process owns the port. In the packaged desktop app, subscription-login buttons must open the server-returned authorize URL through an app-owned Tauri command with an allowlisted OAuth domain, not bare `window.open`, and must show visible feedback if the login page cannot be opened.
- Image defaults should prioritize GPT Image via API Key today; image subscription is not available until implemented.
- Video defaults should prioritize `jimeng-browser-automation` as an external Jimeng/Seedance path. Current recommended Jimeng default is `seedance-2.0-mini` (`Seedance 2.0 mini`) for fast, low-risk shots, visual/review probes, and shots whose audio can be replaced in post-production. Mini is the speed-first default; standard `Seedance 2.0` is reserved for visible character dialogue that cannot be repaired by post dubbing and therefore needs word-level lip sync. API Key video options include Volcengine Ark Seedance and MiniMax when configured.
- BGM, songs, ambience, voice-over, off-screen dialogue, and dialogue without visible lips should be added or replaced in post-production. These uses must not set `audioLockRequired`; they keep the configured video default even when an audio reference is present. If a migrated task carries a stale lock marker, set `postDubbingAllowed = true` so the feed package does not upgrade it to standard 2.0.
- Only a shot with visible character dialogue that must preserve an approved public voice and cannot be solved by post dubbing may set `task.metadata.audioLockRequired = true` (legacy `modelPolicy: audio_reference_uses_seedance_2_0` remains supported) and bind the final approved master as at least one `@音频N` reference. Its Jimeng feed package must override mini with standard `seedance-2.0` (`Seedance 2.0`). Never select a `VIP` model variant unless the user explicitly authorizes the higher-cost tier for that exact generation.
- When a visible-dialogue lip-sync shot is expensive or still uncertain, first generate the shortest useful validation clip with the same approved voice master, active visual references, and standard `Seedance 2.0`; a successful validation does not authorize trimming, splicing, promoting, or replacing a formal shot without user approval. After generation, QC must compare the output against the approved public voice and verify every spoken line, speaker assignment, repeated or invented words, silence boundaries, and lip sync. Any mismatch remains a candidate and must not become current automatically.
- Audio defaults should prioritize `jimeng-browser-automation` as an external Jimeng path. Current recommended Jimeng audio default is `jimeng-audio` (`即梦音频生成`), kept separate from Seedance video model ids so settings and handoff logic do not confuse voice/audio generation with video generation.
- Jimeng audio handoff files should separate `音色来源`, `输入框台词`, and `听感目标`: the Jimeng `配音生成` textarea receives only the spoken dialogue, while style briefs, role boundaries, and QC notes stay in project prompt/card files. When using built-in voices, record the visible voice label such as `气质阿姨` or `慈祥奶奶`, archive downloaded candidates into `scripts/assets/voices/references/`, and mark newly generated voice assets as pending user audio QC until the user approves the sound. When a downstream dialogue task already links an approved project-level public voice, that public audio is the required source of truth: use its Jimeng `我的音色` clone mapping, include the source file in the feed package evidence, and block with `manual_settings_required` if the file or clone mapping is missing. Never silently fall back to a similar built-in voice, because type similarity does not preserve cross-shot timbre consistency.
- Jimeng browser automation model ids must mirror visible Jimeng page options, not arbitrary free text. Current built-ins are `seedance-2.0-mini` (`Seedance 2.0 mini`), `seedance-2.0` (`Seedance 2.0`), and `seedance-2.0-fast` (`Seedance 2.0 Fast`). The selected model must be written into the feed package and selected in the managed Jimeng page before prompt filling.
- Model verification must distinguish standard `Seedance 2.0` from `Seedance 2.0 VIP`; a shared name prefix is not sufficient evidence. Before submission, the automation status must show the exact visible toolbar variant, ratio, and duration.
- Jimeng审核/风控验证片默认使用当前页面可见的最低时长档位，并在托管窗口实际确认选项；2026-07 实测视频时长下拉最低为 `4s`、最高为 `15s`。验证片只用于定位审核或参考素材问题，优先使用少量低风险参考资源，不得把验证片时长误写回正式分镜正片时长。
- If an adapter has `productionMode: "external"`, `/api/generate` must return `external_handoff_required` instead of creating a failed job.
- Settings provider templates are only prefills for endpoint, docs, API-key links, and default model id. Always include a custom option for user-managed endpoints.
- Model settings UI must keep Claude, DeepSeek, Qwen, Doubao, Kimi, GLM, Gemini, Grok, Ollama, and similar providers inside the API Key path. Do not split them into standalone authorization categories unless the product spec adds a new generic authorization method.

## Common APIs

- `GET /api/projects`: list projects.
- `POST /api/projects/create`: create an app-owned project with `name`, optional `firstEpisodeName`, `startMode`, and `sourceText`. The public new-project UI should omit `firstEpisodeName` and let the server default to `第 1 集`.
- `POST /api/story/generate`: expand a one-sentence idea into a complete story with the configured text model; when text models are unavailable, return `settings.html#model-text` and manual fallback metadata.
- `POST /api/script-draft/generate`: generate an episode script draft from story source text with the configured text model; when text models are unavailable, keep manual writing available and return `settings.html#model-text`.
- `POST /api/projects/episode`: add an episode to an app-owned project.
- `DELETE /api/projects/episode`: move an episode to trash; forbidden when it is the only episode.
- `DELETE /api/projects`: move app-owned projects to trash or unregister external records.
- `GET /api/episode?path=<episodePath>` and `PATCH /api/episode`: read/write the episode document.
- `GET /api/library?path=<projectRoot>`: list public library items.
- `POST /api/library/generate-from-script`: generate editable public asset candidates from the current saved episode script and write them into the episode document.
- `DELETE /api/library/item`: move an unreferenced project-level public asset file to trash and remove its public asset record from the current episode document.
- `GET /api/asset?episode=<episodeOrProjectPath>&path=<relativePath>`: serve allowed media.
- `POST /api/manual-assets/import`: import a user-selected image/video/audio/text into the current shot.
- `POST /api/episode/references`: attach an existing image asset to the current shot prompt without copying the file.
- `PATCH /api/episode/references`: reorder current shot prompt reference edges with `orderedAssetNodeIds`, or replace one reference slot with `referenceEdgeId + assetNodeId`; edge order controls Jimeng `@图片N`.
- `DELETE /api/episode/references`: detach a reference edge only; do not delete the asset file or public asset node.
- `POST /api/episode/video-version/current`: promote a candidate `video_output` to the shot's current version; export chooses only the current video when `shot.videoVersions` exists.
- `DELETE /api/episode/resources`: move a selected resource to trash and remove graph references.
- `POST /api/jimeng/feed-package`: create a Jimeng handoff package for a video task.
- `POST /api/jimeng/automation/start`: validate the feed package references, write an app-owned automation run, open the managed Jimeng browser profile, and return both the automation run state and the feed package for in-page review.
- `POST /api/export/episode`: export original, subtitled video, and SRT for one episode.
- `POST /api/export/preview`: create a review-only MP4 by stitching currently available shot videos in shot order; missing shots are skipped and formal export readiness is unchanged. Preferred full-episode assemblies can be returned directly; preferred partial assemblies are treated as fixed timeline segments and replace the individual shot videos they cover.
- `GET /api/adapters`, `GET /api/credentials`, `PUT /api/credentials/<adapterId>`, `DELETE /api/credentials/<adapterId>`: manage non-secret credential refs and keychain-backed secrets.
- `POST /api/credentials/oauth/start` and `GET /api/credentials/oauth/status`: subscription OAuth start and polling.
- `GET /api/trash`, `POST /api/trash/restore`, `DELETE /api/trash/item`, `DELETE /api/trash`: inspect, restore, permanently delete, or empty trash.

## Jimeng Handoff

- Jimeng is an external browser-automation path, not an API Key adapter.
- Current stable path is the shot-canvas primary action `提交到即梦生成`, which calls `/api/jimeng/automation/start`, uses the app-managed browser launch, and keeps the returned feed package plus automation status visible in the page. Feed-package handoff remains the manual fallback for prompt/reference inspection and copy. If in-page scripting is unavailable, guide the user to copy prompt/reference order manually.
- The automation status shown in the shot page must explicitly say that the filled prompt is in the Drama Creator managed Jimeng window, not in the user's daily Chrome/Jimeng tab, and should surface uploaded-reference count, bound resource-reference count, and remaining raw `@图片N` / `@音频N` count when available.
- A feed package contains target URL, workspace intent, project-level Jimeng `spaceName`, single-shot-safe prompt, prompt guidance, ordered image/audio references, warnings, and gates. Image placeholders use `@图片N`; audio placeholders use independent `@音频N` numbering so adding voice references never changes existing image reference order.
- Jimeng feed packages must include only active usable reference edges. Edges marked diagnostic, rejected, inactive, rerun-needed, or otherwise non-active are evidence only and must not enter the upload order, because stale tail frames or rejected assets can silently become `@图片1`.
- Jimeng feed package reference order must prefer explicit edge roles such as `@图片1`, `@图片2`, `@图片3`, or `@音频1` over raw graph insertion order. Corrected references are often appended after older edges, so the upload order must remain stable from the visible placeholder contract, not from JSON edge position.
- For sequential shots, `@图片1` is a strict continuity contract: it must be the physical final frame extracted from the previous shot's approved current video. Do not replace it with an earlier, cleaner, or more semantically useful frame. If the previous video's last frame loses a required character or state, repair/trim/regenerate the previous video first, promote that repaired video to current after user approval, then extract its physical final frame for the next shot. Until then, block the next shot from Jimeng submission instead of feeding a substitute tail frame.
- `workspace.modelId` / `workspace.model` in the Jimeng feed package come from the app's video model default. Keep them aligned with the Jimeng page model labels and automation target.
- `workspace.spaceName` in the Jimeng feed package comes from the project manifest field `jimengSpaceName`; it is a per-project target, not a global model setting.
- In user-facing UI, the top-level generation action should be `提交到即梦生成`; use "投喂信息" and "上传清单" for fallback inspection/copy. Expose full feed-package JSON only under an advanced/troubleshooting disclosure, not as the non-technical main path.
- Jimeng feed packages may remove standalone editing metadata such as `转场到 s003` or `Transition to ...` from the handoff prompt. Record the removed lines in `promptSanitization`; do not mutate the source project prompt automatically.
- The shot page exposes `复制上传清单` for manual fallback; it includes target URL, model, ratio/duration, ordered upload paths, pre-submit checks, and the post-generation `导入外部资源` backfill step.
- Automation uses the app profile at `~/.drama-creator/browser-profiles/jimeng/`. First-time Jimeng login happens in the window launched by Drama Creator, then that app profile is reused.
- Repeated automation starts should reuse the managed browser CDP port when that app-owned window is already open and reachable; do not spawn a second Jimeng window in that case.
- Managed-window reuse crosses audio and video tasks. Before any video setup or upload, verify the current page capability from its URL; if the reused window is still on an audio-generation URL, navigate to the video feed package `targetUrl` while preserving the current `workspace` query parameter. If a generic managed page has already lost that parameter, recover only the most recent same-origin project workspace from the managed window's own navigation history and navigate again; if no reliable history exists, stay blocked instead of guessing. Verify both the video page and retained project space before continuing. Apply the inverse rule when an audio task reuses a video page.
- If the managed browser was killed and its CDP port is unreachable, clear stale Chrome `SingletonLock`, `SingletonCookie`, and `SingletonSocket` files before starting a fresh app-owned Jimeng window.
- The app can connect to the managed browser's local CDP port to close non-production popups, switch to the project-level Jimeng space when `workspace.spaceName` is set, switch to video generation, set full-reference mode, set ratio/duration, fill the prompt, and attach reference files. This is not Chrome DevTools MCP and must only target the app-managed browser.
- Jimeng space verification must use the current active conversation/space evidence, such as the selected sidebar item or equivalent active state. Do not treat a target space name merely appearing in page body text or a sidebar list as proof that the managed page has switched into that space; stop at `manual_settings_required` if active-space evidence is missing or points elsewhere.
- The Jimeng chip-binding primary path is the page's own `引用参考` / toolbar `@` candidate list. After uploading references, the script must preserve prompt text spans, put the caret at each source placeholder, open the reference candidate list, select the exact uploaded resource, and verify `.node-reference-mention-tag` chips before submit.
- Chip count alone is not sufficient evidence. The selected Jimeng candidate/chip label must match the current ordered reference file or title with distinctive tokens, such as `teacher`, `bully`, `music-classroom`, or `lv03-tail-for-lv04`; weak shared fragments like `char`, `scene`, or `01` must never count as a valid match.
- Repeated Jimeng handoff must clear stale reference thumbnails before upload. Upload each unique reference file exactly once, even when the prompt mentions that same `@图片N` / `@音频N` placeholder multiple times; the pre-submit upload gate compares external uploaded-reference thumbnails with the unique reference-file count. Prompt chip binding remains occurrence-based, so every placeholder occurrence must become a verified resource chip. Jimeng also renders prompt reference chips as `reference-item` nodes inside the editor; cleanup and upload counting must exclude every editor-contained node. Small blob icons inside verified chips are not duplicate reference evidence.
- Do not treat clicking uploaded thumbnails, dragging thumbnails, or typing bare inline `@` as equivalent to `引用参考`. Those are only canaries or fallback evidence; raw `@图片N` / `@音频N` text is never generation-ready.
- The V1 稳定路径验收要求 is complete only when automation reaches `pre_submit_confirmation`, uploaded thumbnails match the unique reference-file count, verified `chip` count matches placeholder occurrences, and raw `@图片N` / `@音频N` count is 0.
- Do not claim V1 can fully automate Jimeng media chip binding unless the page script verifies real resource chips. If the `引用参考` path cannot be verified, stop at the binding gate when raw `@图片N` / `@音频N` remains or chip count/order is wrong.
- If `pageAutomation.status` is `manual_settings_required`, `manual_upload_required`, or `manual_reference_binding_required`, stop before submit and guide the user to confirm settings, upload files, or bind resource chips manually.
- Do not validate product behavior by reusing the user's daily Chrome login state, Codex Browser/Chrome plugin state, Chrome DevTools MCP, or any Agent-side browser session.
- Automation must pause before final submit for user confirmation and must not automatically click the generate button; 不自动点击生成按钮。
- Generated videos are not automatically downloaded or backfilled in V1. The user manually downloads them and imports them through the shot canvas.

## Visual QA

- Prefer the Browser plugin for local `localhost` UI checks unless the user explicitly asks for Chrome or desktop app automation.
- For Jimeng product acceptance, use the app-managed browser flow. Chrome or Browser plugins may help inspect local UI, but existing user login state is not valid evidence that the packaged app flow works.
- For the packaged desktop app, use desktop UI inspection only after building/installing the `.app`.
- If desktop UI inspection cannot capture the app, first confirm the Mac is not on the lock screen. A locked screen can make Computer Use report no app window even when Tauri logs/window state say `visible=true`.
- After frontend changes, verify the relevant page at desktop-size and at least one narrow/mobile-ish viewport when layout risk exists.
- Clean up temporary screenshots, browser tabs, extra local servers, or throwaway files unless they are part of the user's acceptance setup.

## Maintenance Rule

- Any change that alters user-facing workflow, storage paths, credentials, model settings, adapter behavior, deletion/trash, export, project schema, or page/API entry points must update this skill in the same task.
- If a user corrects a workflow rule and that correction conflicts with this skill, ask whether to make the correction permanent, then update this skill and the project docs if they agree.
