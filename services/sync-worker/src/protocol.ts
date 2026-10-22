/**
 * Mirror of the frozen ONL wire contract.
 *
 * Source of truth: `apps/web/src/sync/types.ts` (frozen — do not edit; see
 * `docs/research/online-sync-design.md`). The service must build independently
 * of the web app and must not import across workspaces, so this minimal copy
 * lives here. Keep it byte-compatible with the frozen file: the server stores
 * these envelopes and only ever reads the routing fields.
 *
 * **v2: plaintext envelopes.** The server-held master key was removed, so the
 * payload is no longer encrypted. `payload` is the payload **object** itself;
 * `iv`, `ciphertext` and `keyVersion` are gone. The per-device P-256 ECDSA
 * `sig` over the canonical envelope bytes is now the only integrity mechanism.
 *
 * If the frozen contract changes, change both files in the same coordinated
 * task — never one alone.
 */

/** Envelope format version. Bump only with a migration story. */
export const SYNC_ENVELOPE_VERSION = 2;

/** Record kinds that can be synced (mirror of the frozen union). */
export type SyncEntityType =
  | 'attempt'
  | 'setting'
  | 'collection'
  | 'woodpecker'
  | 'woodpeckerResult'
  | 'userPuzzle';

/** Runtime allow-list of the entity types above (kept next to the type). */
export const SYNC_ENTITY_TYPES: readonly SyncEntityType[] = [
  'attempt',
  'setting',
  'collection',
  'woodpecker',
  'woodpeckerResult',
  'userPuzzle',
];

/**
 * What the server stores and serves. `payload` is the plaintext payload object;
 * the routing fields exist so the server can dedupe, order and authorize
 * without inspecting it.
 */
export interface SyncRecordEnvelope {
  /** Envelope version. */
  v: typeof SYNC_ENVELOPE_VERSION;
  type: SyncEntityType;
  /** Local stable id (attemptId, collectionId, puzzleId, setId…). */
  recordId: string;
  /**
   * Opaque, client-supplied uniqueness key — still `SHA-256(scope)` hex, but
   * with no salt involved any more (there is no key material to salt with).
   */
  dedupeKey: string;
  deviceId: string;
  /** Plaintext payload object (the same shapes the encrypted wire carried). */
  payload: unknown;
  /** base64 P-256 ECDSA signature over the canonical envelope bytes. */
  sig: string;
  /**
   * Exact epoch ms of the change (design #8 revised 2026-10-19). The server
   * uses it only for ordering / LWW.
   */
  updatedAt: number;
  /**
   * Monotonic per-device revision counter. Optional for tolerance with older
   * clients: a missing / `undefined` value is treated as `0`. Ordering is
   * `(updatedAt, rev, deviceId)`, so same-device edits in the same millisecond
   * still total-order. It is part of the signed canonical bytes.
   */
  rev?: number;
  /** Server-assigned monotonic sequence; absent in push payloads. */
  seq?: number;
}

export interface SyncPushRequest {
  since: number;
  push: SyncRecordEnvelope[];
}

export interface SyncPushResponse {
  cursor: number;
  /**
   * Dedupe keys accepted on this push (newly stored, first write wins).
   * Mirrors the frozen `SyncPushResponse.accepted: string[]` widening: the
   * value is the envelope's `dedupeKey`, which is the server's uniqueness key.
   */
  accepted: string[];
  /** Dedupe keys already present for this user; **never** overwritten. */
  duplicates: string[];
  changes: SyncRecordEnvelope[];
}
