import { delimiter, dirname, resolve, sep } from 'node:path';

export function getDefaultEpisodeRoots({ cwd = process.cwd(), envValue = process.env.DRAMA_CREATOR_EPISODE_ROOTS } = {}) {
  if (envValue) {
    return envValue.split(delimiter).filter(Boolean);
  }

  const roots = [resolve(cwd)];
  const workspaceRoot = inferWorkspaceRoot(cwd);
  if (workspaceRoot && !roots.includes(workspaceRoot)) {
    roots.push(workspaceRoot);
  }
  return roots;
}

function inferWorkspaceRoot(cwd) {
  const normalized = resolve(cwd);
  const marker = `${sep}drama-creator${sep}`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    return normalized.slice(0, markerIndex);
  }

  // Running from the main repo root should still allow sibling episode data folders.
  if (normalized.endsWith(`${sep}drama-creator`)) {
    return dirname(normalized);
  }
  return null;
}
