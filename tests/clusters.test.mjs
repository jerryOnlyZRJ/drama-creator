// 公开测试使用虚构名称与对应资源标识，避免将创作项目的人物或作品名称带入源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClusters, COLUMNS } from '../src/layout/clusters.mjs';

const baseDoc = {
  schemaVersion: '0.1.0',
  nodes: [
    { id: 'node:script:s001', type: 'script_segment', title: 's001 开场', shotId: 'shot:s001' },
    { id: 'node:prompt:image:kf-s001', type: 'image_prompt', title: 'KF-s001 关键帧', metadata: { prompt: '关键帧提示词' } },
    { id: 'node:image:kf-s001', type: 'image_asset', title: 'KF-s001 关键帧', path: 'scripts/assets/keyframes/ep001/images/ep001_s001_keyframe_v003.png', status: 'active' },
    { id: 'node:prompt:video:s001:v001', type: 'video_prompt', title: 's001 视频提示词', shotId: 'shot:s001', metadata: { prompt: '视频提示词' } },
    { id: 'node:video:s001:v001', type: 'video_output', title: 'ep001_s001_v001.mp4', shotId: 'shot:s001', path: 'raw-videos/ep001_s001_v001.mp4', metadata: { version: 'v001' }, status: 'reviewing' },
    { id: 'node:qc:s001:imported', type: 'qc_record', title: 's001 QC', metadata: { qcNote: '待复核' }, status: 'reviewing' }
  ],
  edges: [
    { id: 'edge:image:gen', from: 'node:prompt:image:kf-s001', to: 'node:image:kf-s001', type: 'generates' },
    { id: 'edge:video:gen', from: 'node:prompt:video:s001:v001', to: 'node:video:s001:v001', type: 'generates' },
    { id: 'edge:video:uses-image', from: 'node:prompt:video:s001:v001', to: 'node:image:kf-s001', type: 'uses_reference', role: '尾帧锁定' },
    { id: 'edge:qc:for-output', from: 'node:qc:s001:imported', to: 'node:video:s001:v001', type: 'qc_for' }
  ],
  tasks: [
    { id: 'task:video:s001:v001', shotId: 'shot:s001', type: 'video', title: 's001 视频生成', status: 'ready_to_feed', promptNodeId: 'node:prompt:video:s001:v001', outputNodeIds: ['node:video:s001:v001'], fields: { ratio: '9:16', duration: 10 } }
  ]
};

test('builds three column clusters from doc nodes/edges', () => {
  const { clusters } = buildClusters(baseDoc);
  const byColumn = Object.fromEntries(COLUMNS.map((column) => [column, clusters.filter((cluster) => cluster.column === column)]));

  assert.equal(byColumn.script.length, 1);
  assert.equal(byColumn.asset.length, 1);
  assert.equal(byColumn.product.length, 1);
});

test('asset cluster merges image_prompt and image_asset into one card', () => {
  const { clusters } = buildClusters(baseDoc);
  const assetCluster = clusters.find((cluster) => cluster.column === 'asset');

  assert.ok(assetCluster);
  assert.equal(assetCluster.kind, 'image');
  assert.deepEqual(new Set(assetCluster.memberIds), new Set(['node:prompt:image:kf-s001', 'node:image:kf-s001']));
  assert.equal(assetCluster.asset.path, baseDoc.nodes[2].path);
  assert.match(assetCluster.promptText, /关键帧提示词/);
});

test('product cluster merges prompt + output + qc + task fields into one card', () => {
  const { clusters } = buildClusters(baseDoc);
  const productCluster = clusters.find((cluster) => cluster.column === 'product');

  assert.ok(productCluster);
  assert.equal(productCluster.kind, 'video');
  assert.deepEqual(new Set(productCluster.memberIds), new Set([
    'node:prompt:video:s001:v001',
    'node:video:s001:v001',
    'node:qc:s001:imported'
  ]));
  assert.equal(productCluster.output.path, 'raw-videos/ep001_s001_v001.mp4');
  assert.equal(productCluster.qc.note, '待复核');
  assert.deepEqual(productCluster.task.fields, { ratio: '9:16', duration: 10 });
  assert.ok(productCluster.badges.includes('9:16'));
  assert.ok(productCluster.badges.includes('10s'));
});

