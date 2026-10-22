/**
 * v2 canonical-bytes fixed vectors.
 *
 * These pin the exact bytes the client signs so the two halves — the server
 * (`src/canonical.ts`) and the frozen client contract
 * (`apps/web/src/sync/types.ts#canonicalEnvelopeBytes`) — cannot drift. The
 * harness carries an independent copy of the same helpers; both are asserted
 * against the same constants.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  canonicalEnvelopeBytes,
  payloadHashHex,
  sha256Hex,
  stableJson,
} from '../src/canonical.ts';
import {
  canonicalBytesForTest,
  payloadHashForTest,
  stableJsonForTest,
} from './harness.ts';
import type { SyncRecordEnvelope } from '../src/protocol.ts';

const PAYLOAD = { b: [2, { d: 3, c: 4 }], a: 1, z: 'ü', n: null, skipped: undefined };

const STABLE_JSON = '{"a":1,"b":[2,{"c":4,"d":3}],"n":null,"z":"ü"}';
const PAYLOAD_HASH = 'e565fe6a917ebb6cfddb97411e7e87958995104b77df598963a59cd634fc2e60';
const CANONICAL =
  '[2,"attempt","a1","deadbeef","device-a",1700000000000,3,"e565fe6a917ebb6cfddb97411e7e87958995104b77df598963a59cd634fc2e60"]';
const SCOPE_HASH = '13da841d9dfe5894386184e8d4d3604fc7089010c314ab2d6b8f80dd674f2639';

const ENVELOPE = {
  v: 2 as const,
  type: 'attempt' as const,
  recordId: 'a1',
  dedupeKey: 'deadbeef',
  deviceId: 'device-a',
  updatedAt: 1_700_000_000_000,
  rev: 3,
  payload: PAYLOAD,
};

test('stableJson sorts object keys at every level and omits undefined', () => {
  assert.equal(stableJson(PAYLOAD), STABLE_JSON);
  // Sanity: primitives, arrays and null are unchanged.
  assert.equal(stableJson(null), 'null');
  assert.equal(stableJson(undefined), 'null');
  assert.equal(stableJson('ü'), '"ü"');
  assert.equal(stableJson([1, 'a', null]), '[1,"a",null]');
});

test('payloadHash is sha256 of the stable JSON', async () => {
  assert.equal(await payloadHashHex(PAYLOAD), PAYLOAD_HASH);
  assert.equal(await sha256Hex(STABLE_JSON), PAYLOAD_HASH);
});

test('the canonical signed string is exactly the frozen field list', async () => {
  assert.equal(await canonicalEnvelopeBytes(ENVELOPE), CANONICAL);
});

test('sha256Hex("attempt\\u0000a1") matches the scope hash vector', async () => {
  assert.equal(await sha256Hex('attempt\u0000a1'), SCOPE_HASH);
});

test('the independent client copy in the harness matches the server byte-for-byte', async () => {
  assert.equal(stableJsonForTest(PAYLOAD), STABLE_JSON);
  assert.equal(await payloadHashForTest(PAYLOAD), PAYLOAD_HASH);
  const signed = { ...ENVELOPE, sig: 'x' } satisfies SyncRecordEnvelope;
  assert.equal(await canonicalBytesForTest(signed), CANONICAL);
});
