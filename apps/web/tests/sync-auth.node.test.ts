/**
 * ONL-011 — Cognito authorization-code + PKCE auth flow (Node, no network).
 *
 * Covers: authorize URL fields, PKCE S256 correctness, random state, state
 * mismatch/expiry rejection, callback parsing, token exchange success/failure
 * (asserting the exact form body) and that nothing secret is ever logged.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  AUTH_PENDING_STORAGE_KEY,
  AUTH_PENDING_TTL_MS,
  DEFAULT_AUTH_SCOPE,
  beginAuth,
  completeAuth,
  isAuthCallback,
  parseAuthCallback,
  SyncAuthError,
  type AuthFetch,
  type AuthPendingStorage,
  type SyncAuthErrorCode,
} from '../src/sync/auth.ts';
import type { SyncPanelConfig } from '../src/sync/panel.ts';

const CONFIG: SyncPanelConfig = {
  apiBase: 'https://api.example.test',
  authAuthority: 'https://auth.example.test',
  authClientId: 'client-123',
  authRedirectUri: 'https://app.example.test/',
};

class MemoryAuthStorage implements AuthPendingStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

interface CapturedRequest {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

/** Fake token endpoint; never touches the network. */
function fakeFetch(options: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throwError?: boolean;
  onRequest?: (request: CapturedRequest) => void;
} = {}): AuthFetch {
  return async (url, init) => {
    options.onRequest?.({ url, init });
    if (options.throwError === true) throw new Error('offline');
    return {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      json: async () => options.body ?? { id_token: 'id-token-value' },
    };
  };
}

function pendingRecord(storage: MemoryAuthStorage): {
  state: string;
  verifier: string;
  createdAt: number;
} {
  const raw = storage.getItem(AUTH_PENDING_STORAGE_KEY);
  assert.ok(raw, 'a pending authorize request is persisted');
  return JSON.parse(raw) as { state: string; verifier: string; createdAt: number };
}

/** base64url(SHA-256(text)) — the S256 challenge, computed independently. */
async function s256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- authorize URL + PKCE --------------------------------------------------

test('beginAuth builds the authorize URL with code response, PKCE S256 and state', async () => {
  const storage = new MemoryAuthStorage();
  const { url, state } = await beginAuth({ config: CONFIG, storage, now: 1_000 });

  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://auth.example.test/oauth2/authorize');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('client_id'), CONFIG.authClientId);
  assert.equal(parsed.searchParams.get('redirect_uri'), CONFIG.authRedirectUri);
  assert.equal(parsed.searchParams.get('scope'), DEFAULT_AUTH_SCOPE);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('state'), state);

  const pending = pendingRecord(storage);
  assert.equal(pending.state, state);
  assert.equal(pending.createdAt, 1_000);
  assert.equal(pending.verifier.length, 43, '32 random bytes = 43 base64url chars');
  assert.match(pending.verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(parsed.searchParams.get('code_challenge'), await s256(pending.verifier));
  assert.ok(!url.includes(pending.verifier), 'the verifier never appears in the URL');
});

test('beginAuth honours a custom scope and trims a trailing authority slash', async () => {
  const storage = new MemoryAuthStorage();
  const { url } = await beginAuth({
    config: { ...CONFIG, authAuthority: 'https://auth.example.test///' },
    storage,
    scope: 'openid',
  });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/oauth2/authorize');
  assert.equal(parsed.searchParams.get('scope'), 'openid');
});

test('beginAuth generates a fresh random state on every call', async () => {
  const storage = new MemoryAuthStorage();
  const first = await beginAuth({ config: CONFIG, storage });
  const second = await beginAuth({ config: CONFIG, storage });
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.url, second.url);
});

test('beginAuth fails closed when auth config is missing', async () => {
  const storage = new MemoryAuthStorage();
  await assert.rejects(
    () => beginAuth({ config: {}, storage }),
    (error: unknown) => error instanceof SyncAuthError && error.code === 'missing_config',
  );
});

