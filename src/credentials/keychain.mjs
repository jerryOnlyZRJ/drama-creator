import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Service name fixed at platform level (P2Q1). All accounts under the same service let
// users see a single grouped block in their OS keychain UI.
export const KEYCHAIN_SERVICE = 'drama-creator';

// Factory pattern lets tests inject a fake keytar without monkey-patching ESM imports.
// Production callers omit `keytar` and we lazy-import the real package once.
export function createKeychain({ keytar } = {}) {
  let backend = keytar;
  async function ensureBackend() {
    if (backend) return backend;
    // Keep this as a static require string so pkg can discover keytar and its native addon
    // when building the Tauri sidecar. Unit tests still inject a fake backend and skip it.
    backend = require('keytar');
    return backend;
  }

  return {
    async readSecret(account) {
      const k = await ensureBackend();
      return k.getPassword(KEYCHAIN_SERVICE, account);
    },
    async writeSecret(account, password) {
      const k = await ensureBackend();
      await k.setPassword(KEYCHAIN_SERVICE, account, password);
    },
    async deleteSecret(account) {
      const k = await ensureBackend();
      await k.deletePassword(KEYCHAIN_SERVICE, account);
    },
    async listAccounts() {
      const k = await ensureBackend();
      const all = await k.findCredentials(KEYCHAIN_SERVICE);
      return all.map((entry) => entry.account);
    }
  };
}
