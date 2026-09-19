// 公开测试使用虚构名称与对应资源标识，避免将创作项目的人物或作品名称带入源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseShotSections,
  parseBoundAssets,
  extractFirstTextBlock,
  parseFilePathLine,
  parseVideoFileName,
  parseMarkdownSectionsByHeading
} from '../src/import/markdownParsers.mjs';

test('parses shot sections from video prompt headings', () => {
  const markdown = [
    '# 第1集 Seedance 视频提示词',
    '## s001a 开场旁白 + 修事故余韵',
    '### 绑定素材',
    '- @图片1：C01 小邮 → `scripts/assets/characters/images/char_robot.png`',
    '### 提示词',
    '```text',
    '9:16竖屏，5秒。',
    '```',
    '## s001b 会议邀请弹出',
    '### 提示词',
    '```text',
    '9:16竖屏，10秒。',
    '```'
  ].join('\n');

  const sections = parseShotSections(markdown);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].shotNo, 's001a');
  assert.equal(sections[0].title, '开场旁白 + 修事故余韵');
  assert.equal(sections[1].shotNo, 's001b');
  assert.equal(sections[1].title, '会议邀请弹出');
});

test('stops shot sections before non-shot second-level headings', () => {
  const sections = parseShotSections([
    '## s012 工作台初始化',
    '```text',
    '9:16竖屏，12秒。',
    '```',
    '## 全集时长汇总（投喂版 vs 03-shot-list 原值）',
    '| 合计 | 投喂版总时长 143s |'
  ].join('\n'));

  assert.equal(sections.length, 1);
  assert.equal(sections[0].shotNo, 's012');
  assert.doesNotMatch(sections[0].body, /143s/);
});

test('parses bound asset lines with chip number and path', () => {
  const markdown = '- @图片3：KF-s001 会议邀请弹出关键帧 → `scripts/assets/keyframes/ep001/images/ep001_s001_keyframe_v003.png`（尾帧锁定）';
  const assets = parseBoundAssets(markdown);
  assert.deepEqual(assets, [
    {
      chip: '@图片3',
      name: 'KF-s001 会议邀请弹出关键帧',
      path: 'scripts/assets/keyframes/ep001/images/ep001_s001_keyframe_v003.png',
      note: '尾帧锁定'
    }
  ]);
});

test('extracts first fenced text block', () => {
  const markdown = ['前文', '```text', '第一行', '第二行', '```'].join('\n');
  assert.equal(extractFirstTextBlock(markdown), '第一行\n第二行');
});

test('extracts fenced text block from CRLF markdown', () => {
  const markdown = ['前文', '```text', '第一行', '第二行', '```'].join('\r\n');
  assert.equal(extractFirstTextBlock(markdown), '第一行\r\n第二行');
});

test('parses file path lines from image prompt docs', () => {
  const line = '文件路径：`scripts/assets/characters/images/char_robot_2026_v001.png`';
  assert.equal(parseFilePathLine(line), 'scripts/assets/characters/images/char_robot_2026_v001.png');
});

test('parses generated video file names', () => {
  assert.deepEqual(parseVideoFileName('ep001_s001b_v002.mp4'), {
    episodeId: 'ep001',
    shotNo: 's001b',
    version: 'v002',
    extension: '.mp4'
  });
});

test('splits markdown into sections by heading level', () => {
  const markdown = [
    '# 图片提示词',
    '### KF-s001 会议邀请弹出关键帧',
    '文件路径：`scripts/assets/keyframes/ep001/images/ep001_s001_keyframe_v003.png`',
    '### C01 小邮角色基准',
    '```text',
    '沉稳但疲惫的互联网创始人。',
    '```'
  ].join('\n');

  const sections = parseMarkdownSectionsByHeading(markdown, 3);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, 'KF-s001 会议邀请弹出关键帧');
  assert.match(sections[1].body, /沉稳但疲惫/);
});
