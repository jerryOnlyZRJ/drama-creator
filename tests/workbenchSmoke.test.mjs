import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('L1 home page exposes V1 create-project path instead of old project import', async () => {
  const html = await readFile('index.html', 'utf8');
  const sharedCss = await readFile('shared.css', 'utf8');
  const shotCss = await readFile('shot.css', 'utf8');
  assert.match(html, /id="projectsGrid"/);
  assert.match(html, /id="newProjectButton"/);
  assert.match(html, /id="newProjectDialog"/);
  assert.match(html, /从想法开始/);
  assert.match(html, /id="generateStoryButton"/);
  assert.doesNotMatch(html, /首集名称/);
  assert.doesNotMatch(html, /firstEpisodeName/);
  assert.doesNotMatch(html, /newEpisodeName/);
  assert.match(html, /从故事开始/);
  assert.match(html, /从已有素材开始/);
  assert.match(html, /最近项目/);
  assert.match(html, /home\.js/);
  assert.match(html, /shared\.css/);
  assert.doesNotMatch(html, /选择目录/);
  assert.doesNotMatch(html, /添加项目/);
  assert.doesNotMatch(html, /drama-creator\.json/);
  assert.match(sharedCss, /html,\s*body\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(sharedCss, /grid-template-columns:\s*minmax\(220px,\s*1fr\)\s+minmax\(0,\s*auto\)\s+minmax\(220px,\s*1fr\)/);
  assert.match(sharedCss, /\.app-shell\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(sharedCss, /\.app-bar__crumbs\s*\{[\s\S]*grid-column:\s*2[\s\S]*justify-self:\s*center/);
  assert.match(shotCss, /\.app-bar__crumbs\s*\{[\s\S]*grid-column:\s*2[\s\S]*justify-self:\s*center/);
});

test('L1 new project flow stores projects in app workspace without directory picking', async () => {
  const js = await readFile('home.js', 'utf8');
  assert.match(js, /\/api\/projects\/create/);
  assert.match(js, /method:\s*'DELETE'/);
  assert.match(js, /deleteProject\(project,\s*remove\)/);
  assert.match(js, /createTrashIcon/);
  assert.match(js, /project-card__delete-icon/);
  assert.match(js, /aria-label/);
  assert.match(js, /确认移入/);
  assert.match(js, /resetPendingDeleteButtons/);
  assert.doesNotMatch(js, /project-card__open/);
  assert.doesNotMatch(js, /open\.textContent\s*=\s*'打开'/);
  assert.doesNotMatch(js, /window\.confirm/);
  assert.match(js, /newProjectButton/);
  assert.match(js, /startMode/);
  assert.match(js, /idea_text/);
  assert.match(js, /\/api\/story\/generate/);
  assert.match(js, /settings\.html#model-text/);
  assert.match(js, /story_text/);
  assert.match(js, /material_text/);
  assert.doesNotMatch(js, /pick_project_directory/);
  assert.doesNotMatch(js, /pickProjectDirectory/);
  assert.doesNotMatch(js, /目录选择仅在桌面端可用/);
});

test('L2 project page provides shots tab + library tab', async () => {
  const html = await readFile('project.html', 'utf8');
  assert.match(html, /id="tabShots"/);
  assert.match(html, /id="tabLibrary"/);
  assert.match(html, /id="shotsGrid"/);
  assert.match(html, /id="libraryBody"/);
  assert.match(html, /project\.js/);
});

test('L2 project page exposes V1 workflow steps and script source controls', async () => {
  const html = await readFile('project.html', 'utf8');
  assert.match(html, /id="workflowSteps"/);
  assert.match(html, /id="stepScriptShots"/);
  assert.match(html, /id="stepAssetLibrary"/);
  assert.match(html, /id="stepShotVideos"/);
  assert.match(html, /id="stepExport"/);
  assert.match(html, /id="episodeStrip"/);
  assert.match(html, /class="episode-strip"/);
  assert.match(html, /id="episodeSelect"/);
  assert.match(html, /id="episodeSummary"/);
  assert.match(html, /id="episodeBar"/);
  assert.match(html, /id="episodeBar" hidden/);
  assert.match(html, /id="newEpisodeButton"/);
  assert.match(html, /id="scriptPanel"/);
  assert.match(html, /class="script-sections"/);
  assert.match(html, /class="script-compare-grid"/);
  assert.match(html, /aria-label="故事源与剧本对照"/);
  assert.match(html, /作品元数据/);
  assert.match(html, /故事源/);
  assert.match(html, /<h2 id="episodeScriptTitle">分镜剧本<\/h2>/);
  assert.doesNotMatch(html, /class="storyboard-rule-button"/);
  assert.match(html, /id="scriptDraftEditor" class="script-draft-editor script-draft-editor--hidden" hidden/);
  assert.match(html, /class="workflow-card__footer script-draft-footer" hidden aria-hidden="true"/);
  assert.doesNotMatch(html, /<section class="workflow-card storyboard-card"/);
  assert.doesNotMatch(html, /完整剧本草稿/);
  assert.doesNotMatch(html, /class="script-draft-disclosure"/);
  assert.doesNotMatch(html, /class="storyboard-rule"/);
  assert.doesNotMatch(html, /id="storyboardCardTitle"/);
  assert.doesNotMatch(html, /class="storyboard-section"/);
  assert.match(html, /class="storyboard-card__body"/);
  assert.match(html, /id="metadataProjectName"/);
  assert.match(html, /id="metadataEpisodeName"/);
  assert.match(html, /核心立意/);
  assert.match(html, /id="metadataCoreIdea"/);
  assert.match(html, /全局设定/);
  assert.match(html, /id="metadataGlobalBrief"/);
  assert.match(html, /id="saveCoreIdeaButton"/);
  assert.match(html, /即梦空间/);
  assert.match(html, /id="metadataJimengSpaceName"/);
  assert.match(html, /id="metadataShotCount"/);
  assert.match(html, /id="storySourceEditor"/);
  assert.match(html, /id="storySourceFile"/);
  assert.match(html, /id="saveStorySourceButton"/);
  assert.match(html, /不填写镜头、分镜、提示词或资产清单/);
  assert.match(html, /id="generateScriptDraftButton" class="ghost-button" type="button" hidden aria-hidden="true"/);
  assert.match(html, /id="splitStoryboardButton" class="ghost-button" type="button">生成分镜剧本<\/button>/);
  assert.doesNotMatch(html, />生成草稿<\/button>\s*<button id="splitStoryboardButton"[^>]*>拆分分镜<\/button>/);
  assert.match(html, /id="scriptDraftEditor"/);
  assert.doesNotMatch(html, /分镜规则/);
  assert.doesNotMatch(html, /每个分镜默认不超过 15 秒/);
  assert.doesNotMatch(html, /超过 15 秒请拆成多个镜头/);
  assert.match(html, /id="saveScriptDraftButton"/);
  assert.match(html, /id="splitStoryboardButton"/);
  assert.match(html, /id="addStoryboardShotButton"/);
  assert.match(html, /id="saveStoryboardButton"/);
  assert.match(html, /id="storyboardList"/);
  assert.match(html, /<section id="exportPanel" class="panel export-panel" role="tabpanel" hidden/);
  assert.doesNotMatch(html, /id="exportCloseButton"/);
  assert.match(html, /剧本与分镜/);
  // Step rail 采用创作阶段短文案，公共资产库对应的阶段名必须是“公共资产”。
  assert.match(html, /<strong>公共资产<\/strong>/);
  assert.doesNotMatch(html, /<strong>资产库<\/strong>/);
  assert.doesNotMatch(html, /class="script-layout"/);
  assert.doesNotMatch(html, /<aside class="script-side">/);
  assert.match(html, /成片导出/);
});

test('L2 project workflow can persist pasted or locally imported story text', async () => {
  const js = await readFile('project.js', 'utf8');
  const html = await readFile('project.html', 'utf8');
  const css = await readFile('project.css', 'utf8');
  assert.match(css, /\.script-compare-grid/);
  assert.match(css, /grid-template-columns:\s*minmax\(320px, 0\.74fr\) minmax\(560px, 1\.26fr\)/);
  assert.match(css, /故事源与分镜剧本并列对照/);
  assert.match(css, /--script-workbench-height:\s*clamp\(520px, calc\(100vh - 350px\), 720px\)/);
  assert.match(css, /\.story-source-editor[\s\S]*height:\s*100%/);
  assert.match(css, /\.script-draft-editor[\s\S]*height:\s*100%/);
  assert.match(css, /\.script-draft-editor--hidden[\s\S]*display:\s*none/);
  assert.doesNotMatch(css, /\.storyboard-rule-button/);
  assert.doesNotMatch(css, /\.storyboard-section/);
  assert.match(css, /\.storyboard-card__body[\s\S]*display:\s*grid/);
  assert.match(css, /\.storyboard-card__body[\s\S]*grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.storyboard-card__body[\s\S]*overflow:\s*auto/);
  assert.match(css, /\.storyboard-card__body[\s\S]*contain:\s*layout paint/);
  assert.match(css, /\.storyboard-list[\s\S]*height:\s*100%/);
  assert.match(css, /\.storyboard-list[\s\S]*min-height:\s*0/);
  assert.match(css, /\.storyboard-script-editor[\s\S]*height:\s*100%/);
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*\.script-compare-grid[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(js, /storySources/);
  assert.match(js, /\/api\/projects\/metadata/);
  assert.match(js, /saveProjectCoreIdea/);
  assert.match(js, /metadataCoreIdea/);
  assert.match(js, /metadataGlobalBrief/);
  assert.match(js, /metadataJimengSpaceName/);
  assert.match(js, /newEpisodeButton/);
  assert.match(js, /deleteEpisodeButton/);
  assert.match(js, /episodeSelect/);
  assert.match(js, /onEpisodeSelected/);
  assert.match(js, /episodeStrip\.hidden\s*=\s*state\.activeStep === 'asset_library'/);
  assert.doesNotMatch(js, /episode-chip/);
  assert.match(js, /\/api\/projects\/episode/);
  assert.match(js, /deleteEpisode\(ep\)/);
  assert.match(js, /pendingDeleteEpisodeId/);
  assert.doesNotMatch(js, /window\.confirm/);
  assert.match(js, /method:\s*'DELETE'/);
  assert.match(js, /saveStorySourceButton/);
  assert.match(js, /storySourceFile/);
  assert.match(js, /FileReader/);
  assert.match(js, /\/api\/script-draft\/generate/);
  assert.match(js, /settings\.html#model-text/);
  assert.match(js, /setScriptDraftStatus/);
  assert.match(js, /formatScriptDraftGenerationFailureMessage/);
  assert.match(js, /生成未完成/);
  assert.match(js, /inline-status-action/);
  assert.match(js, /button\.addEventListener\('click'/);
  assert.match(js, /refreshProjectFromServer/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /window\.addEventListener\('focus'/);
  assert.match(js, /cache:\s*'no-store'/);
  assert.match(js, /initialStepFromUrl/);
  assert.match(js, /updateStepInUrl/);
  assert.match(js, /state\.activeStep = initialStepFromUrl\(\)/);
  assert.doesNotMatch(js, /state\.activeStep = normalizeStep\(doc\?\.workflow\?\.currentStep \|\| project\.currentStep \|\| 'script_shots'\)/);
  assert.match(js, /ensureEpisodeDoc\(state\.activeEpisodeId,\s*\{\s*force\s*\}/);
  assert.doesNotMatch(js, /createScriptDraftFromSource/);
  assert.match(js, /applyStoryboardSplit/);
  assert.match(js, /replaceStoryboardShots/);
  assert.match(js, /addStoryboardShotButton/);
  assert.match(js, /saveStoryboardEdits/);
  assert.match(js, /collectStoryboardEditRows/);
  assert.match(js, /formatStoryboardEditorText/);
  assert.match(js, /formatReadableStoryboardScriptText/);
  assert.match(js, /formatStoryboardShotHeading/);
  assert.match(js, /S001 分镜/);
  assert.doesNotMatch(js, /buildIntegratedStoryboardScriptText/);
  assert.doesNotMatch(js, /parseScriptDraftScenes/);
  assert.doesNotMatch(js, /formatSceneContextForStoryboard/);
  assert.doesNotMatch(js, /formatShotRequirementForStoryboard/);
  assert.match(js, /parseStoryboardEditorRows/);
  assert.doesNotMatch(js, /覆盖细分镜/);
  assert.doesNotMatch(js, /拍摄重点/);
  assert.doesNotMatch(js, /【完整剧本上下文】/);
  assert.doesNotMatch(js, /【分镜执行要求】/);
  assert.match(js, /compactStoryboardNo/);
  assert.match(js, /storyboard-script-editor/);
  assert.match(html, /id="storyboardDeleteDialog"/);
  assert.doesNotMatch(js, /moveStoryboardEditItem/);
  assert.doesNotMatch(js, /上移分镜|下移分镜/);
  assert.doesNotMatch(css, /storyboard-move-button/);
  assert.match(js, /normalizeShotScriptTexts/);
  assert.match(js, /shotScriptText/);
  assert.match(js, /getStoryboardScriptEditor/);
  assert.match(js, /getShotVideoPrerequisite/);
  assert.match(js, /分镜剧本尚未保存/);
  assert.match(js, /返回剧本与分镜/);
  assert.match(js, /returnToScriptStepFromShots/);
  assert.match(js, /publicAssets/);
  assert.match(js, /\/api\/export\/episode/);
  assert.match(js, /export: dom\.exportPanel/);
  assert.doesNotMatch(js, /showModal/);
  assert.doesNotMatch(js, /closeExportDialog/);
  assert.match(js, /\/api\/episode/);
  assert.match(js, /script_shots/);
  assert.match(js, /asset_library/);
  assert.match(js, /shot_videos/);
  assert.match(js, /export/);
});

test('L2 public asset step exposes tabs, search, and editable detail inspector', async () => {
  const html = await readFile('project.html', 'utf8');
  const js = await readFile('project.js', 'utf8');
  const css = await readFile('project.css', 'utf8');
  assert.match(html, /id="libraryTabs"/);
  assert.match(html, /id="librarySearch"/);
  assert.match(html, /id="generatePublicAssetsButton"/);
  assert.match(html, /id="libraryGenerationState"/);
  assert.doesNotMatch(html, /id="libraryFilters"/);
  assert.doesNotMatch(html, /class="library-filter"/);
  assert.doesNotMatch(html, /data-filter="bound"|data-filter="unbound"/);
  assert.doesNotMatch(js, /matchesLibraryFilter/);
  assert.match(html, /id="libraryInspector"/);
  assert.match(html, /id="assetNameInput"/);
  assert.match(html, /id="assetCategorySelect"/);
  assert.match(html, /id="assetStatusSelect"/);
  assert.match(html, /id="assetRequiredCheckbox"/);
  assert.match(html, /id="assetDescriptionInput"/);
  assert.match(html, /id="assetPromptInput"/);
  assert.match(html, /id="assetReferenceAssetsInput"/);
  assert.match(html, /id="assetTagsInput"/);
  assert.match(html, /id="assetLinkedShotsInput"/);
  assert.match(html, /id="assetUsageInput"/);
  assert.match(html, /id="assetSourceInput"/);
  assert.match(html, /id="saveAssetDetailButton"/);
  assert.match(html, /id="deleteAssetButton"/);
  assert.match(js, /saveSelectedLibraryAsset/);
  assert.match(js, /deleteSelectedLibraryAsset/);
  assert.match(js, /registerLibraryAudio/);
  assert.match(js, /pauseOtherLibraryAudio/);
  assert.match(js, /pauseActiveLibraryAudio/);
  assert.match(js, /data-library-audio/);
  assert.match(js, /buildAudioArtwork/);
  assert.match(js, /audio-artwork/);
  assert.match(js, /openLibraryImagePreview/);
  assert.match(js, /closeLibraryImagePreview/);
  assert.match(js, /button\.textContent = '预览'/);
  assert.match(js, /libraryItemDedupeKey/);
  assert.match(js, /normalizeLibraryIdentity/);
  assert.match(js, /normalizePublicAssetStatus/);
  assert.match(js, /approved_by_user_audio_qc/);
  assert.match(js, /\.toLowerCase\(\)/);
  assert.match(js, /pointerdown', 'click', 'dblclick', 'keydown'/);
  assert.match(js, /pendingDeleteAssetKey/);
  assert.match(js, /\/api\/library\/item/);
  assert.match(js, /确认移入回收站/);
  assert.match(js, /doc\.publicAssets/);
  assert.match(js, /只更新项目公共资产记录/);
  assert.match(js, /normalizeAssetReferenceTokens/);
  assert.match(js, /referenceAssets/);
  assert.match(js, /prompt/);
  assert.match(js, /generatePublicAssetsFromScript/);
  assert.match(js, /\/api\/library\/generate-from-script/);
  assert.match(js, /从剧本生成公共资产/);
  assert.match(css, /\.audio-artwork/);
  assert.match(css, /\.audio-artwork__wave/);
  assert.match(css, /\.library-generation/);
  assert.match(css, /\.library-preview-button/);
  assert.match(css, /\.library-lightbox/);
  assert.match(css, /\.library-inspector__preview \.audio-artwork/);
  // 详情栏必须独立滚动，避免长表单只能通过滚动整页才能编辑到底部字段。
  assert.match(css, /\.library-inspector\s*\{[\s\S]*max-height:\s*calc\(100vh - \d+px\)[\s\S]*overflow-y:\s*auto[\s\S]*overscroll-behavior:\s*contain/);
  assert.doesNotMatch(js, /window\.confirm/);
});

test('L2 shot video step uses one episode selector and complete card status filters', async () => {
  const html = await readFile('project.html', 'utf8');
  const js = await readFile('project.js', 'utf8');
  assert.doesNotMatch(html, /id="reloadButton"/);
  assert.match(html, /id="shotsSearch"/);
  assert.match(html, /id="shotsStatusFilter"/);
  assert.match(html, /id="shotsCount"/);
  for (const label of ['未生成', '准备投喂', '处理中', '待质检', '需重跑', '已通过']) {
    assert.match(html, new RegExp(label));
  }
  assert.match(js, /matchesShotQueryAndStatus/);
  assert.match(js, /shotVideoStatusKey/);
  assert.match(js, /shotVideoStatusLabel/);
  assert.match(js, /SHOT_PROCESSING_TASK_STATUSES/);
  assert.match(js, /isShotPreviewImage/);
  assert.match(js, /不能回退到角色\/场景\/道具公共资产/);
  assert.match(js, /processing: '处理中'/);
  assert.match(js, /waiting_download/);
  assert.match(js, /waiting_backfill/);
  assert.match(js, /返回剧本与分镜/);
});

test('L2 export step matches the workbench prototype with progress and cancel controls', async () => {
  const html = await readFile('project.html', 'utf8');
  const js = await readFile('project.js', 'utf8');
  const css = await readFile('project.css', 'utf8');
  assert.match(html, /class="export-workbench"/);
  assert.match(html, /id="exportShotList"/);
  assert.match(html, /id="exportPreviewMedia"/);
  assert.match(html, /id="exportPreviewStartButton"/);
  assert.match(html, /id="exportPreviewStatus"/);
  assert.match(html, /id="exportResolutionSelect"/);
  assert.match(html, /id="exportStartButton"/);
  assert.match(html, /id="exportCancelButton"/);
  assert.match(html, /id="exportProgressBar"/);
  assert.match(html, /id="exportResultList"/);
  assert.doesNotMatch(html, /id="exportOriginalButton"/);
  assert.doesNotMatch(html, /id="exportSubtitleButton"/);
  assert.match(js, /AbortController/);
  assert.match(js, /cancelExport/);
  assert.match(js, /startExportProgress/);
  assert.match(js, /renderExportCheck/);
  assert.match(js, /renderExportPreview/);
  // 预览覆盖同一路径时必须把服务端文件版本加入媒体 URL，确保应用内立即加载新视频。
  assert.match(js, /previewResult\.previewRevision/);
  assert.match(js, /revision: previewResult\.previewRevision/);
  assert.match(js, /buildExportPreviewVideo/);
  assert.match(js, /generateExportPreview/);
  assert.match(js, /loadExistingExportPreview/);
  assert.match(js, /不能用任意分镜关键帧冒充视频预览|避免用任意分镜关键帧冒充视频预览/);
  assert.match(js, /已找到上次生成的分镜拼接预览/);
  assert.match(js, /\/api\/export\/preview/);
  assert.match(js, /selectPreviewVideoNodeLocal/);
  assert.match(js, /renderExportResults/);
  assert.match(js, /exportStatus === 'final'/);
  assert.match(js, /selectLegacyExportVideoNodeLocal/);
  assert.match(js, /shot\.videoVersions\.candidate\)\s*return null/);
  assert.match(css, /\.export-workbench/);
  assert.match(css, /\.export-shot-row/);
  assert.match(css, /\.export-preview-actions/);
  assert.match(css, /\.export-preview-video/);
  assert.match(css, /\.export-preview-placeholder/);
  assert.match(css, /\.export-preview-inline-hint/);
  assert.match(css, /\.export-progress__track/);
  assert.match(css, /\.export-result-row/);
});

test('export step keeps creator-facing Chinese copy in the main flow', async () => {
  const html = await readFile('project.html', 'utf8');
  const exportPanel = html.match(/<section id="exportPanel"[\s\S]*?<\/section>\s*<\/main>/)?.[0] || '';

  assert.match(exportPanel, /导出检查/);
  assert.match(exportPanel, /字幕预览/);
  assert.match(exportPanel, /生成分镜拼接预览/);
  assert.match(exportPanel, /导出文件/);
  assert.match(exportPanel, /开始导出/);
  assert.match(exportPanel, /取消导出/);
  assert.match(exportPanel, /导出结果/);

  // 导出是面向创作者的主流程，不能把英文模块名或工程术语暴露成页面标签。
  assert.doesNotMatch(exportPanel, /Export Check|Subtitle Preview|Export Output/);
  assert.doesNotMatch(exportPanel, /adapter|schema|JSON|CDP|localhost/i);
});

test('L3 shot canvas mounts viewport, inspector and shot management navigation', async () => {
  const html = await readFile('shot.html', 'utf8');
  const css = await readFile('shot.css', 'utf8');
  assert.match(html, /id="canvasViewport"/);
  assert.match(html, /id="canvasCards"/);
  assert.match(html, /id="canvasLines"/);
  assert.match(html, /id="inspector"/);
  assert.match(html, /id="backToShotVideos"/);
  assert.match(html, /返回分镜管理/);
  assert.match(html, /id="prevShot"/);
  assert.match(html, /id="nextShot"/);
  assert.match(html, /id="submitJimengAutomationButton"/);
  assert.match(html, /id="jimengAutomationStatus"/);
  assert.match(html, /不复用你平时打开的 Chrome 标签/);
  assert.match(html, /提交到即梦生成/);
  assert.match(html, /id="feedButton"[^>]*>投喂信息</);
  assert.match(html, /class="app-bar__actions shot-toolbar"/);
  assert.match(html, /class="shot-toolbar__group shot-toolbar__nav"[\s\S]*id="backToShotVideos"[\s\S]*id="nextShot"/);
  assert.match(html, /class="shot-toolbar__group shot-toolbar__production"[\s\S]*id="referenceManagerButton"[\s\S]*id="submitJimengAutomationButton"/);
  assert.match(html, /id="deleteResourceButton"/);
  assert.match(html, /id="setCurrentVideoButton"/);
  assert.match(html, /shot\.js/);
  assert.match(css, /grid-template-rows:\s*48px 40px/);
  assert.match(css, /\.app-bar__actions\s*\{[\s\S]*grid-column:\s*1 \/ -1[\s\S]*justify-content:\s*space-between/);
  assert.match(css, /\.shot-toolbar__nav\s*\{[\s\S]*justify-content:\s*flex-start/);
  assert.match(css, /\.shot-toolbar__production\s*\{[\s\S]*justify-content:\s*flex-end/);
  assert.match(css, /white-space:\s*nowrap/);
  assert.match(css, /#feedButton\s*\{[\s\S]*min-width:\s*92px/);
  assert.match(css, /#submitJimengAutomationButton\s*\{[\s\S]*min-width:\s*136px/);
  assert.match(css, /\.jimeng-feed__status\s*\{/);
  assert.match(css, /\.jimeng-feed__status\[data-tone="success"\]/);

  const js = await readFile('shot.js', 'utf8');
  assert.match(js, /function buildScriptInspectorSection/);
  assert.match(js, /scriptNode\?\.metadata\?\.text/);
  assert.match(js, /shot\?\.scriptText/);
  assert.match(css, /\.script-detail__body\s*\{[\s\S]*white-space:\s*pre-wrap/);
});

test('L3 shot canvas drives buildClusters with shotFilter from the URL', async () => {
  const js = await readFile('shot.js', 'utf8');
  assert.match(js, /from '\.\/src\/layout\/clusters\.mjs'/);
  assert.match(js, /buildClusters\(state\.doc, \{ shotFilter: state\.shotNo \}\)/);
  assert.match(js, /params\.get\('path'\)/);
  assert.match(js, /params\.get\('shot'\)/);
  assert.match(js, /backToShotVideos/);
  assert.match(js, /step=shot_videos/);
  assert.match(js, /\/episodes\//);
});

test('L3 shot canvas renders media through the episode-scoped /api/asset proxy', async () => {
  const js = await readFile('shot.js', 'utf8');
  const css = await readFile('shot.css', 'utf8');
  assert.match(js, /\/api\/asset\?episode=\$\{encodeURIComponent\(episodePath\)\}&path=\$\{encodeURIComponent\(/);
  assert.match(js, /document\.createElement\('img'\)/);
  assert.match(js, /document\.createElement\('video'\)/);
  assert.match(js, /video\.controls\s*=\s*true/);
  assert.match(js, /registerShotAudio/);
  assert.match(js, /pauseOtherShotAudio/);
  assert.match(js, /pauseActiveShotAudio/);
  assert.match(js, /data-shot-audio/);
  assert.match(js, /cluster-card__play/);
  assert.match(js, /toggleVideoPlayback/);
  assert.match(js, /cluster-card__details/);
  assert.match(js, /详情\/QC/);
  assert.match(js, /buildPromptInspectorSection/);
  assert.match(js, /src\/workflow\/promptReferences\.mjs/);
  assert.match(js, /formatPromptDisplayText/);
  assert.match(js, /buildPromptReferences/);
  assert.match(js, /编辑提示词/);
  assert.match(js, /savePromptText/);
  assert.match(js, /promptUpdatedAt/);
  assert.match(js, /引用资源/);
  assert.match(js, /上传顺序/);
  assert.match(js, /isCardInteractiveTarget/);
  assert.match(js, /\/api\/episode\/resources/);
  assert.match(js, /deleteSelectedResource/);
  assert.match(js, /pendingDeleteResourceNodeId/);
  assert.doesNotMatch(js, /window\.confirm/);
  assert.match(js, /\/api\/episode\/video-version\/current/);
  assert.match(js, /promoteSelectedVideoVersion/);
  assert.match(js, /SUPPORTING_OUTPUT_BADGES/);
  assert.match(js, /edge-label--supporting/);
  assert.match(js, /cluster-card__badge--supporting/);
  assert.match(css, /\.cluster-card__details/);
  assert.match(css, /\.edge--supporting/);
  assert.match(css, /\.edge-label--supporting/);
  assert.match(css, /\.cluster-card__badge--supporting/);
  assert.match(css, /\.prompt-editor__textarea/);
  assert.match(css, /\.prompt-editor__actions/);
});

test('storage and deletion flows use in-page confirmation instead of native dialogs', async () => {
  const html = await readFile('project.html', 'utf8');
  const settings = await readFile('settings.js', 'utf8');
  assert.match(html, /id="deleteEpisodeButton"/);
  assert.match(settings, /pendingEmptyTrash/);
  assert.match(settings, /确认清空/);
  assert.doesNotMatch(settings, /window\.confirm/);
});

test('public voice assets expose the app-managed Jimeng audio generation entry', async () => {
  const html = await readFile('project.html', 'utf8');
  const js = await readFile('project.js', 'utf8');
  assert.match(html, /id="generateAssetAudioButton"/);
  assert.match(js, /generateSelectedLibraryAudio/);
  assert.match(js, /\/api\/library\/audio-generation\/start/);
  assert.match(js, /launchBrowser:\s*true/);
  assert.match(js, /等待确认生成/);
});

test('cluster cards are built with createElement + textContent rather than HTML strings', async () => {
  const js = await readFile('shot.js', 'utf8');
  assert.match(js, /createElement\('article'\)/);
  assert.match(js, /card\.role\s*=\s*'button'/);
  assert.match(js, /textContent\s*=\s*cluster\.title/);
  assert.doesNotMatch(js, /innerHTML\s*=\s*`<button class="graph-node/);
});

test('feed button delegates to the shared preview behavior and avoids HTML sinks', async () => {
  const js = await readFile('shot.js', 'utf8');
  assert.match(js, /createFeedPackagePreviewResult/);
  assert.match(js, /\.\/src\/feed\/feedPackage\.mjs/);
  assert.match(js, /window\.alert\(result\.message\)/);
  assert.match(js, /feedButton\.addEventListener\('click', showFeedPackageSummary\)/);
  assert.match(js, /submitJimengAutomationButton\.addEventListener\('click', startJimengAutomationRun\)/);
  assert.match(js, /\/api\/jimeng\/automation\/start/);
  assert.match(js, /renderJimengAutomationPending\(task\)[\s\S]*openJimengFeedDialog\(\)[\s\S]*setJimengAutomationBusy\(true\)/);
  assert.doesNotMatch(js, /window\.alert\(`启动即梦自动化失败/);
  assert.match(js, /renderJimengAutomationStatus/);
  assert.match(js, /renderJimengFeedPackage\(payload\.package\)/);
});

test('static build ships every page entry plus browser-side modules', async () => {
  const buildScript = await readFile('scripts/build.mjs', 'utf8');
  for (const file of ['index.html', 'home.css', 'home.js', 'project.html', 'project.css', 'project.js', 'shot.html', 'shot.css', 'shot.js', 'settings.html', 'settings.css', 'settings.js', 'trash.html', 'trash.css', 'trash.js', 'shared.css']) {
    assert.ok(buildScript.includes(file), `build.mjs ships ${file}`);
  }
  for (const moduleFile of [
    'src/feed/feedPackage.mjs',
    'src/checks/preFeedChecks.mjs',
    'src/layout/clusters.mjs',
    'src/workflow/scriptShots.mjs',
    'src/workflow/shotScripts.mjs',
    'src/workflow/promptReferences.mjs',
    'src/schema/dramaCreatorSchema.mjs',
    'src/prompting/bestPractices.mjs',
    'src/export/subtitles.mjs'
  ]) {
    assert.ok(buildScript.includes(`copyBrowserModule('${moduleFile}')`), `build.mjs ships browser module ${moduleFile}`);
  }
  assert.doesNotMatch(buildScript, /src\/workflow\/videoVersions\.mjs/);
  assert.doesNotMatch(buildScript, /src\/feed\/generateInput\.mjs/);
});
