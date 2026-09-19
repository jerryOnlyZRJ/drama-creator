export const PROMPT_BEST_PRACTICES_VERSION = 'drama-creator-prompt-best-practices.v6';

const PROMPT_GUIDANCE_SOURCE = 'app_builtin';

const RUNTIME_POLICY = Object.freeze({
  readsLocalAgentSkills: false,
  reason: '桌面端必须独立分发，提示词规范只来自应用自有代码和文档。'
});

const CORE_PRODUCTION_FLOW = [
  '故事源',
  '剧本草稿',
  '分镜拆分',
  '资产依赖矩阵',
  '公共资产库',
  '分镜参考资源',
  '即梦投喂包',
  '分镜视频',
  '质检',
  '成片导出'
];

const SHARED_PROMPT_PRINCIPLES = [
  '生产顺序：故事源先改编成剧本，再拆分镜，再准备可追溯的公共资产和分镜参考资源。',
  '导演判断：进入视频提示词前先明确前2秒钩子、角色气质、空间关系、镜头功能和节奏类型。',
  '提示词污染：抽象词必须落成可见证据，不希望出现的内容优先改写为正向画面，模板大词必须补具体动作。',
  '平台绑定：即梦/Seedance 的 @图片N 必须和上传顺序一致，并在网页里形成真实资源 chip。'
];

const TEXT_WRITING_RULES = [
  '先把故事源改编成可拍摄剧本，再拆成分镜；不要直接从故事梗概跳到视频提示词。',
  '短剧剧本需要明确场景、人物、动作、台词语气、悬念钩子和本镜头叙事任务。',
  '剧本拆分时默认保留分集概念；只有一条 AI 短片时也视作 ep001，方便后续扩展多集。',
  '新用户可以只粘贴故事源开始；缺素材时仍应输出可人工补齐的资产清单和下一步动作。'
];

const IMAGE_PROMPT_RULES = [
  '图片资产先按角色、场景、道具、风格、关键帧分层规划；复杂镜头必须能回溯到资产依赖矩阵。',
  '角色图、场景图、道具图和关键帧图必须能追溯到具体剧本或分镜。',
  '已建立角色基线后，后续关键帧必须显式引用角色基线作为唯一脸部、体型和服装参考。',
  '屏幕 UI、通知、弹窗和 HUD 必须声明是屏幕共面还是 AR/HUD 浮空，避免穿模或飘出画面。',
  '图片提示词允许正向描述画面中的中文 UI、报纸、通知和招牌文字；只有剧情不希望出现文字时才禁止文字。',
  '信息类道具如节目单、练声本、便签、手机通知、黑板字、海报、信件、证书和主题卡，必须先生成真实、虚构、可读的参考图；空白承载图只能作为后期模板或诊断素材。'
];

const VIDEO_PROMPT_RULES = [
  'Seedance/即梦单次生成以 15 秒内单镜头为基本生产单元。',
  '模型选择：Seedance 2.0 mini 优先用于快速、低风险镜头、画面验证，以及声音可在后期替换的镜头；它生成更快，但不作为可见角色对白逐字口型的强一致性方案。',
  '音画同步锁定：只有可见角色对白必须严格音画同步、且无法通过后期配音解决时，任务才绑定最终 @音频N 母带、设置 audioLockRequired，并使用普通 Seedance 2.0；除非用户为本次生成明确授权，否则不使用 VIP 变体。',
  '后期音频：BGM、歌曲、环境声、画外音和无需可见口型的对白优先在后期添加或替换，不设置 audioLockRequired，视频生成继续使用配置的默认模型。',
  '写提示词前先完成导演判断：前2秒钩子、角色气质、空间关系、镜头功能和节奏类型。',
  '多角色、连续对话或空间敏感镜头必须先有空间调度表：人物左右/前后关系、镜头轴线、视线方向和可切换景别。',
  '视频提示词必须写清镜头功能、空间关系、景别、运镜、表演动作、音效和时长。',
  '参考素材按 @图片1、@图片2 顺序绑定；通过网页执行时必须形成平台资源 chip，而不是普通文本。',
  '提示词中的 @图片N 要出现在具体语义位置，前后留空格，不能只把参考素材清单堆在末尾。',
  '长视频分段默认优先使用上一段尾帧图做连续性参考；第二段开始要有 0.8-1.5 秒桥接段。',
  '生成前做提示词污染扫描：抽象词落成视觉证据，不希望出现的内容优先改写为正向结果，模板大词补足具体动作。',
  '信息类道具的视频提示词要求继承参考图已有文字，并让文字内容稳定、清晰、不过度抢镜；空白承载图只作为后期模板或诊断素材。',
  '角色对白音画锁定镜头生成后必须逐句检查音色一致性、台词完整性、重复或新增台词、发声人归属和口型同步；任一项不通过都只能保留为候选，不能自动设为当前版本。',
  '视频提示词末尾只保留平台层硬约束，例如无 BGM、无字幕、无 LOGO、无水印；角色、空间、表演和镜头稳定性用正向描述锁定。'
];

const AUDIO_PROMPT_RULES = [
  '配音生成的平台输入框只放角色实际说出的台词，不把音色说明、QC 备注或角色边界当作台词。',
  '角色音色资产要单独记录平台可见音色名、输入台词、听感目标和关联分镜。',
  '平台提交前必须确认当前音色与台词，生成后保持待音频 QC，不直接当作已确认公共资产。'
];

