import { test } from 'node:test';
import assert from 'node:assert';
import { TrainingAdapter } from '../src/training-adapter.ts';
import type { NormalizedPuzzle } from '../src/types.ts';

const puzzle: NormalizedPuzzle = {
  id: 'flow-test-puzzle',
  contentSchemaVersion: '1.0.0',
  rating: 1000,
  source: 'lichess',
  sourceId: 'flow-test',
  themes: [],
  sourceFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  solverFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  solverColor: 'white',
  solution: ['e2e4'],
  originalFields: {},
};

test('failure is committed immutably and correction does not change the outcome', async () => {
  const adapter = new TrainingAdapter();
  await adapter.startSession();
  const started = await adapter.startAttempt(puzzle);

  await adapter.commitFailure(puzzle, 5);
  await adapter.finishCorrection(8);

  const record = await adapter.getService().getAttempt({ attemptId: started.attemptId });
  assert.equal(record.outcome, 'failure');
  assert.ok(record.completedAt);
});

test('success is committed and advances schedule state', async () => {
  const adapter = new TrainingAdapter();
  await adapter.startSession();
  const started = await adapter.startAttempt(puzzle);

  await adapter.commitSuccess(puzzle, 12);

  const record = await adapter.getService().getAttempt({ attemptId: started.attemptId });
  assert.equal(record.outcome, 'success');
  assert.ok(record.completedAt);
});
