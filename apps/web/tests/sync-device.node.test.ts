/**
 * ONL-002 — device identity and per-device P-256 ECDSA signing (the user salt
 * was removed with the key model in ONL-020).
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  SYNC_ENVELOPE_VERSION,
  type SyncRecordEnvelope,
  type SyncState,
  type SyncStateStorage,
} from '../src/sync/types.ts';
import {
  bytesToHex,
  getOrCreateDeviceId,
  newDeviceId,
  randomHex,
} from '../src/sync/device.ts';
import {
  base64ToBytes,
  bytesToBase64,
  exportDevicePublicKeyJwk,
  generateDeviceKeys,
  importDevicePublicKeyJwk,
  signBytes,
  signEnvelope,
  verifyBytes,
  verifyEnvelopeSignature,
} from '../src/sync/signing.ts';

/** Minimal in-memory `SyncStateStorage` for tests. */
function makeStateStorage(initial?: SyncState): SyncStateStorage & { saved: SyncState[] } {
  let state = initial;
  const saved: SyncState[] = [];
  return {
    saved,
    async load() {
      return state;
    },
    async save(next: SyncState) {
      state = structuredClone(next);
      saved.push(structuredClone(next));
    },
  };
}

/** Deterministic byte source: byte i is `seed + i`. */
function fixedBytes(seed: number) {
  return (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = (seed + i) & 0xff;
    return out;
  };
}

/** A realistic v2 envelope (ONL-020: plaintext payload, no ciphertext fields). */
function makeEnvelope(payload: unknown): SyncRecordEnvelope {
  return {
    v: SYNC_ENVELOPE_VERSION,
    type: 'attempt',
    recordId: 'attempt-1',
    dedupeKey: 'ab'.repeat(32),
    deviceId: 'device-1',
    payload,
    sig: '',
    updatedAt: 1_697_000_000_000,
    rev: 1,
  };
}

test('getOrCreateDeviceId is stable across calls and persists only deviceId', async () => {
  const storage = makeStateStorage({ enabled: true, cursor: 12 });

  const first = await getOrCreateDeviceId(storage, { randomBytes: fixedBytes(0) });
  const second = await getOrCreateDeviceId(storage, { randomBytes: fixedBytes(200) });

  assert.equal(first, second, 'same id returned, not regenerated');
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(storage.saved.length, 1, 'only the first call writes');
  assert.deepEqual(storage.saved[0], {
    enabled: true,
    cursor: 12,
    deviceId: first,
  });
});

test('getOrCreateDeviceId honours an existing id without writing', async () => {
  const storage = makeStateStorage({ enabled: true, deviceId: 'existing-id' });
  assert.equal(await getOrCreateDeviceId(storage), 'existing-id');
  assert.equal(storage.saved.length, 0);
});

test('newDeviceId and randomHex are injectable and correctly sized', () => {
  assert.equal(newDeviceId(fixedBytes(0)), '000102030405060708090a0b0c0d0e0f');
  assert.equal(randomHex(3, fixedBytes(0)), '000102');
  assert.equal(bytesToHex(new Uint8Array([0, 15, 255])), '000fff');
  assert.notEqual(newDeviceId(), newDeviceId(), 'device ids are actually random');
});

test('signBytes/verifyBytes round-trip and reject a changed key', async () => {
  const a = await generateDeviceKeys();
  const b = await generateDeviceKeys();
  const jwkA = await exportDevicePublicKeyJwk(a.publicKey);
  const jwkB = await exportDevicePublicKeyJwk(b.publicKey);

  const payload = new TextEncoder().encode('canonical envelope bytes');
  const sig = await signBytes(payload, a.privateKey);

  assert.equal(await verifyBytes(payload, jwkA, sig), true);
  assert.equal(await verifyBytes(payload, jwkB, sig), false, 'different key must fail');

  // Imported CryptoKey works too.
  const importedA = await importDevicePublicKeyJwk(jwkA);
  assert.equal(await verifyBytes(payload, importedA, sig), true);

  // Tampering with the message fails.
  const tampered = new Uint8Array(payload);
  tampered[0] ^= 0x01;
  assert.equal(await verifyBytes(tampered, jwkA, sig), false);

  // Garbage signature is rejected, not thrown.
  assert.equal(await verifyBytes(payload, jwkA, 'not-base64!!'), false);
});

test('verifyEnvelopeSignature accepts a valid envelope and rejects tampering', async () => {
  const keys = await generateDeviceKeys();
  const jwk = await exportDevicePublicKeyJwk(keys.publicKey);

  const attempt = {
    attemptId: 'attempt-1',
    programId: 'program-1',
    puzzleId: 'puzzle-1',
    startedAt: 1_697_000_000_000,
    timing: { activeSolvingSeconds: 5, correctionSeconds: 1 },
  };
  const envelope = makeEnvelope(attempt);
  envelope.sig = await signEnvelope(envelope, keys.privateKey);
  assert.equal(await verifyEnvelopeSignature(envelope, jwk), true);

  // Mutating the payload is caught (it is covered through its stable hash).
  const tampered = { ...envelope, payload: { ...attempt, puzzleId: 'puzzle-2' } };
  assert.equal(await verifyEnvelopeSignature(tampered, jwk), false);

  // Mutating a routing field is also caught.
  const spoofed = { ...envelope, recordId: 'attempt-2' };
  assert.equal(await verifyEnvelopeSignature(spoofed, jwk), false);

  // A different device key cannot validate the envelope.
  const other = await generateDeviceKeys();
  const otherJwk = await exportDevicePublicKeyJwk(other.publicKey);
  assert.equal(await verifyEnvelopeSignature(envelope, otherJwk), false);
});
