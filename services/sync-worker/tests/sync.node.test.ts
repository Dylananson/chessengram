import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEV_USER_ID } from '../src/auth.ts';
import type { SyncPushResponse, SyncRecordEnvelope } from '../src/protocol.ts';
import {
  createDeviceFixture,
  makeEnvelope,
  makeHarness,
  registerDevice,
  request,
  signedEnvelope,
  syncRequest,
  AUTH_HEADER,
} from './harness.ts';

async function push(
  handler: (request: Request) => Promise<Response>,
  body: { since: number; push: SyncRecordEnvelope[] },
): Promise<SyncPushResponse> {
  const response = await handler(syncRequest(body));
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as SyncPushResponse;
}

test('push then pull with a cursor', async () => {
  const harness = makeHarness();
  const { handler } = harness;
  const device = await createDeviceFixture();
  await registerDevice(harness, DEV_USER_ID, device);

  const first = await signedEnvelope(device, { recordId: 'attempt-a', dedupeKey: 'key-a' });
  const one = await push(handler, { since: 0, push: [first] });
  assert.deepEqual(one.accepted, ['key-a']);
  assert.deepEqual(one.duplicates, []);
  assert.equal(one.cursor, 1);
  assert.equal(one.changes.length, 1);
  assert.equal(one.changes[0]?.seq, 1);
  assert.equal(one.changes[0]?.recordId, 'attempt-a');

  const second = await signedEnvelope(device, { recordId: 'attempt-b', dedupeKey: 'key-b' });
  const two = await push(handler, { since: one.cursor, push: [second] });
  assert.deepEqual(two.accepted, ['key-b']);
  assert.equal(two.cursor, 2);
  assert.equal(two.changes.length, 1);
  assert.equal(two.changes[0]?.recordId, 'attempt-b');

  // A pure pull from the start returns both, in seq order.
  const pull = await push(handler, { since: 0, push: [] });
  assert.deepEqual(pull.accepted, []);
  assert.deepEqual(pull.duplicates, []);
  assert.deepEqual(pull.changes.map((change) => change.recordId), ['attempt-a', 'attempt-b']);
  assert.equal(pull.cursor, 2);
});

test('idempotent replay: same batch twice is all duplicates and adds no seq', async () => {
  const harness = makeHarness();
  const { handler } = harness;
  const device = await createDeviceFixture();
  await registerDevice(harness, DEV_USER_ID, device);

  const envelope = await signedEnvelope(device, { dedupeKey: 'replay-key' });
  const first = await push(handler, { since: 0, push: [envelope] });
  assert.deepEqual(first.accepted, ['replay-key']);
  assert.equal(first.cursor, 1);

  const second = await push(handler, { since: first.cursor, push: [envelope] });
  assert.deepEqual(second.accepted, []);
  assert.deepEqual(second.duplicates, ['replay-key']);
  assert.equal(second.changes.length, 0);
  assert.equal(second.cursor, 1, 'cursor does not advance on a replay');

  // Replaying from scrollback still shows exactly one stored row.
  const third = await push(handler, { since: 0, push: [envelope] });
  assert.deepEqual(third.duplicates, ['replay-key']);
  assert.equal(third.changes.length, 1);
  assert.equal(third.changes[0]?.seq, 1);
});

test('first write wins for two envelopes sharing a dedupeKey', async () => {
  const harness = makeHarness();
  const { handler } = harness;
  const device = await createDeviceFixture();
  await registerDevice(harness, DEV_USER_ID, device);

  const first = await signedEnvelope(device, {
    recordId: 'first-record',
    dedupeKey: 'shared-key',
    payload: { id: 'first-record' },
    updatedAt: 1_700_000_000_000,
  });
  const second = await signedEnvelope(device, {
    recordId: 'second-record',
    dedupeKey: 'shared-key',
    payload: { id: 'second-record' },
    updatedAt: 1_800_000_000_000,
  });

  const response = await push(handler, { since: 0, push: [first, second] });
  assert.deepEqual(response.accepted, ['shared-key']);
  assert.deepEqual(response.duplicates, ['shared-key']);
  assert.equal(response.changes.length, 1);
  assert.equal(response.changes[0]?.recordId, 'first-record');
  assert.deepEqual(response.changes[0]?.payload, { id: 'first-record' });
  assert.equal(response.changes[0]?.updatedAt, 1_700_000_000_000);
});