test('product cluster prefers the current video version and labels candidate/current roles', () => {
  const doc = {
    schemaVersion: '0.1.0',
    shots: [{
      id: 'shot:s001',
      shotNo: 's001',
      title: '开场',
      videoVersions: {
        current: 'node:video:s001:v002',
        candidate: 'node:video:s001:v001'
      }
    }],
    nodes: [
      { id: 'node:prompt:video:s001:v001', type: 'video_prompt', title: 's001 视频提示词', shotId: 'shot:s001', metadata: { prompt: '镜头提示词' } },
      { id: 'node:video:s001:v001', type: 'video_output', title: '旧候选', shotId: 'shot:s001', path: 'videos/old.mp4', status: 'reviewing', metadata: { version: 'v001', versionRole: 'candidate' } },
      { id: 'node:video:s001:v002', type: 'video_output', title: '当前成片', shotId: 'shot:s001', path: 'videos/current.mp4', status: 'approved', metadata: { version: 'v002', versionRole: 'current' } },
      { id: 'node:qc:s001:v002', type: 'qc_record', title: '当前 QC', shotId: 'shot:s001', status: 'approved', metadata: { qcNote: '已确认' } }
    ],
    edges: [
      { id: 'edge:video:gen:old', from: 'node:prompt:video:s001:v001', to: 'node:video:s001:v001', type: 'generates' },
      { id: 'edge:video:gen:current', from: 'node:prompt:video:s001:v001', to: 'node:video:s001:v002', type: 'generates' },
      { id: 'edge:qc:current', from: 'node:qc:s001:v002', to: 'node:video:s001:v002', type: 'qc_for' }
    ],
    tasks: [
      { id: 'task:video:s001:v001', shotId: 'shot:s001', type: 'video', status: 'approved', promptNodeId: 'node:prompt:video:s001:v001', outputNodeIds: ['node:video:s001:v001', 'node:video:s001:v002'], fields: { ratio: '9:16', duration: 8 } }
    ]
  };

  const { clusters } = buildClusters(doc, { shotFilter: 's001' });
  const productCluster = clusters.find((cluster) => cluster.column === 'product');

  assert.equal(productCluster.members.primaryOutput.id, 'node:video:s001:v002');
  assert.equal(productCluster.title, '当前成片');
  assert.equal(productCluster.output.path, 'videos/current.mp4');
  assert.equal(productCluster.output.versionRole, 'current');
  assert.ok(productCluster.badges.includes('当前版本'));
  assert.equal(productCluster.qc.status, 'approved');
});

