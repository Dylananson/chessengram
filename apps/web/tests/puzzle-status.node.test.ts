import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { projectPuzzleStatus } from '../src/puzzle-status.ts';

test('projects an unattempted puzzle as New', () => {
  assert.deepEqual(projectPuzzleStatus(undefined, []), {
    state: 'new', algorithm: '—', rung: undefined, dueAt: undefined, successfulSolves: 0,
    averageActiveSeconds: undefined, bestActiveSeconds: undefined, lapses: 0,
  });
});

test('preserves generic learning/relearning/review states and mastery signals', () => {
  const attempts = [
    { outcome: 'success' as const, timing: { activeSolvingSeconds: 20 } },
    { outcome: 'success' as const, timing: { activeSolvingSeconds: 10 } },
    { outcome: 'failure' as const, timing: { activeSolvingSeconds: 5 } },
  ];
  for (const state of ['learning', 'relearning', 'review'] as const) {
    const result = projectPuzzleStatus({ state, algorithmId: 'generic', rung: 4, lapseCount: 2 }, attempts);
    assert.equal(result.state, state);
    assert.equal(result.algorithm, 'generic');
    assert.equal(result.rung, 4);
    assert.equal(result.successfulSolves, 2);
    assert.equal(result.averageActiveSeconds, 15);
    assert.equal(result.bestActiveSeconds, 10);
    assert.equal(result.lapses, 2);
  }
});

test('ignores untrusted active times while retaining failures as lapses', () => {
  const result = projectPuzzleStatus(
    { state: 'review', lapseCount: 0 },
    [
      { outcome: 'success', timing: { activeSolvingSeconds: 12, timingTrustworthy: false } },
      { outcome: 'failure', timing: { activeSolvingSeconds: 3 } },
    ],
  );
  assert.equal(result.successfulSolves, 1);
  assert.equal(result.averageActiveSeconds, undefined);
  assert.equal(result.lapses, 1);
});
