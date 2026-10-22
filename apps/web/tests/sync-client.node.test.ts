/**
 * ONL-009a — `sync/client.ts`: routes, headers/credentials, typed errors,
 * no-retry policy and the server-blind push body. A fake `fetch` is injected
 * everywhere, so the suite never touches the network.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEFAULT_SYNC_TIMEOUT_MS,
  MAX_ERROR_BODY_CHARS,
  SyncHttpError,
  createSyncApiClient,
  isRetryable,
  type SyncClientTimers,
  type SyncFetch,
} from '../src/sync/client.ts';
import { SYNC_ENVELOPE_VERSION, type SyncRecordEnvelope } from '../src/sync/types.ts';

const BASE = 'https://sync.example.test';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: string | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Builds a `fetch` that records every call and returns `handler(call)`. */
function recorder(handler: (call: RecordedCall) => Response | Promise<Response>): {
  impl: SyncFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const impl: SyncFetch = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    const call: RecordedCall = {
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      credentials: init.credentials,
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return { impl, calls };
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

test('every route: URL, method, headers and credentials', async () => {
  const { impl, calls } = recorder((call) => {
    if (call.url.endsWith('/auth/session')) return jsonResponse({ userId: 'u1', expiresAt: 42 });
    if (call.method === 'POST' && call.url.endsWith('/devices')) return jsonResponse({ thumbprint: 'tp' });
    if (call.method === 'GET' && call.url.endsWith('/devices')) return jsonResponse({ devices: [] });
    if (call.url.endsWith('/sync')) return jsonResponse({ cursor: 0, accepted: [], duplicates: [], changes: [] });
    return jsonResponse({ ok: true });
  });
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });

  assert.deepEqual(await client.exchangeSession('id-token-123'), { userId: 'u1', expiresAt: 42 });
  assert.deepEqual(await client.getSession(), { userId: 'u1', expiresAt: 42 });
  await client.signOut();
  assert.deepEqual(
    await client.registerDevice({
      deviceId: 'dev 1',
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey,
    }),
    { thumbprint: 'tp' },
  );
  assert.deepEqual(await client.listDevices(), []);
  await client.revokeDevice('dev/1 ?');
  await client.push({ since: 5, push: [] });
  await client.deleteAccount();

  assert.equal(calls.length, 8);

  const expected: Array<{
    url: string;
    method: string;
    contentType: boolean;
    authorization?: string;
  }> = [
    { url: `${BASE}/auth/session`, method: 'POST', contentType: true, authorization: 'Bearer id-token-123' },
    { url: `${BASE}/auth/session`, method: 'GET', contentType: false },
    { url: `${BASE}/auth/signout`, method: 'POST', contentType: true },
    { url: `${BASE}/devices`, method: 'POST', contentType: true },
    { url: `${BASE}/devices`, method: 'GET', contentType: false },
    { url: `${BASE}/devices/dev%2F1%20%3F`, method: 'DELETE', contentType: true },
    { url: `${BASE}/sync`, method: 'POST', contentType: true },
    { url: `${BASE}/sync/account`, method: 'DELETE', contentType: true },
  ];

  expected.forEach((want, index) => {
    const call = calls[index]!;
    assert.equal(call.url, want.url, `call ${index} url`);
    assert.equal(call.method, want.method, `call ${index} method`);
    assert.equal(call.credentials, 'include', `call ${index} credentials`);
    // Mutations must carry the JSON content type the worker's CSRF check needs.
    assert.equal(
      call.headers['content-type'] === 'application/json',
      want.contentType,
      `call ${index} content-type`,
    );
    // Bearer belongs to the session exchange and nowhere else.
    assert.equal(call.headers['authorization'], want.authorization, `call ${index} authorization`);
  });
});

test('registerDevice serializes deviceId and publicKeyJwk as the request body', async () => {
  const { impl, calls } = recorder(() => jsonResponse({ thumbprint: 'tp' }));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  const publicKeyJwk = { kty: 'EC', crv: 'P-256', x: 'aaa', y: 'bbb' } as JsonWebKey;

  await client.registerDevice({ deviceId: 'device-1', publicKeyJwk });

  assert.deepEqual(JSON.parse(calls[0]!.body!), { deviceId: 'device-1', publicKeyJwk });
});

test('getSession returns undefined on 401 (no session is not an error)', async () => {
  const { impl } = recorder(() => jsonResponse({ error: 'unauthenticated' }, 401));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  assert.equal(await client.getSession(), undefined);
});

test('getSession throws the typed error for non-401 failures', async () => {
  const { impl } = recorder(() => jsonResponse({ error: 'boom' }, 500));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  const error = await capture(client.getSession());
  assert.ok(error instanceof SyncHttpError);
  assert.equal(error.status, 500);
  assert.equal(error.code, 'boom');
  assert.equal(isRetryable(error), true);
});

test('error mapping: 401 → unauthorized (server code kept on serverCode)', async () => {
  const { impl } = recorder(() => jsonResponse({ error: 'unauthenticated' }, 401));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  const error = await capture(client.listDevices());
  assert.ok(error instanceof SyncHttpError);
  assert.equal(error.status, 401);
  assert.equal(error.code, 'unauthorized');
  assert.equal(error.serverCode, 'unauthenticated');
  assert.equal(error.retryable, false);
});

