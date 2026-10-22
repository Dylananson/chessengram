import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeHarness, request, syncRequest, AUTH_HEADER } from './harness.ts';

const APP_ORIGIN = 'https://app.example';

test('preflight is answered for an allow-listed origin', async () => {
  const { handler } = makeHarness();
  const response = await handler(
    request('OPTIONS', '/sync', {
      headers: { Origin: APP_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    }),
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), APP_ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, POST, DELETE, OPTIONS');
  assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /Authorization/);
  assert.equal(response.headers.get('Vary'), 'Origin');
});

test('preflight from a disallowed origin is refused without CORS headers', async () => {
  const { handler } = makeHarness();
  const response = await handler(
    request('OPTIONS', '/sync', { headers: { Origin: 'https://evil.example' } }),
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('allowed origin gets CORS headers on the actual response', async () => {
  const { handler, store } = makeHarness();
  await store.addDevice('dev-user', 'device-1');

  const response = await handler(
    syncRequest({ since: 0, push: [] }, { ...AUTH_HEADER, Origin: APP_ORIGIN }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), APP_ORIGIN);
  assert.equal(response.headers.get('Vary'), 'Origin');
});

test('actual request from a disallowed origin is refused', async () => {
  const { handler } = makeHarness();
  const response = await handler(
    syncRequest({ since: 0, push: [] }, { ...AUTH_HEADER, Origin: 'https://evil.example' }),
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('requests without an Origin are not treated as cross-origin', async () => {
  const { handler } = makeHarness();
  const response = await handler(syncRequest({ since: 0, push: [] }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('a wildcard allow-list accepts any origin', async () => {
  const { handler } = makeHarness({ allowedOrigins: ['*'] });
  const response = await handler(
    request('OPTIONS', '/health', { headers: { Origin: 'https://anything.example' } }),
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://anything.example');
});

test('an empty allow-list denies every explicit cross-origin request', async () => {
  const { handler } = makeHarness({ allowedOrigins: [] });
  const response = await handler(request('GET', '/health', { headers: { Origin: APP_ORIGIN } }));
  assert.equal(response.status, 403);
});
