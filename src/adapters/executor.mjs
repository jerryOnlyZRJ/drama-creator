import { createNode, createJob, normalizeIdPart } from '../schema/dramaCreatorSchema.mjs';
import { buildGenerateInput } from '../feed/generateInput.mjs';
import { ensureNode, linkOutputToTask } from '../import/outputBackfill.mjs';

// Standard error codes (contract §2.2). Unknown adapter codes collapse to 'unknown'.
const KNOWN_ERROR_CODES = new Set(['quota_exceeded', 'auth_failed', 'timeout', 'invalid_params', 'unknown']);

// Map adapter output kind -> doc node type. New kinds (e.g. text) extend §2.1 contract.
const KIND_TO_NODE_TYPE = { video: 'video_output', image: 'image_asset', audio: 'audio_asset', text: 'text_output' };

// Normalize any adapter outcome / crash into a tri-state result object (contract §2.2).
function normalizeResult(raw) {
  if (!raw || typeof raw !== 'object' || !raw.status) {
    return { status: 'failed', outputs: [], error: { code: 'unknown', message: 'adapter returned no valid status' } };
  }
  if (raw.status === 'failed') {
    const code = KNOWN_ERROR_CODES.has(raw.error?.code) ? raw.error.code : 'unknown';
    return { status: 'failed', outputs: [], error: { code, message: raw.error?.message || 'unknown error' } };
  }
  return raw;
}

// Backfill completed outputs into the graph and link them to the task (idempotent).
function backfillOutputs(doc, task, outputs) {
  const outputNodeIds = [];
  for (const out of outputs) {
    const outputNodeId = `node:output:${normalizeIdPart(task.shotId)}:${normalizeIdPart(out.path)}`;
    ensureNode(doc, createNode({
      id: outputNodeId,
      type: KIND_TO_NODE_TYPE[out.kind] || 'video_output',  // fallback keeps old video-only behavior intact
      title: out.path,
      shotId: task.shotId,
      path: out.path,
      status: 'reviewing',
      metadata: { kind: out.kind, role: out.role || 'primary' }
    }));
    linkOutputToTask(doc, task.shotId, outputNodeId, { taskType: task.type });
    outputNodeIds.push(outputNodeId);
  }
  return outputNodeIds;
}

// Run a generate call against a builtin adapter and reconcile the job + graph (contract §2, sync path).
export async function runGenerate({ doc, taskId, adapterRef, capability, model, outputDir, userParams = {}, credential = null }) {
  const task = doc.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  // CLI adapters expose manifest at the ref level; builtin adapters via the loaded module.
  const manifest = adapterRef.kind === 'cli' ? adapterRef.manifest : adapterRef.module.manifest;
  const input = buildGenerateInput(doc, taskId, { manifest }, {
    capability, model, outputDir, userParams, credential
  });

  let result;
  try {
    if (adapterRef.kind === 'cli') {
      // CLI adapter: spawn subprocess with two-stage timeout (P1Q2).
      const { runCliAdapter } = await import('./cliRunner.mjs');
      result = normalizeResult(await runCliAdapter({
        entryPath: adapterRef.entryPath,
        input,
        timeoutSec: adapterRef.manifest?.timeoutSec
      }));
    } else {
      // Builtin adapter: in-process call.
      result = normalizeResult(await adapterRef.module.generate(input));
    }
  } catch (error) {
    // Adapter crash == exit != 0 (contract §2.2): platform-level execution exception.
    result = { status: 'failed', outputs: [], error: { code: 'unknown', message: error.message } };
  }

  const job = createJob({
    id: `job:${normalizeIdPart(taskId)}:${Date.now()}`,
    taskId,
    adapterId: adapterRef.id,
    status: result.status,
    externalJobId: result.externalJobId || null
  });

  if (result.status === 'completed') {
    job.outputNodeIds = backfillOutputs(doc, task, result.outputs || []);
  } else if (result.status === 'failed') {
    job.error = result.error;
  }
  // generating: keep externalJobId for later poll (handled in a later task)

  doc.jobs = doc.jobs || [];
  doc.jobs.push(job);
  return { job, result };
}

// User-triggered rescan (P1Q3): poll every generating job, advance completed ones, backfill outputs.
// resolveAdapter(adapterId) -> { id, kind, module?, entryPath?, manifest? } | null
export async function refreshJobs({ doc, outputDir, resolveAdapter }) {
  let advanced = 0;
  for (const job of (doc.jobs || []).filter((j) => j.status === 'generating')) {
    const adapterRef = resolveAdapter(job.adapterId);
    if (!adapterRef) continue;

    const pollInput = { action: 'poll', externalJobId: job.externalJobId, outputDir };
    let result;
    try {
      if (adapterRef.kind === 'cli') {
        // CLI adapter: spawn subprocess to poll the external job.
        const { runCliAdapter } = await import('./cliRunner.mjs');
        result = normalizeResult(await runCliAdapter({
          entryPath: adapterRef.entryPath,
          input: pollInput,
          timeoutSec: adapterRef.manifest?.timeoutSec
        }));
      } else {
        // Builtin adapter: in-process poll call.
        result = normalizeResult(await adapterRef.module.poll(pollInput));
      }
    } catch (error) {
      // Adapter crash during poll == platform-level execution exception (contract §2.2).
      result = { status: 'failed', outputs: [], error: { code: 'unknown', message: error.message } };
    }

    if (result.status === 'completed') {
      // Reconcile completed outputs into the graph and link them to the task.
      const task = doc.tasks.find((t) => t.id === job.taskId);
      if (task) job.outputNodeIds = backfillOutputs(doc, task, result.outputs || []);
      job.status = 'completed';
      advanced += 1;
    } else if (result.status === 'failed') {
      job.status = 'failed';
      job.error = result.error;
      advanced += 1;
    }
    // still generating: leave untouched
  }
  return { advanced };
}