test('error mapping: 403 → csrf_or_forbidden', async () => {
  const { impl } = recorder(() => jsonResponse({ error: 'csrf_protection' }, 403));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  const error = await capture(client.push({ since: 0, push: [] }));
  assert.ok(error instanceof SyncHttpError);
  assert.equal(error.status, 403);
  assert.equal(error.code, 'csrf_or_forbidden');
  assert.equal(error.serverCode, 'csrf_protection');
});

test('error mapping: 422 preserves the server code', async () => {
  for (const serverCode of ['invalid_signature', 'unregistered_device', 'device_revoked']) {
    const { impl } = recorder(() => jsonResponse({ error: serverCode }, 422));
    const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
    const error = await capture(client.push({ since: 0, push: [] }));
    assert.ok(error instanceof SyncHttpError);
    assert.equal(error.status, 422);
    assert.equal(error.code, serverCode);
    assert.equal(error.serverCode, serverCode);
    assert.equal(error.retryable, false);
  }
});

test('error mapping: 422 without a body code falls back to http_422', async () => {
  const { impl } = recorder(() => new Response('', { status: 422 }));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  const error = await capture(client.push({ since: 0, push: [] }));
  assert.ok(error instanceof SyncHttpError);
  assert.equal(error.code, 'http_422');
});

test('error mapping: 429 and 5xx are retryable', async () => {
  const { impl } = recorder(() => jsonResponse({}, 429));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  const tooMany = await capture(client.push({ since: 0, push: [] }));
  assert.ok(tooMany instanceof SyncHttpError);
  assert.equal(tooMany.code, 'http_429');
  assert.equal(tooMany.retryable, true);
  assert.equal(isRetryable(tooMany), true);

  const { impl: impl500 } = recorder(() => jsonResponse({ error: 'internal_error' }, 500));
  const client500 = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl500 });
  const boom = await capture(client500.push({ since: 0, push: [] }));
  assert.ok(boom instanceof SyncHttpError);
  assert.equal(boom.code, 'internal_error');
  assert.equal(boom.retryable, true);
});

test('error mapping: network failure → code network, status 0, retryable', async () => {
  const impl: SyncFetch = () => Promise.reject(new TypeError('Failed to fetch'));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  const error = await capture(client.push({ since: 0, push: [] }));
  assert.ok(error instanceof SyncHttpError);
  assert.equal(error.status, 0);
  assert.equal(error.code, 'network');
  assert.equal(error.timeout, false);
  assert.equal(error.retryable, true);
  assert.equal(isRetryable(error), true);
});

test('error mapping: timeout aborts and maps to a retryable network error', async () => {
  let aborted = false;
  const scheduled: Array<() => void> = [];
  const cleared: unknown[] = [];
  const timers: SyncClientTimers = {
    setTimeout: (handler) => {
      scheduled.push(handler);
      return `timer-${scheduled.length}`;
    },
    clearTimeout: (handle) => {
      cleared.push(handle);
    },
  };
  const impl: SyncFetch = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    });
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl, timeoutMs: 5000, timers });

  const pending = client.push({ since: 0, push: [] }).catch((error: unknown) => error);
  assert.equal(scheduled.length, 1, 'timeout is scheduled for the in-flight request');
  scheduled[0]!();

  const error = await pending;
  assert.ok(error instanceof SyncHttpError);
  assert.equal(error.code, 'network');
  assert.equal(error.status, 0);
  assert.equal(error.timeout, true);
  assert.equal(error.retryable, true);
  assert.equal(aborted, true);
  assert.deepEqual(cleared, ['timer-1'], 'the timeout is always cleared');
});

test('the timeout timer is cleared after a successful request', async () => {
  const cleared: unknown[] = [];
  const timers: SyncClientTimers = {
    setTimeout: () => 7,
    clearTimeout: (handle) => {
      cleared.push(handle);
    },
  };
  const { impl } = recorder(() => jsonResponse({ ok: true }));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl, timers });
  await client.signOut();
  assert.deepEqual(cleared, [7]);
  assert.equal(DEFAULT_SYNC_TIMEOUT_MS, 15_000);
});

test('error bodies are captured raw and bounded', async () => {
  const huge = 'x'.repeat(5000);
  const { impl } = recorder(() => new Response(huge, { status: 500 }));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  const error = await capture(client.signOut());
  assert.ok(error instanceof SyncHttpError);
  assert.equal(error.body.length, MAX_ERROR_BODY_CHARS);
  assert.equal(MAX_ERROR_BODY_CHARS, 2048);
});

test('a non-JSON success body is a typed invalid_response error', async () => {
  const { impl } = recorder(() => new Response('<html>nope</html>', { status: 200 }));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  const error = await capture(client.listDevices());
  assert.ok(error instanceof SyncHttpError);
  assert.equal(error.code, 'invalid_response');
  assert.equal(error.retryable, false);
});

