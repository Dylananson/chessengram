import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { D1IdentityStore, resolveCanonicalUserId } from '../src/identity.ts';
import { D1SessionStore, createSession, hashSessionId } from '../src/session.ts';
import { FakeAuthD1 } from './d1-auth-fake.ts';

const ISSUER = 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_ABC123';

test('D1IdentityStore: stable identity mapping and device keys', async () => {
  const db = new FakeAuthD1();
  const store = new D1IdentityStore(db, { clock: () => 1_000 });

  const first = await resolveCanonicalUserId(store, { issuer: ISSUER, subject: 'sub-a' });
  const second = await resolveCanonicalUserId(store, { issuer: ISSUER, subject: 'sub-a' });
  const other = await resolveCanonicalUserId(store, { issuer: ISSUER, subject: 'sub-b' });
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^usr_[0-9a-f]{32}$/);

  const jwk = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };
  await store.setDevicePublicKey(first, 'device-1', jwk);
  assert.deepEqual(await store.getDevicePublicKey(first, 'device-1'), jwk);

  await store.deleteDevicePublicKey(first, 'device-1');
  assert.equal(await store.getDevicePublicKey(first, 'device-1'), undefined);

  await store.setDevicePublicKey(first, 'device-1', jwk);
  await store.deleteDevicePublicKeysForUser(first);
  assert.equal(await store.getDevicePublicKey(first, 'device-1'), undefined);
});

test('D1SessionStore: create/get/delete and per-user wipe', async () => {
  const db = new FakeAuthD1();
  const store = new D1SessionStore(db);

  const created = await createSession(store, { userId: 'user-a', ttlSeconds: 60, now: 1_000 });
  const hash = await hashSessionId(created.sessionId);
  assert.equal(created.expiresAt, 61_000);
  assert.deepEqual(await store.get(hash), {
    sessionHash: hash,
    userId: 'user-a',
    createdAt: 1_000,
    expiresAt: 61_000,
  });
  assert.equal(await store.get(created.sessionId), undefined);

  await store.delete(hash);
  assert.equal(await store.get(hash), undefined);

  const one = await createSession(store, { userId: 'user-a', ttlSeconds: 60, now: 2_000 });
  const two = await createSession(store, { userId: 'user-b', ttlSeconds: 60, now: 2_000 });
  await store.deleteUserSessions('user-a');
  assert.equal(await store.get(await hashSessionId(one.sessionId)), undefined);
  assert.ok(await store.get(await hashSessionId(two.sessionId)));
});
