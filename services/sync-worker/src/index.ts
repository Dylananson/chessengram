/**
 * ChessEngram sync worker — plaintext envelope store.
 *
 * The server never held anything but the envelope: it stores the payload object
 * as stable-normalized JSON, dedupes by `dedupeKey`, orders by a monotonic
 * `seq`, and enforces that pushes come from a registered device of the
 * authenticated user **and** that every envelope is signed by that device's
 * registered key. The per-device P-256 ECDSA `sig` over the canonical envelope
 * bytes is the only integrity mechanism: there is no server-held master key and
 * no encryption (see the README for the residual trade-off). Everything
 * account-specific comes from the environment (see `config.ts`) — with no
 * environment set the worker reports `configured: false` and refuses
 * authenticated routes.
 *
 * Authentication accepts either the opaque BFF session cookie (browser) or an
 * `Authorization: Bearer` token (dev/tests). Cookie-authenticated mutations
 * additionally require `Content-Type: application/json` and an allow-listed
 * `Origin` (a simple, testable CSRF defence).
 *
 * Exports `createHandler(deps)` so tests inject store/verifier without any
 * network or Cloudflare account, plus the Workers `fetch` default export.
 */

import {
  DEFAULT_CONTENT_MANIFEST_MAX_AGE,
  DEFAULT_SESSION_TTL_SECONDS,
  loadConfig,
  type LoadConfigResult,
} from './config.ts';
import { DevVerifier, type TokenVerifier } from './auth.ts';
import { createCognitoVerifier } from './cognito.ts';
import { canonicalEnvelopeBytes } from './canonical.ts';
import {
  applyContentBaseUrl,
  contentSourceFromEnv,
  type ContentSource,
} from './content.ts';
import {
  D1IdentityStore,
  InMemoryIdentityStore,
  resolveCanonicalUserId,
  type IdentityStore,
  type PublicDeviceJwk,
} from './identity.ts';
import {
  D1SessionStore,
  InMemorySessionStore,
  clearSessionCookie,
  createSession,
  hashSessionId,
  readSessionCookie,
  type SessionStore,
} from './session.ts';
import {
  D1SyncStore,
  InMemorySyncStore,
  envelopeRev,
  type D1Like,
  type SyncStore,
} from './store.ts';
import {
  SYNC_ENVELOPE_VERSION,
  SYNC_ENTITY_TYPES,
  type SyncPushResponse,
  type SyncRecordEnvelope,
} from './protocol.ts';

export interface HandlerDeps {
  store: SyncStore;
  /** `undefined` ⇒ nothing can authenticate ⇒ authenticated routes answer 401. */
  verifier?: TokenVerifier;
  /** Canonical identity + device public-key store. */
  identities?: IdentityStore;
  /** Opaque BFF session store. */
  sessions?: SessionStore;
  auth: 'cognito' | 'dev' | 'unconfigured';
  storage: 'd1' | 'memory';
  configured: boolean;
  maxBatch: number;
  maxPushBytes: number;
  allowedOrigins: readonly string[];
  /** BFF session lifetime; defaults to 30 days. */
  sessionTtlSeconds?: number;
  /**
   * Public content manifest source. Absent ⇒ `/content/manifest` fails closed
   * with `503 content_not_configured` and `/health` reports content
   * `unconfigured`. The worker never serves pack bytes.
   */
  content?: ContentSource;
  /** CDN base for pack urls the manifest does not embed. */
  contentBaseUrl?: string;
  /** `Cache-Control: max-age` for `/content/manifest`; defaults to 300. */
  contentManifestMaxAge?: number;
  /** Injectable clock (tests). */
  clock?: () => number;
}

export type Handler = (request: Request) => Promise<Response>;

const ENTITY_TYPES = new Set<string>(SYNC_ENTITY_TYPES);
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSyncRecordEnvelope(value: unknown): value is SyncRecordEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope.v === SYNC_ENVELOPE_VERSION &&
    typeof envelope.type === 'string' &&
    ENTITY_TYPES.has(envelope.type) &&
    typeof envelope.recordId === 'string' &&
    envelope.recordId.length > 0 &&
    typeof envelope.dedupeKey === 'string' &&
    envelope.dedupeKey.length > 0 &&
    typeof envelope.deviceId === 'string' &&
    envelope.deviceId.length > 0 &&
    // v2 carries the payload object in plaintext (never an encrypted string).
    typeof envelope.payload === 'object' &&
    envelope.payload !== null &&
    typeof envelope.sig === 'string' &&
    envelope.sig.length > 0 &&
    typeof envelope.updatedAt === 'number' &&
    Number.isFinite(envelope.updatedAt) &&
    // `rev` is optional for older clients; when present it must be a number.
    (envelope.rev === undefined ||
      (typeof envelope.rev === 'number' && Number.isFinite(envelope.rev)))
  );
}

