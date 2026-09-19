# Prompt Best Practices

`drama-creator` does not read or bundle local agent skills such as `short-drama` or `seedance` at runtime. Those skills are useful references for agents, but the desktop app must remain open-source friendly and independent from machine-specific paths.

The app-owned prompt guidance lives in `src/prompting/bestPractices.mjs` and is versioned by `PROMPT_BEST_PRACTICES_VERSION`. It is the packaged runtime source of truth; local agent skills are only references for maintainers.

## Built-In Flow

The default production flow is:

```
故事源 → 剧本草稿 → 分镜拆分 → 公共资产库 → 分镜参考资源 → 分镜视频 → 成片导出
```

Current V2 flow:

```
故事源 → 剧本草稿 → 分镜拆分 → 资产依赖矩阵 → 公共资产库 → 分镜参考资源 → 即梦投喂包 → 分镜视频 → 质检 → 成片导出
```

## Runtime Usage

- Storyboard splitting uses `createBestPracticeVideoPrompt()` so newly generated shot prompts are Seedance/Jimeng ready by default.
- Public asset generation from the saved episode script uses built-in extraction rules to create editable character, location, prop, and style candidates before the user binds or uploads media.
- `buildGenerateInput()` adds `systemPrompt` for text generation and `promptGuidance` for all capabilities.
- `openai-compatible-text` sends `systemPrompt` as a system message when present.
- `openai-codex-oauth` sends `systemPrompt` as Responses API `instructions`.
- Jimeng feed packages include structured `promptGuidance` alongside prompt, references, warnings, and gates.
- `promptGuidance.source` is `app_builtin`, and `promptGuidance.runtimePolicy.readsLocalAgentSkills` is `false`.

## Video Prompt Principles

- A shot is the smallest production unit and should map to one video clip of 15 seconds or less.
- Before writing a video prompt, complete the director checks: first-2-second hook, character temperament, spatial relationship, shot function, and rhythm type.
- Video prompts must specify shot function, spatial relationship, framing, camera movement, performance, sound, duration, and positive stability locks. Keep hard constraints narrow, such as no BGM, subtitles, logos, or watermarks.
- References must be ordered by media placeholder: images use `@图片1`, `@图片2`, ... while audio references use independent `@音频1`, `@音频2`, ...; those placeholders must match uploaded assets.
- Browser execution must turn `@图片N` / `@音频N` text into platform resource chips before submission.
- Follow-up segments should use the previous approved tail frame by default and start with a short bridge segment.
- Run a prompt pollution scan before submission: abstract words must become visible evidence, unwanted elements should be rewritten as positive results, template words need concrete actions, and standalone editing metadata such as `转场到 s003` or `Transition to ...` must stay out of the single-shot generation prompt.
- Continuity should be expressed through visible first/tail-frame references, voice references, and bound media resource chips, not through clip-editing notes that the video model may render or misinterpret.

## Jimeng Model Selection And Voice Lock

- Keep `Seedance 2.0 mini` as the speed-first default for low-risk visual shots, short review probes, and any shot whose sound can be added or replaced in post-production.
- Add BGM, songs, ambience, voice-over, off-screen dialogue, and dialogue without visible lips in post-production. These audio uses must not set `audioLockRequired` and must not upgrade the configured video model merely because an `@音频N` reference exists.
- Only when visible character dialogue requires strict audiovisual sync and cannot be solved by post dubbing should the task set `task.metadata.audioLockRequired = true`, bind the final approved dialogue master as `@音频N`, and use standard `Seedance 2.0` even when the global default is mini.
- `postDubbingAllowed = true` takes priority over stale or migrated lock metadata and keeps the configured video default. Conversely, a true lip-sync lock must not silently fall back to a similar built-in voice; missing final audio or clone mapping is a blocking setup issue.
- Standard `Seedance 2.0` is distinct from `Seedance 2.0 VIP`. VIP remains opt-in for the exact generation and requires explicit user authorization.
- For expensive or uncertain visible-dialogue lip-sync shots, first use the shortest useful validation clip with the same final audio and active visual references. Validation success does not authorize trimming, splicing, promotion, or formal-shot replacement without user approval.
- After generation, compare against the approved public voice and verify every line, speaker assignment, repeated or invented words, silence boundaries, and lip sync. A mismatch stays as a candidate and cannot become current automatically.
- Prompt text must not hardcode mini or standard model names. The feed package owns model selection so `audioLockRequired` can upgrade the task without contradicting the shot prompt.

## Image Prompt Principles

- Character, scene, prop, and keyframe images must be traceable to a script or shot.
- Once a character baseline exists, downstream keyframes should explicitly use it as the only face/body/clothing reference.
- Screen UI, notifications, popups, and HUD elements must state whether they are screen-coplanar or AR/HUD floating UI, so generated images avoid perspective drift and clipping.
- Image prompts may positively describe visible Chinese UI/text when the story needs it. Only forbid text when the scene should not contain text.
- Information-bearing props such as program lists, notebooks, sticky notes, phone notifications, blackboard text, posters, letters, certificates, and title cards must first use a real, fictional, readable reference image. Blank carrier images are only post-production templates or diagnostic assets.

## Information Prop Rule

- For image prompts, render safe fictional text directly in the prop reference when the text carries story meaning.
- For video prompts, inherit only the text already present in the approved prop reference and state that the inherited text should stay stable, readable, and secondary to the shot action. Use an explicit no-new-text constraint only when the prop carries exact story meaning and the model repeatedly invents text.
- Do not use a blank carrier as the main semantic reference for Jimeng/Seedance generation; it weakens the model's understanding of the prop and can make the prop dominate or drift.

## Text Prompt Principles

- Rewrite story sources into shootable scripts before splitting shots.
- Generated text should be understandable to non-technical users and should produce concrete next steps in the app.
- Missing assets should become a clear fill-in list, not a hard block for all workflows.
