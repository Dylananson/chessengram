/**
 * ONL-007 — pure merge rules for synced collections.
 *
 * The wire shape is the frozen `SyncCollectionPayload` (`types.ts`): one
 * snapshot per collection with a name, the sender's live membership, the ids it
 * has removed (tombstones), an optional deleted flag and a single
 * `updatedAt`/`updatedBy` pair. Local state is a superset because convergence
 * needs a little more history (see {@link CollectionSyncState}).
 *
 * Rules (design: `docs/research/online-sync-design.md`):
 * - **name**: last-writer-wins by `updatedAt`; equal timestamps are broken
 *   lexicographically by `updatedBy`, so every device picks the same winner.
 * - **membership**: a set union. A payload never removes an id merely because
 *   it is absent — removals are explicit (`removedPuzzleIds`) and become
 *   tombstones. A tombstone removes an id that was added at the same or an
 *   earlier time (ties go to the tombstone).
 * - **re-add**: a payload that carries an id *newer* than its tombstone
 *   resurrects it (the tombstone is dropped). A stale payload cannot, which is
 *   what makes offline edits safe and applying payloads in any order converge.
 * - **deleted**: LWW exactly like the name. Deletion is a tombstone for the
 *   collection; it never destroys membership history locally.
 *
 * Pure: no clock reads, no randomness, no I/O. Callers pass every timestamp.
 */

import type { SyncCollectionPayload } from './types.ts';
import { dedupeScope } from './types.ts';
import { dedupeKey } from './types.ts';

/**
 * Local merge state for one collection.
 *
 * `puzzleIds` holds the live membership (it never contains a tombstoned id).
 * `tombstones` remembers *when* each removed id disappeared so a later re-add
 * can win; `addedAt` remembers the latest time an id was known to be present,
 * which is the only extra history the tombstone/re-add comparison needs.
 */
export interface CollectionSyncState {
  readonly collectionId: string;
  readonly name: string;
  readonly nameUpdatedAt: number;
  readonly nameUpdatedBy: string;
  /** Live membership; disjoint from {@link tombstones}. */
  readonly puzzleIds: ReadonlySet<string>;
  /** puzzleId -> latest known removal time (epoch ms). */
  readonly tombstones: ReadonlyMap<string, number>;
  /**
   * puzzleId -> latest time the id was known to be present (epoch ms).
   * Internal companion to {@link puzzleIds}; needed for the re-add rule.
   */
  readonly addedAt: ReadonlyMap<string, number>;
  /** Set when the collection is deleted, to the deletion time. */
  readonly deletedAt: number | undefined;
  /**
   * Time of the last payload that declared a deletion state (deleted *or*
   * active), so an older delete cannot resurrect a newer undelete and vice
   * versa. Always defined, even for a never-deleted collection.
   */
  readonly deletedUpdatedAt: number;
  readonly deletedUpdatedBy: string;
}

/** What a local edit stamps onto the payload it produces. */
export interface CollectionPayloadMeta {
  /** Change time in epoch ms. */
  updatedAt: number;
  /** Device id; also the deterministic LWW tie-break. */
  updatedBy: string;
}

