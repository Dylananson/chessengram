/**
 * IndexedDB storage backend for the browser.
 *
 * One object store ("kv") keyed by a composite string, with a secondary index
 * on the collection name so we can enumerate a collection efficiently. This
 * avoids schema churn when new collections are added: a collection is just a
 * logical namespace, not a table.
 */

import type { StorageBackend, StorageRecord } from './backend.ts';

interface KvRecord {
  composite: string;
  collection: string;
  key: string;
  value: unknown;
}

const SEP = '\u0000';
const RANGE_END = '\uffff';

/**
 * Legacy database name. Kept deliberately when the app was renamed from
 * "player-spike" to "web": changing it would orphan existing progress stored
 * under the old name. Renaming requires a migration that copies old -> new.
 */
export const INDEXEDDB_NAME = 'chessreps-player-spike';

export class IndexedDbStorageBackend implements StorageBackend {
  readonly kind = 'indexeddb';

  private readonly dbName: string;
  private readonly storeName: string;
  private readonly version: number;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName = INDEXEDDB_NAME, storeName = 'kv', version = 1) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.version = version;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.dbName, this.version);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            const store = db.createObjectStore(this.storeName, { keyPath: 'composite' });
            store.createIndex('by-collection', 'collection', { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
      });
    }
    return this.dbPromise;
  }

  private composite(collection: string, key: string): string {
    return `${collection}${SEP}${key}`;
  }

  private async read<T>(fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const request = fn(tx.objectStore(this.storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexedDB read failed'));
    });
  }

  private async write<T>(fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const request = fn(tx.objectStore(this.storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  }

  async get(collection: string, key: string): Promise<unknown | undefined> {
    const record = await this.read<KvRecord | undefined>((store) =>
      store.get(this.composite(collection, key)) as IDBRequest<KvRecord | undefined>,
    );
    return record?.value;
  }

  async set(collection: string, key: string, value: unknown): Promise<void> {
    await this.write<IDBValidKey>((store) =>
      store.put({
        composite: this.composite(collection, key),
        collection,
        key,
        value,
      }) as IDBRequest<IDBValidKey>,
    );
  }

  async delete(collection: string, key: string): Promise<void> {
    await this.write<undefined>((store) =>
      store.delete(this.composite(collection, key)) as IDBRequest<undefined>,
    );
  }

  async getAll(collection: string): Promise<StorageRecord[]> {
    const records = await this.read<KvRecord[]>((store) => {
      const index = store.index('by-collection');
      return index.getAll(collection) as IDBRequest<KvRecord[]>;
    });
    return records.map((record) => ({ key: record.key, value: record.value }));
  }

  async clear(collection?: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      if (collection) {
        const start = `${collection}${SEP}`;
        store.delete(IDBKeyRange.bound(start, `${start}${RANGE_END}`));
      } else {
        store.clear();
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB clear failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB clear aborted'));
    });
  }

  /** Close the underlying connection (tests / teardown). */
  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}