test('shotFilter links same-shot orphan videos back to the storyboard script', () => {
  const doc = {
    schemaVersion: '0.1.0',
    nodes: [
      { id: 'node:script:s001', type: 'script_segment', title: 's001 正片镜头', shotId: 'shot:s001' },
      { id: 'node:prompt:video:s001:v001', type: 'video_prompt', title: 's001 视频提示词', shotId: 'shot:s001', status: 'ready_to_feed' },
      { id: 'node:video:assembly:s001-s010-roughcut', type: 'video_output', title: 'S001-S010 粗剪预览', path: 'assets/videos/roughcut.mp4', status: 'available', metadata: { role: 'assembly_preview' } },
      { id: 'node:video:s001:legacy-placeholder', type: 'video_output', title: 'S001 旧版占位视频', path: 'assets/videos/legacy.mp4', status: 'available', metadata: { legacyShotId: 'shot:s001', legacyRole: 'legacy_short_segment_diagnostic' } },
      { id: 'node:script:s002', type: 'script_segment', title: 's002 其他镜头', shotId: 'shot:s002' },
      { id: 'node:video:s002:legacy-placeholder', type: 'video_output', title: 'S002 旧版占位视频', path: 'assets/videos/s002-legacy.mp4', status: 'available', shotId: 'shot:s002' }
    ],
    edges: [
      { id: 'edge:s001:derived', from: 'node:script:s001', to: 'node:prompt:video:s001:v001', type: 'derived_from' }
    ],
    tasks: []
  };

  const { clusters, links } = buildClusters(doc, { shotFilter: 's001' });
  const scriptCluster = clusters.find((cluster) => cluster.column === 'script');
  const supportingLinks = links.filter((link) => link.kind === 'same_shot_output');
  const supportingTitles = supportingLinks.map((link) => clusters.find((cluster) => cluster.id === link.toCluster)?.title);
  const roughcutCluster = clusters.find((cluster) => cluster.title === 'S001-S010 粗剪预览');
  const legacyCluster = clusters.find((cluster) => cluster.title === 'S001 旧版占位视频');

  assert.equal(supportingLinks.length, 2);
  assert.ok(supportingLinks.every((link) => link.fromCluster === scriptCluster.id), 'same-shot video links start at the storyboard script');
  assert.ok(supportingTitles.includes('S001-S010 粗剪预览'));
  assert.ok(supportingTitles.includes('S001 旧版占位视频'));
  assert.ok(!clusters.some((cluster) => cluster.title === 'S002 旧版占位视频'), 'other shot orphan videos stay out of the closure');
  assert.ok(roughcutCluster.badges.includes('预览参考'));
  assert.ok(legacyCluster.badges.includes('旧版参考'));
});

test('cross-cluster uses_reference becomes a single visible link', () => {
  const { links } = buildClusters(baseDoc);
  const referenceLinks = links.filter((link) => link.kind === 'uses_reference');

  assert.equal(referenceLinks.length, 1);
  assert.equal(referenceLinks[0].fromColumn, 'asset');
  assert.equal(referenceLinks[0].toColumn, 'product');
});

test('inactive reference edges stay out of shot canvas closure and links', () => {
  const doc = JSON.parse(JSON.stringify(baseDoc));
  doc.nodes.push({ id: 'node:image:old-ref', type: 'image_asset', title: '旧版误用参考', path: 'old.png', status: 'active' });
  doc.edges.push({
    id: 'edge:video:uses-old-ref',
    from: 'node:prompt:video:s001:v001',
    to: 'node:image:old-ref',
    type: 'uses_reference',
    role: '旧引用',
    status: 'inactive'
  });

  const { clusters, links } = buildClusters(doc, { shotFilter: 's001' });
  const referenceLinks = links.filter((link) => link.kind === 'uses_reference');

  assert.equal(referenceLinks.length, 1);
  assert.ok(!clusters.some((cluster) => cluster.title === '旧版误用参考'));
});

test('intra-cluster generates and qc_for edges are not rendered as links', () => {
  const { links } = buildClusters(baseDoc);
  const internal = links.filter((link) => ['generates', 'qc_for'].includes(link.kind));
  assert.equal(internal.length, 0);
});

test('clusters land on the same row band when they share a shotNo', () => {
  const { clusters } = buildClusters(baseDoc);
  const rows = new Set(clusters.map((cluster) => cluster.row));
  assert.equal(rows.size, 1);

  const xs = clusters.map((cluster) => cluster.position.x).sort((a, b) => a - b);
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2], 'columns must be left-to-right');
});

test('orphan asset without prompt still becomes a single asset cluster', () => {
  const orphanDoc = {
    schemaVersion: '0.1.0',
    nodes: [
      { id: 'node:image:orphan', type: 'image_asset', title: 'orphan', path: 'foo.png', status: 'active' }
    ],
    edges: [],
    tasks: []
  };
  const { clusters } = buildClusters(orphanDoc);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].column, 'asset');
  assert.equal(clusters[0].isOrphan, true);
});