/** Strict standard base64 (padded or unpadded) → bytes. */
function base64ToBytes(input: string): Uint8Array<ArrayBuffer> {
  if (typeof input !== 'string') throw new Error('base64 value must be a string');
  const clean = input.replace(/\s/g, '');
  if (clean.length === 0) throw new Error('empty base64 value');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('invalid base64 characters');
  if (clean.length % 4 === 1) throw new Error('invalid base64 length');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type DeviceCryptoKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

async function importDeviceKey(jwk: PublicDeviceJwk): Promise<DeviceCryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

async function verifyEnvelopeSignature(
  key: DeviceCryptoKey,
  envelope: SyncRecordEnvelope,
): Promise<boolean> {
  try {
    const signature = base64ToBytes(envelope.sig);
    const data = new TextEncoder().encode(await canonicalEnvelopeBytes(envelope));
    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      data,
    );
  } catch {
    return false;
  }
}

/** Accept only a public P-256 ECDSA JWK (never private material). */
function normalizeDeviceJwk(value: unknown): PublicDeviceJwk | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kty !== 'EC' || value.crv !== 'P-256') return undefined;
  if (typeof value.x !== 'string' || value.x.length === 0) return undefined;
  if (typeof value.y !== 'string' || value.y.length === 0) return undefined;
  if (value.d !== undefined) return undefined;
  if (value.key_ops !== undefined) {
    if (!Array.isArray(value.key_ops) || !value.key_ops.includes('verify')) return undefined;
  }
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
}

/** RFC 7638 JWK thumbprint (base64url SHA-256) — safe to expose. */
async function jwkThumbprint(jwk: PublicDeviceJwk): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

interface AuthContext {
  userId: string;
  via: 'bearer' | 'session';
  expiresAt?: number;
  sessionHash?: string;
}

