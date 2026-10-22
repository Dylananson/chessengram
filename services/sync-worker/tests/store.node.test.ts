import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { InMemorySyncStore } from '../src/store.ts';
import { makeEnvelope } from './harness.ts';

test('assigns monotonic seq across users', async () => {
  const store = new InMemorySyncStore();
  const a = await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'a' }));
  const b = await store.putEnvelope('user-b', makeEnvelope({ dedupeKey: 'b' }));
  const c = await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'c' }));
  assert.equal(a.envelope.seq, 1);
  assert.equal(b.envelope.seq, 2);
  assert.equal(c.envelope.seq, 3);
});

test('dedupes by dedupeKey per user and never overwrites the first write', async () => {
  const store = new InMemorySyncStore();
  const first = await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'shared', recordId: 'first' }));
  const replay = await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'shared', recordId: 'second' }));
  const otherUser = await store.putEnvelope('user-b', makeEnvelope({ dedupeKey: 'shared', recordId: 'other' }));

  assert.equal(first.status, 'accepted');
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.envelope.recordId, 'first');
  assert.equal(replay.envelope.seq, first.envelope.seq);
  assert.equal(otherUser.status, 'accepted');

  const changes = await store.listChanges('user-a', 0, 10);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.recordId, 'first');
});

test('listChanges filters by seq, orders ascending and honours the limit', async () => {
  const store = new InMemorySyncStore();
  for (const key of ['k1', 'k2', 'k3']) {
    await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: key, recordId: key }));
  }
  assert.deepEqual((await store.listChanges('user-a', 0, 10)).map((e) => e.recordId), ['k1', 'k2', 'k3']);
  assert.deepEqual((await store.listChanges('user-a', 1, 10)).map((e) => e.recordId), ['k2', 'k3']);
  assert.deepEqual((await store.listChanges('user-a', 0, 2)).map((e) => e.recordId), ['k1', 'k2']);
  assert.deepEqual(await store.listChanges('user-a', 3, 10), []);
  assert.deepEqual(await store.listChanges('user-a', 0, 0), []);
});

test('deleteUser wipes only that user and their devices', async () => {
  const store = new InMemorySyncStore();
  await store.addDevice('user-a', 'd1', 'laptop');
  await store.addDevice('user-b', 'd2');
  await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'a' }));
  await store.putEnvelope('user-b', makeEnvelope({ dedupeKey: 'b' }));

  await store.deleteUser('user-a');

  assert.deepEqual(await store.listChanges('user-a', 0, 10), []);
  assert.deepEqual(await store.listDevices('user-a'), []);
  assert.equal((await store.listChanges('user-b', 0, 10)).length, 1);
  assert.equal((await store.listDevices('user-b')).length, 1);
});

test('device registry add/list/revoke', async () => {
  let now = 1_000;
  const store = new InMemorySyncStore({ clock: () => now });
  await store.addDevice('user-a', 'laptop', 'Laptop');
  now = 2_000;
  await store.addDevice('user-a', 'phone');

  const devices = await store.listDevices('user-a');
  assert.deepEqual(devices, [
    { userId: 'user-a', deviceId: 'laptop', name: 'Laptop', addedAt: 1_000 },
    { userId: 'user-a', deviceId: 'phone', addedAt: 2_000 },
  ]);

  now = 3_000;
  await store.revokeDevice('user-a', 'laptop');
  const revoked = (await store.listDevices('user-a')).find((device) => device.deviceId === 'laptop');
  assert.equal(revoked?.revokedAt, 3_000);

  await store.revokeDevice('user-a', 'unknown-device'); // no-op, never throws
});
