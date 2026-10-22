/**
 * ONL-002 — local, cloud-free upload queue.
 *
 * The queue holds **pointers, not payloads**: `{type, recordId, changedAt}`.
 * The pusher reads the current local record at push time, encrypts it, sends
 * it, and drops the pointer on ack. This keeps local storage lean and lets a
 * later edit supersede an unsent change (see
 * `docs/research/online-sync-design.md`, "Local queue model").
 *
 * Persistence is the frozen `SyncQueueStorage` seam (`types.ts`); the real
 * IndexedDB adapter is supplied by ONL-001. This module never imports
 * `LocalStore` — `InMemorySyncQueueStorage` covers tests and local dev.
 */

import type { SyncEntityType, SyncQueueEntry, SyncQueueStorage } from './types.ts';

/** What the pusher hands back after a successful push of one pointer. */
export interface SyncQueueAck {
  type: SyncEntityType;
  recordId: string;
  /**
   * The `changedAt` that was actually pushed. When omitted the entry is
   * removed unconditionally. When the stored pointer is *newer*, the push is
   * stale: the entry survives (re-enqueued) so the newer change is not lost.
   */
  changedAt?: number;
}

/** Outcome of {@link SyncQueue.ack}. */
export type SyncQueueAckResult =
  /** Removed: the pushed pointer was still the latest one. */
  | 'acked'
  /** A newer change landed while the push was in flight; pointer kept. */
  | 'superseded'
  /** Nothing pending for this `(type, recordId)`. */
  | 'missing';

/** Identity of a queue pointer: `(type, recordId)` is unique. */
function queueKey(type: SyncEntityType, recordId: string): string {
  return `${type}\u0000${recordId}`;
}

/** Defensive copy: the queue never hands out or keeps caller-owned objects. */
function cloneEntry(entry: SyncQueueEntry): SyncQueueEntry {
  return { type: entry.type, recordId: entry.recordId, changedAt: entry.changedAt };
}

/** Deterministic oldest-first order (ties broken by type then recordId). */
function byChangedAtThenId(a: SyncQueueEntry, b: SyncQueueEntry): number {
  if (a.changedAt !== b.changedAt) return a.changedAt - b.changedAt;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.recordId !== b.recordId) return a.recordId < b.recordId ? -1 : 1;
  return 0;
}

/**
 * Pointer queue over a {@link SyncQueueStorage}.
 *
 * Coalescing: at most one pending pointer per `(type, recordId)`. A strictly
 * newer `changedAt` supersedes a pending one; an equal or older `changedAt` is
 * ignored (idempotent re-enqueue, out-of-order callbacks).
 *
 * In-flight safety: {@link take} never mutates, so a failed push (no ack)
 * leaves the queue fully intact. The pusher should pass the pushed
 * `changedAt` to {@link ack}; if the local record was edited meanwhile, the
 * newer pointer is kept for the next round.
 */
export class SyncQueue {
  private readonly storage: SyncQueueStorage;
  private readonly entries = new Map<string, SyncQueueEntry>();
  private loaded = false;

  constructor(storage: SyncQueueStorage) {
    this.storage = storage;
  }

  /** Lazily mirror persisted pointers; storage is the source of truth. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    for (const entry of await this.storage.list()) {
      this.entries.set(queueKey(entry.type, entry.recordId), cloneEntry(entry));
    }
    this.loaded = true;
  }

  /**
   * Record a change. Returns `true` when this call wrote a newer pointer,
   * `false` when an equal/older one is already pending (coalesced away).
   */
  async enqueue(entry: SyncQueueEntry): Promise<boolean> {
    await this.ensureLoaded();
    const key = queueKey(entry.type, entry.recordId);
    const existing = this.entries.get(key);
    if (existing && existing.changedAt >= entry.changedAt) return false;

    const next = cloneEntry(entry);
    this.entries.set(key, next);
    await this.storage.put(cloneEntry(next));
    return true;
  }

  /**
   * Re-enqueue a change observed while a push was in flight. Identical to
   * {@link enqueue}: only a strictly newer `changedAt` replaces the pointer.
   */
  async supersede(entry: SyncQueueEntry): Promise<boolean> {
    return this.enqueue(entry);
  }

  /** All pending pointers, oldest change first. */
  async pending(): Promise<SyncQueueEntry[]> {
    await this.ensureLoaded();
    return [...this.entries.values()].sort(byChangedAtThenId).map(cloneEntry);
  }

  /** Alias for {@link pending}. */
  async list(): Promise<SyncQueueEntry[]> {
    return this.pending();
  }

  /** Number of pending pointers. */
  async size(): Promise<number> {
    await this.ensureLoaded();
    return this.entries.size;
  }

  /**
   * Bounded snapshot for one push batch, oldest change first. Does **not**
   * mutate the queue: pointers stay pending until {@link ack}. A failed push
   * therefore loses nothing and retries unchanged next round.
   */
  async take(limit: number): Promise<SyncQueueEntry[]> {
    await this.ensureLoaded();
    if (!Number.isFinite(limit) || limit <= 0) return [];
    return [...this.entries.values()]
      .sort(byChangedAtThenId)
      .slice(0, Math.floor(limit))
      .map(cloneEntry);
  }

  /**
   * Drop the pointer for a successfully pushed `(type, recordId)`.
   *
   * When `ack.changedAt` is supplied and the pending pointer is newer, the
   * push was superseded mid-flight: the entry is kept (return `'superseded'`)
   * so the newer change is pushed next round.
   */
  async ack(ack: SyncQueueAck): Promise<SyncQueueAckResult> {
    await this.ensureLoaded();
    const key = queueKey(ack.type, ack.recordId);
    const existing = this.entries.get(key);
    if (!existing) return 'missing';
    if (ack.changedAt !== undefined && existing.changedAt > ack.changedAt) {
      return 'superseded';
    }
    this.entries.delete(key);
    await this.storage.delete(ack.type, ack.recordId);
    return 'acked';
  }
}

/**
 * Tiny in-memory `SyncQueueStorage` for tests and local dev, so queue logic
 * needs no IndexedDB. Persists only for the lifetime of the instance — the
 * real adapter (ONL-001) owns durability.
 */
export class InMemorySyncQueueStorage implements SyncQueueStorage {
  private readonly entries = new Map<string, SyncQueueEntry>();

  constructor(initial?: Iterable<SyncQueueEntry>) {
    if (initial) {
      for (const entry of initial) {
        this.entries.set(queueKey(entry.type, entry.recordId), cloneEntry(entry));
      }
    }
  }

  async list(): Promise<SyncQueueEntry[]> {
    return [...this.entries.values()].map(cloneEntry);
  }

  async put(entry: SyncQueueEntry): Promise<void> {
    this.entries.set(queueKey(entry.type, entry.recordId), cloneEntry(entry));
  }

  async delete(type: SyncEntityType, recordId: string): Promise<void> {
    this.entries.delete(queueKey(type, recordId));
  }

  /** Number of stored pointers (test/inspection convenience). */
  get size(): number {
    return this.entries.size;
  }
}