export function createHandler(deps: HandlerDeps): Handler {
  const allowedOrigins = deps.allowedOrigins;
  const identities = deps.identities ?? new InMemoryIdentityStore();
  const sessions = deps.sessions ?? new InMemorySessionStore();
  const sessionTtlSeconds = deps.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const contentManifestMaxAge = deps.contentManifestMaxAge ?? DEFAULT_CONTENT_MANIFEST_MAX_AGE;
  const clock = deps.clock ?? Date.now;

  return async function handler(request: Request): Promise<Response> {
    const origin = request.headers.get('Origin');
    const originAllowed = origin === null || allowedOrigins.includes('*') || allowedOrigins.includes(origin);

    // CORS: fail closed for an explicit, non-allow-listed Origin.
    if (!originAllowed) {
      return json({ error: 'origin_not_allowed', message: 'origin is not in ALLOWED_ORIGINS' }, 403);
    }
    const cors: Record<string, string> =
      origin === null
        ? {}
        : {
            'Access-Control-Allow-Origin': origin,
            // Needed for the BFF session cookie on a same-site, cross-origin API.
            'Access-Control-Allow-Credentials': 'true',
            Vary: 'Origin',
          };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
        },
      });
    }

    const path = new URL(request.url).pathname;
    const is = (candidate: string): boolean => path === candidate || path === `${candidate}/`;

    function notConfigured(): Response {
      return json(
        { error: 'unauthenticated', message: 'authentication is not configured on this server' },
        401,
        cors,
      );
    }

    async function authenticateBearer(): Promise<AuthContext | Response> {
      if (!deps.verifier) return notConfigured();
      const result = await deps.verifier.verify(request.headers.get('Authorization'));
      if (!result) {
        return json({ error: 'unauthenticated', message: 'missing or invalid bearer token' }, 401, cors);
      }
      return { userId: result.userId, via: 'bearer' };
    }

    async function authenticateSession(): Promise<AuthContext | undefined> {
      const sessionId = readSessionCookie(request.headers.get('Cookie'));
      if (sessionId === undefined) return undefined;
      const sessionHash = await hashSessionId(sessionId);
      const record = await sessions.get(sessionHash);
      if (!record) return undefined;
      if (record.expiresAt <= clock()) {
        await sessions.delete(sessionHash);
        return undefined;
      }
      return { userId: record.userId, via: 'session', expiresAt: record.expiresAt, sessionHash };
    }

    /** Session cookie first; Bearer remains the dev/test fallback. */
    async function authenticate(): Promise<AuthContext | Response> {
      const session = await authenticateSession();
      if (session) return session;
      if (!deps.verifier) return notConfigured();
      return authenticateBearer();
    }

    /**
     * Cookie-authenticated mutations must be JSON and come from an
     * allow-listed Origin. Bearer requests are not cookie-authenticated and
     * therefore do not need this (they cannot be forged by a browser).
     */
    function csrfFailure(auth: AuthContext): Response | undefined {
      if (auth.via !== 'session') return undefined;
      const method = request.method.toUpperCase();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return undefined;
      const contentType = (request.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
      const requestOrigin = request.headers.get('Origin');
      const requestOriginAllowed =
        requestOrigin !== null &&
        (allowedOrigins.includes('*') || allowedOrigins.includes(requestOrigin));
      if (contentType !== 'application/json' || !requestOriginAllowed) {
        return json(
          {
            error: 'csrf_protection',
            message:
              'cookie-authenticated requests require Content-Type: application/json and an allowed Origin',
          },
          403,
          cors,
        );
      }
      return undefined;
    }

    function methodNotAllowed(allow: string): Response {
      return new Response(null, { status: 405, headers: { Allow: allow, ...cors } });
    }

    async function readJsonObject(): Promise<Record<string, unknown> | Response> {
      const raw = await request.text();
      const bytes = new TextEncoder().encode(raw).byteLength;
      if (bytes > deps.maxPushBytes) {
        return json(
          { error: 'payload_too_large', message: `request body exceeds MAX_PUSH_BYTES (${deps.maxPushBytes})` },
          413,
          cors,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return json({ error: 'invalid_json', message: 'request body is not valid JSON' }, 400, cors);
      }
      if (!isRecord(parsed)) {
        return json({ error: 'invalid_body', message: 'request body must be a JSON object' }, 400, cors);
      }
      return parsed;
    }

    if (is('/health')) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      return json(
        {
          ok: true,
          configured: deps.configured,
          auth: deps.auth,
          storage: deps.storage,
          content: deps.content ? 'configured' : 'unconfigured',
        },
        200,
        cors,
      );
    }

    // Public: the cacheable pack manifest needs no account and keeps working
    // while signed out. Pack bytes are never proxied here.
    if (is('/content/manifest')) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      if (!deps.content) {
        return json(
          {
            error: 'content_not_configured',
            message: 'content distribution is not configured: no content source is available',
          },
          503,
          cors,
        );
      }
      let manifest: unknown;
      try {
        manifest = applyContentBaseUrl(await deps.content.loadManifest(), deps.contentBaseUrl);
      } catch {
        return json(
          { error: 'content_unavailable', message: 'the content manifest could not be loaded' },
          503,
          cors,
        );
      }
      return json(manifest, 200, {
        ...cors,
        'Cache-Control': `public, max-age=${contentManifestMaxAge}`,
      });
    }

    if (is('/auth/session')) {
      if (request.method === 'POST') {
        // Session exchange always requires the provider Bearer token.
        const auth = await authenticateBearer();
        if (auth instanceof Response) return auth;
        const session = await createSession(sessions, {
          userId: auth.userId,
          ttlSeconds: sessionTtlSeconds,
          now: clock(),
        });
        return json(
          { userId: auth.userId, expiresAt: session.expiresAt },
          200,
          { ...cors, 'Set-Cookie': session.cookie, 'Cache-Control': 'no-store' },
        );
      }
      if (request.method === 'GET') {
        const auth = await authenticateSession();
        if (!auth) {
          return json({ error: 'unauthenticated', message: 'missing or invalid session' }, 401, cors);
        }
        return json({ userId: auth.userId, expiresAt: auth.expiresAt }, 200, {
          ...cors,
          'Cache-Control': 'no-store',
        });
      }
      return methodNotAllowed('GET, POST');
    }

    if (is('/auth/signout')) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const sessionId = readSessionCookie(request.headers.get('Cookie'));
      if (sessionId !== undefined) {
        // Signout mutates server state, so apply the same cookie CSRF rules.
        const auth = await authenticateSession();
        if (auth) {
          const csrf = csrfFailure(auth);
          if (csrf) return csrf;
          if (auth.sessionHash !== undefined) await sessions.delete(auth.sessionHash);
        } else {
          // Unknown/expired cookie: clearing it is still safe.
          const csrf = csrfFailure({ userId: '', via: 'session' });
          if (csrf) return csrf;
        }
      }
      return json({ ok: true }, 200, { ...cors, 'Set-Cookie': clearSessionCookie() });
    }

    if (is('/devices')) {
      const auth = await authenticate();
      if (auth instanceof Response) return auth;
      const csrf = csrfFailure(auth);
      if (csrf) return csrf;

      if (request.method === 'GET') {
        const devices = await deps.store.listDevices(auth.userId);
        const listed = [];
        for (const device of devices) {
          const jwk = await identities.getDevicePublicKey(auth.userId, device.deviceId);
          const entry: Record<string, unknown> = {
            deviceId: device.deviceId,
            addedAt: device.addedAt,
            hasPublicKey: jwk !== undefined,
          };
          if (device.name !== undefined) entry.name = device.name;
          if (device.revokedAt !== undefined) entry.revokedAt = device.revokedAt;
          if (jwk !== undefined) entry.thumbprint = await jwkThumbprint(jwk);
          listed.push(entry);
        }
        return json({ devices: listed }, 200, { ...cors, 'Cache-Control': 'no-store' });
      }

      if (request.method === 'POST') {
        const body = await readJsonObject();
        if (body instanceof Response) return body;
        const deviceId = body.deviceId;
        if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
          return json(
            { error: 'invalid_body', message: 'deviceId must be 1-128 safe characters' },
            400,
            cors,
          );
        }
        if (body.name !== undefined && typeof body.name !== 'string') {
          return json({ error: 'invalid_body', message: 'name must be a string' }, 400, cors);
        }
        const jwk = normalizeDeviceJwk(body.publicKeyJwk);
        if (jwk === undefined) {
          return json(
            {
              error: 'invalid_public_key',
              message: 'publicKeyJwk must be a public P-256 ECDSA JWK (no private material)',
            },
            422,
            cors,
          );
        }
        try {
          await importDeviceKey(jwk);
        } catch {
          return json(
            { error: 'invalid_public_key', message: 'publicKeyJwk is not a valid P-256 key' },
            422,
            cors,
          );
        }
        await identities.setDevicePublicKey(auth.userId, deviceId, jwk);
        await deps.store.addDevice(
          auth.userId,
          deviceId,
          typeof body.name === 'string' ? body.name : undefined,
        );
        return json(
          { ok: true, deviceId, thumbprint: await jwkThumbprint(jwk) },
          200,
          { ...cors, 'Cache-Control': 'no-store' },
        );
      }

      return methodNotAllowed('GET, POST');
    }

    if (path.startsWith('/devices/')) {
      if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
      const auth = await authenticate();
      if (auth instanceof Response) return auth;
      const csrf = csrfFailure(auth);
      if (csrf) return csrf;

      const rawDeviceId = path.slice('/devices/'.length);
      let deviceId: string;
      try {
        deviceId = decodeURIComponent(rawDeviceId);
      } catch {
        return json({ error: 'invalid_device', message: 'deviceId is not valid URL encoding' }, 400, cors);
      }
      if (!DEVICE_ID_PATTERN.test(deviceId)) {
        return json({ error: 'invalid_device', message: 'invalid deviceId' }, 400, cors);
      }
      await deps.store.revokeDevice(auth.userId, deviceId);
      await identities.deleteDevicePublicKey(auth.userId, deviceId);
      return json({ ok: true, deviceId }, 200, cors);
    }

    if (is('/sync')) {
      if (request.method !== 'POST') return methodNotAllowed('POST');

      const auth = await authenticate();
      if (auth instanceof Response) return auth;
      const csrf = csrfFailure(auth);
      if (csrf) return csrf;
      const userId = auth.userId;

      const raw = await request.text();
      const bytes = new TextEncoder().encode(raw).byteLength;
      if (bytes > deps.maxPushBytes) {
        return json(
          { error: 'payload_too_large', message: `request body exceeds MAX_PUSH_BYTES (${deps.maxPushBytes})` },
          413,
          cors,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return json({ error: 'invalid_json', message: 'request body is not valid JSON' }, 400, cors);
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return json({ error: 'invalid_body', message: 'request body must be a JSON object' }, 400, cors);
      }
      const { since, push } = parsed as { since?: unknown; push?: unknown };
      if (typeof since !== 'number' || !Number.isFinite(since) || since < 0) {
        return json({ error: 'invalid_body', message: 'since must be a non-negative number' }, 400, cors);
      }
      if (!Array.isArray(push)) {
        return json({ error: 'invalid_body', message: 'push must be an array' }, 400, cors);
      }
      if (push.length > deps.maxBatch) {
        return json(
          { error: 'batch_too_large', message: `push exceeds MAX_BATCH (${deps.maxBatch})` },
          413,
          cors,
        );
      }

      const envelopes: SyncRecordEnvelope[] = [];
      for (let index = 0; index < push.length; index += 1) {
        const candidate = push[index];
        if (!isSyncRecordEnvelope(candidate)) {
          return json(
            { error: 'invalid_envelope', message: `push[${index}] is not a valid sync envelope` },
            422,
            cors,
          );
        }
        // Normalize a missing `rev` to `0` once, so the signed canonical bytes,
        // the conflict comparison and the stored row all agree.
        envelopes.push({ ...candidate, rev: envelopeRev(candidate) });
      }

      const devices = await deps.store.listDevices(userId);
      const registered = new Set(devices.filter((device) => device.revokedAt === undefined).map((d) => d.deviceId));
      for (const envelope of envelopes) {
        if (!registered.has(envelope.deviceId)) {
          return json(
            { error: 'unregistered_device', message: `device ${envelope.deviceId} is not registered for this user` },
            422,
            cors,
          );
        }
      }

      // Verify every signature before storing anything: a tampered batch is
      // rejected as a whole (nothing partially applied).
      const keys = new Map<string, DeviceCryptoKey | undefined>();
      for (const envelope of envelopes) {
        if (keys.has(envelope.deviceId)) continue;
        const jwk = await identities.getDevicePublicKey(userId, envelope.deviceId);
        if (jwk === undefined) {
          return json(
            {
              error: 'unregistered_device',
              message: `device ${envelope.deviceId} has no registered public key`,
            },
            422,
            cors,
          );
        }
        try {
          keys.set(envelope.deviceId, await importDeviceKey(jwk));
        } catch {
          return json(
            {
              error: 'unregistered_device',
              message: `device ${envelope.deviceId} has an unusable public key`,
            },
            422,
            cors,
          );
        }
      }
      for (let index = 0; index < envelopes.length; index += 1) {
        const envelope = envelopes[index] as SyncRecordEnvelope;
        const key = keys.get(envelope.deviceId);
        if (key === undefined || !(await verifyEnvelopeSignature(key, envelope))) {
          return json(
            {
              error: 'invalid_signature',
              message: `push[${index}] signature does not verify for device ${envelope.deviceId}`,
            },
            422,
            cors,
          );
        }
      }

      const accepted: string[] = [];
      const duplicates: string[] = [];
      for (const envelope of envelopes) {
        // `putEnvelope` ignores any client-supplied `seq` and resolves the
        // conflict by type: immutable records stay first-write-wins, mutable
        // ones (setting/collection/userPuzzle) are last-write-wins by
        // `updatedAt`. A replacement counts as accepted so the client acks it.
        const result = await deps.store.putEnvelope(userId, envelope);
        if (result.status === 'accepted') accepted.push(envelope.dedupeKey);
        else duplicates.push(envelope.dedupeKey);
      }

      const changes = await deps.store.listChanges(userId, since, deps.maxBatch);
      const cursor = changes.at(-1)?.seq ?? since;
      const response: SyncPushResponse = { cursor, accepted, duplicates, changes };
      return json(response, 200, cors);
    }

    if (is('/sync/account')) {
      if (request.method !== 'DELETE') return methodNotAllowed('DELETE');

      const auth = await authenticate();
      if (auth instanceof Response) return auth;
      const csrf = csrfFailure(auth);
      if (csrf) return csrf;
      await deps.store.deleteUser(auth.userId);
      await identities.deleteDevicePublicKeysForUser(auth.userId);
      return json({ ok: true }, 200, cors);
    }

    return json({ error: 'not_found', message: `no route for ${request.method} ${path}` }, 404, cors);
  };
}

