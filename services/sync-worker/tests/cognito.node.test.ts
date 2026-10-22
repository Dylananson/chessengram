import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { createCognitoVerifier, type VerifiedIdToken } from '../src/cognito.ts';

const REGION = 'eu-west-1';
const USER_POOL_ID = 'eu-west-1_ABC123';
const CLIENT_ID = 'client-abc';
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

interface TestKey {
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  jwk: { kid: string; kty: string; n: string; e: string; alg: string; use: string };
}

function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
  return {
    privateKey,
    jwk: { kid, kty: exported.kty, n: exported.n, e: exported.e, alg: 'RS256', use: 'sig' },
  };
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

interface MintOptions {
  header?: Record<string, unknown>;
  signature?: string;
}

function mint(key: TestKey | undefined, claims: Record<string, unknown>, options: MintOptions = {}): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: key?.jwk.kid ?? 'kid-1', ...options.header };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature =
    options.signature ??
    (key === undefined
      ? ''
      : nodeSign('RSA-SHA256', Buffer.from(signingInput), key.privateKey).toString('base64url'));
  return `${signingInput}.${signature}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    iss: ISSUER,
    sub: 'provider-sub-123',
    aud: CLIENT_ID,
    token_use: 'id',
    exp: NOW_S + 3600,
    iat: NOW_S - 10,
    email: 'person@example.com',
  };
  return { ...base, ...overrides };
}

function jwksResponse(...keys: TestKey[]): Response {
  return new Response(JSON.stringify({ keys: keys.map((key) => key.jwk) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function verifier(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof createCognitoVerifier>[0]> = {},
) {
  return createCognitoVerifier({
    region: REGION,
    userPoolId: USER_POOL_ID,
    clientId: CLIENT_ID,
    jwksUrl: JWKS_URL,
    fetchImpl,
    clock: () => NOW_MS,
    cacheSeconds: 3600,
    ...overrides,
  });
}

test('verifies a valid RS256 ID token and returns its claims', async () => {
  const key = makeKey('kid-1');
  let fetches = 0;
  const v = verifier(async () => {
    fetches += 1;
    return jwksResponse(key);
  });

  const token = mint(key, claims());
  const verified = await v.verifyIdToken(`Bearer ${token}`);
  assert.ok(verified);
  assert.equal(verified.issuer, ISSUER);
  assert.equal(verified.subject, 'provider-sub-123');
  assert.equal(verified.email, 'person@example.com');
  assert.equal(verified.claims.token_use, 'id');
  assert.equal(fetches, 1);

  const mapped = await verifier(async () => jwksResponse(key), {
    resolveUserId: (tokenClaims: VerifiedIdToken) => `canonical:${tokenClaims.subject}`,
  }).verify(`Bearer ${token}`);
  assert.deepEqual(mapped, { userId: 'canonical:provider-sub-123' });
});

test('rejects wrong signature, wrong iss/aud/token_use, expired and future iat', async () => {
  const key = makeKey('kid-1');
  const other = makeKey('kid-2');
  const v = verifier(async () => jwksResponse(key));

  // Signed by a different key but claiming the cached kid.
  assert.equal(await v.verifyIdToken(`Bearer ${mint(other, claims(), { header: { kid: 'kid-1' } })}`), undefined);

  for (const bad of [
    claims({ iss: `${ISSUER}-other` }),
    claims({ aud: 'another-client' }),
    claims({ token_use: 'access' }),
    claims({ exp: NOW_S - 1 }),
    claims({ iat: NOW_S + 3600 }),
  ]) {
    assert.equal(await v.verifyIdToken(`Bearer ${mint(key, bad)}`), undefined);
  }
});

test('rejects alg:none and HS256 before touching JWKS', async () => {
  const key = makeKey('kid-1');
  let fetches = 0;
  const v = verifier(async () => {
    fetches += 1;
    return jwksResponse(key);
  });

  const none = mint(undefined, claims(), {
    header: { alg: 'none', kid: 'kid-1' },
    signature: '',
  });
  assert.equal(await v.verifyIdToken(`Bearer ${none}`), undefined);

  const hs = mint(key, claims(), {
    header: { alg: 'HS256', kid: 'kid-1' },
    signature: 'aGVsbG8',
  });
  assert.equal(await v.verifyIdToken(`Bearer ${hs}`), undefined);
  assert.equal(fetches, 0);
});

test('missing kid and malformed tokens are rejected', async () => {
  const key = makeKey('kid-1');
  let fetches = 0;
  const v = verifier(async () => {
    fetches += 1;
    return jwksResponse(key);
  });

  const noKid = mint(key, claims(), { header: { kid: undefined } });
  assert.equal(await v.verifyIdToken(`Bearer ${noKid}`), undefined);
  assert.equal(await v.verifyIdToken(`Bearer ${mint(key, claims())}.extra`), undefined);
  assert.equal(await v.verifyIdToken('Bearer not-a-jwt'), undefined);
  assert.equal(await v.verifyIdToken(null), undefined);
  assert.equal(fetches, 0);
});

test('unknown kid refetches once and then throttles further lookups', async () => {
  const keyA = makeKey('kid-a');
  const keyB = makeKey('kid-b');
  const keyC = makeKey('kid-c');
  let now = NOW_MS;
  let fetches = 0;
  const v = createCognitoVerifier({
    region: REGION,
    userPoolId: USER_POOL_ID,
    clientId: CLIENT_ID,
    jwksUrl: JWKS_URL,
    fetchImpl: async () => {
      fetches += 1;
      return fetches === 1 ? jwksResponse(keyA) : jwksResponse(keyA, keyB);
    },
    clock: () => now,
    cacheSeconds: 3600,
    refetchMinSeconds: 10,
  });

  assert.ok(await v.verifyIdToken(`Bearer ${mint(keyA, claims())}`));
  assert.equal(fetches, 1);

  // Unknown kid → one refetch, which learns key B.
  assert.ok(await v.verifyIdToken(`Bearer ${mint(keyB, claims())}`));
  assert.equal(fetches, 2);

  // A different unknown kid immediately after must not hammer the JWKS.
  assert.equal(await v.verifyIdToken(`Bearer ${mint(keyC, claims())}`), undefined);
  assert.equal(fetches, 2);

  // After the throttle window a lookup may refetch again.
  now += 11_000;
  assert.equal(await v.verifyIdToken(`Bearer ${mint(keyC, claims())}`), undefined);
  assert.equal(fetches, 3);
});

test('derives the JWKS URL and reuses the cache across verifications', async () => {
  const key = makeKey('kid-1');
  const requested: string[] = [];
  const v = createCognitoVerifier({
    region: REGION,
    userPoolId: USER_POOL_ID,
    clientId: CLIENT_ID,
    fetchImpl: async (input) => {
      requested.push(String(input));
      return jwksResponse(key);
    },
    clock: () => NOW_MS,
  });

  const token = mint(key, claims());
  assert.ok(await v.verifyIdToken(`Bearer ${token}`));
  assert.ok(await v.verifyIdToken(`Bearer ${token}`));
  assert.deepEqual(requested, [JWKS_URL]);
});

test('oversized tokens are rejected without parsing or fetching', async () => {
  const key = makeKey('kid-1');
  let fetches = 0;
  const v = verifier(
    async () => {
      fetches += 1;
      return jwksResponse(key);
    },
    { maxTokenBytes: 64 },
  );
  assert.equal(await v.verifyIdToken(`Bearer ${mint(key, claims())}`), undefined);
  assert.equal(fetches, 0);
});
