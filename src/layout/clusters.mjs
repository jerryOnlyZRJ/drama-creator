// Fold raw schema nodes/edges into "clusters": resource cards that merge
// 1:1 prompt -> asset / prompt -> output / qc_for relationships into a single card.
// The canvas renders clusters, not raw nodes, so prompt-and-product become one tile
// and only true cross-shot dependencies remain as visible lines.

const SCRIPT_TYPES = new Set(['script_segment']);
const IMAGE_PROMPT_TYPES = new Set(['image_prompt']);
const VIDEO_PROMPT_TYPES = new Set(['video_prompt']);
const AUDIO_PROMPT_TYPES = new Set(['audio_prompt']);
const IMAGE_ASSET_TYPES = new Set(['image_asset']);
const AUDIO_ASSET_TYPES = new Set(['audio_asset']);
const VIDEO_OUTPUT_TYPES = new Set(['video_output']);
const QC_TYPES = new Set(['qc_record']);
const POST_TYPES = new Set(['post_task']);

const COLUMN_SCRIPT = 'script';
const COLUMN_ASSET = 'asset';
const COLUMN_PRODUCT = 'product';

export const COLUMNS = [COLUMN_SCRIPT, COLUMN_ASSET, COLUMN_PRODUCT];

export function buildClusters(doc, { shotFilter } = {}) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc?.edges) ? doc.edges : [];
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const generatesByFrom = indexEdges(edges, 'generates', 'from');
  const generatesByTo = indexEdges(edges, 'generates', 'to');
  const qcByTarget = indexEdges(edges, 'qc_for', 'to');
  const usesByFrom = indexEdges(edges, 'uses_reference', 'from');
  // 剧本 → 素材 引用：列 0 → 列 1，方向天然左到右，连线无需反转。
  const scriptUsesByFrom = indexEdges(edges, 'script_uses_asset', 'from');
  const derivedByFrom = indexEdges(edges, 'derived_from', 'from');
  const continuesByFrom = indexEdges(edges, 'continues_to', 'from');

  const consumed = new Set();
  const clusters = [];

  for (const node of nodes) {
    if (consumed.has(node.id)) continue;

    if (SCRIPT_TYPES.has(node.type)) {
      consumed.add(node.id);
      clusters.push(scriptCluster(node));
      continue;
    }

    if (VIDEO_PROMPT_TYPES.has(node.type)) {
      const cluster = productClusterFromPrompt({
        doc,
        promptNode: node,
        nodeById,
        consumed,
        generatesByFrom,
        qcByTarget,
        tasks
      });
      clusters.push(cluster);
      continue;
    }

    if (IMAGE_PROMPT_TYPES.has(node.type) || AUDIO_PROMPT_TYPES.has(node.type)) {
      clusters.push(assetClusterFromPrompt({ promptNode: node, nodeById, consumed, generatesByFrom }));
      continue;
    }

    if (IMAGE_ASSET_TYPES.has(node.type) || AUDIO_ASSET_TYPES.has(node.type)) {
      clusters.push(assetClusterFromOrphanAsset({ assetNode: node, nodeById, consumed, generatesByTo }));
      continue;
    }

    if (VIDEO_OUTPUT_TYPES.has(node.type)) {
      clusters.push(productClusterFromOrphanOutput({
        outputNode: node,
        nodeById,
        consumed,
        generatesByTo,
        qcByTarget,
        tasks
      }));
      continue;
    }

    if (QC_TYPES.has(node.type) && !consumed.has(node.id)) {
      consumed.add(node.id);
      clusters.push(qcCluster(node));
      continue;
    }

    if (POST_TYPES.has(node.type)) {
      consumed.add(node.id);
      clusters.push(postTaskCluster(node));
      continue;
    }
  }

  const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const memberToCluster = new Map();
  for (const cluster of clusters) {
    for (const memberId of cluster.memberIds) {
      memberToCluster.set(memberId, cluster.id);
    }
  }

  const links = buildLinks({
    memberToCluster,
    clustersById,
    usesByFrom,
    scriptUsesByFrom,
    derivedByFrom,
    continuesByFrom
  });
  appendSameShotOutputLinks({ clusters, links });

  // shotFilter 闭包：只保留属于该 shot 的 script + product cluster，加上被该 shot 通过
  // uses_reference 引用到的 asset cluster；连线只在闭包内部保留。
  const filtered = shotFilter
    ? applyShotFilter({ clusters, links, memberToCluster, shotFilter, edges })
    : { clusters, links };

  const positioned = layoutClusters(filtered.clusters);
  return { clusters: positioned, links: filtered.links };
}

