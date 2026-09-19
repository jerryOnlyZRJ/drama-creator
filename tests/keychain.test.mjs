import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeychain } from '../src/credentials/keychain.mjs';

// In-memory fake mirroring keytar's surface used by keychain.mjs.
function fakeKeytar() {
  const store = new Map();
  return {
    setPassword: async (service, account, password) => { store.set(`${service}\u0000${account}`, password); },
    getPassword: async (service, account) => store.get(`${service}\u0000${account}`) || null,
    deletePassword: async (service, account) => store.delete(`${service}\u0000${account}`),
    findCredentials: async (service) => [...store.entries()]
      .filter(([k]) => k.startsWith(`${service}\u0000`))
      .map(([k, password]) => ({ account: k.split('\u0000')[1], password }))
  };
}

test('keychain reads/writes/deletes secrets under fixed service drama-creator', async () => {
  const keychain = createKeychain({ keytar: fakeKeytar() });
  await keychain.writeSecret('drama-creator:openai', JSON.stringify({ apiKey: 'sk-x' }));
  assert.equal(await keychain.readSecret('drama-creator:openai'), '{"apiKey":"sk-x"}');
  assert.deepEqual(await keychain.listAccounts(), ['drama-creator:openai']);
  await keychain.deleteSecret('drama-creator:openai');
  assert.equal(await keychain.readSecret('drama-creator:openai'), null);
});

test('keychain returns null for missing accounts', async () => {
  const keychain = createKeychain({ keytar: fakeKeytar() });
  assert.equal(await keychain.readSecret('drama-creator:nope'), null);
});