const QUALITY_CHECKS = [
  '抽象词已落成可见画面证据，例如人物动作、空间、光影、材质或声音。',
  '不希望出现的角色、道具、动作或空间元素已尽量改写成正向稳定结果，避免把无关元素激活。',
  '多角色或连续对话已明确左右/前后关系、镜头轴线和视线方向。',
  '情绪已拆成微表情、手部动作、身体姿态和视线方向。',
  '提示词中的每个 @图片N 都有对应参考资源，并且顺序与上传顺序一致。'
];

// 应用内置的是可开源、可版本化的提示词策略，不读取本机 agent skill 路径；
// 这样桌面端分发后仍能稳定生成短剧/Seedance 友好的提示词。
export function buildPromptBestPracticeContext({ capability = 'text_prompt' } = {}) {
  const capabilityKey = normalizeCapability(capability);
  return {
    version: PROMPT_BEST_PRACTICES_VERSION,
    source: PROMPT_GUIDANCE_SOURCE,
    runtimePolicy: { ...RUNTIME_POLICY },
    productionFlow: [...CORE_PRODUCTION_FLOW],
    principles: [...SHARED_PROMPT_PRINCIPLES],
    systemPrompt: buildSystemPrompt(capabilityKey),
    checklist: checklistForCapability(capabilityKey)
  };
}

export function createBestPracticeVideoPrompt(storyUnit, {
  ratio = '9:16',
  duration = 8,
  referencePlaceholders = []
} = {}) {
  const seconds = clampDuration(duration);
  const references = referencePlaceholders.length
    ? `参考资源：${referencePlaceholders.join('、')}。`
    : '参考资源：如有角色图、场景图或关键帧，请在投喂前补齐并按 @图片N 顺序绑定。';
  const midpoint = Math.max(2, Math.min(seconds - 2, Math.round(seconds * 0.45)));
  return [
    // 模型由投喂包根据任务风险选择；提示词不写死 mini，避免音色锁定任务与普通 2.0 选择互相冲突。
    `${seconds}秒${ratio}短剧单镜头，即梦视频生成，电影感但以叙事清晰为第一优先级。`,
    '导演判断：前2秒必须给出可理解的信息钩子或视觉动作，本镜头只完成一个叙事任务，避免把多段剧情压进单镜头。',
    `镜头功能：把“${String(storyUnit || '').trim()}”转成一个可验收的最小分镜视频，先交代空间，再展示动作和情绪变化。`,
    '空间调度：写清主体左右/前后关系、视线方向和镜头轴线；如有角色图、场景图或关键帧，以 @图片N 作为视觉权威。',
    references,
    `0-${midpoint}秒：中景或中近景平视，建立人物与环境位置关系，主体动作清楚，表情用眼神、手部动作和身体姿态表现，不只写抽象情绪。`,
    `${midpoint}-${seconds}秒：镜头缓慢推进或轻微跟拍，聚焦关键动作/道具/信息变化，保持角色形象、场景光线和动作连续。`,
    '投喂检查：@图片N 前后留空格，进入即梦后必须绑定成真实资源 chip；提交前再次扫描抽象词、无关元素触发词和模板大词。',
    '音效：补充环境声、物件声或必要对白；无对白时保持自然环境底噪。',
    // 平台层硬约束保留为窄化禁止项；角色和空间稳定性用正向锁定，避免反向词污染生成。
    '稳定性锁：角色身份、空间关系、光线色调、动作连续和表演强度保持一致，画面只呈现本镜头剧情需要的角色、道具和环境。',
    '窄化约束：禁止任何背景音乐、配乐、BGM、音乐卡点、字幕、LOGO或水印；剧情需要的道具文字仅继承已绑定参考图。'
  ].join('\n');
}

export function buildPromptGuidanceSummary({ capability = 'text_prompt' } = {}) {
  const context = buildPromptBestPracticeContext({ capability });
  return {
    version: context.version,
    source: context.source,
    runtimePolicy: context.runtimePolicy,
    flow: context.productionFlow.join(' → '),
    principles: context.principles,
    checklist: context.checklist
  };
}

function normalizeCapability(capability) {
  if (capability === 'image') return 'image';
  if (capability === 'video') return 'video';
  if (capability === 'audio') return 'audio';
  return 'text_prompt';
}

function checklistForCapability(capability) {
  if (capability === 'image') return [...IMAGE_PROMPT_RULES, ...QUALITY_CHECKS.slice(0, 3)];
  if (capability === 'video') return [...VIDEO_PROMPT_RULES, ...QUALITY_CHECKS];
  if (capability === 'audio') return [...AUDIO_PROMPT_RULES];
  return [...TEXT_WRITING_RULES, ...QUALITY_CHECKS.slice(0, 4)];
}

function buildSystemPrompt(capability) {
  const rules = checklistForCapability(capability);
  return [
    '你是 Drama Creator 内置的短剧创作与 AI 素材提示词助手。',
    `默认生产流程：${CORE_PRODUCTION_FLOW.join(' → ')}。`,
    `运行时策略：${RUNTIME_POLICY.reason}`,
    '输出必须面向非技术用户，可直接进入应用的分镜、资产库或投喂包。',
    ...SHARED_PROMPT_PRINCIPLES.map((rule) => `- ${rule}`),
    ...rules.map((rule) => `- ${rule}`)
  ].join('\n');
}

function clampDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 8;
  return Math.max(3, Math.min(15, Math.round(number)));
}