test('a configured client without a redirect URI relies on the registered callback', async () => {
  const storage = new MemoryAuthStorage();
  const config: SyncPanelConfig = {
    authAuthority: 'https://auth.example.test',
    authClientId: 'client-123',
  };
  const { url, state } = await beginAuth({ config, storage });
  assert.equal(new URL(url).searchParams.get('redirect_uri'), null);

  let captured: CapturedRequest | undefined;
  await completeAuth({
    config,
    callbackUrl: `https://app.example.test/?code=c&state=${state}`,
    storage,
    fetchImpl: fakeFetch({ onRequest: (request) => (captured = request) }),
  });
  const body = new URLSearchParams(captured!.init.body);
  assert.equal(body.get('redirect_uri'), null);
});

// --- callback parsing ------------------------------------------------------

test('isAuthCallback detects only a code+state callback', () => {
  assert.equal(isAuthCallback('https://app.example.test/?code=a&state=b'), true);
  assert.equal(isAuthCallback('https://app.example.test/#/settings'), false);
  assert.equal(isAuthCallback('https://app.example.test/?state=b'), false);
  assert.equal(isAuthCallback('https://app.example.test/?code=a'), false);
  assert.equal(isAuthCallback('?code=a&state=b'), true, 'relative callbacks parse too');
});

test('parseAuthCallback exposes code, state and error without extra keys', () => {
  assert.deepEqual(parseAuthCallback('https://app/?code=a&state=b'), { code: 'a', state: 'b' });
  assert.deepEqual(parseAuthCallback('https://app/?error=access_denied'), {
    error: 'access_denied',
  });
  assert.equal(parseAuthCallback('http://['), undefined);
});

// --- token exchange --------------------------------------------------------

test('completeAuth validates state, exchanges the code and returns the ID token', async () => {
  const storage = new MemoryAuthStorage();
  const { state } = await beginAuth({ config: CONFIG, storage, now: 5_000 });
  const verifier = pendingRecord(storage).verifier;
  let captured: CapturedRequest | undefined;

  const result = await completeAuth({
    config: CONFIG,
    callbackUrl: `${CONFIG.authRedirectUri}?code=auth-code-1&state=${state}`,
    storage,
    now: 6_000,
    fetchImpl: fakeFetch({
      body: { id_token: 'id-token-value' },
      onRequest: (request) => {
        captured = request;
      },
    }),
  });

  assert.deepEqual(result, { idToken: 'id-token-value' });
  assert.ok(captured, 'the token endpoint was called');
  assert.equal(captured.url, 'https://auth.example.test/oauth2/token');
  assert.equal(captured.init.method, 'POST');
  assert.match(captured.init.headers['Content-Type'] ?? '', /application\/x-www-form-urlencoded/);

  const body = new URLSearchParams(captured.init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), CONFIG.authClientId);
  assert.equal(body.get('code'), 'auth-code-1');
  assert.equal(body.get('redirect_uri'), CONFIG.authRedirectUri);
  assert.equal(body.get('code_verifier'), verifier, 'the PKCE verifier is sent once');

  assert.equal(storage.getItem(AUTH_PENDING_STORAGE_KEY), null, 'pending entry is consumed');
});

test('completeAuth rejects a mismatched state and keeps the pending request', async () => {
  const storage = new MemoryAuthStorage();
  await beginAuth({ config: CONFIG, storage });
  await assert.rejects(
    () =>
      completeAuth({
        config: CONFIG,
        callbackUrl: `${CONFIG.authRedirectUri}?code=c&state=forged`,
        storage,
        fetchImpl: fakeFetch(),
      }),
    (error: unknown) => error instanceof SyncAuthError && error.code === 'state_mismatch',
  );
  assert.ok(storage.getItem(AUTH_PENDING_STORAGE_KEY), 'the legitimate pending request survives');
});

test('completeAuth rejects an expired state and clears it', async () => {
  const storage = new MemoryAuthStorage();
  const { state } = await beginAuth({ config: CONFIG, storage, now: 0 });
  await assert.rejects(
    () =>
      completeAuth({
        config: CONFIG,
        callbackUrl: `${CONFIG.authRedirectUri}?code=c&state=${state}`,
        storage,
        now: AUTH_PENDING_TTL_MS + 1,
        fetchImpl: fakeFetch(),
      }),
    (error: unknown) => error instanceof SyncAuthError && error.code === 'state_expired',
  );
  assert.equal(storage.getItem(AUTH_PENDING_STORAGE_KEY), null);
});

