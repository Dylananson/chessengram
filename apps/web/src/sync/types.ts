/**
 * ONL frozen sync contracts (see `docs/research/online-sync-design.md`).
 *
 * These types are the interface between the independent sync components:
 * the local queue (queue.ts), device identity + signing (device.ts/signing.ts),
 * the envelope builder (envelope.ts), the transport and the worker service.
 *
 * RULES: pure types + tiny pure helpers only — no DOM, no network, no storage,
 * no dependencies, so every module and test can import this under Node.
 * Do not change a shape here without the coordinator: other tasks are coded
 * against it.
 */

/** Record kinds that can be synced. */
export type SyncEntityType = 'attempt' | 'setting' | 'collection' | 'woodpecker' | 'woodpeckerResult' | 'userPuzzle';

/**
 * Envelope format version. **v2 (ONL-020):** `payload` is plaintext and signed
 * via {@link payloadHash}; `iv`, `ciphertext` and `keyVersion` were removed with
 * the master key. There is no migration — no v1 envelope was ever stored.
 */
export const SYNC_ENVELOPE_VERSION = 2;

/**
 * What the server stores and serves. **v2 (ONL-020): the payload is plaintext**
 * — the server can read it, by decision. `sig` is the only integrity mechanism
 * (per-device, so a stolen session cannot forge another device's writes).
 */
export interface SyncRecordEnvelope {
  /** Envelope version. */
  v: typeof SYNC_ENVELOPE_VERSION;
  type: SyncEntityType;
  /** Local stable id (attemptId, collectionId, puzzleId, setId…). */
  recordId: string;
  /** hex SHA-256(scope) — the server's uniqueness key (first-write-wins). */
  dedupeKey: string;
  deviceId: string;
  /** Plaintext payload (the `Sync*Payload` shapes below). */
  payload: unknown;
  /** base64 P-256 ECDSA signature over {@link canonicalEnvelopeBytes}. */
  sig: string;
  /**
   * Exact epoch ms of the change (design #8 revised 2026-10-19: the user
   * explicitly traded training-rhythm privacy for precise cross-device
   * ordering, so this is no longer hour-rounded). The server uses it only for
   * ordering / LWW; the payload inside still carries the authoritative timings.
   */
  updatedAt: number;
  /**
   * Monotonic per-device revision counter. Even with exact timestamps two
   * mutations on one device can land in the same millisecond, which would tie
   * on the server and drop the second; `rev` makes same-device ordering total.
   * Ordering is `(updatedAt, rev, deviceId)`. It is signed (see
   * {@link canonicalEnvelopeBytes}) and reveals only a change count.
   */
  rev: number;
  /** Server-assigned monotonic sequence; absent in push payloads. */
  seq?: number;
}

/** Local queue entry: a pointer, never ciphertext (design: lean local storage). */
export interface SyncQueueEntry {
  type: SyncEntityType;
  recordId: string;
  /** Local change time (epoch ms) used to detect a superseded change. */
  changedAt: number;
}

/** Persisted sync state (local only; exported with the 1.3.0 format). */
export interface SyncState {
  enabled: boolean;
  deviceId?: string;
  /** Last acked server cursor. */
  cursor?: number;
  /** Canonical user id issued by the server (never the raw provider `sub`). */
  userId?: string;
  lastSyncedAt?: number;
}

/** The three user-visible states (design: Settings → Sync). */
export type SyncMode = 'local-only' | 'syncing' | 'paused';

export interface SyncPushRequest {
  since: number;
  push: SyncRecordEnvelope[];
}

export interface SyncPushResponse {
  cursor: number;
  accepted: string[];
  duplicates: string[];
  changes: SyncRecordEnvelope[];
}

/** Transport seam. Implemented for real later; faked in tests. */
export interface SyncTransport {
  push(request: SyncPushRequest): Promise<SyncPushResponse>;
  deleteAccount(): Promise<void>;
}

/**
 * Full server API surface the client needs (implemented by ONL-009a
 * `sync/client.ts`, consumed by ONL-009b `sync/bootstrap.ts`). Frozen so both
 * halves can be built in parallel.
 */
export interface SyncApiClient extends SyncTransport {
  getSession(): Promise<{ userId: string; expiresAt: number } | undefined>;
  exchangeSession(idToken: string): Promise<{ userId: string; expiresAt: number }>;
  signOut(): Promise<void>;
  registerDevice(input: { deviceId: string; publicKeyJwk: JsonWebKey }): Promise<{ thumbprint: string }>;
  listDevices(): Promise<Array<{ deviceId: string; addedAt: number; revokedAt?: number; thumbprint?: string }>>;
  revokeDevice(deviceId: string): Promise<void>;
}