function assertTimestamp(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

/** Deterministic LWW comparison: newer timestamp wins, then larger device id. */
function isNewer(
  updatedAt: number,
  updatedBy: string,
  currentAt: number,
  currentBy: string,
): boolean {
  return updatedAt > currentAt || (updatedAt === currentAt && updatedBy > currentBy);
}

/** Unique, sorted ids: payloads stay byte-stable for encryption and tests. */
function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Create the local state for a collection the device has never seen, directly
 * from a payload. Removals at the same time as an add win (tombstone tie rule).
 */
function stateFromPayload(payload: SyncCollectionPayload): CollectionSyncState {
  const puzzleIds = new Set<string>();
  const addedAt = new Map<string, number>();
  for (const id of payload.puzzleIds ?? []) {
    puzzleIds.add(id);
    addedAt.set(id, payload.updatedAt);
  }

  const tombstones = new Map<string, number>();
  for (const id of payload.removedPuzzleIds ?? []) {
    tombstones.set(id, payload.updatedAt);
    puzzleIds.delete(id);
    addedAt.delete(id);
  }

  return {
    collectionId: payload.collectionId,
    name: payload.name,
    nameUpdatedAt: payload.updatedAt,
    nameUpdatedBy: payload.updatedBy,
    puzzleIds,
    tombstones,
    addedAt,
    deletedAt: payload.deleted === true ? payload.updatedAt : undefined,
    deletedUpdatedAt: payload.updatedAt,
    deletedUpdatedBy: payload.updatedBy,
  };
}

/**
 * Merge one payload into the local state (or create it when `local` is
 * undefined). Deterministic, order-insensitive across payloads and idempotent:
 * applying the same payload twice returns an equivalent state.
 */
export function applyCollectionPayload(
  local: CollectionSyncState | undefined,
  payload: SyncCollectionPayload,
): CollectionSyncState {
  assertNonEmptyString(payload.collectionId, 'payload.collectionId');
  assertTimestamp(payload.updatedAt, 'payload.updatedAt');
  assertNonEmptyString(payload.updatedBy, 'payload.updatedBy');
  if (local !== undefined && local.collectionId !== payload.collectionId) {
    throw new Error(
      `collection id mismatch: local ${local.collectionId} vs payload ${payload.collectionId}`,
    );
  }
  if (local === undefined) return stateFromPayload(payload);

  // --- name LWW (tie-break by larger device id) ---
  const nameWins = isNewer(
    payload.updatedAt,
    payload.updatedBy,
    local.nameUpdatedAt,
    local.nameUpdatedBy,
  );
  const name = nameWins ? payload.name : local.name;
  const nameUpdatedAt = nameWins ? payload.updatedAt : local.nameUpdatedAt;
  const nameUpdatedBy = nameWins ? payload.updatedBy : local.nameUpdatedBy;

  // --- deleted LWW; deletion keeps membership history ---
  const deletedWins = isNewer(
    payload.updatedAt,
    payload.updatedBy,
    local.deletedUpdatedAt,
    local.deletedUpdatedBy,
  );
  const deletedAt = deletedWins
    ? payload.deleted === true
      ? payload.updatedAt
      : undefined
    : local.deletedAt;
  const deletedUpdatedAt = deletedWins ? payload.updatedAt : local.deletedUpdatedAt;
  const deletedUpdatedBy = deletedWins ? payload.updatedBy : local.deletedUpdatedBy;

  // --- membership: union + tombstones ---
  const puzzleIds = new Set(local.puzzleIds);
  const tombstones = new Map(local.tombstones);
  const addedAt = new Map(local.addedAt);

  // Adds/resurrections: only an add newer than an existing tombstone wins.
  for (const id of payload.puzzleIds ?? []) {
    const tombstonedAt = tombstones.get(id);
    if (tombstonedAt !== undefined && payload.updatedAt <= tombstonedAt) continue;
    const knownAt = addedAt.get(id);
    puzzleIds.add(id);
    addedAt.set(id, knownAt === undefined ? payload.updatedAt : Math.max(knownAt, payload.updatedAt));
    tombstones.delete(id);
  }

  // Removals: keep the latest removal time; a strictly newer add survives.
  for (const id of payload.removedPuzzleIds ?? []) {
    const prior = tombstones.get(id);
    const removedAt = prior === undefined ? payload.updatedAt : Math.max(prior, payload.updatedAt);
    const addTime = addedAt.get(id);
    if (puzzleIds.has(id) && addTime !== undefined && addTime > removedAt) continue;
    puzzleIds.delete(id);
    addedAt.delete(id);
    tombstones.set(id, removedAt);
  }

  return {
    collectionId: payload.collectionId,
    name,
    nameUpdatedAt,
    nameUpdatedBy,
    puzzleIds,
    tombstones,
    addedAt,
    deletedAt,
    deletedUpdatedAt,
    deletedUpdatedBy,
  };
}

/**
 * Build the wire payload from local state. Live membership excludes anything
 * tombstoned; tombstones travel separately so the receiver can apply them
 * without guessing. Arrays are sorted so the payload (and therefore the signed
 * canonical bytes) is deterministic.
 */
export function collectionToPayload(
  state: CollectionSyncState,
  meta: CollectionPayloadMeta,
): SyncCollectionPayload {
  assertTimestamp(meta.updatedAt, 'meta.updatedAt');
  assertNonEmptyString(meta.updatedBy, 'meta.updatedBy');

  const puzzleIds = sortedUnique([...state.puzzleIds].filter((id) => !state.tombstones.has(id)));
  const removedPuzzleIds = sortedUnique(state.tombstones.keys());

  const payload: SyncCollectionPayload = {
    collectionId: state.collectionId,
    name: state.name,
    puzzleIds,
    updatedAt: meta.updatedAt,
    updatedBy: meta.updatedBy,
  };
  if (removedPuzzleIds.length > 0) payload.removedPuzzleIds = removedPuzzleIds;
  if (state.deletedAt !== undefined) payload.deleted = true;
  return payload;
}

/** `hex SHA-256('collection' ‖ collectionId)` — one row per collection. */
export function collectionDedupeKey(collectionId: string): Promise<string> {
  return dedupeKey(dedupeScope('collection', [collectionId]));
}
