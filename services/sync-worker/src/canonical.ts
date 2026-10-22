/**
 * Canonical envelope bytes — the exact, byte-for-byte mirror of
 * `apps/web/src/sync/types.ts#canonicalEnvelopeBytes` (the client signs the
 * same string; see also the comment in `src/index.ts`).
 *
 * v2 definition (no key material, plaintext payload):
 *
 *   stableJson(value)  — JSON with object keys sorted lexicographically at
 *                        every level, `undefined` members omitted, arrays in
 *                        order.
 *   payloadHash        — hex(sha256(utf8(stableJson(envelope.payload))))
 *   canonical          — JSON.stringify([v, type, recordId, dedupeKey,
 *                        deviceId, updatedAt, rev, payloadHash])
 *   sig                — P-256 ECDSA (raw r‖s) over utf8(canonical).
 *
 * `sig` and `seq` are deliberately excluded, so a server-assigned `seq` never
 * invalidates a client signature; the per-device `rev` *is* included because
 * the client signs it. Do not reorder or add fields without changing both
 * sides in the same coordinated task.
 *
 * This module deliberately does not import Node's crypto module: hashing goes
 * through WebCrypto (`globalThis.crypto`), available in Workers and Node ≥ 20.
 */

import type { SyncRecordEnvelope } from './protocol.ts';

/** Stable, deterministic JSON serialization (see the module doc comment). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((v) => stableJson(v)).join(',') + ']';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableJson(record[key])).join(',') + '}';
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return hex;
}

/** Lowercase-hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** hex(sha256(utf8(stableJson(payload)))) — the hash bound by the signature. */
export async function payloadHashHex(payload: unknown): Promise<string> {
  return sha256Hex(stableJson(payload));
}

/**
 * The exact string a device signs. Async because the payload hash is a
 * WebCrypto digest.
 */
export async function canonicalEnvelopeBytes(
  envelope: Omit<SyncRecordEnvelope, 'sig' | 'seq'>,
): Promise<string> {
  const payloadHash = await payloadHashHex(envelope.payload);
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