/**
 * Persistence seam for the queue (implemented by ONL-001 against `LocalStore`,
 * faked in memory for tests/local dev so the queue logic needs no IndexedDB).
 */
export interface SyncQueueStorage {
  list(): Promise<SyncQueueEntry[]>;
  put(entry: SyncQueueEntry): Promise<void>;
  delete(type: SyncEntityType, recordId: string): Promise<void>;
}

/** Persistence seam for sync state (cursor, salt, device, key version). */
export interface SyncStateStorage {
  load(): Promise<SyncState | undefined>;
  save(state: SyncState): Promise<void>;
}

/**
 * Device-local state that must never leave this device: the P-256 signing
 * keypair (private half) and, historically, a cached master key — the latter is
 * gone with the key model (ONL-020). Never exported, never backed up, never
 * synced; also holds the monotonic `rev` counter under a separate key.
 */
export interface SyncSecrets {
  devicePublicKeyJwk: JsonWebKey;
  /** Private half of the P-256 signing key; stays on this device. */
  devicePrivateKeyJwk: JsonWebKey;
}

/** Persistence seam for per-device secrets (kept out of exports). */
export interface SyncKeyStorage {
  load(): Promise<SyncSecrets | undefined>;
  save(secrets: SyncSecrets): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Decrypted payloads. Exact timestamps and timings live here, not in the
 * plaintext envelope (design decision #8).
 */
export interface SyncAttemptPayload {
  attemptId: string;
  programId: string;
  collectionId?: string;
  puzzleId: string;
  outcome?: 'success' | 'failure';
  startedAt: number;
  completedAt?: number;
  /**
   * Full timing segments: a remote replay must reproduce the same intervals as
   * the originating device. Older payloads may omit the extra fields — readers
   * must default `interruptionSeconds`/`hiddenSeconds` to 0 and
   * `timingTrustworthy` to true.
   */
  timing: {
    activeSolvingSeconds: number;
    correctionSeconds: number;
    interruptionSeconds: number;
    hiddenSeconds: number;
    timingTrustworthy: boolean;
  };
  events?: unknown[];
}

export interface SyncSettingPayload {
  values: Record<string, unknown>;
  updatedAt: number;
  updatedBy: string;
}

export interface SyncCollectionPayload {
  collectionId: string;
  name: string;
  puzzleIds?: string[];
  removedPuzzleIds?: string[];
  deleted?: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface SyncWoodpeckerPayload {
  setId: string;
  cycleId?: string;
  sourceCollectionId: string;
  name?: string;
  puzzleIds?: string[];
  startedAt?: number;
  completedAt?: number;
}

export interface SyncWoodpeckerResultPayload {
  cycleId: string;
  puzzleId: string;
  result: 'clean' | 'failed';
  activeSeconds: number;
}

export interface SyncUserPuzzlePayload {
  puzzleId: string;
  /** Serialized NormalizedPuzzle; content is CC0-free but user-owned. */
  puzzle: Record<string, unknown>;
  updatedAt: number;
  /**
   * Tombstone: the puzzle was deleted on another device. A deleted payload may
   * omit `puzzle`. LWW against the local stamp decides, like any other update.
   */
  deleted?: boolean;
}

/**
 * JSON with object keys sorted lexicographically at every level, `undefined`
 * members omitted and arrays kept in order. Both this app and the service
 * implement it identically so the signed bytes cannot drift; it is covered by
 * fixed test vectors on both sides.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** hex SHA-256 of the stable-normalized payload — what the signature covers. */
export async function payloadHash(payload: unknown): Promise<string> {
  return sha256Hex(stableJson(payload));
}

/**
 * `hex SHA-256(scope)` — the server's per-record uniqueness key
 * (first-write-wins). No salt any more (ONL-020): the payload is plaintext in
 * this model, so salting the hash input protects nothing, and determinism is
 * what lets two devices agree on the same record.
 */
export async function dedupeKey(scopeString: string): Promise<string> {
  if (typeof scopeString !== 'string') throw new Error('scope must be a string');
  return sha256Hex(scopeString);
}

/**
 * The exact bytes a device signs (and the server verifies). The payload itself
 * is covered through {@link payloadHash}, so a payload swapped in transit can
 * never match the signature.
 */
export async function canonicalEnvelopeBytes(
  envelope: Omit<SyncRecordEnvelope, 'sig' | 'seq'>,
): Promise<string> {
  return JSON.stringify([
    envelope.v,
    envelope.type,
    envelope.recordId,
    envelope.dedupeKey,
    envelope.deviceId,
    envelope.updatedAt,
    envelope.rev,
    await payloadHash(envelope.payload),
  ]);
}

/** Dedupe/scope key input; callers hash the result for the server's unique key. */
export function dedupeScope(type: SyncEntityType, parts: readonly string[]): string {
  return [type, ...parts].join('\u0000');
}
