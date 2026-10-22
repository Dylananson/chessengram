import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  applyCollectionPayload,
  collectionDedupeKey,
  collectionToPayload,
  type CollectionSyncState,
} from '../src/sync/collections.ts';
import type { SyncCollectionPayload } from '../src/sync/types.ts';

const COLLECTION_ID = 'col-1';
const SALT_A = 'aa'.repeat(32);
const SALT_B = 'bb'.repeat(32);

function payload(
  name: string,
  updatedAt: number,
  updatedBy: string,
  extra: {
    collectionId?: string;
    puzzleIds?: string[];
    removedPuzzleIds?: string[];
    deleted?: boolean;
  } = {},
): SyncCollectionPayload {
  return {
    collectionId: COLLECTION_ID,
    name,
    updatedAt,
    updatedBy,
    ...extra,
  };
}

/** Apply a list of payloads to a fresh state, in order. */
function mergeAll(payloads: SyncCollectionPayload[]): CollectionSyncState {
  let state: CollectionSyncState | undefined;
  for (const next of payloads) state = applyCollectionPayload(state, next);
  assert.ok(state);
  return state;
}

const liveIds = (state: CollectionSyncState): string[] => [...state.puzzleIds].sort();

test('collection name is last-writer-wins in both apply directions', () => {
  const older = payload('Older', 1_000, 'device-a');
  const newer = payload('Newer', 2_000, 'device-a');

  const olderThenNewer = mergeAll([older, newer]);
  const newerThenOlder = mergeAll([newer, older]);

  assert.equal(olderThenNewer.name, 'Newer');
  assert.equal(newerThenOlder.name, 'Newer');
  assert.equal(olderThenNewer.nameUpdatedAt, 2_000);
  assert.equal(newerThenOlder.nameUpdatedBy, 'device-a');
});

test('collection name breaks equal timestamps by larger updatedBy, independent of order', () => {
  const fromA = payload('From A', 3_000, 'dev-a');
  const fromB = payload('From B', 3_000, 'dev-b');

  const aThenB = mergeAll([fromA, fromB]);
  const bThenA = mergeAll([fromB, fromA]);

  assert.equal(aThenB.name, 'From B');
  assert.equal(bThenA.name, 'From B');
  assert.equal(aThenB.nameUpdatedAt, 3_000);
  assert.equal(aThenB.nameUpdatedBy, 'dev-b');
});

test('applying the same collection payload twice changes nothing', () => {
  const first = payload('Name', 1_000, 'device-a', {
    puzzleIds: ['b', 'a'],
    removedPuzzleIds: ['c'],
  });
  const once = mergeAll([first]);
  const twice = applyCollectionPayload(once, first);
  assert.deepEqual(twice, once);

  // Also idempotent when the state was created by an earlier, different write.
  const state = mergeAll([
    payload('Name', 1_000, 'device-a', { puzzleIds: ['a'] }),
    payload('Name', 2_000, 'device-b', { puzzleIds: ['b'], removedPuzzleIds: ['a'] }),
  ]);
  assert.deepEqual(applyCollectionPayload(state, payload('Name', 2_000, 'device-b', { puzzleIds: ['b'], removedPuzzleIds: ['a'] })), state);
});

test('collection membership is a union, not a replacement', () => {
  const state = mergeAll([
    payload('Set', 1_000, 'device-a', { puzzleIds: ['a', 'b'] }),
    payload('Set', 2_000, 'device-a', { puzzleIds: ['b', 'c'] }),
    payload('Set', 3_000, 'device-a', { puzzleIds: [] }),
  ]);
  assert.deepEqual(liveIds(state), ['a', 'b', 'c']);
});

test('a tombstone removes a member and is remembered with its removal time', () => {
  const state = mergeAll([
    payload('Set', 1_000, 'device-a', { puzzleIds: ['a', 'b'] }),
    payload('Set', 2_000, 'device-b', { removedPuzzleIds: ['a'] }),
  ]);
  assert.deepEqual(liveIds(state), ['b']);
  assert.equal(state.tombstones.get('a'), 2_000);
  assert.equal(state.addedAt.has('a'), false);
});

test('a re-add newer than the tombstone resurrects the puzzle and drops the tombstone', () => {
  const removed = mergeAll([
    payload('Set', 1_000, 'device-a', { puzzleIds: ['a', 'b'] }),
    payload('Set', 2_000, 'device-b', { removedPuzzleIds: ['a'] }),
  ]);
  const readded = applyCollectionPayload(removed, payload('Set', 3_000, 'device-a', { puzzleIds: ['a'] }));

  assert.deepEqual(liveIds(readded), ['a', 'b']);
  assert.equal(readded.tombstones.has('a'), false);
  assert.equal(readded.addedAt.get('a'), 3_000);

  // A stale removal that arrives afterwards cannot remove the newer add.
  const lateStaleRemoval = applyCollectionPayload(readded, payload('Set', 2_500, 'device-c', { removedPuzzleIds: ['a'] }));
  assert.deepEqual(liveIds(lateStaleRemoval), ['a', 'b']);
});