function applyShotFilter({ clusters, links, memberToCluster, shotFilter, edges }) {
  const targetShot = normalizeShotNo(shotFilter);
  const keepClusterIds = new Set();

  for (const cluster of clusters) {
    if ((cluster.column === 'script' || cluster.column === 'product') && cluster.shotNo === targetShot) {
      keepClusterIds.add(cluster.id);
    }
  }

  // 收集该 shot 通过 uses_reference / script_uses_asset 引用到的素材 cluster。
  // 单向闭包：仅从 keep 中的 script/prompt/product 出发拉入引用到的 asset；
  // 不做反向拉取，否则共享素材会把其他 shot 的 product 全部带进闭包。
  for (const edge of edges) {
    // inactive 边只保留历史证据，不应把旧参考资源重新拉回当前镜头画布。
    if (!isActiveEdge(edge)) continue;
    if (edge.type !== 'uses_reference' && edge.type !== 'script_uses_asset') continue;
    const fromCluster = memberToCluster.get(edge.from);
    const toCluster = memberToCluster.get(edge.to);
    if (!fromCluster || !toCluster) continue;
    if (keepClusterIds.has(fromCluster)) keepClusterIds.add(toCluster);
  }

  const filteredClusters = clusters.filter((cluster) => keepClusterIds.has(cluster.id));
  const filteredLinks = links.filter((link) => keepClusterIds.has(link.fromCluster) && keepClusterIds.has(link.toCluster));
  return { clusters: filteredClusters, links: filteredLinks };
}

function normalizeShotNo(value) {
  if (!value) return null;
  return String(value).replace(/^shot:/, '');
}

function findShotForNode(doc, node) {
  if (!node) return null;
  const normalizedShotNo = normalizeShotNo(node.shotId);
  return (doc?.shots || []).find((shot) => {
    const shotNo = shot.shotNo || normalizeShotNo(shot.id);
    return shot.id === node.shotId || shotNo === normalizedShotNo;
  }) || null;
}

function selectPrimaryVideoOutput(doc, promptNode, outputs) {
  if (!outputs.length) return null;
  const shot = findShotForNode(doc, promptNode) || findShotForNode(doc, outputs[0]);
  const versions = shot?.videoVersions || null;

  // A shot can keep both a confirmed current cut and a newly imported candidate.
  // The canvas should display the current cut first; if there is no current cut yet,
  // show the candidate so manual imports are visible immediately.
  if (versions?.current) {
    const current = outputs.find((output) => output.id === versions.current);
    if (current) return current;
  }
  if (versions?.candidate) {
    const candidate = outputs.find((output) => output.id === versions.candidate);
    if (candidate) return candidate;
  }

  return outputs.find((output) => output.metadata?.versionRole === 'current')
    || outputs.find((output) => output.metadata?.versionRole === 'candidate')
    || outputs[0];
}

function scriptCluster(node) {
  const shotNo = shotNoOf(node);
  return {
    id: `cluster:script:${node.id}`,
    column: COLUMN_SCRIPT,
    kind: 'script',
    shotNo,
    title: node.title || shotNo,
    subtitle: '剧本片段',
    statusLabel: shotNo ? `镜头 ${shotNo}` : '剧本',
    badges: [],
    memberIds: [node.id],
    primaryNodeId: node.id,
    members: { script: node }
  };
}