test('shotFilter keeps only the script + product of the target shot plus referenced assets', () => {
  // 多镜头 doc：s001 引用 char_robot + kf-s001；s002 引用 char_tower + kf-s002
  const multiShotDoc = {
    nodes: [
      { id: 'node:script:s001', type: 'script_segment', title: 's001 开场', shotId: 'shot:s001' },
      { id: 'node:script:s002', type: 'script_segment', title: 's002 转场', shotId: 'shot:s002' },
      // 共用素材 - 角色立绘
      { id: 'node:prompt:image:char-robot', type: 'image_prompt', title: '小邮' },
      { id: 'node:image:char-robot', type: 'image_asset', title: '小邮', path: 'scripts/assets/characters/images/char_robot_v001.png' },
      { id: 'node:prompt:image:char-tower', type: 'image_prompt', title: '小灯' },
      { id: 'node:image:char-tower', type: 'image_asset', title: '小灯', path: 'scripts/assets/characters/images/char_tower_v001.png' },
      // 各 shot 关键帧
      { id: 'node:prompt:image:kf-s001', type: 'image_prompt', title: 'KF-s001' },
      { id: 'node:image:kf-s001', type: 'image_asset', title: 'KF-s001', path: 'scripts/assets/keyframes/s001.png' },
      { id: 'node:prompt:image:kf-s002', type: 'image_prompt', title: 'KF-s002' },
      { id: 'node:image:kf-s002', type: 'image_asset', title: 'KF-s002', path: 'scripts/assets/keyframes/s002.png' },
      // 各 shot 视频产物
      { id: 'node:prompt:video:s001:v001', type: 'video_prompt', title: 's001 视频提示词', shotId: 'shot:s001' },
      { id: 'node:video:s001:v001', type: 'video_output', title: 's001.mp4', shotId: 'shot:s001', path: 'raw-videos/s001.mp4' },
      { id: 'node:prompt:video:s002:v001', type: 'video_prompt', title: 's002 视频提示词', shotId: 'shot:s002' },
      { id: 'node:video:s002:v001', type: 'video_output', title: 's002.mp4', shotId: 'shot:s002', path: 'raw-videos/s002.mp4' }
    ],
    edges: [
      { id: 'e1', from: 'node:prompt:image:char-robot', to: 'node:image:char-robot', type: 'generates' },
      { id: 'e2', from: 'node:prompt:image:char-tower', to: 'node:image:char-tower', type: 'generates' },
      { id: 'e3', from: 'node:prompt:image:kf-s001', to: 'node:image:kf-s001', type: 'generates' },
      { id: 'e4', from: 'node:prompt:image:kf-s002', to: 'node:image:kf-s002', type: 'generates' },
      { id: 'e5', from: 'node:prompt:video:s001:v001', to: 'node:video:s001:v001', type: 'generates' },
      { id: 'e6', from: 'node:prompt:video:s002:v001', to: 'node:video:s002:v001', type: 'generates' },
      // s001 引用：小邮 + KF-s001
      { id: 'e7', from: 'node:prompt:video:s001:v001', to: 'node:image:char-robot', type: 'uses_reference', role: '角色' },
      { id: 'e8', from: 'node:prompt:video:s001:v001', to: 'node:image:kf-s001', type: 'uses_reference', role: '首帧' },
      // s002 引用：小灯 + KF-s002
      { id: 'e9', from: 'node:prompt:video:s002:v001', to: 'node:image:char-tower', type: 'uses_reference', role: '角色' },
      { id: 'e10', from: 'node:prompt:video:s002:v001', to: 'node:image:kf-s002', type: 'uses_reference', role: '首帧' }
    ],
    tasks: []
  };

  const { clusters, links } = buildClusters(multiShotDoc, { shotFilter: 's001' });

  // 闭包内必须包含：s001 script、s001 product、小邮 asset、KF-s001 asset
  const titles = clusters.map((c) => c.title);
  assert.ok(titles.some((t) => t.includes('s001 开场')), 's001 script kept');
  assert.ok(titles.some((t) => t.includes('小邮')), 'robot asset kept');
  assert.ok(titles.some((t) => t.includes('KF-s001')), 's001 keyframe kept');
  // 不属于该 shot 的资源不应出现
  assert.ok(!titles.some((t) => t.includes('s002')), 's002 clusters dropped');
  assert.ok(!titles.some((t) => t.includes('小灯')), 'tower asset dropped');
  assert.ok(!titles.some((t) => t.includes('KF-s002')), 's002 keyframe dropped');

  // 连线只保留 闭包→闭包
  for (const link of links) {
    assert.ok(clusters.some((c) => c.id === link.fromCluster), `link from ${link.fromCluster} kept`);
    assert.ok(clusters.some((c) => c.id === link.toCluster), `link to ${link.toCluster} kept`);
  }
});

