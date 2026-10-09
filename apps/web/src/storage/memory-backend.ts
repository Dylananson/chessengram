/**
 * In-memory storage backend for Node tests and as a graceful fallback when
 * IndexedDB is unavailable (private mode, unsupported browser).
 */

import type { StorageBackend, StorageRecord } from './backend.ts';

type Dump = Record<string, StorageRecord[]>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryStorageBackend implements StorageBackend {
  readonly kind = 'memory';

  private collections = new Map<string, Map<string, unknown>>();

  constructor(initial?: Dump) {
    if (initial) {
      for (const [collection, records] of Object.entries(initial)) {
        const map = new Map<string, unknown>();
        for (const record of records) {
          map.set(record.key, clone(record.value));
        }
        this.collections.set(collection, map);
      }
    }
  }

  private map(collection: string): Map<string, unknown> {
    let map = this.collections.get(collection);
    if (!map) {
      map = new Map<string, unknown>();
      this.collections.set(collection, map);
    }
    return map;
  }

  async get(collection: string, key: string): Promise<unknown | undefined> {
    const value = this.map(collection).get(key);
    return value === undefined ? undefined : clone(value);
  }

  async set(collection: string, key: string, value: unknown): Promise<void> {
    this.map(collection).set(key, clone(value));
  }

  async delete(collection: string, key: string): Promise<void> {
    this.map(collection).delete(key);
  }

  async getAll(collection: string): Promise<StorageRecord[]> {
    return [...this.map(collection).entries()].map(([key, value]) => ({
      key,
      value: clone(value),
    }));
  }

  async clear(collection?: string): Promise<void> {
    if (collection) {
      this.collections.delete(collection);
    } else {
      this.collections.clear();
    }
  }

  /** Deep, detached snapshot usable to simulate a reload or backup. */
  dump(): Dump {
    const out: Dump = {};
    for (const [collection, map] of this.collections) {
      out[collection] = [...map.entries()].map(([key, value]) => ({
        key,
        value: clone(value),
      }));
    }
    return out;
  }

  static fromDump(dump: Dump): InMemoryStorageBackend {
    return new InMemoryStorageBackend(dump);
  }
}
