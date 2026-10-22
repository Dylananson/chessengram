/**
 * ONL-004 envelope; ONL-020 removed the encryption. The payload now travels in
 * plaintext inside the envelope and integrity comes from the per-device
 * signature over `canonicalEnvelopeBytes` (the payload is covered through its
 * stable hash, so a payload swapped in transit cannot match a signature).
 *
 * The canonical-bytes vectors below are the drift guard shared with the
 * service: both sides implement `stableJson` + the same field list, and if
 * either changes, a signature made by one side stops verifying on the other.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  SYNC_ENVELOPE_VERSION,
  canonicalEnvelopeBytes,
  dedupeKey,
  payloadHash,
  stableJson,
} from '../src/sync/types.ts';
import {
  base64ToBytes,
  bytesToBase64,
  dedupeScopePartsFor,
  openRecord,
  sealRecord,
} from '../src/sync/envelope.ts';
import { dedupeScope } from '../src/sync/types.ts';
import type {
  SyncAttemptPayload,
  SyncCollectionPayload,
  SyncEntityType,
  SyncRecordEnvelope,
  SyncSettingPayload,
  SyncUserPuzzlePayload,
  SyncWoodpeckerPayload,
  SyncWoodpeckerResultPayload,
} from '../src/sync/types.ts';

const DEVICE_ID = 'device-a';
const NOW = 1_700_000_123_456;
const FAKE_SIGNATURE = 'fake-signature';

async function seal(
  type: SyncEntityType,
  recordId: string,
  payload: unknown,
  overrides: Partial<Parameters<typeof sealRecord>[0]> = {},
): Promise<SyncRecordEnvelope> {
  return sealRecord({
    type,
    recordId,
    payload,
    deviceId: DEVICE_ID,
    now: NOW,
    rev: 1,
    sign: async () => FAKE_SIGNATURE,
    ...overrides,
  });
}

const ATTEMPT: SyncAttemptPayload = {
  attemptId: 'attempt-1',
  programId: 'program-1',
  collectionId: 'collection-1',
  puzzleId: 'puzzle-1',
  outcome: 'success',
  startedAt: NOW,
  completedAt: NOW + 4_321,
  timing: { activeSolvingSeconds: 12, correctionSeconds: 3 },
  events: [{ type: 'move', at: NOW + 1 }],
};

const SETTING: SyncSettingPayload = {
  values: { theme: 'dark', boardTheme: 'brown', sound: true },
  updatedAt: NOW,
  updatedBy: DEVICE_ID,
};

const COLLECTION: SyncCollectionPayload = {
  collectionId: 'collection-1',
  name: 'Endgames',
  puzzleIds: ['puzzle-1', 'puzzle-2'],
  removedPuzzleIds: ['puzzle-3'],
  updatedAt: NOW,
  updatedBy: DEVICE_ID,
};

const WOODPECKER: SyncWoodpeckerPayload = {
  setId: 'set-1',
  cycleId: 'cycle-1',
  sourceCollectionId: 'collection-1',
  name: 'Woodpecker set',
  puzzleIds: ['puzzle-1'],
  startedAt: NOW,
  completedAt: NOW + 60_000,
};

const WOODPECKER_RESULT: SyncWoodpeckerResultPayload = {
  cycleId: 'cycle-1',
  puzzleId: 'puzzle-1',
  result: 'clean',
  activeSeconds: 42,
};

const USER_PUZZLE: SyncUserPuzzlePayload = {
  puzzleId: 'user-puzzle-1',
  puzzle: { id: 'user-puzzle-1', rating: 1234, solution: ['e2e4'] },
  updatedAt: NOW,
};

const CASES: Array<{ type: SyncEntityType; recordId: string; payload: unknown }> = [
  { type: 'attempt', recordId: ATTEMPT.attemptId, payload: ATTEMPT },
  { type: 'setting', recordId: 'preferences', payload: SETTING },
  { type: 'collection', recordId: COLLECTION.collectionId, payload: COLLECTION },
  { type: 'woodpecker', recordId: WOODPECKER.setId, payload: WOODPECKER },
  { type: 'woodpeckerResult', recordId: 'cycle-1:puzzle-1', payload: WOODPECKER_RESULT },
  { type: 'userPuzzle', recordId: USER_PUZZLE.puzzleId, payload: USER_PUZZLE },
];

// --- shape + round trip -----------------------------------------------------

test('seal/open round-trips a plaintext payload for every entity type', async () => {
  for (const { type, recordId, payload } of CASES) {
    const envelope = await seal(type, recordId, payload);
    assert.equal(envelope.v, SYNC_ENVELOPE_VERSION);
    assert.equal(envelope.type, type);
    assert.equal(envelope.deviceId, DEVICE_ID);
    assert.equal(envelope.updatedAt, NOW);
    assert.equal(envelope.rev, 1);
    assert.deepEqual(envelope.payload, payload, `${type}: payload is carried verbatim`);
    assert.deepEqual(await openRecord(envelope), payload, `${type}: round-trips`);
  }
});

test('the envelope carries no key material or ciphertext fields (v2 shape)', async () => {
  const envelope = await seal('attempt', 'attempt-1', ATTEMPT);
  assert.deepEqual(Object.keys(envelope).sort(), [
    'dedupeKey',
    'deviceId',
    'payload',
    'recordId',
    'rev',
    'sig',
    'type',
    'updatedAt',
    'v',
  ]);
  const serialized = JSON.stringify(envelope);
  void serialized;
  for (const gone of ['keyVersion', 'ciphertext', 'iv', 'masterKey', 'userSalt']) {
    assert.equal(
      Object.hasOwn(envelope, gone),
      false,
      `${gone} must not be a field of the envelope`,
    );
  }
});

test('updatedAt is the exact change time and round-trips', async () => {
  const envelope = await seal('attempt', 'attempt-1', ATTEMPT, { now: 1_700_000_123_456 });
  assert.equal(envelope.updatedAt, 1_700_000_123_456);
});

// --- canonical bytes --------------------------------------------------------

test('the injected signer signs exactly the canonical envelope bytes', async () => {
  let seen: string | undefined;
  const envelope = await seal('attempt', 'attempt-1', ATTEMPT, {
    sign: async (canonicalBytes) => {
      seen = canonicalBytes;
      return FAKE_SIGNATURE;
    },
  });
  const { sig, seq, ...unsigned } = envelope;
  void sig;
  void seq;
  assert.equal(seen, await canonicalEnvelopeBytes(unsigned));
});

test('the payload is covered: changing it invalidates the canonical bytes', async () => {
  const envelope = await seal('attempt', 'attempt-1', ATTEMPT);
  const { sig, seq, ...unsigned } = envelope;
  void sig;
  void seq;
  const before = await canonicalEnvelopeBytes(unsigned);
  const after = await canonicalEnvelopeBytes({
    ...unsigned,
    payload: { ...ATTEMPT, outcome: 'failure' },
  });
  assert.notEqual(after, before, 'a swapped payload cannot match the signature');
});

test('rev and updatedAt are part of the canonical bytes', async () => {
  const envelope = await seal('attempt', 'attempt-1', ATTEMPT);
  const { sig, seq, ...unsigned } = envelope;
  void sig;
  void seq;
  const base = await canonicalEnvelopeBytes(unsigned);
  assert.notEqual(await canonicalEnvelopeBytes({ ...unsigned, rev: 2 }), base);
  assert.notEqual(await canonicalEnvelopeBytes({ ...unsigned, updatedAt: NOW + 1 }), base);
});

test('canonical vectors match the service (shared drift guard)', async () => {
  const payload = { b: [2, { d: 3, c: 4 }], a: 1, z: '\u00fc', n: null, skipped: undefined };
  assert.equal(stableJson(payload), '{"a":1,"b":[2,{"c":4,"d":3}],"n":null,"z":"\u00fc"}');
  assert.equal(
    await payloadHash(payload),
    'e565fe6a917ebb6cfddb97411e7e87958995104b77df598963a59cd634fc2e60',
  );
  assert.equal(
    await canonicalEnvelopeBytes({
      v: 2,
      type: 'attempt',
      recordId: 'a1',
      dedupeKey: 'deadbeef',
      deviceId: 'device-a',
      payload,
      updatedAt: 1_700_000_000_000,
      rev: 3,
    }),
    '[2,"attempt","a1","deadbeef","device-a",1700000000000,3,"e565fe6a917ebb6cfddb97411e7e87958995104b77df598963a59cd634fc2e60"]',
  );
  assert.equal(
    await dedupeKey('attempt\u0000a1'),
    '13da841d9dfe5894386184e8d4d3604fc7089010c314ab2d6b8f80dd674f2639',
  );
  // Key order in the source object must not matter.
  assert.equal(
    await payloadHash({ a: 1, b: 2 }),
    await payloadHash({ b: 2, a: 1 }),
    'stableJson normalises object key order',
  );
});

// --- read-side validation ---------------------------------------------------

test('openRecord rejects an unknown envelope version', async () => {
  const envelope = await seal('attempt', 'attempt-1', ATTEMPT);
  await assert.rejects(
    () => openRecord({ ...envelope, v: 99 as typeof SYNC_ENVELOPE_VERSION }),
    /unsupported envelope version/,
  );
});

test('openRecord rejects an unknown entity type and a non-object payload', async () => {
  const envelope = await seal('attempt', 'attempt-1', ATTEMPT);
  await assert.rejects(
    () => openRecord({ ...envelope, type: 'nope' as SyncEntityType }),
    /unknown sync entity type/,
  );
  await assert.rejects(
    () => openRecord({ ...envelope, payload: 'plain' as unknown }),
    /payload must be an object/,
  );
  await assert.rejects(
    () => openRecord({ ...envelope, updatedAt: Number.NaN }),
    /updatedAt must be a finite/,
  );
});

test('sealRecord refuses a missing payload or unknown type', async () => {
  await assert.rejects(
    () => seal('attempt', 'attempt-1', undefined),
    /payload must be defined/,
  );
  await assert.rejects(
    () => seal('nope' as SyncEntityType, 'attempt-1', ATTEMPT),
    /unknown sync entity type/,
  );
});

// --- dedupe keys ------------------------------------------------------------

test('dedupeKey is deterministic, scope-dependent and matches sealRecord', async () => {
  const scope = dedupeScope('attempt', ['attempt-1']);
  const first = await dedupeKey(scope);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await dedupeKey(scope), first, 'must be deterministic');
  assert.notEqual(await dedupeKey(dedupeScope('attempt', ['attempt-2'])), first);

  const envelope = await seal(
    'attempt',
    'attempt-1',
    ATTEMPT,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  );
  assert.equal(
    envelope.dedupeKey,
    await dedupeKey(dedupeScope('attempt', dedupeScopePartsFor('attempt', 'attempt-1', ATTEMPT))),
    'sealRecord uses the same scope helper',
  );
});

test('base64 helpers round-trip arbitrary bytes and reject bad input', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.equal(bytesToBase64(new Uint8Array(0)), '');
  assert.throws(() => base64ToBytes('abc'), /not a multiple of 4/);
});
