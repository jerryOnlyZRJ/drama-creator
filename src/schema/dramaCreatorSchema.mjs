export const SCHEMA_VERSION = '0.1.0';

// Externalized defaults — no ByteDance-specific hardcoding (open-source ready).
// Callers (importer / future native CRUD) may override via createEmptyDramaCreatorDocument({ config }).
export const DEFAULT_CONFIG = {
  defaultRatio: '9:16',
  defaultModel: null,
  locale: 'zh-CN'
};

// V1 创作流程是产品级导航状态：title 是用户看到的 step 短文案。
export const DEFAULT_WORKFLOW_STEPS = [
  { key: 'script_shots', title: '剧本与分镜', status: 'active' },
  { key: 'asset_library', title: '公共资产', status: 'locked' },
  { key: 'shot_videos', title: '分镜视频', status: 'locked' },
  { key: 'export', title: '成片导出', status: 'locked' }
];

// Centralized enum sets keep importers, APIs, and UI validation aligned.
export const SHOT_STATUSES = new Set([
  'draft',
  'prompting',
  'ready_to_feed',
  'generating',
  'reviewing',
  'approved',
  'rerun_needed'
]);

export const NODE_TYPES = new Set([
  'script_segment',
  'image_prompt',
  'video_prompt',
  'audio_prompt',
  'image_asset',
  'audio_asset',
  'video_output',
  'text_output',
  'post_task',
  'qc_record'
]);

export const EDGE_TYPES = new Set([
  'uses_reference',
  'script_uses_asset',
  'generates',
  'derived_from',
  'qc_for',
  'continues_to'
]);

export const TASK_TYPES = new Set(['image', 'video', 'audio', 'post']);

export const TASK_STATUSES = new Set([
  'draft',
  'prompting',
  'ready_to_feed',
  'generating',
  'reviewing',
  'approved',
  'rerun_needed',
  'blocked'
]);

export const CHECK_TYPES = new Set([
  'pre_feed',
  'asset_integrity',
  'prompt_safety',
  'task_completeness',
  'qc_result',
  'graph_integrity'
]);

// New episode imports start from the same stable top-level document shape.
export function createEmptyDramaCreatorDocument({ projectName, episodeId, episodePath, episodeTitle, config, storySources }) {
  // Merge caller overrides over externalized defaults so no model is hardcoded.
  const resolvedConfig = { ...DEFAULT_CONFIG, ...(config || {}) };
  return {
    schemaVersion: SCHEMA_VERSION,
    config: resolvedConfig,
    project: {
      name: projectName,
      // Mirror config so existing UI reading project.* keeps working (backward compat).
      defaultRatio: resolvedConfig.defaultRatio,
      defaultModel: resolvedConfig.defaultModel
    },
    episode: {
      id: episodeId,
      title: episodeTitle || episodeId,
      path: episodePath,
      importedAt: new Date().toISOString(),
      stateFile: 'drama-creator.json'
    },
    workflow: {
      currentStep: 'script_shots',
      steps: DEFAULT_WORKFLOW_STEPS.map((step) => ({ ...step }))
    },
    // storySources 保存用户最初输入的故事源或素材文本；它是剧本生成的源资产，不属于日志。
    storySources: Array.isArray(storySources) ? storySources : [],
    adapters: [],
    credentials: [],
    jobs: [],
    shots: [],
    nodes: [],
    edges: [],
    tasks: [],
    checks: [],
    activityLog: []
  };
}

// Node records represent user-facing resources such as prompts, assets, and QC notes.
export function createNode(input) {
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    shotId: input.shotId || null,
    path: input.path || null,
    status: input.status || 'active',
    metadata: input.metadata || {},
    ui: input.ui || {}
  };
}

// Edge records preserve why two resource nodes are connected in the canvas.
export function createEdge(input) {
  return {
    id: input.id,
    from: input.from,
    to: input.to,
    type: input.type,
    role: input.role || null,
    status: input.status || 'active',
    note: input.note || ''
  };
}

// Task records track feedable or post-production work against shots.
export function createTask(input) {
  return {
    id: input.id,
    shotId: input.shotId,
    type: input.type,
    title: input.title,
    status: input.status || 'draft',
    promptNodeId: input.promptNodeId || null,
    outputNodeIds: input.outputNodeIds || [],
    fields: input.fields || {}
  };
}

// Job tri-state (Q4 freeze): no 'submitted'/'pending' — generating covers both.
export const JOB_STATUSES = new Set(['generating', 'completed', 'failed']);

