/**
 * Cognito ID-token verification (RS256 via WebCrypto).
 *
 * The worker trusts exactly one issuer/audience pair from configuration:
 *   iss = https://cognito-idp.{region}.amazonaws.com/{userPoolId}
 *   aud = {clientId}
 * and only `token_use: "id"` tokens. Signing keys come from the pool's JWKS,
 * are cached per `kid` with a TTL, and are refreshed at most once (throttled)
 * when an unknown `kid` arrives. **Every network call goes through the
 * injected `fetchImpl`**, so tests never touch the network.
 *
 * `verify()` implements the existing {@link TokenVerifier} seam and maps the
 * verified claims through `resolveUserId` (the canonical-identity store). The
 * raw provider `sub` is never returned as the app user id.
 */

import { bearerToken, type TokenVerifier } from './auth.ts';
import { DEFAULT_JWKS_CACHE_SECONDS, DEFAULT_MAX_ID_TOKEN_BYTES } from './config.ts';

export interface VerifiedIdToken {
  issuer: string;
  subject: string;
  email?: string;
  /** Raw verified claims (never log this object). */
  claims: Record<string, unknown>;
}

export interface CognitoVerifierOptions {
  region: string;
  userPoolId: string;
  clientId: string;
  /** Optional explicit JWKS URL; derived from region/pool otherwise. */
  jwksUrl?: string;
  /** Injectable fetch (tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock in epoch milliseconds. */
  clock?: () => number;
  /** JWKS entry lifetime in seconds. */
  cacheSeconds?: number;
  /** Hard cap on the token string before parsing. */
  maxTokenBytes?: number;
  /** Minimum gap between unknown-`kid` refetches. */
  refetchMinSeconds?: number;
  /** Allowed `iat`/`nbf` clock skew in seconds. */
  clockSkewSeconds?: number;
  /** Maps verified claims to the canonical app user id. */
  resolveUserId?: (claims: VerifiedIdToken) => Promise<string> | string;
}

export interface CognitoVerifier extends TokenVerifier {
  /** Verify and return the claims without resolving the app user id. */
  verifyIdToken(authorization: string | null): Promise<VerifiedIdToken | undefined>;
}

const DEFAULT_REFETCH_MIN_SECONDS = 10;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;

interface CognitoJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  use?: string;
  alg?: string;
}

type CryptoKeyLike = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

interface CachedKey {
  jwk: CognitoJwk;
  key?: CryptoKeyLike;
  fetchedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict base64url → bytes (JWT segments are unpadded base64url). */
function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  if (input.length === 0) throw new Error('empty base64url segment');
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error('invalid base64url characters');
  if (input.length % 4 === 1) throw new Error('invalid base64url length');
  const standard = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeJsonSegment(segment: string): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(segment));
  return JSON.parse(text) as unknown;
}

function normalizeJwk(value: unknown): CognitoJwk | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.kid !== 'string' || value.kid.length === 0 || value.kid.length > 256) return undefined;
  if (value.kty !== 'RSA') return undefined;
  if (typeof value.n !== 'string' || value.n.length === 0) return undefined;
  if (typeof value.e !== 'string' || value.e.length === 0) return undefined;
  // A JWKS must never contain private material.
  if (value.d !== undefined) return undefined;
  if (value.use !== undefined && value.use !== 'sig') return undefined;
  if (value.alg !== undefined && value.alg !== 'RS256') return undefined;
  return {
    kid: value.kid,
    kty: 'RSA',
    n: value.n,
    e: value.e,
    ...(typeof value.use === 'string' ? { use: value.use } : {}),
    ...(typeof value.alg === 'string' ? { alg: value.alg } : {}),
  };
}

function tokenByteLength(token: string): number {
  return new TextEncoder().encode(token).byteLength;
}

