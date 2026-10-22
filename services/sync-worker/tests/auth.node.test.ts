import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { bearerToken } from '../src/auth.ts';
import { makeHarness, request, syncRequest, AUTH_HEADER } from './harness.ts';

test('authenticated routes answer 401 with a clear message when no verifier exists', async () => {
  const { handler } = makeHarness({ configured: false, auth: 'unconfigured', verifier: undefined });

  const push = await handler(syncRequest({ since: 0, push: [] }));
  assert.equal(push.status, 401);
  assert.deepEqual(await push.json(), {
    error: 'unauthenticated',
    message: 'authentication is not configured on this server',
  });

  const wipe = await handler(request('DELETE', '/sync/account'));
  assert.equal(wipe.status, 401);
});

test('missing or invalid bearer token is rejected', async () => {
  const { handler } = makeHarness();

  const missing = await handler(syncRequest({ since: 0, push: [] }, {}));
  assert.equal(missing.status, 401);
  assert.equal((await missing.json() as { message: string }).message, 'missing or invalid bearer token');

  const wrong = await handler(
    syncRequest({ since: 0, push: [] }, { Authorization: 'Bearer not-the-token' }),
  );
  assert.equal(wrong.status, 401);
});

test('a valid dev token authenticates the request', async () => {
  const { handler } = makeHarness();
  const response = await handler(syncRequest({ since: 0, push: [] }, AUTH_HEADER));
  assert.equal(response.status, 200);
});

test('DevVerifier is inert unless explicitly allowed', async () => {
  const { DevVerifier } = await import('../src/auth.ts');
  const blocked = new DevVerifier({ allow: false });
  assert.equal(await blocked.verify('Bearer dev-token'), undefined);
  const allowed = new DevVerifier({ allow: true });
  assert.deepEqual(await allowed.verify('Bearer dev-token'), { userId: 'dev-user' });
  assert.equal(await allowed.verify('Bearer wrong'), undefined);
});

test('bearerToken parses only well-formed Bearer headers', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('bearer   abc '), 'abc');
  assert.equal(bearerToken('Basic abc'), undefined);
  assert.equal(bearerToken(null), undefined);
  assert.equal(bearerToken('Bearer '), undefined);
});
