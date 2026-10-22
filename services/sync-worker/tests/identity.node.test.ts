import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  InMemoryIdentityStore,
  resolveCanonicalUserId,
} from '../src/identity.ts';

const ISSUER = 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_ABC123';

test('same (issuer, subject) maps to the same canonical userId', async () => {
  const store = new InMemoryIdentityStore();
  const first = await resolveCanonicalUserId(store, { issuer: ISSUER, subject: 'sub-a' });
  const second = await resolveCanonicalUserId(store, { issuer: ISSUER, subject: 'sub-a' });
  assert.equal(first, second);
  assert.match(first, /^usr_[0-9a-f]{32}$/);
  assert.notEqual(first, 'sub-a');
  assert.equal(first.includes('sub-a'), false);

  const records = await store.getIdentity(ISSUER, 'sub-a');
  assert.equal(records?.userId, first);
  assert.equal(records?.subject, 'sub-a');
});

test('different subjects or issuers get different canonical userIds', async () => {
  const store = new InMemoryIdentityStore();
  const a = await resolveCanonicalUserId(store, { issuer: ISSUER, subject: 'sub-a' });
  const b = await resolveCanonicalUserId(store, { issuer: ISSUER, subject: 'sub-b' });
  const otherIssuer = await resolveCanonicalUserId(store, {
    issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OTHER',
    subject: 'sub-a',
  });

  assert.notEqual(a, b);
  assert.notEqual(a, otherIssuer);
  assert.equal(await store.getIdentity(ISSUER, 'sub-a').then((record) => record?.userId), a);
  assert.equal(
    await store
      .getIdentity('https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OTHER', 'sub-a')
      .then((record) => record?.userId),
    otherIssuer,
  );
});

test('concurrent first calls still produce one stable identity', async () => {
  const store = new InMemoryIdentityStore();
  const ids = await Promise.all(
    Array.from({ length: 8 }, () => resolveCanonicalUserId(store, { issuer: ISSUER, subject: 'sub-race' })),
  );
  assert.equal(new Set(ids).size, 1);
});

test('email is retained but never required', async () => {
  const store = new InMemoryIdentityStore();
  await resolveCanonicalUserId(store, { issuer: ISSUER, subject: 'with-email', email: 'a@example.com' });
  await resolveCanonicalUserId(store, { issuer: ISSUER, subject: 'without-email' });
  assert.equal((await store.getIdentity(ISSUER, 'with-email'))?.email, 'a@example.com');
  assert.equal((await store.getIdentity(ISSUER, 'without-email'))?.email, undefined);
});

test('device public keys round-trip and can be deleted per user', async () => {
  const store = new InMemoryIdentityStore();
  const jwk = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };
  await store.setDevicePublicKey('user-a', 'device-1', jwk);
  await store.setDevicePublicKey('user-b', 'device-1', jwk);
  assert.deepEqual(await store.getDevicePublicKey('user-a', 'device-1'), jwk);

  await store.deleteDevicePublicKey('user-a', 'device-1');
  assert.equal(await store.getDevicePublicKey('user-a', 'device-1'), undefined);
  assert.deepEqual(await store.getDevicePublicKey('user-b', 'device-1'), jwk);

  await store.deleteDevicePublicKeysForUser('user-b');
  assert.equal(await store.getDevicePublicKey('user-b', 'device-1'), undefined);
});
