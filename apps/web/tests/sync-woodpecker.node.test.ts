import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { WoodpeckerCycle, WoodpeckerSetRecord } from '@chessengram/scheduler';
import {
  applyWoodpeckerCycle,
  applyWoodpeckerResult,
  applyWoodpeckerSet,
  woodpeckerResultDedupeKey,
  woodpeckerSetPayload,
} from '../src/sync/woodpecker.ts';
import type { SyncWoodpeckerPayload } from '../src/sync/types.ts';

const SET_ID = 'set-1';
const CYCLE_ID = 'cycle-1';
const SALT_A = 'aa'.repeat(32);
const SALT_B = 'bb'.repeat(32);

const setRecord: WoodpeckerSetRecord = {
  setId: SET_ID,
  sourceCollectionId: 'col-1',
  name: 'First set',
  puzzleIds: ['p1', 'p2'],
  createdAt: 1_000,
};

const cycle: WoodpeckerCycle = {
  setId: SET_ID,
  cycleNumber: 2,
  puzzleIds: ['p1', 'p2'],
  startedAt: 10_000,
  results: [],
};

function setPayload(overrides: Partial<SyncWoodpeckerPayload> = {}): SyncWoodpeckerPayload {
  return {
    setId: SET_ID,
    sourceCollectionId: 'col-1',
    name: 'First set',
    puzzleIds: ['p1', 'p2'],
    ...overrides,
  };
}

test('woodpeckerSetPayload serializes the snapshot fields', () => {
  assert.deepEqual(woodpeckerSetPayload(setRecord), {
    setId: SET_ID,
    sourceCollectionId: 'col-1',
    name: 'First set',
    puzzleIds: ['p1', 'p2'],
  });
});

test('a woodpecker set is created only when absent and keeps its first snapshot', () => {
  const created = applyWoodpeckerSet(undefined, setPayload(), 5_000);
  assert.equal(created.created, true);
  assert.deepEqual(created.record, { ...setRecord, createdAt: 5_000 });

  const ignored = applyWoodpeckerSet(
    created.record,
    setPayload({ name: 'Renamed', sourceCollectionId: 'col-2', puzzleIds: ['p9'] }),
    9_000,
  );
  assert.equal(ignored.created, false);
  assert.equal(ignored.record, created.record, 'the existing set is returned unchanged');
  assert.equal(ignored.record.name, 'First set');
  assert.equal(ignored.record.sourceCollectionId, 'col-1');
  assert.deepEqual(ignored.record.puzzleIds, ['p1', 'p2']);
  assert.equal(ignored.record.createdAt, 5_000);
});

test('a woodpecker set payload creates a cycle with its snapshot and first startedAt', () => {
  const created = applyWoodpeckerCycle(
    undefined,
    setPayload({ cycleId: CYCLE_ID, startedAt: 10_000 }),
    2,
  );
  assert.equal(created.created, true);
  assert.deepEqual(created.cycle, cycle);

  const later = applyWoodpeckerCycle(
    created.cycle,
    setPayload({ cycleId: CYCLE_ID, startedAt: 20_000, puzzleIds: ['p9'], completedAt: 30_000 }),
  );
  assert.equal(later.created, false);
  assert.equal(later.cycle.startedAt, 10_000, 'startedAt is first-write');
  assert.equal(later.cycle.cycleNumber, 2, 'local cycle number is preserved');
  assert.deepEqual(later.cycle.puzzleIds, ['p1', 'p2'], 'the snapshot is never rewritten');
  assert.equal(later.cycle.completedAt, 30_000, 'a missing completion is filled');
});

test('cycle completedAt is filled once and never moved later', () => {
  const created = applyWoodpeckerCycle(
    undefined,
    setPayload({ cycleId: CYCLE_ID, startedAt: 10_000, completedAt: 40_000 }),
  );
  assert.equal(created.cycle.completedAt, 40_000);

  const laterPayload = applyWoodpeckerCycle(
    created.cycle,
    setPayload({ cycleId: CYCLE_ID, completedAt: 90_000 }),
  );
  assert.equal(laterPayload.cycle.completedAt, 40_000, 'a later completion is ignored');

  // Idempotent: the same payload again leaves the cycle unchanged.
  assert.deepEqual(
    applyWoodpeckerCycle(laterPayload.cycle, setPayload({ cycleId: CYCLE_ID, completedAt: 90_000 })).cycle,
    laterPayload.cycle,
  );

  // The earliest known completion wins even if it arrives out of order.
  const earlier = applyWoodpeckerCycle(
    laterPayload.cycle,
    setPayload({ cycleId: CYCLE_ID, completedAt: 35_000 }),
  );
  assert.equal(earlier.cycle.completedAt, 35_000);
});

test('cycle completion preserves existing results when applying a payload', () => {
  const withResult = applyWoodpeckerResult(cycle, {
    cycleId: CYCLE_ID,
    puzzleId: 'p1',
    result: 'clean',
    activeSeconds: 12,
  }).cycle;
  const completed = applyWoodpeckerCycle(
    withResult,
    setPayload({ cycleId: CYCLE_ID, completedAt: 50_000 }),
  ).cycle;

  assert.deepEqual(completed.results, [{ puzzleId: 'p1', result: 'clean', activeSeconds: 12 }]);
  assert.equal(completed.completedAt, 50_000);
});

test('cycle results are first-write-wins per puzzle', () => {
  const first = applyWoodpeckerResult(cycle, {
    cycleId: CYCLE_ID,
    puzzleId: 'p1',
    result: 'clean',
    activeSeconds: 12,
  });
  assert.equal(first.applied, true);
  assert.equal(cycle.results.length, 0, 'the input cycle is not mutated');
  assert.deepEqual(first.cycle.results, [{ puzzleId: 'p1', result: 'clean', activeSeconds: 12 }]);

  const duplicate = applyWoodpeckerResult(first.cycle, {
    cycleId: CYCLE_ID,
    puzzleId: 'p1',
    result: 'failed',
    activeSeconds: 99,
  });
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.cycle, first.cycle, 'the cycle is returned unchanged (same reference)');

  const otherPuzzle = applyWoodpeckerResult(first.cycle, {
    cycleId: CYCLE_ID,
    puzzleId: 'p2',
    result: 'failed',
    activeSeconds: 20,
  });
  assert.equal(otherPuzzle.applied, true);
  assert.deepEqual(otherPuzzle.cycle.results, [
    { puzzleId: 'p1', result: 'clean', activeSeconds: 12 },
    { puzzleId: 'p2', result: 'failed', activeSeconds: 20 },
  ]);
  assert.equal(first.cycle.results.length, 1, 'earlier results are never dropped');
});

test('woodpecker result dedupe key is stable and unique per cycle and puzzle', async () => {
  const key = await woodpeckerResultDedupeKey(CYCLE_ID, 'p1');
  const again = await woodpeckerResultDedupeKey(CYCLE_ID, 'p1');
  const otherPuzzle = await woodpeckerResultDedupeKey(CYCLE_ID, 'p2');
  const otherCycle = await woodpeckerResultDedupeKey('cycle-2', 'p1');

  assert.equal(key, again, 'the same result always hashes the same key');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(key, otherPuzzle);
  assert.notEqual(key, otherCycle);
});