test('mutable records are last-write-wins end to end', async () => {
  const harness = makeHarness();
  const { handler } = harness;
  const device = await createDeviceFixture();
  await registerDevice(harness, DEV_USER_ID, device);

  const key = 'setting-key';
  const first = await signedEnvelope(device, {
    type: 'setting',
    recordId: 'sync',
    dedupeKey: key,
    payload: { v: 'first' },
    updatedAt: 1_700_000_000_000,
  });
  const one = await push(handler, { since: 0, push: [first] });
  assert.deepEqual(one.accepted, [key]);
  assert.equal(one.cursor, 1);

  // A newer setting replaces the row, is accepted, and gets a new seq.
  const newer = await signedEnvelope(device, {
    type: 'setting',
    recordId: 'sync',
    dedupeKey: key,
    payload: { v: 'newer' },
    updatedAt: 1_700_003_600_000,
  });
  const two = await push(handler, { since: one.cursor, push: [newer] });
  assert.deepEqual(two.accepted, [key]);
  assert.deepEqual(two.duplicates, []);
  assert.equal(two.changes.length, 1);
  assert.deepEqual(two.changes[0]?.payload, { v: 'newer' });
  assert.ok((two.changes[0]?.seq ?? 0) > 1);
  assert.equal(two.cursor, two.changes[0]?.seq);

  // An older setting is a duplicate: the row and cursor are untouched.
  const older = await signedEnvelope(device, {
    type: 'setting',
    recordId: 'sync',
    dedupeKey: key,
    payload: { v: 'older' },
    updatedAt: 1_699_000_000_000,
  });
  const three = await push(handler, { since: two.cursor, push: [older] });
  assert.deepEqual(three.accepted, []);
  assert.deepEqual(three.duplicates, [key]);
  assert.equal(three.changes.length, 0);
  assert.equal(three.cursor, two.cursor);
});

test('pull is bounded by MAX_BATCH and the cursor continues from the bound', async () => {
  const harness = makeHarness({ maxBatch: 2 });
  const { handler } = harness;
  const device = await createDeviceFixture();
  await registerDevice(harness, DEV_USER_ID, device);

  await push(handler, {
    since: 0,
    push: [
      await signedEnvelope(device, { recordId: 'r1', dedupeKey: 'k1' }),
      await signedEnvelope(device, { recordId: 'r2', dedupeKey: 'k2' }),
    ],
  });
  await push(handler, { since: 2, push: [await signedEnvelope(device, { recordId: 'r3', dedupeKey: 'k3' })] });

  const bounded = await push(handler, { since: 0, push: [] });
  assert.deepEqual(bounded.changes.map((change) => change.recordId), ['r1', 'r2']);
  assert.equal(bounded.cursor, 2);

  const rest = await push(handler, { since: bounded.cursor, push: [] });
  assert.deepEqual(rest.changes.map((change) => change.recordId), ['r3']);
  assert.equal(rest.cursor, 3);
});

test('rejects a batch over MAX_BATCH without storing anything', async () => {
  const { handler, store } = makeHarness({ maxBatch: 1 });
  await store.addDevice(DEV_USER_ID, 'device-1');

  const response = await handler(
    syncRequest({
      since: 0,
      push: [makeEnvelope({ dedupeKey: 'k1' }), makeEnvelope({ dedupeKey: 'k2' })],
    }),
  );
  assert.equal(response.status, 413);
  assert.equal((await response.json() as { error: string }).error, 'batch_too_large');
  assert.deepEqual(await store.listChanges(DEV_USER_ID, 0, 10), []);
});

test('rejects a body over MAX_PUSH_BYTES without storing anything', async () => {
  const { handler, store } = makeHarness({ maxPushBytes: 16 });
  await store.addDevice(DEV_USER_ID, 'device-1');

  const response = await handler(syncRequest({ since: 0, push: [makeEnvelope()] }));
  assert.equal(response.status, 413);
  assert.equal((await response.json() as { error: string }).error, 'payload_too_large');
  assert.deepEqual(await store.listChanges(DEV_USER_ID, 0, 10), []);
});

