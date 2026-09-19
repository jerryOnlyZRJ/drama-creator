import { runPreFeedChecks } from '../checks/preFeedChecks.mjs';

export function createFeedPackagePreviewResult(doc) {
  const checks = mergeFeedChecks(doc.checks || [], runPreFeedChecks(doc));
  const warnings = checks.filter((check) => check.status !== 'pass');

  if (warnings.length > 0) {
    return {
      blocked: true,
      checks,
      message: buildWarningMessage(warnings)
    };
  }

  return {
    blocked: false,
    checks,
    message: buildFeedPackagePreview(doc)
  };
}

function mergeFeedChecks(persistedChecks, runtimeChecks) {
  const checksById = new Map();
  for (const check of persistedChecks) {
    checksById.set(check.id, check);
  }
  for (const check of runtimeChecks) {
    // Runtime checks are recalculated at click time, so they supersede stale checks with the same id.
    checksById.set(check.id, check);
  }
  return [...checksById.values()];
}

function buildWarningMessage(warnings) {
  const warningLines = warnings.flatMap((check) => {
    const items = check.items?.length
      ? check.items.map((item) => `- ${item.label}`)
      : ['- 未提供具体明细'];
    return [`【${check.type}】${check.id}`, ...items];
  });

  return [
    `投喂包检查未通过：存在 ${warnings.length} 项 warning，已阻断投喂预览。`,
    ...warningLines
  ].join('\n');
}

function buildFeedPackagePreview(doc) {
  const prompts = (doc.nodes || [])
    .filter((node) => node.type === 'video_prompt' || node.type === 'image_prompt' || node.type === 'audio_prompt')
    .map((node) => {
      // Prompt metadata is user-controlled; keep it as copyable plain text instead of HTML.
      const prompt = node.metadata?.prompt || '（暂无提示词）';
      return `【${labelForType(node.type)}】${node.title}\n${prompt}`;
    });

  if (prompts.length === 0) {
    return '当前 JSON 中还没有可投喂的提示词。';
  }

  return prompts.join('\n\n');
}

function labelForType(type) {
  const labels = {
    image_prompt: '图片提示词',
    video_prompt: '视频提示词',
    audio_prompt: '音频提示词'
  };
  return labels[type] || type;
}