/** Workers environment: string vars plus object bindings. */
export interface Env {
  [key: string]: unknown;
}

let sharedMemoryStore: InMemorySyncStore | undefined;
let sharedMemoryIdentities: InMemoryIdentityStore | undefined;
let sharedMemorySessions: InMemorySessionStore | undefined;
const d1Stores = new WeakMap<object, D1SyncStore>();
const d1IdentityStores = new WeakMap<object, D1IdentityStore>();
const d1SessionStores = new WeakMap<object, D1SessionStore>();

function storeFor(config: LoadConfigResult): { store: SyncStore; storage: 'd1' | 'memory' } {
  const db = config.db as D1Like | undefined;
  if (db) {
    let store = d1Stores.get(db as unknown as object);
    if (!store) {
      store = new D1SyncStore(db);
      d1Stores.set(db as unknown as object, store);
    }
    return { store, storage: 'd1' };
  }
  // No binding: an isolate-wide in-memory store keeps local dev usable and is
  // surfaced as `storage: 'memory'` in /health.
  sharedMemoryStore ??= new InMemorySyncStore();
  return { store: sharedMemoryStore, storage: 'memory' };
}

function authStoresFor(config: LoadConfigResult): {
  identities: IdentityStore;
  sessions: SessionStore;
} {
  const db = config.db as D1Like | undefined;
  if (db) {
    let identities = d1IdentityStores.get(db as unknown as object);
    if (!identities) {
      identities = new D1IdentityStore(db);
      d1IdentityStores.set(db as unknown as object, identities);
    }
    let sessions = d1SessionStores.get(db as unknown as object);
    if (!sessions) {
      sessions = new D1SessionStore(db);
      d1SessionStores.set(db as unknown as object, sessions);
    }
    return { identities, sessions };
  }
  sharedMemoryIdentities ??= new InMemoryIdentityStore();
  sharedMemorySessions ??= new InMemorySessionStore();
  return { identities: sharedMemoryIdentities, sessions: sharedMemorySessions };
}