function assetClusterFromPrompt({ promptNode, nodeById, consumed, generatesByFrom }) {
  consumed.add(promptNode.id);
  const generatesEdges = generatesByFrom.get(promptNode.id) || [];
  const assetNode = generatesEdges
    .map((edge) => nodeById.get(edge.to))
    .find((node) => node && (IMAGE_ASSET_TYPES.has(node.type) || AUDIO_ASSET_TYPES.has(node.type))) || null;
  if (assetNode) consumed.add(assetNode.id);

  const isImage = IMAGE_PROMPT_TYPES.has(promptNode.type);
  const kind = isImage ? 'image' : 'audio';
  const memberIds = [promptNode.id];
  if (assetNode) memberIds.push(assetNode.id);

  return {
    id: `cluster:asset:${kind}:${promptNode.id}`,
    column: COLUMN_ASSET,
    kind,
    shotNo: shotNoOf(promptNode) || shotNoOf(assetNode),
    title: assetNode?.title || promptNode.title,
    subtitle: isImage ? '图片资源' : '音频资源',
    statusLabel: assetNode?.status || promptNode.status,
    badges: collectAssetBadges({ promptNode, assetNode }),
    memberIds,
    primaryNodeId: assetNode?.id || promptNode.id,
    members: { prompt: promptNode, asset: assetNode },
    asset: assetNode
      ? { type: assetNode.type, path: assetNode.path, title: assetNode.title }
      : null,
    promptText: promptNode.metadata?.prompt || '',
    isOrphan: !assetNode
  };
}

function assetClusterFromOrphanAsset({ assetNode, nodeById, consumed, generatesByTo }) {
  consumed.add(assetNode.id);
  const generates = generatesByTo.get(assetNode.id) || [];
  const promptNode = generates
    .map((edge) => nodeById.get(edge.from))
    .find((node) => node && (IMAGE_PROMPT_TYPES.has(node.type) || AUDIO_PROMPT_TYPES.has(node.type))) || null;
  if (promptNode) consumed.add(promptNode.id);

  const isImage = IMAGE_ASSET_TYPES.has(assetNode.type);
  const kind = isImage ? 'image' : 'audio';
  const memberIds = [assetNode.id];
  if (promptNode) memberIds.push(promptNode.id);

  return {
    id: `cluster:asset:${kind}:${assetNode.id}`,
    column: COLUMN_ASSET,
    kind,
    shotNo: shotNoOf(assetNode) || shotNoOf(promptNode),
    title: assetNode.title,
    subtitle: isImage ? '图片素材' : '音频素材',
    statusLabel: assetNode.status,
    badges: collectAssetBadges({ promptNode, assetNode }),
    memberIds,
    primaryNodeId: assetNode.id,
    members: { prompt: promptNode, asset: assetNode },
    asset: { type: assetNode.type, path: assetNode.path, title: assetNode.title },
    promptText: promptNode?.metadata?.prompt || '',
    isOrphan: !promptNode
  };
}

function productClusterFromPrompt({ doc, promptNode, nodeById, consumed, generatesByFrom, qcByTarget, tasks }) {
  consumed.add(promptNode.id);
  const generatesEdges = generatesByFrom.get(promptNode.id) || [];
  const outputs = generatesEdges
    .map((edge) => nodeById.get(edge.to))
    .filter((node) => node && VIDEO_OUTPUT_TYPES.has(node.type));
  const primaryOutput = selectPrimaryVideoOutput(doc, promptNode, outputs);
  for (const output of outputs) consumed.add(output.id);

  const qcNode = primaryOutput ? findQcForTarget(primaryOutput.id, qcByTarget, nodeById, consumed) : null;
  const task = tasks.find((item) => item.promptNodeId === promptNode.id) || null;

  const memberIds = [promptNode.id, ...outputs.map((output) => output.id)];
  if (qcNode) memberIds.push(qcNode.id);

  return {
    id: `cluster:product:${promptNode.id}`,
    column: COLUMN_PRODUCT,
    kind: 'video',
    shotNo: shotNoOf(promptNode) || shotNoOf(primaryOutput),
    // Imported/current videos are what users need to identify on the canvas; the
    // prompt title is only a fallback before any output has been selected.
    title: primaryOutput?.title || promptNode.title?.replace(/视频提示词$/u, '镜头产物') || '镜头产物',
    subtitle: '镜头产物',
    statusLabel: primaryOutput?.status || promptNode.status,
    badges: collectProductBadges({ primaryOutput, task }),
    memberIds,
    primaryNodeId: primaryOutput?.id || promptNode.id,
    members: { prompt: promptNode, primaryOutput, outputs, qc: qcNode, task },
    output: primaryOutput
      ? {
          path: primaryOutput.path,
          title: primaryOutput.title,
          version: primaryOutput.metadata?.version,
          versionRole: primaryOutput.metadata?.versionRole
        }
      : null,
    promptText: promptNode.metadata?.prompt || '',
    qc: qcNode ? { status: qcNode.status, note: qcNode.metadata?.qcNote || '', updatedAt: qcNode.metadata?.qcUpdatedAt || null } : null,
    task: task ? { id: task.id, fields: task.fields || {}, status: task.status } : null
  };
}