test('isRetryable truth table: true for network/timeout/429/5xx, false for other 4xx', async () => {
  const cases: Array<[number, boolean]> = [
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [409, false],
    [413, false],
    [422, false],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
  ];
  for (const [status, expected] of cases) {
    const { impl } = recorder(() => jsonResponse({ error: `e${status}` }, status));
    const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
    const error = await capture(client.listDevices());
    assert.ok(error instanceof SyncHttpError, `status ${status} throws a SyncHttpError`);
    assert.equal(error.retryable, expected, `status ${status} retryable flag`);
    assert.equal(isRetryable(error), expected, `status ${status} isRetryable`);
  }

  const net = createSyncApiClient({ baseUrl: BASE, fetchImpl: () => Promise.reject(new Error('offline')) });
  assert.equal(isRetryable(await capture(net.listDevices())), true);

  assert.equal(isRetryable(new Error('plain error')), false);
  assert.equal(isRetryable(undefined), false);
  assert.equal(isRetryable({ code: 'network' }), false);
});

test('push returns the parsed response unchanged', async () => {
  const response = {
    cursor: 17,
    accepted: ['dedupe-a'],
    duplicates: ['dedupe-b'],
    changes: [
      {
        v: SYNC_ENVELOPE_VERSION,
        type: 'attempt' as const,
        recordId: 'a1',
        dedupeKey: 'dedupe-a',
        deviceId: 'device-1',
        payload: { attemptId: 'a1', outcome: 'success' },
        sig: 'c2ln',
        updatedAt: 1_700_000_000_000,
        rev: 1,
        seq: 17,
      },
    ],
  };
  const { impl } = recorder(() => jsonResponse(response));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  assert.deepEqual(await client.push({ since: 0, push: [] }), response);
});

test('push never retries internally: one attempt even on 5xx', async () => {
  const { impl, calls } = recorder(() => jsonResponse({ error: 'internal_error' }, 500));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  const error = await capture(client.push({ since: 0, push: [] }));
  assert.ok(error instanceof SyncHttpError);
  assert.equal(error.status, 500);
  assert.equal(calls.length, 1, 'a single network attempt');
});

test('push body carries exactly the wire fields (nothing a caller tacked on)', async () => {
  const { impl, calls } = recorder(() =>
    jsonResponse({ cursor: 0, accepted: [], duplicates: [], changes: [] }),
  );
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });

  // Simulate a caller attaching extra fields (and a server-assigned `seq`) to
  // an envelope object: the client must forward only the wire fields.
  const leaky = {
    v: SYNC_ENVELOPE_VERSION,
    type: 'attempt',
    recordId: 'a1',
    dedupeKey: 'd1',
    deviceId: 'device-1',
    payload: { attemptId: 'a1' },
    sig: 'c2ln',
    updatedAt: 1_700_000_000_000,
    rev: 3,
    startedAt: 1_699_999_999_123,
    collectionName: 'My Repertoire',
    seq: 9,
  } as unknown as SyncRecordEnvelope;

  await client.push({ since: 0, push: [leaky] });

  const raw = calls[0]!.body!;
  const parsed = JSON.parse(raw) as { since: number; push: Array<Record<string, unknown>> };
  assert.equal(parsed.since, 0);
  assert.equal(parsed.push.length, 1);
  assert.deepEqual(
    Object.keys(parsed.push[0]!).sort(),
    ['dedupeKey', 'deviceId', 'payload', 'recordId', 'rev', 'sig', 'type', 'updatedAt', 'v'],
  );
  for (const notSent of ['startedAt', 'collectionName', 'seq']) {
    assert.equal(raw.includes(notSent), false, `${notSent} must never leave the client`);
  }
});

test('baseUrl is normalized (trim + trailing slashes) and never doubled', async () => {
  const { impl, calls } = recorder(() => jsonResponse({ userId: 'u1', expiresAt: 1 }));
  const client = createSyncApiClient({ baseUrl: '  https://sync.example.test/v1///  ', fetchImpl: impl });
  await client.getSession();
  assert.equal(calls[0]!.url, 'https://sync.example.test/v1/auth/session');
});

test('an empty baseUrl produces root-relative paths', async () => {
  const { impl, calls } = recorder(() => jsonResponse({ devices: [] }));
  const client = createSyncApiClient({ baseUrl: '/', fetchImpl: impl });
  await client.listDevices();
  assert.equal(calls[0]!.url, '/devices');
});

test('revokeDevice encodes the device id', async () => {
  const { impl, calls } = recorder(() => jsonResponse({ ok: true }));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl });
  await client.revokeDevice('dev/ice ?#&');
  assert.equal(calls[0]!.url, `${BASE}/devices/dev%2Fice%20%3F%23%26`);
  assert.equal(calls[0]!.body, undefined);
});

test('credentials can be overridden (e.g. omit) and defaults to include', async () => {
  const { impl, calls } = recorder(() => jsonResponse({ devices: [] }));
  const client = createSyncApiClient({ baseUrl: BASE, fetchImpl: impl, credentials: 'omit' });
  await client.listDevices();
  assert.equal(calls[0]!.credentials, 'omit');
});
