import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEV_USER_ID } from '../src/auth.ts';
import { hashSessionId } from '../src/session.ts';
import {
  APP_ORIGIN,
  AUTH_HEADER,
  makeHarness,
  request,
  sessionHeaders,
  sessionIdFrom,
} from './harness.ts';

async function createSession(
  handler: (request: Request) => Promise<Response>,
): Promise<{ response: Response; sessionId: string; expiresAt: number }> {
  const response = await handler(request('POST', '/auth/session', { headers: AUTH_HEADER }));
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { userId: string; expiresAt: number };
  assert.equal(body.userId, DEV_USER_ID);
  const sessionId = sessionIdFrom(response);
  assert.ok(sessionId);
  return { response, sessionId, expiresAt: body.expiresAt };
}

test('POST /auth/session exchanges a Bearer token for an HttpOnly session cookie', async () => {
  const { handler, sessions } = makeHarness();
  const now = Date.now();
  const { response, sessionId, expiresAt } = await createSession(handler);

  const cookie = response.headers.get('Set-Cookie') ?? '';
  assert.match(cookie, /^chessengram_session=[0-9a-f]{32};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=2592000/);
  assert.ok(expiresAt > now);

  // The store holds only the hash, never the raw cookie value.
  const stored = await sessions.get(await hashSessionId(sessionId));
  assert.equal(stored?.userId, DEV_USER_ID);
  assert.equal(await sessions.get(sessionId), undefined);
});

test('GET /auth/session works with the cookie and expires with the clock', async () => {
  let now = 1_000_000;
  const harness = makeHarness({ clock: () => now, sessionTtlSeconds: 60 });
  const { handler } = harness;
  const { sessionId } = await createSession(handler);

  const ok = await handler(
    request('GET', '/auth/session', { headers: { Cookie: `chessengram_session=${sessionId}` } }),
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { userId: DEV_USER_ID, expiresAt: now + 60_000 });

  now += 60_001;
  const expired = await handler(
    request('GET', '/auth/session', { headers: { Cookie: `chessengram_session=${sessionId}` } }),
  );
  assert.equal(expired.status, 401);
  assert.equal(await harness.sessions.get(await hashSessionId(sessionId)), undefined);
});

test('GET /auth/session rejects missing and unknown sessions', async () => {
  const { handler } = makeHarness();
  assert.equal((await handler(request('GET', '/auth/session'))).status, 401);
  assert.equal(
    (
      await handler(
        request('GET', '/auth/session', { headers: { Cookie: 'chessengram_session=deadbeef' } }),
      )
    ).status,
    401,
  );
});

test('POST /auth/signout revokes the session and clears the cookie', async () => {
  const { handler, sessions } = makeHarness();
  const { sessionId } = await createSession(handler);
  const hash = await hashSessionId(sessionId);

  const signout = await handler(
    request('POST', '/auth/signout', { headers: sessionHeaders(sessionId) }),
  );
  assert.equal(signout.status, 200);
  assert.deepEqual(await signout.json(), { ok: true });
  assert.match(signout.headers.get('Set-Cookie') ?? '', /chessengram_session=;.*Max-Age=0/);
  assert.equal(await sessions.get(hash), undefined);

  const after = await handler(
    request('GET', '/auth/session', { headers: { Cookie: `chessengram_session=${sessionId}` } }),
  );
  assert.equal(after.status, 401);
});

test('POST /auth/session always requires a Bearer token', async () => {
  const { handler } = makeHarness();
  const { sessionId } = await createSession(handler);
  const cookieOnly = await handler(
    request('POST', '/auth/session', { headers: { Cookie: `chessengram_session=${sessionId}` } }),
  );
  assert.equal(cookieOnly.status, 401);
});

test('cookie-authenticated mutations require JSON and an allowed Origin', async () => {
  const { handler } = makeHarness();
  const { sessionId } = await createSession(handler);
  const body = { since: 0, push: [] };
  const cookie = `chessengram_session=${sessionId}`;

  const noContentType = await handler(
    request('POST', '/sync', { body, headers: { Cookie: cookie, Origin: APP_ORIGIN } }),
  );
  assert.equal(noContentType.status, 403);
  assert.equal((await noContentType.json() as { error: string }).error, 'csrf_protection');

  const noOrigin = await handler(
    request('POST', '/sync', {
      body,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    }),
  );
  assert.equal(noOrigin.status, 403);

  const disallowedOrigin = await handler(
    request('POST', '/sync', {
      body,
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
    }),
  );
  assert.equal(disallowedOrigin.status, 403);
  assert.equal((await disallowedOrigin.json() as { error: string }).error, 'origin_not_allowed');

  const ok = await handler(
    request('POST', '/sync', {
      body,
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: APP_ORIGIN,
      },
    }),
  );
  assert.equal(ok.status, 200, await ok.clone().text());
});

test('GET requests with the session cookie do not need JSON/Origin', async () => {
  const { handler } = makeHarness();
  const { sessionId } = await createSession(handler);
  const response = await handler(
    request('GET', '/devices', { headers: { Cookie: `chessengram_session=${sessionId}` } }),
  );
  assert.equal(response.status, 200);
});
