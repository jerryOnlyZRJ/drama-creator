const QC_STATUSES = new Set(['reviewing', 'approved', 'rerun_needed']);
const BLOCKED_EXPORT_VERSION_ROLES = new Set(['candidate', 'unselected', 'rejected', 'stale_candidate']);
const BLOCKED_PREVIEW_VERSION_ROLES = new Set(['unselected', 'rejected', 'stale_candidate']);

export function ensureShotVideoVersions(shot) {
  if (!shot.videoVersions || typeof shot.videoVersions !== 'object') {
    shot.videoVersions = { current: null, candidate: null };
  }
  if (!Object.prototype.hasOwnProperty.call(shot.videoVersions, 'current')) {
    shot.videoVersions.current = null;
  }
  if (!Object.prototype.hasOwnProperty.call(shot.videoVersions, 'candidate')) {
    shot.videoVersions.candidate = null;
  }
  return shot.videoVersions;
}

export function markVideoNodeAsCandidate(doc, shot, node) {
  const versions = ensureShotVideoVersions(shot);
  const previousCandidate = versions.candidate && versions.candidate !== versions.current
    ? findNode(doc, versions.candidate)
    : null;
  if (previousCandidate && previousCandidate.id !== node.id) {
    previousCandidate.metadata = {
      ...(previousCandidate.metadata || {}),
      versionRole: 'unselected'
    };
  }

  versions.candidate = node.id;
  node.status = 'reviewing';
  node.metadata = {
    ...(node.metadata || {}),
    versionRole: 'candidate'
  };
  shot.status = 'reviewing';
  updateVideoTaskForShot(doc, shot, { status: 'reviewing', outputNodeId: node.id });
}

export function promoteVideoNodeToCurrent(doc, { shotNo, nodeId }) {
  const shot = findShot(doc, shotNo);
  if (!shot) {
    return { error: `Shot not found: ${shotNo}`, statusCode: 404 };
  }
  const node = findNode(doc, nodeId);
  if (!node || node.type !== 'video_output' || node.shotId !== shot.id) {
    return { error: `Video output not found for shot: ${nodeId}`, statusCode: 404 };
  }

  const versions = ensureShotVideoVersions(shot);
  const previousCurrent = versions.current && versions.current !== node.id
    ? findNode(doc, versions.current)
    : null;

  versions.current = node.id;
  versions.candidate = previousCurrent ? previousCurrent.id : null;

  node.metadata = {
    ...(node.metadata || {}),
    versionRole: 'current'
  };

  if (previousCurrent) {
    previousCurrent.metadata = {
      ...(previousCurrent.metadata || {}),
      versionRole: 'candidate'
    };
  }

  const nextStatus = QC_STATUSES.has(node.status) ? node.status : 'reviewing';
  node.status = nextStatus;
  shot.status = nextStatus;
  updateVideoTaskForShot(doc, shot, { status: nextStatus, outputNodeId: node.id });
  return { shot, node, videoVersions: { ...versions } };
}

export function synchronizeQcStatus(doc) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc?.edges) ? doc.edges : [];
  for (const edge of edges) {
    if (edge.type !== 'qc_for') continue;
    const qc = findNode(doc, edge.from);
    const target = findNode(doc, edge.to);
    if (!qc || !target || target.type !== 'video_output' || !QC_STATUSES.has(qc.status)) continue;
    target.status = qc.status;

    const shot = (doc.shots || []).find((item) => item.id === target.shotId);
    if (!shot) continue;
    const versions = ensureShotVideoVersions(shot);
    const isCurrent = versions.current === target.id || target.metadata?.versionRole === 'current';
    if (!isCurrent) continue;
    shot.status = qc.status;
    updateVideoTaskForShot(doc, shot, { status: qc.status, outputNodeId: target.id });
  }
  return doc;
}

export function normalizeVideoVersionState(doc) {
  for (const shot of doc?.shots || []) {
    const versions = shot.videoVersions;
    if (!versions || typeof versions !== 'object') continue;
    const current = versions.current ? findNode(doc, versions.current) : null;
    const candidate = versions.candidate ? findNode(doc, versions.candidate) : null;
    if (current?.type === 'video_output') {
      current.metadata = { ...(current.metadata || {}), versionRole: 'current' };
      shot.status = QC_STATUSES.has(current.status) ? current.status : 'reviewing';
      updateVideoTaskForShot(doc, shot, { status: shot.status, outputNodeId: current.id });
    }
    if (candidate?.type === 'video_output') {
      candidate.metadata = { ...(candidate.metadata || {}), versionRole: 'candidate' };
    }
  }
  synchronizeQcStatus(doc);
  return doc;
}

export function selectExportVideoNode(doc, shot) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  if (shot.videoVersions && Object.prototype.hasOwnProperty.call(shot.videoVersions, 'current')) {
    const current = shot.videoVersions.current
      ? nodes.find((item) => item.id === shot.videoVersions.current && item.type === 'video_output' && item.path)
      : null;
    if (current) return current;
    if (shot.videoVersions.candidate) return null;
    // Legacy imported projects may have an empty videoVersions.current field even though the old video_output is the confirmed cut.
    return selectLegacyExportVideoNode(nodes, shot);
  }
  return selectLegacyExportVideoNode(nodes, shot);
}

export function selectPreviewVideoNode(doc, shot) {
  const exportNode = selectExportVideoNode(doc, shot);
  if (exportNode) return exportNode;
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const outputs = nodes.filter((item) => item.type === 'video_output' && item.shotId === shot.id && item.path);
  if (!outputs.length) return null;

  const candidate = shot.videoVersions?.candidate
    ? outputs.find((item) => item.id === shot.videoVersions.candidate)
    : null;
  if (candidate) return candidate;

  // 成片页的“已有片段预览”是目检辅助；已拒绝或过期的旧片段不能被重新捞回。
  return outputs.find((item) => item.metadata?.versionRole === 'candidate')
    || outputs.find((item) => isSelectablePreviewVideo(item))
    || null;
}

function selectLegacyExportVideoNode(nodes, shot) {
  const outputs = nodes.filter((item) => item.type === 'video_output' && item.shotId === shot.id && item.path);
  return outputs.find((item) => item.metadata?.versionRole === 'current')
    || outputs.find((item) => isSelectableLegacyExportVideo(item))
    || null;
}

function isSelectableLegacyExportVideo(node) {
  return !BLOCKED_EXPORT_VERSION_ROLES.has(node.metadata?.versionRole);
}

function isSelectablePreviewVideo(node) {
  return !BLOCKED_PREVIEW_VERSION_ROLES.has(node.metadata?.versionRole);
}

function updateVideoTaskForShot(doc, shot, { status, outputNodeId }) {
  const task = (doc.tasks || []).find((item) => item.type === 'video' && item.shotId === shot.id);
  if (!task) return;
  if (outputNodeId && !task.outputNodeIds.includes(outputNodeId)) task.outputNodeIds.push(outputNodeId);
  if (QC_STATUSES.has(status)) task.status = status;
}

function findShot(doc, shotNo) {
  const normalized = String(shotNo || '').replace(/^shot:/, '');
  return (doc.shots || []).find((shot) => {
    const candidateShotNo = shot.shotNo || String(shot.id || '').replace(/^shot:/, '');
    return shot.id === shotNo || shot.id === `shot:${normalized}` || candidateShotNo === normalized;
  }) || null;
}

function findNode(doc, nodeId) {
  return (doc.nodes || []).find((node) => node.id === nodeId) || null;
}
