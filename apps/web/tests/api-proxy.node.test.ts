/**
 * ONL-021 — the deployed same-origin API proxy.
 *
 * The failure this fixes: the app on `*.pages.dev` calling the API on
 * `*.workers.dev` is a cross-site request, so the `SameSite=Lax` session cookie
 * is never sent and every session-authenticated call returns 401 (observed on
 * `POST /devices`). The proxy makes `/api/…` same-origin.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
// @ts-expect-error - a plain JS Pages Function, intentionally outside the TS build.
import { onRequest } from '../functions/api/[[path]].js';

interface Call {
  url: string;
  init: { method: string; headers: Headers; body?: unknown; redirect?: string };
}

function proxy(options: { origin?: string | undefined; response?: Response } = {}) {
  const calls: Call[] = [];
  const context = {
    request: undefined as unknown as Request,
    env: options.origin === undefined ? {} : { SYNC_API_ORIGIN: options.origin },
    fetch: async (url: string, init: Call['init']) => {
      calls.push({ url, init });
      return (
        options.response ??
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'session=abc; HttpOnly' },
        })
      );
    },
  };
  return { calls, context };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://chessreps-prod.pages.dev${path}`, init);
}

test('forwards an API call to the Worker origin, preserving method, path and query', async () => {
  const { calls, context } = proxy({ origin: 'https://sync.example.test' });
  context.request = request('/api/devices/device-1?x=1', { method: 'POST' });

  const response = await onRequest(context);

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://sync.example.test/devices/device-1?x=1');
  assert.equal(calls[0]!.init.method, 'POST');
});

test('keeps the origin and cookie headers (so the Worker authorizes the request)', async () => {
  const { calls, context } = proxy({ origin: 'https://sync.example.test' });
  context.request = request('/api/sync', {
    method: 'POST',
    headers: {
      origin: 'https://chessreps-prod.pages.dev',
      cookie: 'session=abc',
      'content-type': 'application/json',
      host: 'chessreps-prod.pages.dev',
    },
    body: '{"since":0,"push":[]}',
  });

  await onRequest(context);

  const headers = calls[0]!.init.headers;
  assert.equal(headers.get('origin'), 'https://chessreps-prod.pages.dev');
  assert.equal(headers.get('cookie'), 'session=abc');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('host'), null, 'the runtime owns Host');
});

test('passes Set-Cookie back so the session becomes first-party', async () => {
  const { context } = proxy({ origin: 'https://sync.example.test' });
  context.request = request('/api/auth/session', { method: 'POST' });

  const response = await onRequest(context);
  assert.match(response.headers.get('set-cookie') ?? '', /session=abc/);
  assert.deepEqual(await response.json(), { ok: true });
});

test('an unconfigured deployment fails closed instead of guessing an origin', async () => {
  const { calls, context } = proxy({});
  context.request = request('/api/health');
  const response = await onRequest(context);
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
  assert.match((await response.json()).error, /proxy_unconfigured/);
});

test('never forwards a body on GET/HEAD', async () => {
  const { calls, context } = proxy({ origin: 'https://sync.example.test' });
  context.request = request('/api/health', { method: 'GET' });
  await onRequest(context);
  assert.equal(calls[0]!.init.body, undefined);
});