function productClusterFromOrphanOutput({ outputNode, nodeById, consumed, generatesByTo, qcByTarget, tasks }) {
  consumed.add(outputNode.id);
  const generates = generatesByTo.get(outputNode.id) || [];
  const promptNode = generates
    .map((edge) => nodeById.get(edge.from))
    .find((node) => node && VIDEO_PROMPT_TYPES.has(node.type)) || null;
  if (promptNode) consumed.add(promptNode.id);

  const qcNode = findQcForTarget(outputNode.id, qcByTarget, nodeById, consumed);
  const task = tasks.find((item) => item.outputNodeIds?.includes(outputNode.id) || item.promptNodeId === promptNode?.id) || null;

  const memberIds = [outputNode.id];
  if (promptNode) memberIds.push(promptNode.id);
  if (qcNode) memberIds.push(qcNode.id);

  return {
    id: `cluster:product:${outputNode.id}`,
    column: COLUMN_PRODUCT,
    kind: 'video',
    shotNo: shotNoOf(outputNode) || shotNoOf(promptNode),
    title: outputNode.title || promptNode?.title || '镜头产物',
    subtitle: '镜头产物',
    statusLabel: outputNode.status,
    badges: collectProductBadges({ primaryOutput: outputNode, task }),
    memberIds,
    primaryNodeId: outputNode.id,
    members: { prompt: promptNode, primaryOutput: outputNode, outputs: [outputNode], qc: qcNode, task },
    output: {
      path: outputNode.path,
      title: outputNode.title,
      version: outputNode.metadata?.version,
      versionRole: outputNode.metadata?.versionRole
    },
    promptText: promptNode?.metadata?.prompt || '',
    qc: qcNode ? { status: qcNode.status, note: qcNode.metadata?.qcNote || '', updatedAt: qcNode.metadata?.qcUpdatedAt || null } : null,
    task: task ? { id: task.id, fields: task.fields || {}, status: task.status } : null
  };
}

function qcCluster(node) {
  return {
    id: `cluster:qc:${node.id}`,
    column: COLUMN_PRODUCT,
    kind: 'qc',
    shotNo: shotNoOf(node),
    title: node.title || 'QC 记录',
    subtitle: '质检记录',
    statusLabel: node.status,
    badges: [],
    memberIds: [node.id],
    primaryNodeId: node.id,
    members: { qc: node },
    qc: { status: node.status, note: node.metadata?.qcNote || node.metadata?.text || '', updatedAt: node.metadata?.qcUpdatedAt || null }
  };
}

function postTaskCluster(node) {
  return {
    id: `cluster:post:${node.id}`,
    column: COLUMN_PRODUCT,
    kind: 'post',
    shotNo: shotNoOf(node),
    title: node.title || '后期任务',
    subtitle: '后期任务',
    statusLabel: node.status,
    badges: [],
    memberIds: [node.id],
    primaryNodeId: node.id,
    members: { post: node }
  };
}

function findQcForTarget(targetNodeId, qcByTarget, nodeById, consumed) {
  const candidates = qcByTarget.get(targetNodeId) || [];
  for (const edge of candidates) {
    const node = nodeById.get(edge.from);
    if (node && QC_TYPES.has(node.type)) {
      consumed.add(node.id);
      return node;
    }
  }
  return null;
}

function collectAssetBadges({ promptNode, assetNode }) {
  const badges = [];
  if (assetNode?.metadata?.chip) badges.push(assetNode.metadata.chip);
  if (assetNode?.path) {
    const versionMatch = assetNode.path.match(/_v(\d+)\.[a-z0-9]+$/i);
    if (versionMatch) badges.push(`v${versionMatch[1]}`);
  }
  if (!assetNode && promptNode) badges.push('待生成');
  return badges;
}

function collectProductBadges({ primaryOutput, task }) {
  const badges = [];
  if (task?.fields?.ratio) badges.push(task.fields.ratio);
  if (task?.fields?.duration) badges.push(`${task.fields.duration}s`);
  const roleBadge = productRoleBadge(primaryOutput);
  if (roleBadge) badges.push(roleBadge);
  if (primaryOutput?.metadata?.version) badges.push(primaryOutput.metadata.version);
  if (primaryOutput?.metadata?.versionRole === 'current') badges.push('当前版本');
  if (primaryOutput?.metadata?.versionRole === 'candidate') badges.push('候选版本');
  if (!primaryOutput) badges.push('待投喂');
  return badges;
}

