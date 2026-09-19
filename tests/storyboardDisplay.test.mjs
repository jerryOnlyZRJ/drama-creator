// 公开测试使用虚构示例文本，保留解析与工作流断言，不承载作者作品。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatReadableStoryboardScriptText,
  formatStoryboardShotHeading,
  formatStoryboardShotLabel
} from '../src/workflow/storyboardDisplay.mjs';

test('formats storyboard headings as direct S001 script review blocks', () => {
  assert.equal(formatStoryboardShotLabel('s001'), 'S001');
  assert.equal(
    formatStoryboardShotHeading({
      shotNo: 's001',
      title: '冷开场嘲笑“娘娘腔”',
      durationSec: 10
    }),
    'S001 分镜｜10s｜冷开场嘲笑“娘娘腔”'
  );
});

test('strips production-only fields from legacy storyboard script text', () => {
  const legacy = [
    '正式分镜：LV01',
    '正片时间：00:00-00:10',
    '覆盖细分镜：S001-S003',
    '场景 / 节点：SHOT-COLD-OPEN-BULLY-HOOK-01',
    '景别与运动：冷白走廊压迫近景、少年眼神极近特写',
    '画面：匿名同学的肩背、鞋尖、挡路的手和笑声围住 12 岁小邮。',
    '声音：匿名嘲笑、笑声骤停、助理提醒、后台观众声',
    '依赖资源：CHAR-XWS-BOY-01、SCENE-SCHOOL-CORRIDOR-STAIR-01',
    '生成备注：新增冷开场钩子'
  ].join('\n');

  const cleaned = formatReadableStoryboardScriptText(legacy);

  assert.equal(cleaned, [
    '镜头：冷白走廊压迫近景、少年眼神极近特写',
    '画面：匿名同学的肩背、鞋尖、挡路的手和笑声围住 12 岁小邮。',
    '声音：匿名嘲笑、笑声骤停、助理提醒、后台观众声'
  ].join('\n'));
  assert.doesNotMatch(cleaned, /覆盖细分镜|依赖资源|生成备注|SHOT-/);
});
