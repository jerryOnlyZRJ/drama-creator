import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverCliAdapters } from './loader.mjs';
import { BUILTIN_ADAPTERS, findBuiltinAdapter } from './builtins.mjs';

// External CLI adapters live under the user data dir; tests inject a custom path.
function defaultCliAdaptersDir() {
  return join(homedir(), '.drama-creator', 'adapters');
}

// Produce the merged "available adapters" listing for the settings UI:
// [ { id, displayName, kind, version, capabilities, ... }, ... ].
// Source 1: builtins shipped with the repo. Source 2: external CLI dirs scanned by loader.
export async function listAvailableAdapters({ cliAdaptersDir = defaultCliAdaptersDir() } = {}) {
  const builtin = BUILTIN_ADAPTERS.map((entry) => ({ ...entry.module.manifest, kind: 'builtin' }));
  const cli = await discoverCliAdapters(cliAdaptersDir);
  return [...builtin, ...cli.available];
}

// Hand back an adapterRef shape that executor.runGenerate / refreshJobs accept directly.
// Returns null when id is not a known builtin and is not present in the CLI scan.
export async function resolveAdapter(manifestId, { cliAdaptersDir = defaultCliAdaptersDir() } = {}) {
  const builtin = findBuiltinAdapter(manifestId);
  if (builtin) {
    return {
      id: `adapter:${manifestId}`,
      manifestId,
      kind: 'builtin',
      module: builtin.module,
      manifest: builtin.module.manifest
    };
  }
  const cli = await discoverCliAdapters(cliAdaptersDir);
  const found = cli.available.find((m) => m.id === manifestId);
  if (!found) return null;
  return {
    id: `adapter:${manifestId}`,
    manifestId,
    kind: 'cli',
    entryPath: join(found._dir, found.entry),
    manifest: found
  };
}