function productRoleBadge(primaryOutput) {
  if (!primaryOutput) return null;
  const role = primaryOutput.metadata?.role || '';
  const legacyRole = primaryOutput.metadata?.legacyRole || '';
  if (role === 'assembly_preview') return '预览参考';
  if (primaryOutput.metadata?.detachedFromStoryboardAt || legacyRole.startsWith('legacy_')) return '旧版参考';
  return null;
}

function indexEdges(edges, type, key) {
  const map = new Map();
  for (const edge of edges) {
    if (!isActiveEdge(edge)) continue;
    if (edge.type !== type) continue;
    const id = edge[key];
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(edge);
  }
  return map;
}

function isActiveEdge(edge) {
  // 画布只展示当前闭包；历史诊断/废弃引用边保留在数据里，但不能重新拉入旧素材卡。
  if (edge.active === false) return false;
  if (edge.status && edge.status !== 'active') return false;
  return !(edge.metadata?.disabledAt || edge.metadata?.inactiveAt || edge.metadata?.inactiveReason);
}

function shotNoOf(node) {
  if (!node) return null;
  if (node.shotId) return node.shotId.replace(/^shot:/, '');
  if (node.metadata?.legacyShotId) return normalizeShotNo(node.metadata.legacyShotId);
  const match = node.id?.match(/:(s\d+[a-z]?)/);
  return match ? match[1] : null;
}

function shotSortKey(shotNo) {
  if (!shotNo) return Number.POSITIVE_INFINITY;
  const match = shotNo.match(/^s(\d+)([a-z]?)$/i);
  if (!match) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * 100 + (match[2] ? match[2].charCodeAt(0) - 96 : 0);
}

