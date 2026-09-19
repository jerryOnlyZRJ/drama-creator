// 公开测试使用虚构名称与对应资源标识，避免将创作项目的人物或作品名称带入源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyDramaCreatorDocument,
  createNode,
  createEdge,
  createTask,
  createAdapterRef,
  createCredentialRef,
  createJob,
  JOB_STATUSES,
  validateDramaCreatorDocument
} from '../src/schema/dramaCreatorSchema.mjs';

test('creates an empty document with stable top-level arrays', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: '机器人送信（公开测试样例）',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001'
  });

  assert.equal(doc.schemaVersion, '0.1.0');
  assert.equal(doc.project.name, '机器人送信（公开测试样例）');
  assert.equal(doc.episode.id, 'ep001');
  assert.deepEqual(doc.shots, []);
  assert.deepEqual(doc.nodes, []);
  assert.deepEqual(doc.edges, []);
  assert.deepEqual(doc.tasks, []);
  assert.deepEqual(doc.checks, []);
  assert.deepEqual(doc.activityLog, []);
});

test('validates node, edge, and task enum values', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001'
  });

  doc.nodes.push(createNode({
    id: 'node:prompt:video:s001b:v002',
    type: 'video_prompt',
    title: 's001b v002 视频提示词',
    shotId: 'shot:s001b',
    status: 'active'
  }));
  doc.nodes.push(createNode({
    id: 'node:image:kf-s001',
    type: 'image_asset',
    title: 'KF-s001',
    status: 'active'
  }));
  doc.edges.push(createEdge({
    id: 'edge:prompt-video-s001b-v002:uses:kf-s001',
    from: 'node:prompt:video:s001b:v002',
    to: 'node:image:kf-s001',
    type: 'uses_reference',
    role: 'first_last_frame_lock',
    status: 'active'
  }));
  doc.tasks.push(createTask({
    id: 'task:video:s001b:v002',
    shotId: 'shot:s001b',
    type: 'video',
    title: 's001b v002 视频生成',
    status: 'reviewing'
  }));

  assert.deepEqual(validateDramaCreatorDocument(doc), []);
});

test('reports broken edges and invalid enum values', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001'
  });

  doc.nodes.push({ id: 'node:bad', type: 'unknown_type', title: 'Bad node' });
  doc.edges.push({
    id: 'edge:bad',
    from: 'node:bad',
    to: 'node:missing',
    type: 'unknown_edge',
    status: 'active'
  });

  const errors = validateDramaCreatorDocument(doc);
  assert.match(errors.join('\n'), /Invalid node type/);
  assert.match(errors.join('\n'), /Invalid edge type/);
  assert.match(errors.join('\n'), /points to missing node/);
});

test('empty document carries externalized config defaults', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001'
  });

  assert.deepEqual(doc.config, {
    defaultRatio: '9:16',
    defaultModel: null,
    locale: 'zh-CN'
  });
  // 向后兼容：project 仍保留 ratio，但 model 不再硬编码字节
  assert.equal(doc.project.defaultRatio, '9:16');
  assert.equal(doc.project.defaultModel, null);
});

test('config defaults are overridable by caller', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001',
    config: { defaultRatio: '16:9', defaultModel: 'gpt-image-1', locale: 'en-US' }
  });

  assert.deepEqual(doc.config, {
    defaultRatio: '16:9',
    defaultModel: 'gpt-image-1',
    locale: 'en-US'
  });
  // project.* 镜像必须随 config 覆盖而同步，防止镜像源被误改回 DEFAULT_CONFIG 的回归
  assert.equal(doc.project.defaultRatio, '16:9');
  assert.equal(doc.project.defaultModel, 'gpt-image-1');
});