export function createCognitoVerifier(options: CognitoVerifierOptions): CognitoVerifier {
  if (!options.region) throw new Error('Cognito region is required');
  if (!options.userPoolId) throw new Error('Cognito userPoolId is required');
  if (!options.clientId) throw new Error('Cognito clientId is required');

  const issuer = `https://cognito-idp.${options.region}.amazonaws.com/${options.userPoolId}`;
  const jwksUrl = options.jwksUrl ?? `${issuer}/.well-known/jwks.json`;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? Date.now;
  const cacheMs = Math.max(1, options.cacheSeconds ?? DEFAULT_JWKS_CACHE_SECONDS) * 1000;
  const maxTokenBytes = Math.max(1, options.maxTokenBytes ?? DEFAULT_MAX_ID_TOKEN_BYTES);
  const refetchMinMs = Math.max(0, options.refetchMinSeconds ?? DEFAULT_REFETCH_MIN_SECONDS) * 1000;
  const clockSkewSeconds = Math.max(0, options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS);
  const resolveUserId = options.resolveUserId;

  let keys = new Map<string, CachedKey>();
  let lastAttemptAt: number | undefined;
  /** Separate throttle for key-rotation lookups, so a new `kid` is learned once. */
  let lastUnknownRefetchAt: number | undefined;
  let hasAttemptedFetch = false;
  let inflight: Promise<void> | undefined;

  function canFetch(now: number): boolean {
    return lastAttemptAt === undefined || now - lastAttemptAt >= refetchMinMs;
  }

  async function fetchKeys(now: number): Promise<void> {
    if (inflight) return inflight;
    if (!fetchImpl) return;
    lastAttemptAt = now;
    hasAttemptedFetch = true;
    inflight = (async () => {
      try {
        const response = await fetchImpl(jwksUrl, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body.keys)) return;
        const next = new Map<string, CachedKey>();
        for (const candidate of body.keys) {
          const jwk = normalizeJwk(candidate);
          if (jwk !== undefined) {
            next.set(jwk.kid, { jwk, fetchedAt: now });
          }
        }
        keys = next;
      } catch {
        // Keep the previous cache; a missing kid fails closed below.
      }
    })();
    try {
      await inflight;
    } finally {
      inflight = undefined;
    }
  }

  async function getKey(kid: string, now: number): Promise<CryptoKeyLike | undefined> {
    let cached = keys.get(kid);
    const fresh = cached !== undefined && now - cached.fetchedAt < cacheMs;
    if (!fresh) {
      if (cached === undefined) {
        // Initial load is free; later unknown kids may trigger at most one
        // refetch per throttle window (key rotation without hammering JWKS).
        if (hasAttemptedFetch) {
          if (lastUnknownRefetchAt !== undefined && now - lastUnknownRefetchAt < refetchMinMs) {
            return undefined;
          }
          lastUnknownRefetchAt = now;
        }
      } else if (!canFetch(now)) {
        return undefined;
      }
      await fetchKeys(now);
      cached = keys.get(kid);
    }
    if (cached === undefined || now - cached.fetchedAt >= cacheMs) return undefined;
    if (cached.key === undefined) {
      try {
        cached.key = await globalThis.crypto.subtle.importKey(
          'jwk',
          cached.jwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        );
      } catch {
        return undefined;
      }
    }
    return cached.key;
  }

  async function verifySignature(
    headerSegment: string,
    payloadSegment: string,
    signatureSegment: string,
    kid: string,
    now: number,
  ): Promise<boolean> {
    const key = await getKey(kid, now);
    if (key === undefined) return false;
    try {
      const signature = base64UrlToBytes(signatureSegment);
      const data = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
      return await globalThis.crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        key,
        signature,
        data,
      );
    } catch {
      return false;
    }
  }

  function validateClaims(claims: Record<string, unknown>, nowSeconds: number): VerifiedIdToken | undefined {
    if (claims.iss !== issuer) return undefined;
    if (claims.aud !== options.clientId) return undefined;
    if (claims.token_use !== 'id') return undefined;
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return undefined;
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds) {
      return undefined;
    }
    if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) return undefined;
    if (claims.iat > nowSeconds + clockSkewSeconds) return undefined;
    if (claims.nbf !== undefined) {
      if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf)) return undefined;
      if (claims.nbf > nowSeconds + clockSkewSeconds) return undefined;
    }

    const verified: VerifiedIdToken = {
      issuer: claims.iss,
      subject: claims.sub,
      claims,
    };
    if (typeof claims.email === 'string' && claims.email.length > 0) {
      verified.email = claims.email;
    }
    return verified;
  }

  async function verifyIdToken(authorization: string | null): Promise<VerifiedIdToken | undefined> {
    try {
      const token = bearerToken(authorization);
      if (token === undefined) return undefined;
      if (tokenByteLength(token) > maxTokenBytes) return undefined;

      const segments = token.split('.');
      if (segments.length !== 3) return undefined;
      const [headerSegment, payloadSegment, signatureSegment] = segments;
      if (!headerSegment || !payloadSegment || !signatureSegment) return undefined;

      const header = decodeJsonSegment(headerSegment);
      if (!isRecord(header)) return undefined;
      if (header.alg !== 'RS256') return undefined;
      if (typeof header.kid !== 'string' || header.kid.length === 0) return undefined;
      if (header.crit !== undefined) return undefined;
      if (header.typ !== undefined && header.typ !== 'JWT') return undefined;

      const payload = decodeJsonSegment(payloadSegment);
      if (!isRecord(payload)) return undefined;

      const now = clock();
      const verified = validateClaims(payload, Math.floor(now / 1000));
      if (verified === undefined) return undefined;

      const valid = await verifySignature(
        headerSegment,
        payloadSegment,
        signatureSegment,
        header.kid,
        now,
      );
      return valid ? verified : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    verifyIdToken,
    async verify(authorization: string | null): Promise<{ userId: string } | undefined> {
      const verified = await verifyIdToken(authorization);
      if (verified === undefined || resolveUserId === undefined) return undefined;
      try {
        const userId = await resolveUserId(verified);
        return userId.length > 0 ? { userId } : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
