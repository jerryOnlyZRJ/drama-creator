// Tauri desktop packaging preflight.
//
// This script intentionally performs read-only checks only: it never installs Rust,
// edits PATH, kills port owners, or starts a server. The goal is to fail fast with
// actionable diagnostics before `npm run build:tauri` reaches the less readable
// `cargo metadata` error.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const tauriBinName = process.platform === 'win32' ? 'tauri.cmd' : 'tauri';
const localTauriBin = join(projectRoot, 'node_modules', '.bin', tauriBinName);

const checks = [
  {
    label: 'Node.js',
    command: 'node',
    args: ['--version'],
    required: true,
    hint: 'Install Node.js or make sure `node` is available in PATH.'
  },
  {
    label: 'Tauri CLI',
    // 优先检查项目本地 CLI，避免要求非技术用户或 CI 额外安装全局 tauri 命令。
    command: existsSync(localTauriBin) ? localTauriBin : 'tauri',
    displayCommand: existsSync(localTauriBin) ? `node_modules/.bin/${tauriBinName}` : 'tauri',
    args: ['--version'],
    required: true,
    hint: 'Run `npm install` so node_modules/.bin/tauri is available through npm scripts.'
  },
  {
    label: 'Rust cargo',
    command: 'cargo',
    args: ['--version'],
    required: true,
    hint: 'Install Rust with rustup or Homebrew, then reopen the shell so `cargo` is in PATH.'
  },
  {
    label: 'Rust compiler',
    command: 'rustc',
    args: ['--version'],
    required: true,
    hint: 'Install Rust with rustup or Homebrew, then reopen the shell so `rustc` is in PATH.'
  }
];

function runCommandCheck({ label, command, displayCommand = command, args, required, hint }) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = (result.stdout || result.stderr || '').trim();
  const ok = result.status === 0;
  return {
    label,
    ok,
    required,
    detail: ok ? output : `${displayCommand} ${args.join(' ')} failed or was not found`,
    hint
  };
}

function probePort(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

function printCommandResult(result) {
  const mark = result.ok ? 'OK' : (result.required ? 'FAIL' : 'WARN');
  console.log(`[${mark}] ${result.label}: ${result.detail}`);
  if (!result.ok && result.hint) {
    console.log(`       ${result.hint}`);
  }
}

const results = checks.map(runCommandCheck);
for (const result of results) {
  printCommandResult(result);
}

// Port 5173 being occupied is not always fatal: during `tauri dev`, the frontend
// server may already be running. We still report it because the Rust shell also
// manages a Node server and duplicate listeners can hide lifecycle bugs.
const portBusy = await probePort('127.0.0.1', 5173);
if (portBusy) {
  console.log('[WARN] Port 5173: already has a listener on 127.0.0.1');
  console.log('       If you are validating Tauri child-process cleanup, stop the existing server first.');
} else {
  console.log('[OK] Port 5173: no existing listener on 127.0.0.1');
}

const failedRequired = results.filter((result) => result.required && !result.ok);
if (failedRequired.length > 0) {
  console.error(`\nTauri environment check failed: ${failedRequired.length} required check(s) failed.`);
  process.exit(1);
}

console.log('\nTauri environment check passed. You can run `npm run build:tauri` next.');