function buildLinks({ memberToCluster, clustersById, usesByFrom, scriptUsesByFrom, derivedByFrom, continuesByFrom }) {
  const seen = new Set();
  const links = [];

  function pushLink(edge, kind, tone) {
    let fromCluster = memberToCluster.get(edge.from);
    let toCluster = memberToCluster.get(edge.to);
    if (!fromCluster || !toCluster || fromCluster === toCluster) return;

    // uses_reference is authored as prompt -> asset, but the canvas reads naturally
    // as asset -> product because the asset feeds into the downstream shot.
    // script_uses_asset 已经是 script -> asset 的左到右方向，不做反转。
    if (kind === 'uses_reference') {
      [fromCluster, toCluster] = [toCluster, fromCluster];
    }

    const dedupeKey = `${kind}:${fromCluster}>${toCluster}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    links.push({
      id: `link:${kind}:${edge.id}`,
      kind,
      tone,
      fromCluster,
      toCluster,
      fromColumn: clustersById.get(fromCluster)?.column,
      toColumn: clustersById.get(toCluster)?.column,
      label: edgeLabel(kind, edge)
    });
  }

  for (const edges of usesByFrom.values()) {
    for (const edge of edges) pushLink(edge, 'uses_reference', 'reference');
  }
  for (const edges of scriptUsesByFrom.values()) {
    for (const edge of edges) pushLink(edge, 'script_uses_asset', 'reference');
  }
  for (const edges of derivedByFrom.values()) {
    for (const edge of edges) pushLink(edge, 'derived_from', 'derived');
  }
  for (const edges of continuesByFrom.values()) {
    for (const edge of edges) pushLink(edge, 'continues_to', 'continuation');
  }

  return links;
}

function appendSameShotOutputLinks({ clusters, links }) {
  const clustersByShot = new Map();
  for (const cluster of clusters) {
    if (!cluster.shotNo) continue;
    if (!clustersByShot.has(cluster.shotNo)) clustersByShot.set(cluster.shotNo, []);
    clustersByShot.get(cluster.shotNo).push(cluster);
  }

  for (const shotClusters of clustersByShot.values()) {
    const scriptAnchor = shotClusters.find((cluster) => cluster.column === COLUMN_SCRIPT);
    const promptProductAnchor = shotClusters.find((cluster) => (
      cluster.column === COLUMN_PRODUCT
      && cluster.kind === 'video'
      && cluster.members?.prompt
    ));
    const anchor = scriptAnchor || promptProductAnchor;
    if (!anchor) continue;

    const orphanVideos = shotClusters.filter((cluster) => (
      cluster.column === COLUMN_PRODUCT
      && cluster.kind === 'video'
      && !cluster.members?.prompt
      && cluster.members?.primaryOutput
    ));

    for (const videoCluster of orphanVideos) {
      if (videoCluster.id === anchor.id) continue;
      const dedupeKey = `same_shot_output:${anchor.id}>${videoCluster.id}`;
      if (links.some((link) => `${link.kind}:${link.fromCluster}>${link.toCluster}` === dedupeKey)) continue;

      // 旧版短段、粗剪和手动导入候选不是正式 generates 产物；这里仅补画布视图关系，
      // 让用户看到它们属于同一分镜上下文，同时不改变“当前版本”或真实项目依赖。
      links.push({
        id: `link:${dedupeKey}`,
        kind: 'same_shot_output',
        tone: 'supporting',
        fromCluster: anchor.id,
        toCluster: videoCluster.id,
        fromColumn: anchor.column,
        toColumn: videoCluster.column,
        label: sameShotOutputLabel(videoCluster)
      });
    }
  }
}

function sameShotOutputLabel(cluster) {
  return productRoleBadge(cluster.members?.primaryOutput) || '同镜头产物';
}

function edgeLabel(kind, edge) {
  if (kind === 'uses_reference') return edge.role || '引用';
  if (kind === 'script_uses_asset') return edge.role || '剧本引用';
  if (kind === 'same_shot_output') return '同镜头产物';
  if (kind === 'derived_from') return '派生';
  if (kind === 'continues_to') return '转场';
  return kind;
}

const COLUMN_INDEX = {
  [COLUMN_SCRIPT]: 0,
  [COLUMN_ASSET]: 1,
  [COLUMN_PRODUCT]: 2
};

const LAYOUT = {
  cardWidth: 280,
  rowHeight: 320,
  rowGap: 36,
  columnGap: 88,
  columnPadding: 56,
  topPadding: 56
};

export function layoutClusters(clusters) {
  // Group clusters by column then assign row indices keyed off shotNo so
  // the same shot lands in the same horizontal row across columns.
  const rowByShotKey = new Map();
  const orderedShots = [...new Set(clusters.map((cluster) => cluster.shotNo).filter(Boolean))]
    .sort((a, b) => shotSortKey(a) - shotSortKey(b));
  orderedShots.forEach((shotNo, index) => rowByShotKey.set(shotNo, index));

  const positioned = clusters.map((cluster) => ({ ...cluster }));
  const columnRowFill = new Map();

  for (const cluster of positioned) {
    const columnKey = cluster.column;
    if (!columnRowFill.has(columnKey)) columnRowFill.set(columnKey, new Set());
    const usedRows = columnRowFill.get(columnKey);

    let row = cluster.shotNo ? rowByShotKey.get(cluster.shotNo) : null;
    if (row === undefined || row === null || usedRows.has(row)) {
      row = nextFreeRow(usedRows, row ?? 0, orderedShots.length);
    }
    usedRows.add(row);
    cluster.row = row;
    cluster.columnIndex = COLUMN_INDEX[columnKey] ?? 0;
    cluster.position = positionFor(cluster.columnIndex, row);
  }

  positioned.sort((a, b) => {
    if (a.columnIndex !== b.columnIndex) return a.columnIndex - b.columnIndex;
    return a.row - b.row;
  });
  return positioned;
}

function nextFreeRow(usedRows, preferredRow, baseline) {
  let row = preferredRow >= 0 ? preferredRow : 0;
  while (usedRows.has(row)) row += 1;
  if (row < baseline) return row;
  return row;
}

function positionFor(columnIndex, row) {
  const x = LAYOUT.columnPadding + columnIndex * (LAYOUT.cardWidth + LAYOUT.columnGap);
  const y = LAYOUT.topPadding + row * (LAYOUT.rowHeight + LAYOUT.rowGap);
  return {
    x,
    y,
    width: LAYOUT.cardWidth,
    height: LAYOUT.rowHeight,
    centerX: x + LAYOUT.cardWidth / 2,
    centerY: y + LAYOUT.rowHeight / 2
  };
}

export const LAYOUT_METRICS = LAYOUT;