test('shotFilter does not pull in other shots that share the same referenced asset', () => {
  // 回归用例：当多个 shot 引用同一个共享素材时，闭包过滤必须保持单向：
  // s001 闭包应包含共享素材 (robot)，但不能因此把 s002 的 product 也带进来。
  const doc = {
    nodes: [
      { id: 'node:script:s001', type: 'script_segment', title: 's001 开场', shotId: 'shot:s001' },
      { id: 'node:script:s002', type: 'script_segment', title: 's002 转场', shotId: 'shot:s002' },
      { id: 'node:prompt:image:char-robot', type: 'image_prompt', title: '小邮' },
      { id: 'node:image:char-robot', type: 'image_asset', title: '小邮', path: 'a/robot.png' },
      { id: 'node:prompt:video:s001:v001', type: 'video_prompt', title: 's001 视频', shotId: 'shot:s001' },
      { id: 'node:video:s001:v001', type: 'video_output', title: 's001.mp4', shotId: 'shot:s001', path: 'r1.mp4' },
      { id: 'node:prompt:video:s002:v001', type: 'video_prompt', title: 's002 视频', shotId: 'shot:s002' },
      { id: 'node:video:s002:v001', type: 'video_output', title: 's002.mp4', shotId: 'shot:s002', path: 'r2.mp4' }
    ],
    edges: [
      { id: 'e1', from: 'node:prompt:image:char-robot', to: 'node:image:char-robot', type: 'generates' },
      { id: 'e2', from: 'node:prompt:video:s001:v001', to: 'node:video:s001:v001', type: 'generates' },
      { id: 'e3', from: 'node:prompt:video:s002:v001', to: 'node:video:s002:v001', type: 'generates' },
      // 两个 shot 都引用同一个共享素材
      { id: 'e4', from: 'node:prompt:video:s001:v001', to: 'node:image:char-robot', type: 'uses_reference', role: '角色' },
      { id: 'e5', from: 'node:prompt:video:s002:v001', to: 'node:image:char-robot', type: 'uses_reference', role: '角色' }
    ],
    tasks: []
  };

  const { clusters } = buildClusters(doc, { shotFilter: 's001' });
  const titles = clusters.map((c) => c.title);
  assert.ok(titles.some((t) => t.includes('小邮')), 'shared asset kept in closure');
  assert.ok(!titles.some((t) => t.includes('s002')), 's002 product must not leak through shared asset');
});

