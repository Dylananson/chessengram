/**
 * Low-level, namespaced, async key/value storage abstraction (T10).
 *
 * The training service is written against this interface only, so the same
 * logic runs in Node tests (in-memory backend) and in the browser (IndexedDB).
 * Values are structured-cloneable plain data; no functions or class instances.
 */

export interface StorageRecord {
  key: string;
  value: unknown;
}

export interface StorageBackend {
  /** Human-readable backend name, for diagnostics. */
  readonly kind: string;

  get(collection: string, key: string): Promise<unknown | undefined>;
  set(collection: string, key: string, value: unknown): Promise<void>;
  delete(collection: string, key: string): Promise<void>;
  getAll(collection: string): Promise<StorageRecord[]>;

  /** Clear one collection, or every collection when omitted. */
  clear(collection?: string): Promise<void>;
}
