import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { D1SyncStore } from '../src/store.ts';
import { FakeD1 } from './d1-fake.ts';
import { makeEnvelope } from './harness.ts';

test('D1SyncStore: push/pull, monotonic seq and first-write-wins', async () => {
  const store = new D1SyncStore(new FakeD1());

  const first = await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'k1', recordId: 'r1' }));
  assert.equal(first.status, 'accepted');
  assert.equal(first.envelope.seq, 1);

  const replay = await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'k1', recordId: 'overwrite' }));
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.envelope.recordId, 'r1');
  assert.equal(replay.envelope.seq, 1);

  const second = await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'k2', recordId: 'r2' }));
  assert.equal(second.envelope.seq, 2);

  assert.deepEqual((await store.listChanges('user-a', 0, 10)).map((e) => e.recordId), ['r1', 'r2']);
  assert.deepEqual((await store.listChanges('user-a', 1, 10)).map((e) => e.recordId), ['r2']);
  assert.deepEqual((await store.listChanges('user-a', 0, 1)).map((e) => e.recordId), ['r1']);
  assert.deepEqual(await store.listChanges('user-b', 0, 10), []);
});

test('D1SyncStore: the stored payload round-trips as stable JSON text', async () => {
  const db = new FakeD1();
  const store = new D1SyncStore(db);
  const payload = { b: [2, { d: 3, c: 4 }], a: 1, z: 'ü', n: null };
  const result = await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'k1', payload }));
  assert.equal(result.status, 'accepted');

  // The column holds the stable-normalized text (keys sorted, none padded).
  assert.equal(db.envelopes[0]?.payload, '{"a":1,"b":[2,{"c":4,"d":3}],"n":null,"z":"ü"}');

  const [change] = await store.listChanges('user-a', 0, 10);
  assert.deepEqual(change?.payload, payload);
  assert.equal(change?.sig, result.envelope.sig);
});

test('D1SyncStore: device add/list/revoke and re-add', async () => {
  let now = 1_000;
  const store = new D1SyncStore(new FakeD1(), { clock: () => now });

  await store.addDevice('user-a', 'laptop', 'Laptop');
  now = 2_000;
  await store.addDevice('user-a', 'phone');
  assert.deepEqual(await store.listDevices('user-a'), [
    { userId: 'user-a', deviceId: 'laptop', name: 'Laptop', addedAt: 1_000 },
    { userId: 'user-a', deviceId: 'phone', addedAt: 2_000 },
  ]);

  now = 3_000;
  await store.revokeDevice('user-a', 'laptop');
  const revoked = (await store.listDevices('user-a')).find((device) => device.deviceId === 'laptop');
  assert.equal(revoked?.revokedAt, 3_000);

  now = 4_000;
  await store.addDevice('user-a', 'laptop', 'New Laptop');
  const revived = (await store.listDevices('user-a')).find((device) => device.deviceId === 'laptop');
  assert.equal(revived?.revokedAt, undefined);
  assert.equal(revived?.name, 'New Laptop');
});

test('D1SyncStore: deleteUser wipes envelopes and devices for one user', async () => {
  const store = new D1SyncStore(new FakeD1());
  await store.addDevice('user-a', 'd1');
  await store.addDevice('user-b', 'd2');
  await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'a' }));
  await store.putEnvelope('user-b', makeEnvelope({ dedupeKey: 'b' }));

  await store.deleteUser('user-a');

  assert.deepEqual(await store.listChanges('user-a', 0, 10), []);
  assert.deepEqual(await store.listDevices('user-a'), []);
  assert.equal((await store.listChanges('user-b', 0, 10)).length, 1);
  assert.equal((await store.listDevices('user-b')).length, 1);
});

test('D1SyncStore: an empty legacy (encrypted) table is migrated to the v2 shape', async () => {
  const db = new FakeD1();
  db.seedLegacyEnvelopeTable(0);

  const store = new D1SyncStore(db);
  const result = await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'k1', recordId: 'r1' }));
  assert.equal(result.status, 'accepted');
  assert.equal(result.envelope.seq, 1);
  assert.deepEqual((await store.listChanges('user-a', 0, 10)).map((e) => e.recordId), ['r1']);

  // The table now has the v2 columns and no longer the legacy ones.
  const columns = db.envelopeColumns();
  assert.ok(columns.includes('payload'));
  assert.ok(columns.includes('sig'));
  assert.equal(columns.includes('ciphertext'), false);
  assert.equal(columns.includes('iv'), false);
  assert.equal(columns.includes('key_version'), false);
});

test('D1SyncStore: an intermediate v2 table (no type/record_id/sig) is healed when empty', async () => {
  // This is the shape a live deployment was found carrying: every push 500'd
  // with `no such column: type` until the shape check learned to look at the
  // whole column set rather than just the legacy `ciphertext` column.
  const db = new FakeD1();
  db.seedIntermediateEnvelopeTable(0);

  const store = new D1SyncStore(db);
  const result = await store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'k1', recordId: 'r1' }));
  assert.equal(result.status, 'accepted');

  const columns = db.envelopeColumns();
  for (const required of ['type', 'record_id', 'payload', 'sig']) {
    assert.ok(columns.includes(required), `${required} must exist after healing`);
  }
  assert.deepEqual((await store.listChanges('user-a', 0, 10)).map((e) => e.recordId), ['r1']);
});

test('D1SyncStore: an intermediate v2 table with rows fails closed', async () => {
  const db = new FakeD1();
  db.seedIntermediateEnvelopeTable(2);
  const store = new D1SyncStore(db);

  await assert.rejects(
    () => store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'k1' })),
    /has 2 row\(s\) but is missing type, record_id, sig; refusing to drop/,
  );
  assert.equal(db.envelopeRowCount(), 2, 'the rows are untouched');
});

test('D1SyncStore: a legacy table with rows fails closed instead of dropping data', async () => {
  const db = new FakeD1();
  db.seedLegacyEnvelopeTable(3);
  const store = new D1SyncStore(db);

  await assert.rejects(
    () => store.putEnvelope('user-a', makeEnvelope({ dedupeKey: 'k1' })),
    /has 3 row\(s\) but is missing .*ciphertext|has 3 row\(s\) but is missing/,
  );
  // The table (and its rows) is untouched.
  assert.ok(db.envelopeColumns().includes('ciphertext'));
  assert.equal(db.envelopeRowCount(), 3);
});
