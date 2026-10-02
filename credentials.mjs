import { readFile, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { findEnvKeys } from '@earendil-works/pi-ai/compat';

// Pi-ai owns credential resolution and OAuth refresh. This adapter supplies
// persistence using Pi's auth.json format and compatible cross-process locks.
class FileCredentials extends InMemoryCredentialStore {
  constructor(path) {
    super();
    this.path = path;
  }

  async data() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error(`Cannot read credential store ${this.path}`, { cause: error });
    }
  }

  async read(providerId, options) {
    options?.signal?.throwIfAborted();
    return (await this.data())[providerId];
  }

  async list(options) {
    options?.signal?.throwIfAborted();
    return Object.entries(await this.data()).map(([providerId, value]) => ({ providerId, type: value.type }));
  }

  modify(providerId, fn, options) {
    // Pi-ai's store serializes in-process modifications; proper-lockfile also
    // protects rotating refresh tokens against a concurrently running Pi.
    return super.modify(providerId, async () => {
      const release = await lockfile.lock(this.path, {
        realpath: false, retries: { retries: 20, minTimeout: 50, maxTimeout: 500 }
      });
      try {
        const data = await this.data();
        const next = await fn(data[providerId]);
        options?.signal?.throwIfAborted();
        if (next !== undefined) {
          data[providerId] = next;
          await writeFile(this.path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
        }
        return next ?? data[providerId];
      } finally {
        await release();
      }
    }, options);
  }
}

const stores = [
  new FileCredentials(join(homedir(), '.pi', 'agent', 'auth.json')),
  new FileCredentials(join(process.cwd(), 'auth.json'))
];

async function source(providerId, options) {
  for (const store of stores) {
    if (await store.read(providerId, options)) return store;
  }
}

export const credentials = {
  async read(providerId, options) {
    // Returning no stored credential makes Pi-ai use its own env mapping and
    // provider auth handler, including providers with bearer/ambient auth.
    if (findEnvKeys(providerId)?.length) return undefined;
    return (await source(providerId, options))?.read(providerId, options);
  },
  async list(options) {
    const entries = await Promise.all(stores.map(store => store.list(options)));
    return [...new Map(entries.flat().map(entry => [entry.providerId, entry])).values()];
  },
  async modify(providerId, fn, options) {
    const store = await source(providerId, options);
    if (!store) throw new Error(`No stored credential for ${providerId}`);
    return store.modify(providerId, fn, options);
  },
  async delete() {
    throw new Error('Use Pi or remove the local auth.json to log out of a provider');
  }
};

export async function loadEnvironment() {
  try {
    await access('.env');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  process.loadEnvFile('.env');
}
