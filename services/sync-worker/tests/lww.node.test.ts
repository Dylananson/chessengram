/**
 * ONL-015 — server-side conflict rules for `putEnvelope`.
 *
 * The same suite runs against both implementations so the D1 adapter's single
 * atomic upsert is exercised through `FakeD1` with no network or account:
 *
 *   - immutable types (`attempt`, `woodpecker`, `woodpeckerResult`) stay
 *     first-write-wins;
 *   - mutable types (`setting`, `collection`, `userPuzzle`) are last-write-wins
 *     by `(updatedAt, rev, deviceId)`, replacing the row with a **new `seq`**
 *     so older cursors observe the change: a newer `updatedAt` wins, then a
 *     higher per-device `rev` (ONL-016), then the lexicographically larger
 *     `deviceId`, so both arrival orders converge on the same stored row.
 *
 * The store never inspects `payload`, so the user-puzzle tombstone is
 * represented by a replacement envelope payload exactly as the wire carries it.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { D1SyncStore, InMemorySyncStore, type SyncStore } from '../src/store.ts';
import { FakeD1 } from './d1-fake.ts';
import { makeEnvelope } from './harness.ts';
import type { SyncEntityType, SyncRecordEnvelope } from '../src/protocol.ts';

interface StoreCase {
  name: string;
  make: () => SyncStore;
}

const STORES: readonly StoreCase[] = [
  { name: 'InMemorySyncStore', make: () => new InMemorySyncStore() },
  { name: 'D1SyncStore', make: () => new D1SyncStore(new FakeD1()) },
];

const LWW_TYPES: readonly SyncEntityType[] = ['setting', 'collection', 'userPuzzle'];
const FWW_TYPES: readonly SyncEntityType[] = ['attempt', 'woodpecker', 'woodpeckerResult'];
const ALL_TYPES: readonly SyncEntityType[] = [...LWW_TYPES, ...FWW_TYPES];

function envelope(type: SyncEntityType, overrides: Partial<SyncRecordEnvelope> = {}): SyncRecordEnvelope {
  return makeEnvelope({ type, ...overrides });
}

for (const { name, make } of STORES) {
  test(`${name}: a newer setting/collection/userPuzzle replaces the row with a new seq`, async () => {
    for (const type of LWW_TYPES) {
      const store = make();
      const key = `lww-${type}`;
      const first = await store.putEnvelope(
        'user-a',
        envelope(type, { dedupeKey: key, recordId: `${type}-1`, updatedAt: 1_000, deviceId: 'device-a' }),
      );
      assert.equal(first.status, 'accepted');
      const firstSeq = first.envelope.seq;
      assert.ok(typeof firstSeq === 'number');

      // A device that already saw the first write (cursor === firstSeq).
      const second = await store.putEnvelope(
        'user-a',
        envelope(type, { dedupeKey: key, recordId: `${type}-2`, updatedAt: 2_000, deviceId: 'device-a' }),
      );
      assert.equal(second.status, 'accepted', `${type}: replacement is accepted`);
      assert.ok(
        typeof second.envelope.seq === 'number' && second.envelope.seq > firstSeq,
        `${type}: replacement gets a new, larger seq`,
      );

      // The replacement is visible to a cursor older than it…
      const delta = await store.listChanges('user-a', firstSeq, 10);
      assert.equal(delta.length, 1, `${type}: replacement appears in changes`);
      assert.equal(delta[0]?.recordId, `${type}-2`);
      assert.equal(delta[0]?.seq, second.envelope.seq);

      // …and it replaced (not appended to) the stored row.
      const all = await store.listChanges('user-a', 0, 10);
      assert.equal(all.length, 1, `${type}: exactly one row is stored`);
      assert.equal(all[0]?.recordId, `${type}-2`);
    }
  });

  test(`${name}: an older LWW envelope is a duplicate and does not move seq`, async () => {
    for (const type of LWW_TYPES) {
      const store = make();
      const key = `older-${type}`;
      const first = await store.putEnvelope(
        'user-a',
        envelope(type, { dedupeKey: key, recordId: `${type}-new`, updatedAt: 5_000, deviceId: 'device-a' }),
      );
      assert.equal(first.status, 'accepted');

      const older = await store.putEnvelope(
        'user-a',
        envelope(type, { dedupeKey: key, recordId: `${type}-old`, updatedAt: 1_000, deviceId: 'device-b' }),
      );
      assert.equal(older.status, 'duplicate', `${type}: stale write is a duplicate`);
      assert.equal(older.envelope.recordId, `${type}-new`);
      assert.equal(older.envelope.seq, first.envelope.seq, `${type}: seq is untouched`);

      const changes = await store.listChanges('user-a', 0, 10);
      assert.equal(changes.length, 1);
      assert.equal(changes[0]?.recordId, `${type}-new`);
    }
  });

  test(`${name}: equal updatedAt converges on the same winner in both arrival orders`, async () => {
    const winnerId = 'device-b'; // lexicographically larger than device-a
    async function run(order: readonly [SyncRecordEnvelope, SyncRecordEnvelope]) {
      const store = make();
      const first = await store.putEnvelope('user-a', order[0]);
      const second = await store.putEnvelope('user-a', order[1]);
      const changes = await store.listChanges('user-a', 0, 10);
      return { first, second, changes };
    }
    const fromA = envelope('setting', {
      dedupeKey: 'tie',
      recordId: 'from-a',
      deviceId: 'device-a',
      updatedAt: 7_000,
      payload: { tag: 'a' },
    });
    const fromB = envelope('setting', {
      dedupeKey: 'tie',
      recordId: 'from-b',
      deviceId: 'device-b',
      updatedAt: 7_000,
      payload: { tag: 'b' },
    });

    const aFirst = await run([fromA, fromB]);
    const bFirst = await run([fromB, fromA]);

    // Both orders store exactly one row, and it is the same winner.
    assert.equal(aFirst.changes.length, 1);
    assert.equal(bFirst.changes.length, 1);
    for (const outcome of [aFirst, bFirst]) {
      assert.equal(outcome.changes[0]?.deviceId, winnerId);
      assert.equal(outcome.changes[0]?.recordId, 'from-b');
      assert.deepEqual(outcome.changes[0]?.payload, { tag: 'b' });
    }
    // The loser is a duplicate in whichever order it arrives.
    assert.equal(aFirst.first.status, 'accepted');
    assert.equal(aFirst.second.status, 'accepted'); // b replaces a
    assert.equal(bFirst.first.status, 'accepted');
    assert.equal(bFirst.second.status, 'duplicate'); // a loses to b
  });

  test(`${name}: a user-puzzle tombstone replaces an earlier create and is pullable`, async () => {
    const store = make();
    const create = await store.putEnvelope(
      'user-a',
      envelope('userPuzzle', {
        dedupeKey: 'puzzle-1',
        recordId: 'puzzle-1',
        updatedAt: 1_000,
        payload: { deleted: false },
      }),
    );
    assert.equal(create.status, 'accepted');

    // Tombstone: a replacement envelope carrying `{ deleted: true }`.
    const tombstone = await store.putEnvelope(
      'user-a',
      envelope('userPuzzle', {
        dedupeKey: 'puzzle-1',
        recordId: 'puzzle-1',
        updatedAt: 2_000,
        payload: { deleted: true },
      }),
    );
    assert.equal(tombstone.status, 'accepted');
    assert.ok(
      typeof tombstone.envelope.seq === 'number' &&
        typeof create.envelope.seq === 'number' &&
        tombstone.envelope.seq > create.envelope.seq,
    );

    // The other device pulls it from its pre-delete cursor.
    const otherDevice = await store.listChanges('user-a', create.envelope.seq as number, 10);
    assert.equal(otherDevice.length, 1);
    assert.deepEqual(otherDevice[0]?.payload, { deleted: true });
    assert.equal(otherDevice[0]?.seq, tombstone.envelope.seq);
  });

  test(`${name}: attempt/woodpecker/woodpeckerResult stay first-write-wins`, async () => {
    for (const type of FWW_TYPES) {
      const store = make();
      const key = `fww-${type}`;
      const first = await store.putEnvelope(
        'user-a',
        envelope(type, { dedupeKey: key, recordId: `${type}-first`, updatedAt: 1_000, deviceId: 'device-a' }),
      );
      assert.equal(first.status, 'accepted');

      // Even a much newer timestamp must not overwrite an immutable row.
      const second = await store.putEnvelope(
        'user-a',
        envelope(type, { dedupeKey: key, recordId: `${type}-second`, updatedAt: 9_000, deviceId: 'device-a' }),
      );
      assert.equal(second.status, 'duplicate', `${type}: still first-write-wins`);
      assert.equal(second.envelope.recordId, `${type}-first`);
      assert.equal(second.envelope.seq, first.envelope.seq);

      const changes = await store.listChanges('user-a', 0, 10);
      assert.equal(changes.length, 1);
      assert.equal(changes[0]?.recordId, `${type}-first`);
    }
  });

  test(`${name}: replaying the same batch is a no-op for every type`, async () => {
    const store = make();
    for (const type of ALL_TYPES) {
      const key = `replay-${type}`;
      const env = envelope(type, {
        dedupeKey: key,
        recordId: `r-${type}`,
        updatedAt: 1_000,
        deviceId: 'device-a',
      });
      const first = await store.putEnvelope('user-a', env);
      const replay = await store.putEnvelope('user-a', env);
      assert.equal(first.status, 'accepted', `${type}: first write accepted`);
      assert.equal(replay.status, 'duplicate', `${type}: replay is a duplicate`);
      assert.equal(replay.envelope.seq, first.envelope.seq, `${type}: seq is untouched`);
    }
    assert.equal((await store.listChanges('user-a', 0, 100)).length, ALL_TYPES.length);
  });

  test(`${name}: a same-millisecond same-device update with a higher rev replaces the row`, async () => {
    const store = make();
    const key = 'same-ms-rev';
    const first = await store.putEnvelope(
      'user-a',
      envelope('setting', {
        dedupeKey: key,
        recordId: 'edit-1',
        updatedAt: 7_000,
        deviceId: 'device-a',
        rev: 1,
        payload: { tag: 'a' },
      }),
    );
    assert.equal(first.status, 'accepted');
    const firstSeq = first.envelope.seq;
    assert.ok(typeof firstSeq === 'number');

    // Same device, same exact timestamp, higher rev: without `rev` this would
    // tie on `deviceId` and be dropped as a duplicate.
    const second = await store.putEnvelope(
      'user-a',
      envelope('setting', {
        dedupeKey: key,
        recordId: 'edit-2',
        updatedAt: 7_000,
        deviceId: 'device-a',
        rev: 2,
        payload: { tag: 'b' },
      }),
    );
    assert.equal(second.status, 'accepted', 'a higher rev wins in the same millisecond');
    assert.ok(
      typeof second.envelope.seq === 'number' && second.envelope.seq > firstSeq,
      'the replacement gets a new, larger seq',
    );

    // The replacement is pullable from a cursor older than it…
    const delta = await store.listChanges('user-a', firstSeq, 10);
    assert.equal(delta.length, 1);
    assert.equal(delta[0]?.recordId, 'edit-2');
    assert.equal(delta[0]?.rev, 2);
    assert.equal(delta[0]?.seq, second.envelope.seq);

    // …and it replaced (not appended to) the stored row.
    const all = await store.listChanges('user-a', 0, 10);
    assert.equal(all.length, 1);
    assert.equal(all[0]?.recordId, 'edit-2');
  });

  test(`${name}: a lower rev at the same updatedAt is a duplicate`, async () => {
    const store = make();
    const key = 'lower-rev';
    const first = await store.putEnvelope(
      'user-a',
      envelope('setting', {
        dedupeKey: key,
        recordId: 'newer',
        updatedAt: 7_000,
        deviceId: 'device-a',
        rev: 5,
      }),
    );
    assert.equal(first.status, 'accepted');

    const stale = await store.putEnvelope(
      'user-a',
      envelope('setting', {
        dedupeKey: key,
        recordId: 'older',
        updatedAt: 7_000,
        deviceId: 'device-a',
        rev: 4,
      }),
    );
    assert.equal(stale.status, 'duplicate', 'a lower rev loses at the same timestamp');
    assert.equal(stale.envelope.recordId, 'newer');
    assert.equal(stale.envelope.seq, first.envelope.seq, 'seq is untouched');
    assert.equal((await store.listChanges('user-a', 0, 10)).length, 1);
  });

  test(`${name}: rev then deviceId break ties and converge in both arrival orders`, async () => {
    async function run(order: readonly [SyncRecordEnvelope, SyncRecordEnvelope]) {
      const store = make();
      const first = await store.putEnvelope('user-a', order[0]);
      const second = await store.putEnvelope('user-a', order[1]);
      const changes = await store.listChanges('user-a', 0, 10);
      return { first, second, changes };
    }

    // Same device + same timestamp: the higher rev wins regardless of order.
    const lowRev = envelope('setting', {
      dedupeKey: 'tie-rev',
      recordId: 'rev-low',
      deviceId: 'device-a',
      updatedAt: 7_000,
      rev: 1,
    });
    const highRev = envelope('setting', {
      dedupeKey: 'tie-rev',
      recordId: 'rev-high',
      deviceId: 'device-a',
      updatedAt: 7_000,
      rev: 2,
    });
    const revLowFirst = await run([lowRev, highRev]);
    const revHighFirst = await run([highRev, lowRev]);
    for (const outcome of [revLowFirst, revHighFirst]) {
      assert.equal(outcome.changes.length, 1);
      assert.equal(outcome.changes[0]?.recordId, 'rev-high');
      assert.equal(outcome.changes[0]?.rev, 2);
    }

    // Same timestamp + same rev: the larger deviceId wins regardless of order.
    const fromA = envelope('setting', {
      dedupeKey: 'tie-device',
      recordId: 'from-a',
      deviceId: 'device-a',
      updatedAt: 7_000,
      rev: 1,
    });
    const fromB = envelope('setting', {
      dedupeKey: 'tie-device',
      recordId: 'from-b',
      deviceId: 'device-b',
      updatedAt: 7_000,
      rev: 1,
    });
    const aFirst = await run([fromA, fromB]);
    const bFirst = await run([fromB, fromA]);
    for (const outcome of [aFirst, bFirst]) {
      assert.equal(outcome.changes.length, 1);
      assert.equal(outcome.changes[0]?.deviceId, 'device-b');
      assert.equal(outcome.changes[0]?.recordId, 'from-b');
    }
  });

  test(`${name}: immutable types stay first-write-wins even with a higher rev`, async () => {
    for (const type of FWW_TYPES) {
      const store = make();
      const key = `fww-rev-${type}`;
      const first = await store.putEnvelope(
        'user-a',
        envelope(type, {
          dedupeKey: key,
          recordId: `${type}-first`,
          updatedAt: 1_000,
          deviceId: 'device-a',
          rev: 1,
        }),
      );
      assert.equal(first.status, 'accepted');

      const second = await store.putEnvelope(
        'user-a',
        envelope(type, {
          dedupeKey: key,
          recordId: `${type}-second`,
          updatedAt: 1_000,
          deviceId: 'device-a',
          rev: 9,
        }),
      );
      assert.equal(second.status, 'duplicate', `${type}: rev does not override first-write-wins`);
      assert.equal(second.envelope.recordId, `${type}-first`);
      assert.equal(second.envelope.seq, first.envelope.seq);
    }
  });
}
