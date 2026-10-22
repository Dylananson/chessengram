/**
 * ONL-002 — local upload queue: enqueue/coalesce, supersede, ack, bounded take,
 * and persistence through the in-memory storage seam.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SyncQueue, InMemorySyncQueueStorage } from '../src/sync/queue.ts';

test('enqueue coalesces: only a strictly newer changedAt supersedes', async () => {
  const queue = new SyncQueue(new InMemorySyncQueueStorage());

  assert.equal(await queue.enqueue({ type: 'attempt', recordId: 'a1', changedAt: 100 }), true);
  assert.equal(
    await queue.enqueue({ type: 'attempt', recordId: 'a1', changedAt: 50 }),
    false,
    'older change is ignored',
  );
  assert.equal(
    await queue.enqueue({ type: 'attempt', recordId: 'a1', changedAt: 100 }),
    false,
    'equal change is ignored (idempotent)',
  );

  assert.deepEqual(await queue.pending(), [{ type: 'attempt', recordId: 'a1', changedAt: 100 }]);

  assert.equal(await queue.enqueue({ type: 'attempt', recordId: 'a1', changedAt: 150 }), true);
  assert.deepEqual(await queue.pending(), [{ type: 'attempt', recordId: 'a1', changedAt: 150 }]);
  assert.equal(await queue.size(), 1);
});

test('pending/list are ordered oldest-first and reference-stable', async () => {
  const queue = new SyncQueue(new InMemorySyncQueueStorage());
  await queue.enqueue({ type: 'collection', recordId: 'c1', changedAt: 300 });
  await queue.enqueue({ type: 'attempt', recordId: 'a1', changedAt: 100 });
  await queue.enqueue({ type: 'attempt', recordId: 'a2', changedAt: 200 });

  const ids = (await queue.pending()).map((e) => e.recordId);
  assert.deepEqual(ids, ['a1', 'a2', 'c1']);
  assert.deepEqual(await queue.list(), await queue.pending());

  // Mutating a returned entry must not corrupt the queue.
  const first = (await queue.pending())[0]!;
  first.changedAt = -1;
  assert.equal((await queue.pending())[0]!.changedAt, 100);
});

test('ack removes only the pointer that was pushed', async () => {
  const queue = new SyncQueue(new InMemorySyncQueueStorage());
  await queue.enqueue({ type: 'attempt', recordId: 'a1', changedAt: 1 });
  await queue.enqueue({ type: 'setting', recordId: 's1', changedAt: 2 });

  assert.equal(await queue.ack({ type: 'attempt', recordId: 'a1' }), 'acked');
  assert.deepEqual(await queue.pending(), [{ type: 'setting', recordId: 's1', changedAt: 2 }]);

  assert.equal(await queue.ack({ type: 'attempt', recordId: 'a1' }), 'missing');
  assert.equal(await queue.ack({ type: 'setting', recordId: 's1' }), 'acked');
  assert.equal(await queue.size(), 0);
});

test('bounded take does not mutate, so a failed push retries intact', async () => {
  const storage = new InMemorySyncQueueStorage();
  const queue = new SyncQueue(storage);
  await queue.enqueue({ type: 'attempt', recordId: 'a1', changedAt: 1 });
  await queue.enqueue({ type: 'attempt', recordId: 'a2', changedAt: 2 });
  await queue.enqueue({ type: 'attempt', recordId: 'a3', changedAt: 3 });

  const batch = await queue.take(2);
  assert.deepEqual(
    batch.map((e) => e.recordId),
    ['a1', 'a2'],
    'oldest first, capped at n',
  );
  assert.equal(batch.length, 2);

  // Simulate a failed push: nothing was acked, so nothing may be lost.
  assert.equal(await queue.size(), 3, 'queue intact on failure');
  assert.deepEqual(
    (await queue.pending()).map((e) => e.recordId),
    ['a1', 'a2', 'a3'],
  );
  assert.equal((await storage.list()).length, 3, 'storage untouched by take');

  // A full take and then ack drains the queue.
  for (const entry of await queue.take(5)) {
    assert.equal(await queue.ack({ type: entry.type, recordId: entry.recordId }), 'acked');
  }
  assert.equal(await queue.size(), 0);
  assert.equal((await storage.list()).length, 0);

  assert.deepEqual(await queue.take(0), [], 'non-positive limit is empty');
  assert.deepEqual(await queue.take(Number.NaN), []);
});

test('a change during an in-flight push supersedes the ack instead of being lost', async () => {
  const queue = new SyncQueue(new InMemorySyncQueueStorage());
  await queue.enqueue({ type: 'collection', recordId: 'c1', changedAt: 10 });

  const [inFlight] = await queue.take(1);
  assert.equal(inFlight!.changedAt, 10);

  // Local record edited while the push was in flight.
  assert.equal(
    await queue.supersede({ type: 'collection', recordId: 'c1', changedAt: 20 }),
    true,
  );

  // The old push ack must not delete the newer pointer.
  assert.equal(
    await queue.ack({ type: 'collection', recordId: 'c1', changedAt: 10 }),
    'superseded',
  );
  assert.deepEqual(await queue.pending(), [{ type: 'collection', recordId: 'c1', changedAt: 20 }]);

  // Acking the newer push finally clears it.
  assert.equal(
    await queue.ack({ type: 'collection', recordId: 'c1', changedAt: 20 }),
    'acked',
  );
  assert.equal(await queue.size(), 0);
});

test('InMemorySyncQueueStorage persists across queue instances', async () => {
  const storage = new InMemorySyncQueueStorage();

  const first = new SyncQueue(storage);
  await first.enqueue({ type: 'userPuzzle', recordId: 'p1', changedAt: 7 });
  await first.enqueue({ type: 'userPuzzle', recordId: 'p2', changedAt: 8 });

  // A fresh queue over the same storage sees the persisted pointers.
  const second = new SyncQueue(storage);
  assert.deepEqual(
    (await second.pending()).map((e) => e.recordId).sort(),
    ['p1', 'p2'],
  );

  await second.ack({ type: 'userPuzzle', recordId: 'p1' });
  assert.equal(storage.size, 1);

  const third = new SyncQueue(storage);
  assert.deepEqual(await third.pending(), [{ type: 'userPuzzle', recordId: 'p2', changedAt: 8 }]);

  // Seeded construction shares the same put/delete/de-list surface.
  const seeded = new InMemorySyncQueueStorage([
    { type: 'attempt', recordId: 'seeded', changedAt: 1 },
  ]);
  assert.deepEqual(await seeded.list(), [{ type: 'attempt', recordId: 'seeded', changedAt: 1 }]);
});