/**
 * One Cognito verifier per (identity store, config) so the JWKS cache survives
 * across requests in an isolate. A new verifier per request would refetch the
 * key set on every call.
 */
const cognitoVerifiers = new WeakMap<IdentityStore, Map<string, TokenVerifier>>();

function selectVerifier(config: LoadConfigResult, identities: IdentityStore): TokenVerifier | undefined {
  if (config.auth === 'dev') return new DevVerifier({ allow: true });
  if (config.auth === 'cognito' && config.cognito) {
    const cognito = config.cognito;
    const cacheKey = JSON.stringify([
      cognito.region,
      cognito.userPoolId,
      cognito.clientId,
      cognito.jwksUrl ?? '',
      config.jwksCacheSeconds,
      config.maxIdTokenBytes,
    ]);
    let perStore = cognitoVerifiers.get(identities);
    if (!perStore) {
      perStore = new Map<string, TokenVerifier>();
      cognitoVerifiers.set(identities, perStore);
    }
    const existing = perStore.get(cacheKey);
    if (existing) return existing;
    const verifier = createCognitoVerifier({
      ...cognito,
      cacheSeconds: config.jwksCacheSeconds,
      maxTokenBytes: config.maxIdTokenBytes,
      resolveUserId: (claims) =>
        resolveCanonicalUserId(identities, {
          issuer: claims.issuer,
          subject: claims.subject,
          ...(claims.email !== undefined ? { email: claims.email } : {}),
        }),
    });
    perStore.set(cacheKey, verifier);
    return verifier;
  }
  return undefined;
}

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    const config = loadConfig(env);
    const { store, storage } = storeFor(config);
    const { identities, sessions } = authStoresFor(config);
    return createHandler({
      store,
      verifier: selectVerifier(config, identities),
      identities,
      sessions,
      auth: config.auth,
      storage,
      configured: config.configured,
      maxBatch: config.maxBatch,
      maxPushBytes: config.maxPushBytes,
      sessionTtlSeconds: config.sessionTtlSeconds,
      allowedOrigins: config.allowedOrigins,
      content: contentSourceFromEnv(env),
      contentBaseUrl: config.contentBaseUrl,
      contentManifestMaxAge: config.contentManifestMaxAge,
    })(request);
  },
};
