/**
 * ONL-004 sync envelope; **ONL-020 dropped the encryption** (frozen design:
 * `docs/research/online-sync-design.md`).
 *
 * Pure functions: no DOM, no network, no storage, no key material. A record's
 * payload travels as plaintext JSON inside the envelope and integrity comes from
 * the per-device signature over `canonicalEnvelopeBytes` (the device key lives
 * in ONL-002's signing.ts). The server can read payloads — that is the accepted
 * trade-off of the server-trusted model; see the design note.
 */

import {
  SYNC_ENVELOPE_VERSION,
  canonicalEnvelopeBytes,
  dedupeKey,
  dedupeScope,
  type SyncEntityType,
  type SyncRecordEnvelope,
} from './types.ts';

/** Callback the envelope uses to sign `canonicalEnvelopeBytes` (ONL-002 owns the key). */
export type EnvelopeSigner = (canonicalBytes: string) => Promise<string>;

export interface SealRecordInput {
  type: SyncEntityType;
  /** Local stable id (attemptId, collectionId, puzzleId, setId…). */
  recordId: string;
  /** Exact payload; written into the envelope in the clear and signed. */
  payload: unknown;
  deviceId: string;
  /**
   * Exact current time in epoch ms; stored verbatim as the envelope's
   * `updatedAt` (design #8 revised 2026-10-19: no more hour-rounding).
   */
  now: number;
  /**
   * Monotonic per-device revision counter. Total-orders same-device edits that
   * land in the same millisecond; part of the signed canonical bytes.
   */
  rev: number;
  sign: EnvelopeSigner;
}

// --- byte / base64 helpers (no dependencies, no Buffer, no DOM-only APIs) ---

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_DECODE: Record<string, number> = {};
for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
  BASE64_DECODE[BASE64_ALPHABET[i]] = i;
}

/** Standard base64 with padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Strict base64 decode; throws on bad length, characters or trailing bits. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string') throw new Error('base64 value must be a string');
  const clean = text.replace(/\s/g, '');
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 4 !== 0) throw new Error('invalid base64: length is not a multiple of 4');

  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;
  const body = padding > 0 ? clean.slice(0, clean.length - padding) : clean;

  const out = new Uint8Array((body.length * 6) / 8);
  let value = 0;
  let bits = 0;
  let index = 0;
  for (const char of body) {
    const symbol = BASE64_DECODE[char];
    if (symbol === undefined) throw new Error(`invalid base64 character: ${char}`);
    value = (value << 6) | symbol;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (value >>> bits) & 0xff;
      index += 1;
    }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) {
    throw new Error('invalid base64: non-canonical trailing bits');
  }
  return out;
}

// --- dedupe scope ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Per-entity parts hashed into the dedupe key (design table in the sync note):
 * attempts/collections/user puzzles key on their id, settings are a single LWW
 * record, woodpecker sets on `setId ‖ cycleId`, cycle results on
 * `cycleId ‖ puzzleId`. Callers pass the result to `dedupeScope`.
 */
export function dedupeScopePartsFor(
  type: SyncEntityType,
  recordId: string,
  payload: unknown,
): string[] {
  const record = isRecord(payload) ? payload : {};
  switch (type) {
    case 'setting':
      return [];
    case 'woodpecker': {
      const setId = typeof record.setId === 'string' ? record.setId : recordId;
      const cycleId = typeof record.cycleId === 'string' ? record.cycleId : '';
      return [setId, cycleId];
    }
    case 'woodpeckerResult': {
      const cycleId = typeof record.cycleId === 'string' ? record.cycleId : recordId;
      const puzzleId = typeof record.puzzleId === 'string' ? record.puzzleId : '';
      return [cycleId, puzzleId];
    }
    default:
      return [recordId];
  }
}

// --- seal / open ---

const SEALABLE_TYPES: readonly SyncEntityType[] = [
  'attempt',
  'setting',
  'collection',
  'woodpecker',
  'woodpeckerResult',
  'userPuzzle',
];

function assertSealInput(input: SealRecordInput): void {
  if (!SEALABLE_TYPES.includes(input.type)) {
    throw new Error(`unknown sync entity type: ${String(input.type)}`);
  }
  if (input.payload === undefined) throw new Error('payload must be defined');
  if (typeof input.recordId !== 'string' || input.recordId.length === 0) {
    throw new Error('recordId must be a non-empty string');
  }
  if (typeof input.deviceId !== 'string' || input.deviceId.length === 0) {
    throw new Error('deviceId must be a non-empty string');
  }
  if (!Number.isFinite(input.now)) throw new Error('now must be a finite epoch-ms timestamp');
  if (!Number.isInteger(input.rev) || input.rev < 0) {
    throw new Error(`invalid rev: ${String(input.rev)}`);
  }
  if (typeof input.sign !== 'function') throw new Error('sign must be a function');
}

/**
 * Build and sign one record. `updatedAt` is the exact `now` (design #8 revised)
 * and `rev` is the caller's per-device counter; the payload is covered through
 * its stable hash, so all three are tamper-evident. Signing is injected so this
 * module never touches the device's signing key.
 */
export async function sealRecord(input: SealRecordInput): Promise<SyncRecordEnvelope> {
  assertSealInput(input);
  const dedupe = await dedupeKey(
    dedupeScope(input.type, dedupeScopePartsFor(input.type, input.recordId, input.payload)),
  );

  const unsigned: Omit<SyncRecordEnvelope, 'sig' | 'seq'> = {
    v: SYNC_ENVELOPE_VERSION,
    type: input.type,
    recordId: input.recordId,
    dedupeKey: dedupe,
    deviceId: input.deviceId,
    payload: input.payload,
    updatedAt: input.now,
    rev: input.rev,
  };

  const sig = await input.sign(await canonicalEnvelopeBytes(unsigned));
  return { ...unsigned, sig };
}

/**
 * Read one record's payload. Rejects an unknown envelope version, an unknown
 * entity type and a missing/malformed payload — always failing closed rather
 * than handing the caller partial data.
 *
 * Signature verification is deliberately NOT done here: the apply path checks
 * `sig` against the sending device's registered public key before calling this.
 */
export async function openRecord<T = unknown>(envelope: SyncRecordEnvelope): Promise<T> {
  if (!isRecord(envelope)) throw new Error('envelope must be an object');
  if (envelope.v !== SYNC_ENVELOPE_VERSION) {
    throw new Error(`unsupported envelope version: ${String(envelope.v)}`);
  }
  if (!SEALABLE_TYPES.includes(envelope.type)) {
    throw new Error(`unknown sync entity type: ${String(envelope.type)}`);
  }
  // `updatedAt` is the exact epoch-ms change time (no hour-rounding). It is
  // validated as finite only; the server owns ordering.
  if (!Number.isFinite(envelope.updatedAt)) {
    throw new Error('envelope updatedAt must be a finite epoch-ms timestamp');
  }
  if (envelope.payload === null || typeof envelope.payload !== 'object') {
    throw new Error('envelope payload must be an object');
  }
  return envelope.payload as T;
}
