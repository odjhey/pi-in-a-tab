import { FileError, ok, err } from '@earendil-works/pi-durable/env';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Each operation resolves only after the IndexedDB transaction commits.
// JSONL's main marker provides the cross-file commit/recovery boundary.
export class IndexedDBFileSystem {
  constructor(db) {
    this.db = db;
    this.id = `indexeddb:${db.name}`;
    this.cwd = '/';
  }

  static async open(name = 'pi-in-a-tab') {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'path' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new IndexedDBFileSystem(db);
  }

  path(input) {
    const parts = (input.startsWith('/') ? input : `${this.cwd}/${input}`).split('/');
    const result = [];
    for (const part of parts) {
      if (part === '..') result.pop();
      else if (part && part !== '.') result.push(part);
    }
    return '/' + result.join('/');
  }

  async transaction(mode, operation) {
    try {
      const value = await new Promise((resolve, reject) => {
        const tx = this.db.transaction('files', mode, { durability: 'strict' });
        let result;
        let failure;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure || tx.error || new Error('Transaction aborted'));
        const set = value => { result = value; };
        const fail = error => { failure = error; tx.abort(); };
        try { operation(tx.objectStore('files'), set, fail); }
        catch (error) { fail(error); }
      });
      return ok(value);
    } catch (error) {
      return err(error instanceof FileError ? error : new FileError('unknown', error.message));
    }
  }

  async absolutePath(path) { return ok(this.path(path)); }
  async joinPath(parts) { return ok(this.path(parts.join('/'))); }
  async canonicalPath(path) { return this.absolutePath(path); }

  async readBinaryFile(path) {
    path = this.path(path);
    return this.transaction('readonly', (store, set, fail) => {
      const request = store.get(path);
      request.onsuccess = () => {
        const file = request.result;
        if (!file) return fail(new FileError('not_found', `Missing ${path}`, path));
        if (file.kind !== 'file') return fail(new FileError('is_directory', path, path));
        set(file.bytes);
      };
    });
  }

  async readTextFile(path) {
    const result = await this.readBinaryFile(path);
    return result.ok ? ok(decoder.decode(result.value)) : result;
  }

  async openTextLineReader(path) {
    const result = await this.readTextFile(path);
    if (!result.ok) return result;
    const lines = result.value.match(/[^\n]*\n|[^\n]+$/g) || [];
    let index = 0;
    return ok({
      readLine: async () => {
        const line = lines[index++];
        return ok(line === undefined ? undefined : {
          text: line.endsWith('\n') ? line.slice(0, -1) : line,
          terminated: line.endsWith('\n')
        });
      },
      close: async () => { index = lines.length; }
    });
  }

  async readTextLines(path, options) {
    const result = await this.readTextFile(path);
    if (!result.ok) return result;
    return ok(result.value.split('\n').slice(0, options?.maxLines));
  }

  async mutate(path, update) {
    path = this.path(path);
    return this.transaction('readwrite', (store, set, fail) => {
      const request = store.get(path);
      request.onsuccess = () => {
        try {
          const bytes = update(request.result?.bytes);
          store.put({ path, kind: 'file', bytes, mtimeMs: Date.now() });
          set(undefined);
        } catch (error) { fail(error); }
      };
    });
  }

  async writeFile(path, content) {
    const bytes = typeof content === 'string' ? encoder.encode(content) : content;
    return this.mutate(path, () => bytes);
  }

  async appendFile(path, content) {
    const incoming = typeof content === 'string' ? encoder.encode(content) : content;
    return this.mutate(path, previous => {
      const old = previous || new Uint8Array();
      const next = new Uint8Array(old.length + incoming.length);
      next.set(old);
      next.set(incoming, old.length);
      return next;
    });
  }

  async truncateFile(path, size) {
    return this.mutate(path, previous => {
      if (!previous) throw new FileError('not_found', path, path);
      const next = new Uint8Array(size);
      next.set(previous.subarray(0, size));
      return next;
    });
  }

  async flushFile() { return ok(undefined); } // Writes already use strict durability.

  async renameFile(source, destination) {
    source = this.path(source);
    destination = this.path(destination);
    return this.transaction('readwrite', (store, set, fail) => {
      const request = store.get(source);
      request.onsuccess = () => {
        if (!request.result) return fail(new FileError('not_found', source, source));
        store.put({ ...request.result, path: destination });
        store.delete(source);
        set(undefined);
      };
    });
  }

  info(record) {
    return { name: record.path.split('/').pop(), path: record.path, kind: record.kind,
      size: record.bytes?.length || 0, mtimeMs: record.mtimeMs };
  }

  async fileInfo(path) {
    path = this.path(path);
    return this.transaction('readonly', (store, set, fail) => {
      const request = store.get(path);
      request.onsuccess = () => request.result
        ? set(this.info(request.result)) : fail(new FileError('not_found', path, path));
    });
  }

  async listDir(path) {
    const prefix = this.path(path).replace(/\/$/, '') + '/';
    return this.transaction('readonly', (store, set) => {
      const request = store.getAll();
      request.onsuccess = () => set(request.result.filter(file =>
        file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes('/')).map(file => this.info(file)));
    });
  }

  async exists(path) {
    const result = await this.fileInfo(path);
    return result.ok ? ok(true) : result.error.code === 'not_found' ? ok(false) : result;
  }

  async createDir(path, options) {
    path = this.path(path);
    return this.transaction('readwrite', (store, set) => {
      const parts = path.split('/').filter(Boolean);
      const paths = options?.recursive ? parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/')) : [path];
      for (const directory of paths) store.put({ path: directory, kind: 'directory', mtimeMs: Date.now() });
      set(undefined);
    });
  }

  async remove(path, options) {
    path = this.path(path);
    return this.transaction('readwrite', (store, set, fail) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const rows = request.result;
        const found = rows.find(row => row.path === path);
        if (!found && !options?.force) return fail(new FileError('not_found', path, path));
        const children = rows.filter(row => row.path.startsWith(path + '/'));
        if (children.length && !options?.recursive) return fail(new FileError('invalid', 'Directory not empty', path));
        store.delete(path);
        for (const child of children) store.delete(child.path);
        set(undefined);
      };
    });
  }

  async createTempDir(prefix = 'tmp') {
    const path = '/' + prefix + crypto.randomUUID();
    const result = await this.createDir(path);
    return result.ok ? ok(path) : result;
  }
  async createTempFile(options) {
    const path = '/' + (options?.prefix || 'tmp') + crypto.randomUUID() + (options?.suffix || '');
    const result = await this.writeFile(path, '');
    return result.ok ? ok(path) : result;
  }
  async cleanup() { this.db.close(); }
}