test('completeAuth rejects a callback without a pending request or code', async () => {
  const storage = new MemoryAuthStorage();
  await assert.rejects(
    () =>
      completeAuth({
        config: CONFIG,
        callbackUrl: `${CONFIG.authRedirectUri}?code=c&state=s`,
        storage,
        fetchImpl: fakeFetch(),
      }),
    (error: unknown) => error instanceof SyncAuthError && error.code === 'state_missing',
  );

  const { state } = await beginAuth({ config: CONFIG, storage });
  await assert.rejects(
    () =>
      completeAuth({
        config: CONFIG,
        callbackUrl: `${CONFIG.authRedirectUri}?state=${state}`,
        storage,
        fetchImpl: fakeFetch(),
      }),
    (error: unknown) => error instanceof SyncAuthError && error.code === 'invalid_callback',
  );
});

test('completeAuth surfaces non-2xx and malformed responses as typed errors', async () => {
  const storage = new MemoryAuthStorage();
  const { state } = await beginAuth({ config: CONFIG, storage });
  const callbackUrl = `${CONFIG.authRedirectUri}?code=c&state=${state}`;

  await assert.rejects(
    () => completeAuth({ config: CONFIG, callbackUrl, storage, fetchImpl: fakeFetch({ ok: false, status: 400 }) }),
    (error: unknown) =>
      error instanceof SyncAuthError &&
      error.code === 'token_exchange_failed' &&
      error.status === 400,
  );

  await beginAuth({ config: CONFIG, storage });
  const second = pendingRecord(storage);
  await assert.rejects(
    () =>
      completeAuth({
        config: CONFIG,
        callbackUrl: `${CONFIG.authRedirectUri}?code=c&state=${second.state}`,
        storage,
        fetchImpl: fakeFetch({ body: {} }),
      }),
    (error: unknown) => error instanceof SyncAuthError && error.code === 'invalid_token_response',
  );
});

test('completeAuth wraps a transport failure as a typed network error', async () => {
  const storage = new MemoryAuthStorage();
  const { state } = await beginAuth({ config: CONFIG, storage });
  await assert.rejects(
    () =>
      completeAuth({
        config: CONFIG,
        callbackUrl: `${CONFIG.authRedirectUri}?code=c&state=${state}`,
        storage,
        fetchImpl: fakeFetch({ throwError: true }),
      }),
    (error: unknown) => error instanceof SyncAuthError && error.code === 'network_error',
  );
});

// --- no secret ever logged -------------------------------------------------

test('nothing secret is logged during begin or complete', async () => {
  const storage = new MemoryAuthStorage();
  const logged: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((name) => console[name]);
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      logged.push(args.map((value) => String(value)).join(' '));
    };
  }

  let verifier = '';
  let state = '';
  try {
    const begun = await beginAuth({ config: CONFIG, storage });
    state = begun.state;
    verifier = pendingRecord(storage).verifier;
    await completeAuth({
      config: CONFIG,
      callbackUrl: `${CONFIG.authRedirectUri}?code=super-secret-code&state=${state}`,
      storage,
      fetchImpl: fakeFetch({ body: { id_token: 'super-secret-id-token' } }),
    });
    await completeAuth({
      config: CONFIG,
      callbackUrl: `${CONFIG.authRedirectUri}?code=c&state=mismatch`,
      storage,
      fetchImpl: fakeFetch(),
    }).catch(() => {});
  } finally {
    methods.forEach((name, index) => {
      console[name] = originals[index]!;
    });
  }

  const all = logged.join('\n');
  for (const secret of [verifier, 'super-secret-code', 'super-secret-id-token']) {
    assert.ok(secret.length > 0);
    assert.ok(!all.includes(secret), `secret "${secret.slice(0, 6)}…" must never be logged`);
  }
});

test('SyncAuthError codes cover the documented failure set', () => {
  const codes: SyncAuthErrorCode[] = [
    'missing_config',
    'storage_unavailable',
    'state_missing',
    'state_mismatch',
    'state_expired',
    'invalid_callback',
    'token_exchange_failed',
    'invalid_token_response',
    'network_error',
  ];
  for (const code of codes) {
    const error = new SyncAuthError(code, 'x');
    assert.equal(error.code, code);
    assert.equal(error.name, 'SyncAuthError');
  }
});