// Adapter ref: project-level enablement record, points to a manifest by bare id.
// Holds no implementation and no credential plaintext.
export function createAdapterRef(input) {
  return {
    id: input.id,                                  // internal ref, e.g. "adapter:openai-text"
    manifestId: input.manifestId,                  // bare manifest id (Q5), no "adapter:" prefix
    kind: input.kind,                              // "builtin" | "cli"
    enabledModels: input.enabledModels || [],      // models user enabled under this adapter
    credentialRef: input.credentialRef || null     // points to credentials[], no plaintext
  };
}

// Credential ref (Q6): records WHERE a secret lives (keychain), never the secret itself.
export function createCredentialRef(input) {
  return {
    ref: input.ref,                                // e.g. "credential:openai"
    adapterId: input.adapterId,                    // bare manifest id
    method: input.method,                          // "oauth" | "api_key" | "env"
    keychainAccount: input.keychainAccount,        // "drama-creator:<adapterId>" (shared globally)
    secretFieldKeys: input.secretFieldKeys || [],  // key NAMES only that went to keychain
    publicFields: input.publicFields || {},        // non-secret fields may live in plaintext here
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

// Async job record tracking an adapter generate/poll lifecycle against a task.
export function createJob(input) {
  return {
    id: input.id,
    taskId: input.taskId,
    adapterId: input.adapterId,
    status: input.status || 'generating',          // tri-state (Q4)
    externalJobId: input.externalJobId || null,    // returned by adapter when generating, for poll
    submittedAt: input.submittedAt || new Date().toISOString(),
    outputNodeIds: input.outputNodeIds || []
  };
}

// IDs are normalized for deterministic file-driven imports and graph references.
export function normalizeIdPart(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Validation reports schema issues without throwing so callers can show all fixes at once.
export function validateDramaCreatorDocument(doc) {
  const errors = [];
  const nodeIds = new Set((doc.nodes || []).map((node) => node.id));

  if (doc.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion: ${doc.schemaVersion}`);
  }

  for (const shot of doc.shots || []) {
    if (!SHOT_STATUSES.has(shot.status)) {
      errors.push(`Invalid shot status for ${shot.id}: ${shot.status}`);
    }
  }

  for (const node of doc.nodes || []) {
    if (!NODE_TYPES.has(node.type)) {
      errors.push(`Invalid node type for ${node.id}: ${node.type}`);
    }
  }

  for (const edge of doc.edges || []) {
    if (!EDGE_TYPES.has(edge.type)) {
      errors.push(`Invalid edge type for ${edge.id}: ${edge.type}`);
    }
    if (!nodeIds.has(edge.from)) {
      errors.push(`Edge ${edge.id} points from missing node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`Edge ${edge.id} points to missing node: ${edge.to}`);
    }
  }

  for (const task of doc.tasks || []) {
    if (!TASK_TYPES.has(task.type)) {
      errors.push(`Invalid task type for ${task.id}: ${task.type}`);
    }
    if (!TASK_STATUSES.has(task.status)) {
      errors.push(`Invalid task status for ${task.id}: ${task.status}`);
    }
  }

  for (const check of doc.checks || []) {
    if (!CHECK_TYPES.has(check.type)) {
      errors.push(`Invalid check type for ${check.id}: ${check.type}`);
    }
  }

  // Credentials must never leak secret plaintext into the document (security baseline §8).
  const credentialRefs = new Set((doc.credentials || []).map((cred) => cred.ref));
  for (const cred of doc.credentials || []) {
    for (const secretKey of cred.secretFieldKeys || []) {
      if (cred.publicFields && Object.prototype.hasOwnProperty.call(cred.publicFields, secretKey)) {
        errors.push(`Credential ${cred.ref}: secret field "${secretKey}" must not appear in publicFields`);
      }
    }
  }

  // Adapter credential references must resolve to an existing credential.
  for (const adapter of doc.adapters || []) {
    if (adapter.credentialRef && !credentialRefs.has(adapter.credentialRef)) {
      errors.push(`Adapter ${adapter.id} has dangling credentialRef: ${adapter.credentialRef}`);
    }
  }

  // Jobs must use the frozen tri-state (Q4).
  for (const job of doc.jobs || []) {
    if (!JOB_STATUSES.has(job.status)) {
      errors.push(`Invalid job status for ${job.id}: ${job.status}`);
    }
  }

  return errors;
}
