import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordWoodpeckerResult,
  startWoodpeckerCycle,
  summarizeWoodpeckerCycle,
} from '../src/woodpecker.ts';

test('Woodpecker cycle snapshots fixed membership and starts empty', () => {
  const puzzleIds = ['p1', 'p2'];
  const cycle = startWoodpeckerCycle({ setId: 'set-a', puzzleIds }, 1, 100);
  puzzleIds.push('p3');

  assert.deepEqual(cycle.puzzleIds, ['p1', 'p2']);
  assert.deepEqual(summarizeWoodpeckerCycle(cycle), {
    total: 2,
    attempted: 0,
    remaining: 2,
    clean: 0,
    failed: 0,
    accuracy: 0,
    activeSeconds: 0,
    complete: false,
    failedPuzzleIds: [],
  });
});

test('cycle summary tracks accuracy, active time, completion, and failed-review handoff', () => {
  let cycle = startWoodpeckerCycle({ setId: 'set-a', puzzleIds: ['p1', 'p2', 'p3'] }, 2, 100);
  cycle = recordWoodpeckerResult(cycle, 'p1', 'clean', 12);
  cycle = recordWoodpeckerResult(cycle, 'p2', 'failed', 8);

  assert.deepEqual(summarizeWoodpeckerCycle(cycle), {
    total: 3,
    attempted: 2,
    remaining: 1,
    clean: 1,
    failed: 1,
    accuracy: 0.5,
    activeSeconds: 20,
    complete: false,
    failedPuzzleIds: ['p2'],
  });

  cycle = recordWoodpeckerResult(cycle, 'p3', 'clean', 10, 5000);
  const summary = summarizeWoodpeckerCycle(cycle);
  assert.equal(summary.complete, true);
  assert.equal(summary.remaining, 0);
  assert.equal(summary.accuracy, 2 / 3);
  assert.deepEqual(summary.failedPuzzleIds, ['p2']);
  assert.equal(cycle.completedAt, 5000);
});

test('cycle result recording is immutable and rejects out-of-set or duplicate results', () => {
  const cycle = startWoodpeckerCycle({ setId: 'set-a', puzzleIds: ['p1'] }, 1, 100);
  const next = recordWoodpeckerResult(cycle, 'p1', 'failed', 4);

  assert.equal(cycle.results.length, 0);
  assert.throws(() => recordWoodpeckerResult(cycle, 'other', 'clean', 2), /not in this cycle/);
  assert.throws(() => recordWoodpeckerResult(next, 'p1', 'clean', 2), /already has a result/);
});

test('cycle creation and results reject invalid ids, cycle numbers, and durations', () => {
  assert.throws(() => startWoodpeckerCycle({ setId: 's', puzzleIds: [] }, 1, 0), /at least one/);
  assert.throws(() => startWoodpeckerCycle({ setId: 's', puzzleIds: ['p', 'p'] }, 1, 0), /duplicate/);
  assert.throws(() => startWoodpeckerCycle({ setId: 's', puzzleIds: ['p'] }, 0, 0), /positive integer/);
  const cycle = startWoodpeckerCycle({ setId: 's', puzzleIds: ['p'] }, 1, 0);
  assert.throws(() => recordWoodpeckerResult(cycle, 'p', 'clean', -1), /non-negative/);
  assert.throws(() => recordWoodpeckerResult(cycle, 'p', 'clean', 1, Number.NaN), /recordedAt/);
});
