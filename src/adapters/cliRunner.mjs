import { spawn } from 'node:child_process';

// Default execution budget for a CLI adapter (seconds).
const DEFAULT_TIMEOUT_SEC = 300;
// Grace window between SIGTERM and SIGKILL during the two-stage timeout (P1Q2).
const SIGTERM_GRACE_MS = 3000;

// Signal an entire process group so an adapter's own child processes (e.g. a shell's
// `sleep`) are terminated too — otherwise orphaned children keep the inherited stdout
// pipe open and stall the platform until they exit on their own.
function killProcessTree(child, signal) {
  try {
    // Negative pid targets the whole group created via `detached: true`.
    process.kill(-child.pid, signal);
  } catch {
    // Group already gone, or pid invalid — fall back to a direct child kill.
    try {
      child.kill(signal);
    } catch {
      // Process already exited; nothing to terminate.
    }
  }
}

// Spawn a CLI adapter, feed input via stdin, parse stdout JSON, enforce two-stage timeout (P1Q2).
// Always resolves to a tri-state result; never rejects on adapter misbehavior.
export function runCliAdapter({ entryPath, input, timeoutSec = DEFAULT_TIMEOUT_SEC, cwd }) {
  return new Promise((resolve) => {
    // `detached: true` puts the adapter in its own process group so we can kill the
    // whole tree on timeout (P1Q2), not just the entry script.
    const child = spawn(entryPath, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;

    // Resolve exactly once and clear all pending timers to avoid leaks.
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(termTimer);
      resolve(result);
    };

    // Stage 1: SIGTERM the whole group with a grace window; Stage 2: SIGKILL if still alive.
    const termTimer = setTimeout(() => {
      killProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), SIGTERM_GRACE_MS);
      finish({ status: 'failed', outputs: [], error: { code: 'timeout', message: `adapter timed out after ${timeoutSec}s` } });
    }, timeoutSec * 1000);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', () => {
      finish({ status: 'failed', outputs: [], error: { code: 'unknown', message: 'failed to spawn adapter' } });
    });

    child.on('close', (code) => {
      if (settled) return; // already timed out
      // exit != 0 == adapter crash (contract §2.2)
      if (code !== 0) {
        finish({ status: 'failed', outputs: [], error: { code: 'unknown', message: stderr.slice(0, 500) || `adapter exited ${code}` } });
        return;
      }
      try {
        finish(JSON.parse(stdout));
      } catch {
        // exit 0 but stdout not valid JSON == execution exception, collapse to unknown.
        finish({ status: 'failed', outputs: [], error: { code: 'unknown', message: `invalid adapter output: ${stdout.slice(0, 200)}` } });
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