test('an add older than (or equal to) the tombstone does not resurrect the puzzle', () => {
  const removed = mergeAll([
    payload('Set', 1_000, 'device-a', { puzzleIds: ['a'] }),
    payload('Set', 2_000, 'device-b', { removedPuzzleIds: ['a'] }),
  ]);

  const staleAdd = applyCollectionPayload(removed, payload('Set', 1_500, 'device-a', { puzzleIds: ['a'] }));
  assert.deepEqual(liveIds(staleAdd), []);
  assert.equal(staleAdd.tombstones.get('a'), 2_000);

  // Same timestamp: the tombstone wins the tie, in either order.
  const tiedTombstoneLast = mergeAll([
    payload('Set', 2_000, 'device-a', { puzzleIds: ['a'] }),
    payload('Set', 2_000, 'device-b', { removedPuzzleIds: ['a'] }),
  ]);
  const tiedTombstoneFirst = mergeAll([
    payload('Set', 2_000, 'device-b', { removedPuzzleIds: ['a'] }),
    payload('Set', 2_000, 'device-a', { puzzleIds: ['a'] }),
  ]);
  assert.deepEqual(liveIds(tiedTombstoneLast), []);
  assert.deepEqual(liveIds(tiedTombstoneFirst), []);
});

test('collection deletion is LWW and never destroys membership history', () => {
  const beforeDelete = mergeAll([
    payload('Set', 1_000, 'device-a', { puzzleIds: ['x', 'y'], removedPuzzleIds: ['z'] }),
  ]);
  const deleted = applyCollectionPayload(beforeDelete, payload('Set', 2_000, 'device-a', { deleted: true }));

  assert.equal(deleted.deletedAt, 2_000);
  assert.deepEqual(liveIds(deleted), ['x', 'y']);
  assert.equal(deleted.tombstones.get('z'), 1_000);

  // An older "not deleted" payload cannot resurrect the collection.
  const staleUndelete = applyCollectionPayload(deleted, payload('Set', 1_500, 'device-b'));
  assert.equal(staleUndelete.deletedAt, 2_000);

  // A newer one can, from either apply order.
  const undeleted = applyCollectionPayload(staleUndelete, payload('Set', 3_000, 'device-b'));
  assert.equal(undeleted.deletedAt, undefined);
  const reverseOrder = mergeAll([
    payload('Set', 3_000, 'device-b'),
    payload('Set', 2_000, 'device-a', { deleted: true }),
  ]);
  assert.equal(reverseOrder.deletedAt, undefined);
});

test('equal-timestamp delete vs active is tie-broken by updatedBy', () => {
  const deleteByA = payload('Set', 2_000, 'dev-a', { deleted: true });
  const activeByB = payload('Set', 2_000, 'dev-b');

  const deleteThenActive = mergeAll([deleteByA, activeByB]);
  const activeThenDelete = mergeAll([activeByB, deleteByA]);

  assert.equal(deleteThenActive.deletedAt, undefined);
  assert.equal(activeThenDelete.deletedAt, undefined);
  assert.equal(deleteThenActive.deletedUpdatedBy, 'dev-b');
});

test('collectionToPayload carries live membership, tombstones and deletion', () => {
  const state = mergeAll([
    payload('Name', 1_000, 'device-a', { puzzleIds: ['b', 'a'], removedPuzzleIds: ['c'] }),
  ]);
  const out = collectionToPayload(state, { updatedAt: 4_000, updatedBy: 'device-z' });

  assert.equal(out.collectionId, COLLECTION_ID);
  assert.equal(out.name, 'Name');
  assert.deepEqual(out.puzzleIds, ['a', 'b']);
  assert.deepEqual(out.removedPuzzleIds, ['c']);
  assert.equal(out.deleted, undefined);
  assert.equal(out.updatedAt, 4_000);
  assert.equal(out.updatedBy, 'device-z');

  const deletedState = applyCollectionPayload(state, payload('Name', 5_000, 'device-a', { deleted: true }));
  const deletedPayload = collectionToPayload(deletedState, { updatedAt: 5_000, updatedBy: 'device-a' });
  assert.equal(deletedPayload.deleted, true);
  // Deletion is a tombstone for the collection, not for its members.
  assert.deepEqual(deletedPayload.puzzleIds, ['a', 'b']);

  const clean = mergeAll([payload('Clean', 1_000, 'device-a')]);
  assert.equal('removedPuzzleIds' in collectionToPayload(clean, { updatedAt: 1_000, updatedBy: 'device-a' }), false);
});

test('collection dedupe key is deterministic and id-dependent', async () => {
  const first = await collectionDedupeKey(COLLECTION_ID);
  const again = await collectionDedupeKey(COLLECTION_ID);
  const otherId = await collectionDedupeKey('col-2');

  assert.equal(first, again, 'the same collection always hashes the same key');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, otherId);
});
