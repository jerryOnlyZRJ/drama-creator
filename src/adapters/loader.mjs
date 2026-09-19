import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Platform implements contract v1.x; major-compatible (contract §6.6): load all 1.y, reject 2.x.
export const PLATFORM_CONTRACT_MAJOR = 1;

// A manifest is loadable iff its contractVersion shares the platform major version.
export function isContractCompatible(contractVersion) {
  if (typeof contractVersion !== 'string') return false;
  const major = Number(contractVersion.split('.')[0]);
  return Number.isInteger(major) && major === PLATFORM_CONTRACT_MAJOR;
}

// Minimal manifest shape validation — enough to safely list & render in settings UI.
function validateManifestShape(manifest) {
  const required = ['contractVersion', 'id', 'displayName', 'version', 'kind', 'entry'];
  for (const key of required) {
    if (!manifest[key]) return `missing field: ${key}`;
  }
  if (!Array.isArray(manifest.capabilities)) return 'capabilities must be an array';
  if (manifest.kind !== 'cli' && manifest.kind !== 'builtin') return `invalid kind: ${manifest.kind}`;
  return null;
}

// Parse + validate a single manifest object; returns { manifest } or { error }.
export function loadManifest(raw) {
  let manifest;
  try {
    manifest = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { error: 'invalid_manifest' };
  }
  const shapeError = validateManifestShape(manifest);
  if (shapeError) return { error: 'invalid_manifest', detail: shapeError };
  if (!isContractCompatible(manifest.contractVersion)) return { error: 'incompatible_contract' };
  return { manifest };
}

// Scan an external CLI adapters directory (~/.drama-creator/adapters/<id>/manifest.json).
// Returns { available: manifest[], skipped: [{ id, reason, detail? }] }.
// Missing directory is not an error — yields empty lists.
export async function discoverCliAdapters(adaptersDir) {
  let entries = [];
  try {
    entries = await readdir(adaptersDir, { withFileTypes: true });
  } catch {
    return { available: [], skipped: [] };
  }

  const available = [];
  const skipped = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(adaptersDir, entry.name, 'manifest.json');
    let raw;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch {
      skipped.push({ id: entry.name, reason: 'invalid_manifest', detail: 'manifest.json not readable' });
      continue;
    }
    const { manifest, error, detail } = loadManifest(raw);
    if (error) {
      skipped.push({ id: entry.name, reason: error, ...(detail ? { detail } : {}) });
      continue;
    }
    // Mark resolved load info so executor knows where the entry lives.
    available.push({ ...manifest, kind: 'cli', _dir: join(adaptersDir, entry.name) });
  }
  return { available, skipped };
}
