// Build the local HTTP server as a Tauri sidecar binary.
//
// Tauri expects every external binary to be named with the current Rust target
// triple suffix, for example `drama-creator-server-aarch64-apple-darwin`.
// Keeping that logic in one script prevents package scripts and CI from
// drifting across macOS / Windows hosts.

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binariesDir = join(root, 'src-tauri', 'binaries');
const inputFile = join(root, 'server.mjs');
const targetTriple = process.env.DRAMA_CREATOR_TARGET_TRIPLE || detectRustTargetTriple();
const pkgTarget = process.env.DRAMA_CREATOR_PKG_TARGET || mapPkgTarget(targetTriple);
const extension = targetTriple.includes('windows') ? '.exe' : '';
const outputFile = join(binariesDir, `drama-creator-server-${targetTriple}${extension}`);

await mkdir(binariesDir, { recursive: true });
await rm(outputFile, { force: true });

const pkgBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'pkg.cmd' : 'pkg');
const result = spawnSync(pkgBin, [
  inputFile,
  '--targets',
  pkgTarget,
  '--output',
  outputFile,
  '--no-bytecode',
  '--public',
  '--fallback-to-source'
], {
  cwd: root,
  stdio: 'inherit'
});

if (result.status !== 0) {
  throw new Error(`pkg failed for target ${pkgTarget}`);
}

if (!targetTriple.includes('windows')) {
  await chmod(outputFile, 0o755);
}

const info = await stat(outputFile);
console.log(`Built sidecar ${outputFile} (${Math.round(info.size / 1024 / 1024)} MB, ${pkgTarget})`);

function detectRustTargetTriple() {
  const direct = spawnSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' });
  if (direct.status === 0 && direct.stdout.trim()) {
    return direct.stdout.trim();
  }

  const verbose = spawnSync('rustc', ['-Vv'], { encoding: 'utf8' });
  if (verbose.status === 0) {
    const host = verbose.stdout.split('\n').find((line) => line.startsWith('host: '));
    if (host) return host.slice('host: '.length).trim();
  }

  throw new Error('Unable to determine Rust target triple. Install rustc or set DRAMA_CREATOR_TARGET_TRIPLE.');
}

function mapPkgTarget(triple) {
  const targets = new Map([
    ['aarch64-apple-darwin', 'node22-macos-arm64'],
    ['x86_64-apple-darwin', 'node22-macos-x64'],
    ['x86_64-pc-windows-msvc', 'node22-win-x64'],
    ['aarch64-pc-windows-msvc', 'node22-win-arm64'],
    ['x86_64-unknown-linux-gnu', 'node22-linux-x64'],
    ['aarch64-unknown-linux-gnu', 'node22-linux-arm64']
  ]);
  const target = targets.get(triple);
  if (!target) {
    throw new Error(`Unsupported sidecar target triple: ${triple}`);
  }
  return target;
}