test('shotFilter accepts the shot:<id> form as well as plain shotNo', () => {
  const doc = {
    nodes: [
      { id: 'node:script:s001', type: 'script_segment', title: 's001 开场', shotId: 'shot:s001' },
      { id: 'node:prompt:video:s001:v001', type: 'video_prompt', title: 's001 视频', shotId: 'shot:s001' },
      { id: 'node:video:s001:v001', type: 'video_output', title: 's001.mp4', shotId: 'shot:s001', path: 'r.mp4' }
    ],
    edges: [
      { id: 'e1', from: 'node:prompt:video:s001:v001', to: 'node:video:s001:v001', type: 'generates' }
    ],
    tasks: []
  };
  const a = buildClusters(doc, { shotFilter: 's001' });
  const b = buildClusters(doc, { shotFilter: 'shot:s001' });
  assert.deepEqual(a.clusters.map((c) => c.id), b.clusters.map((c) => c.id));
});

test('script_uses_asset edge produces a script -> asset link without column reversal', () => {
  // 剧本卡（列 0）通过 script_uses_asset 直连素材卡（列 1）；连线方向应为 script -> asset。
  const doc = {
    nodes: [
      { id: 'node:script:s001', type: 'script_segment', title: 's001 开场', shotId: 'shot:s001' },
      { id: 'node:prompt:image:char-robot', type: 'image_prompt', title: '小邮' },
      { id: 'node:image:char-robot', type: 'image_asset', title: '小邮', path: 'a/robot.png' }
    ],
    edges: [
      { id: 'e1', from: 'node:prompt:image:char-robot', to: 'node:image:char-robot', type: 'generates' },
      { id: 'e2', from: 'node:script:s001', to: 'node:image:char-robot', type: 'script_uses_asset', role: '出场角色' }
    ],
    tasks: []
  };
  const { clusters, links } = buildClusters(doc);
  const scriptCluster = clusters.find((c) => c.column === 'script');
  const assetCluster = clusters.find((c) => c.column === 'asset');
  const link = links.find((l) => l.kind === 'script_uses_asset');
  assert.ok(link, 'script_uses_asset link emitted');
  assert.equal(link.fromCluster, scriptCluster.id, 'link starts at script cluster');
  assert.equal(link.toCluster, assetCluster.id, 'link ends at asset cluster');
  assert.equal(link.tone, 'reference');
  assert.equal(link.label, '出场角色');
});

test('shotFilter pulls in assets referenced by the kept script via script_uses_asset', () => {
  // s001 的剧本通过 script_uses_asset 引用素材 → 闭包应包含该素材；s002 的剧本及其素材不应进入。
  const doc = {
    nodes: [
      { id: 'node:script:s001', type: 'script_segment', title: 's001 开场', shotId: 'shot:s001' },
      { id: 'node:script:s002', type: 'script_segment', title: 's002 转场', shotId: 'shot:s002' },
      { id: 'node:prompt:image:char-robot', type: 'image_prompt', title: '小邮' },
      { id: 'node:image:char-robot', type: 'image_asset', title: '小邮', path: 'a/robot.png' },
      { id: 'node:prompt:image:char-other', type: 'image_prompt', title: '其他角色' },
      { id: 'node:image:char-other', type: 'image_asset', title: '其他角色', path: 'a/other.png' }
    ],
    edges: [
      { id: 'e1', from: 'node:prompt:image:char-robot', to: 'node:image:char-robot', type: 'generates' },
      { id: 'e2', from: 'node:prompt:image:char-other', to: 'node:image:char-other', type: 'generates' },
      { id: 'e3', from: 'node:script:s001', to: 'node:image:char-robot', type: 'script_uses_asset' },
      { id: 'e4', from: 'node:script:s002', to: 'node:image:char-other', type: 'script_uses_asset' }
    ],
    tasks: []
  };
  const { clusters } = buildClusters(doc, { shotFilter: 's001' });
  const titles = clusters.map((c) => c.title);
  assert.ok(titles.some((t) => t.includes('s001 开场')), 's001 script kept');
  assert.ok(titles.some((t) => t.includes('小邮')), 'asset referenced by s001 script kept');
  assert.ok(!titles.some((t) => t.includes('s002')), 's002 script dropped');
  assert.ok(!titles.some((t) => t.includes('其他角色')), 'asset only referenced by s002 dropped');
});
