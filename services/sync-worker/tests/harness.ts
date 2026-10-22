/**
 * Shared test harness. Not a test file (does not match `*.node.test.ts`).
 *
 * Builds a handler with injected in-memory stores / dev verifier so no network,
 * binding or cloud account is involved. Device fixtures use WebCrypto in the
 * same way the browser client does (P-256 ECDSA), so signature enforcement is
 * exercised end to end.
 *
 * The canonical-bytes helpers below are an **independent copy** of the frozen
 * client contract (`apps/web/src/sync/types.ts`) — deliberately not importing
 * the server's `src/canonical.ts`, so a drift between the two shows up as a
 * failing signature. `tests/envelope.node.test.ts` pins both copies to the
 * fixed test vectors.
 */

import type { webcrypto } from 'node:crypto';
import { createHandler, type HandlerDeps, type Handler } from '../src/index.ts';
import { InMemorySyncStore } from '../src/store.ts';
import { InMemoryIdentityStore, type PublicDeviceJwk } from '../src/identity.ts';
import { InMemorySessionStore } from '../src/session.ts';
import { DevVerifier, DEV_BEARER_TOKEN } from '../src/auth.ts';
import type { SyncRecordEnvelope } from '../src/protocol.ts';

export interface Harness {
  handler: Handler;
  store: InMemorySyncStore;
  identities: InMemoryIdentityStore;
  sessions: InMemorySessionStore;
  deps: HandlerDeps;
}

export interface HarnessOptions extends Partial<HandlerDeps> {
  clock?: () => number;
}

export function makeHarness(overrides: HarnessOptions = {}): Harness {
  const store = (overrides.store as InMemorySyncStore | undefined) ?? new InMemorySyncStore();
  const identities =
    (overrides.identities as InMemoryIdentityStore | undefined) ?? new InMemoryIdentityStore();
  const sessions = (overrides.sessions as InMemorySessionStore | undefined) ?? new InMemorySessionStore();
  const deps: HandlerDeps = {
    store,
    verifier: new DevVerifier({ allow: true }),
    identities,
    sessions,
    auth: 'dev',
    storage: 'memory',
    configured: true,
    maxBatch: 100,
    maxPushBytes: 100_000,
    allowedOrigins: ['https://app.example'],
    ...overrides,
  };
  return { handler: createHandler(deps), store, identities, sessions, deps };
}

let counter = 0;

export function makeEnvelope(overrides: Partial<SyncRecordEnvelope> = {}): SyncRecordEnvelope {
  counter += 1;
  const base: SyncRecordEnvelope = {
    v: 2,
    type: 'attempt',
    recordId: `attempt-${counter}`,
    dedupeKey: `key-${counter}`,
    deviceId: 'device-1',
    payload: { note: `payload-${counter}` },
    sig: 'c2lnbmF0dXJl',
    updatedAt: 1_700_000_000_000,
    rev: 1,
  };
  return { ...base, ...overrides };
}

export const APP_ORIGIN = 'https://app.example';
export const AUTH_HEADER: Record<string, string> = { Authorization: `Bearer ${DEV_BEARER_TOKEN}` };

export function syncRequest(
  body: unknown,
  headers: Record<string, string> = AUTH_HEADER,
): Request {
  return new Request('https://sync.example/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export function request(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const init: RequestInit = { method, headers: options.headers ?? {} };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return new Request(`https://sync.example${path}`, init);
}

/** Cookie-based request headers for a browser-style call. */
export function sessionHeaders(
  sessionId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Cookie: `chessengram_session=${sessionId}`,
    Origin: APP_ORIGIN,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** Read the session id out of a `Set-Cookie` response header. */
export function sessionIdFrom(response: Response): string | undefined {
  const header = response.headers.get('Set-Cookie');
  if (header === null) return undefined;
  const match = /(?:^|;\s*)chessengram_session=([^;]*)/.exec(header);
  return match?.[1] && match[1].length > 0 ? match[1] : undefined;
}

export interface DeviceFixture {
  deviceId: string;
  publicKeyJwk: PublicDeviceJwk;
  privateKey: webcrypto.CryptoKey;
}

/** Generate the same P-256 keypair shape ONL-002's signing module uses. */
export async function createDeviceFixture(deviceId = 'device-1'): Promise<DeviceFixture> {
  const pair = (await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as { privateKey: webcrypto.CryptoKey; publicKey: webcrypto.CryptoKey };
  const exported = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
  if (typeof exported.x !== 'string' || typeof exported.y !== 'string') {
    throw new Error('generated public key is missing EC coordinates');
  }
  return {
    deviceId,
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y },
    privateKey: pair.privateKey,
  };
}

/** Stable JSON — independent copy of the frozen client helper (v2). */
export function stableJsonForTest(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((v) => stableJsonForTest(v)).join(',') + ']';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return (
    '{' +
    keys.map((key) => JSON.stringify(key) + ':' + stableJsonForTest(record[key])).join(',') +
    '}'
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += (bytes[i] as number).toString(16).padStart(2, '0');
  return hex;
}

/** hex(sha256(utf8(stableJson(payload)))) — independent copy. */
export async function payloadHashForTest(payload: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stableJsonForTest(payload)),
  );
  return bytesToHex(new Uint8Array(digest));
}

/** Canonical bytes — independent copy of the frozen contract used by tests. */
export async function canonicalBytesForTest(envelope: SyncRecordEnvelope): Promise<string> {
  const payloadHash = await payloadHashForTest(envelope.payload);
  return JSON.stringify([
    envelope.v,
    envelope.type,
    envelope.recordId,
    envelope.dedupeKey,
    envelope.deviceId,
    envelope.updatedAt,
    envelope.rev,
    payloadHash,
  ]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

/** Sign an envelope with a fixture's private key (standard base64 output). */
export async function signEnvelope(
  envelope: SyncRecordEnvelope,
  fixture: DeviceFixture,
): Promise<SyncRecordEnvelope> {
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    fixture.privateKey,
    new TextEncoder().encode(await canonicalBytesForTest(envelope)),
  );
  return { ...envelope, sig: bytesToBase64(new Uint8Array(signature)) };
}

/** Register a fixture's public key for `userId` through the same store seams. */
export async function registerDevice(
  harness: Pick<Harness, 'store' | 'identities'>,
  userId: string,
  fixture: DeviceFixture,
  name?: string,
): Promise<void> {
  await harness.store.addDevice(userId, fixture.deviceId, name);
  await harness.identities.setDevicePublicKey(userId, fixture.deviceId, fixture.publicKeyJwk);
}

/** Envelope signed by `fixture` with optional overrides. */
export async function signedEnvelope(
  fixture: DeviceFixture,
  overrides: Partial<SyncRecordEnvelope> = {},
): Promise<SyncRecordEnvelope> {
  return signEnvelope(makeEnvelope({ deviceId: fixture.deviceId, ...overrides }), fixture);
}