test('rejects a push from an unregistered device', async () => {
  const { handler, store } = makeHarness();
  const response = await handler(syncRequest({ since: 0, push: [makeEnvelope({ deviceId: 'ghost' })] }));
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { error: string }).error, 'unregistered_device');
  assert.deepEqual(await store.listChanges(DEV_USER_ID, 0, 10), []);
});

test('rejects a push from a revoked device', async () => {
  const { handler, store } = makeHarness();
  await store.addDevice(DEV_USER_ID, 'device-1');
  await store.revokeDevice(DEV_USER_ID, 'device-1');

  const response = await handler(syncRequest({ since: 0, push: [makeEnvelope({ deviceId: 'device-1' })] }));
  assert.equal(response.status, 422);
});

test('rejects malformed envelopes', async () => {
  const { handler, store } = makeHarness();
  await store.addDevice(DEV_USER_ID, 'device-1');

  const response = await handler(
    syncRequest({ since: 0, push: [{ ...makeEnvelope(), payload: null }] }),
  );
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { error: string }).error, 'invalid_envelope');
});

test('rejects a v1 (pre-plaintext) envelope', async () => {
  const { handler, store } = makeHarness();
  await store.addDevice(DEV_USER_ID, 'device-1');

  const v1 = { ...makeEnvelope(), v: 1 };
  const response = await handler(syncRequest({ since: 0, push: [v1] }));
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { error: string }).error, 'invalid_envelope');
  assert.deepEqual(await store.listChanges(DEV_USER_ID, 0, 10), []);
});

test('rejects a payload that does not match the signature', async () => {
  const harness = makeHarness();
  const { handler } = harness;
  const device = await createDeviceFixture();
  await registerDevice(harness, DEV_USER_ID, device);

  const good = await signedEnvelope(device, { dedupeKey: 'payload-key', payload: { v: 'good' } });
  // Swap in a different payload without re-signing: the signed payload hash no
  // longer matches the payload actually present.
  const tampered = { ...good, payload: { v: 'tampered' } };

  const response = await handler(syncRequest({ since: 0, push: [tampered] }));
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { error: string }).error, 'invalid_signature');
  assert.deepEqual(await harness.store.listChanges(DEV_USER_ID, 0, 10), []);
});

test('rejects invalid bodies', async () => {
  const { handler } = makeHarness();
  const badSince = await handler(syncRequest({ since: -1, push: [] }));
  assert.equal(badSince.status, 400);
  const badPush = await handler(syncRequest({ since: 0, push: 'nope' }));
  assert.equal(badPush.status, 400);

  const notJson = await handler(
    new Request('https://sync.example/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: '{not json',
    }),
  );
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json() as { error: string }).error, 'invalid_json');
});

test('DELETE /sync/account wipes envelopes and devices for that user only', async () => {
  const harness = makeHarness();
  const { handler, store } = harness;
  const device = await createDeviceFixture();
  await registerDevice(harness, DEV_USER_ID, device);
  await store.addDevice('other-user', 'device-1');
  await push(handler, { since: 0, push: [await signedEnvelope(device, { dedupeKey: 'k1' })] });
  await store.putEnvelope('other-user', makeEnvelope({ dedupeKey: 'other-key' }));

  const response = await handler(request('DELETE', '/sync/account', { headers: AUTH_HEADER }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  assert.deepEqual(await store.listChanges(DEV_USER_ID, 0, 10), []);
  assert.deepEqual(await store.listDevices(DEV_USER_ID), []);
  assert.equal((await store.listChanges('other-user', 0, 10)).length, 1);
  assert.equal((await store.listDevices('other-user')).length, 1);
});

test('unknown routes and wrong methods are explicit', async () => {
  const { handler } = makeHarness();
  assert.equal((await handler(request('GET', '/nope'))).status, 404);

  const wrongMethod = await handler(request('GET', '/sync'));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('Allow'), 'POST');
});
