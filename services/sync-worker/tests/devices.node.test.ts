import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEV_USER_ID } from '../src/auth.ts';
import type { SyncPushResponse } from '../src/protocol.ts';
import {
  AUTH_HEADER,
  createDeviceFixture,
  makeHarness,
  registerDevice,
  request,
  sessionHeaders,
  sessionIdFrom,
  signedEnvelope,
  syncRequest,
} from './harness.ts';

const JSON_HEADERS = { ...AUTH_HEADER, 'Content-Type': 'application/json' };

async function registerViaApi(
  handler: (request: Request) => Promise<Response>,
  device: Awaited<ReturnType<typeof createDeviceFixture>>,
): Promise<Response> {
  return handler(
    request('POST', '/devices', {
      headers: JSON_HEADERS,
      body: { deviceId: device.deviceId, publicKeyJwk: device.publicKeyJwk },
    }),
  );
}

test('register → list (no key material) → signed push accepted', async () => {
  const harness = makeHarness();
  const { handler } = harness;
  const device = await createDeviceFixture();

  const registered = await registerViaApi(handler, device);
  assert.equal(registered.status, 200, await registered.clone().text());
  const registration = (await registered.json()) as { ok: boolean; deviceId: string; thumbprint: string };
  assert.equal(registration.ok, true);
  assert.equal(registration.deviceId, 'device-1');
  assert.equal(typeof registration.thumbprint, 'string');
  assert.equal(registration.thumbprint.length > 0, true);

  const list = await handler(request('GET', '/devices', { headers: AUTH_HEADER }));
  assert.equal(list.status, 200);
  const body = (await list.json()) as { devices: Array<Record<string, unknown>> };
  assert.equal(body.devices.length, 1);
  const entry = body.devices[0] as Record<string, unknown>;
  assert.equal(entry.deviceId, 'device-1');
  assert.equal(entry.hasPublicKey, true);
  assert.equal(typeof entry.thumbprint, 'string');
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('"x"'), false);
  assert.equal(serialized.includes('"y"'), false);
  assert.equal(serialized.includes('"d"'), false);

  const envelope = await signedEnvelope(device, { recordId: 'attempt-1', dedupeKey: 'signed-key' });
  const push = await handler(syncRequest({ since: 0, push: [envelope] }));
  assert.equal(push.status, 200, await push.clone().text());
  const response = (await push.json()) as SyncPushResponse;
  assert.deepEqual(response.accepted, ['signed-key']);
  assert.equal((await harness.store.listChanges(DEV_USER_ID, 0, 10)).length, 1);
});

test('a tampered signature is 422 and stores nothing', async () => {
  const harness = makeHarness();
  const device = await createDeviceFixture();
  await registerDevice(harness, DEV_USER_ID, device);

  const good = await signedEnvelope(device, { dedupeKey: 'tamper-key', recordId: 'record-1' });
  const tampered = { ...good, payload: { note: 'tampered' } };

  const response = await harness.handler(syncRequest({ since: 0, push: [tampered] }));
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { error: string }).error, 'invalid_signature');
  assert.deepEqual(await harness.store.listChanges(DEV_USER_ID, 0, 10), []);
});

test('one bad signature rejects the whole batch (nothing stored)', async () => {
  const harness = makeHarness();
  const device = await createDeviceFixture();
  await registerDevice(harness, DEV_USER_ID, device);

  const good = await signedEnvelope(device, { dedupeKey: 'good-key' });
  const bad = { ...(await signedEnvelope(device, { dedupeKey: 'bad-key' })), sig: 'AAAA' };

  const response = await harness.handler(syncRequest({ since: 0, push: [good, bad] }));
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { error: string }).error, 'invalid_signature');
  assert.deepEqual(await harness.store.listChanges(DEV_USER_ID, 0, 10), []);
});

test('a signed push from an unregistered device is 422', async () => {
  const harness = makeHarness();
  const device = await createDeviceFixture('ghost-device');
  const envelope = await signedEnvelope(device, { dedupeKey: 'ghost-key' });

  const response = await harness.handler(syncRequest({ since: 0, push: [envelope] }));
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { error: string }).error, 'unregistered_device');
  assert.deepEqual(await harness.store.listChanges(DEV_USER_ID, 0, 10), []);
});

test('a registered device without a public key cannot push', async () => {
  const harness = makeHarness();
  await harness.store.addDevice(DEV_USER_ID, 'device-1');
  const device = await createDeviceFixture();
  const envelope = await signedEnvelope(device, { dedupeKey: 'no-key' });

  const response = await harness.handler(syncRequest({ since: 0, push: [envelope] }));
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { error: string }).error, 'unregistered_device');
  assert.deepEqual(await harness.store.listChanges(DEV_USER_ID, 0, 10), []);
});

test('a revoked device is 422 and its key is forgotten', async () => {
  const harness = makeHarness();
  const device = await createDeviceFixture();
  await registerDevice(harness, DEV_USER_ID, device);

  const revoked = await harness.handler(
    request('DELETE', `/devices/${device.deviceId}`, { headers: AUTH_HEADER }),
  );
  assert.equal(revoked.status, 200);
  assert.equal(await harness.identities.getDevicePublicKey(DEV_USER_ID, device.deviceId), undefined);

  const envelope = await signedEnvelope(device, { dedupeKey: 'revoked-key' });
  const response = await harness.handler(syncRequest({ since: 0, push: [envelope] }));
  assert.equal(response.status, 422);
});

test('device registration rejects private or non-P-256 JWKs', async () => {
  const { handler } = makeHarness();
  const device = await createDeviceFixture();

  const privateKey = await handler(
    request('POST', '/devices', {
      headers: JSON_HEADERS,
      body: {
        deviceId: 'device-2',
        publicKeyJwk: { ...device.publicKeyJwk, d: 'private-material' },
      },
    }),
  );
  assert.equal(privateKey.status, 422);
  assert.equal((await privateKey.json() as { error: string }).error, 'invalid_public_key');

  const rsa = await handler(
    request('POST', '/devices', {
      headers: JSON_HEADERS,
      body: { deviceId: 'device-2', publicKeyJwk: { kty: 'RSA', n: 'abc', e: 'AQAB' } },
    }),
  );
  assert.equal(rsa.status, 422);
});

test('cookie-authenticated device registration and revoke work with CSRF headers', async () => {
  const harness = makeHarness();
  const { handler } = harness;

  const exchanged = await handler(request('POST', '/auth/session', { headers: AUTH_HEADER }));
  assert.equal(exchanged.status, 200);
  const sessionId = sessionIdFrom(exchanged);
  assert.ok(sessionId);

  const device = await createDeviceFixture('cookie-device');
  const registered = await handler(
    request('POST', '/devices', {
      headers: sessionHeaders(sessionId),
      body: { deviceId: device.deviceId, publicKeyJwk: device.publicKeyJwk, name: 'Laptop' },
    }),
  );
  assert.equal(registered.status, 200, await registered.clone().text());

  const list = await handler(
    request('GET', '/devices', { headers: { Cookie: `chessengram_session=${sessionId}` } }),
  );
  assert.equal(list.status, 200);
  const body = (await list.json()) as { devices: Array<{ deviceId: string; name?: string }> };
  assert.equal(body.devices[0]?.deviceId, 'cookie-device');
  assert.equal(body.devices[0]?.name, 'Laptop');

  const revoked = await handler(
    request('DELETE', `/devices/${device.deviceId}`, { headers: sessionHeaders(sessionId) }),
  );
  assert.equal(revoked.status, 200);
});