test('createAdapterRef builds a reference-only adapter record', () => {
  const adapter = createAdapterRef({
    id: 'adapter:openai-text',
    manifestId: 'openai-text',
    kind: 'builtin',
    enabledModels: ['dall-e-3'],
    credentialRef: 'credential:openai'
  });

  assert.deepEqual(adapter, {
    id: 'adapter:openai-text',
    manifestId: 'openai-text',
    kind: 'builtin',
    enabledModels: ['dall-e-3'],
    credentialRef: 'credential:openai'
  });
});

test('createCredentialRef never carries secret plaintext', () => {
  const cred = createCredentialRef({
    ref: 'credential:openai',
    adapterId: 'openai-text',
    method: 'api_key',
    keychainAccount: 'drama-creator:openai-text',
    secretFieldKeys: ['apiKey'],
    publicFields: { endpoint: 'https://api.openai.com' }
  });

  assert.equal(cred.ref, 'credential:openai');
  assert.equal(cred.method, 'api_key');
  assert.deepEqual(cred.secretFieldKeys, ['apiKey']);
  assert.deepEqual(cred.publicFields, { endpoint: 'https://api.openai.com' });
  assert.ok(typeof cred.updatedAt === 'string' && cred.updatedAt.length > 0);
  // Guard: no field literally holds an apiKey value.
  assert.equal('apiKey' in cred, false);
});

test('createJob defaults to generating tri-state and tracks externalJobId', () => {
  const job = createJob({
    id: 'job:abc',
    taskId: 'task:video:s001a:v001',
    adapterId: 'adapter:jimeng-video',
    externalJobId: 'jm-abc123'
  });

  assert.equal(job.status, 'generating');
  assert.equal(job.externalJobId, 'jm-abc123');
  assert.deepEqual(job.outputNodeIds, []);
  assert.ok(JOB_STATUSES.has('completed') && JOB_STATUSES.has('failed'));
  // Tri-state freeze (Q4): no legacy 'submitted'/'pending'.
  assert.equal(JOB_STATUSES.has('submitted'), false);
});

test('validator passes for a well-formed adapters/credentials/jobs set', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001'
  });

  doc.credentials.push(createCredentialRef({
    ref: 'credential:openai',
    adapterId: 'openai-text',
    method: 'api_key',
    keychainAccount: 'drama-creator:openai-text',
    secretFieldKeys: ['apiKey']
  }));
  doc.adapters.push(createAdapterRef({
    id: 'adapter:openai-text',
    manifestId: 'openai-text',
    kind: 'builtin',
    enabledModels: ['dall-e-3'],
    credentialRef: 'credential:openai'
  }));
  doc.jobs.push(createJob({
    id: 'job:abc',
    taskId: 'task:video:s001a:v001',
    adapterId: 'adapter:openai-text',
    status: 'completed'
  }));

  assert.deepEqual(validateDramaCreatorDocument(doc), []);
});

test('validator rejects invalid job status, dangling credentialRef, and secret plaintext', () => {
  const doc = createEmptyDramaCreatorDocument({
    projectName: 'demo',
    episodeId: 'ep001',
    episodePath: '/tmp/ep001'
  });

  // Invalid job status (not tri-state)
  doc.jobs.push({ id: 'job:bad', taskId: 't', adapterId: 'a', status: 'submitted' });
  // Adapter referencing a credential that does not exist
  doc.adapters.push(createAdapterRef({
    id: 'adapter:x', manifestId: 'x', kind: 'cli', credentialRef: 'credential:missing'
  }));
  // Credential leaking a secret field key into publicFields (security violation)
  doc.credentials.push(createCredentialRef({
    ref: 'credential:y', adapterId: 'y', method: 'api_key',
    keychainAccount: 'drama-creator:y',
    secretFieldKeys: ['apiKey'],
    publicFields: { apiKey: 'sk-leaked-123' }
  }));

  const errors = validateDramaCreatorDocument(doc).join('\n');
  assert.match(errors, /Invalid job status/);
  assert.match(errors, /credentialRef/);
  assert.match(errors, /secret field .* must not appear in publicFields/);
});
