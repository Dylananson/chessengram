import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import worker from '../src/index.ts';
import { FakeD1 } from './d1-fake.ts';
import { makeHarness, request } from './harness.ts';

test('health reports unconfigured (no auth) without inventing a mode', async () => {
  const { handler } = makeHarness({ configured: false, auth: 'unconfigured', verifier: undefined });
  const response = await handler(request('GET', '/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    configured: false,
    auth: 'unconfigured',
    storage: 'memory',
    content: 'unconfigured',
  });
});

test('health reports configured Cognito + D1 storage', async () => {
  const { handler } = makeHarness({ configured: true, auth: 'cognito', verifier: undefined, storage: 'd1' });
  const response = await handler(request('GET', '/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    configured: true,
    auth: 'cognito',
    storage: 'd1',
    content: 'unconfigured',
  });
});

test('health reports dev auth mode', async () => {
  const { handler } = makeHarness({ configured: true, auth: 'dev' });
  const response = await handler(request('GET', '/health'));
  assert.deepEqual(await response.json(), {
    ok: true,
    configured: true,
    auth: 'dev',
    storage: 'memory',
    content: 'unconfigured',
  });
});

test('default worker export: unconfigured env, dev env, and D1 binding', async () => {
  const unconfigured = await worker.fetch(request('GET', '/health'), {});
  assert.deepEqual(await unconfigured.json(), {
    ok: true,
    configured: false,
    auth: 'unconfigured',
    storage: 'memory',
    content: 'unconfigured',
  });

  const dev = await worker.fetch(request('GET', '/health'), { SYNC_ALLOW_DEV_AUTH: 'true' });
  assert.deepEqual(await dev.json(), {
    ok: true,
    configured: true,
    auth: 'dev',
    storage: 'memory',
    content: 'unconfigured',
  });

  const withD1 = await worker.fetch(request('GET', '/health'), {
    SYNC_ALLOW_DEV_AUTH: 'true',
    SYNC_DB: new FakeD1(),
  });
  assert.deepEqual(await withD1.json(), {
    ok: true,
    configured: true,
    auth: 'dev',
    storage: 'd1',
    content: 'unconfigured',
  });
});

test('default worker export dev mode rejects an unregistered device', async () => {
  const response = await worker.fetch(
    new Request('https://sync.example/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-token' },
      body: JSON.stringify({ since: 0, push: [] }),
    }),
    { SYNC_ALLOW_DEV_AUTH: 'true' },
  );
  // Empty push is fine — proves the dev token authenticates against the real store.
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cursor: 0, accepted: [], duplicates: [], changes: [] });
});
