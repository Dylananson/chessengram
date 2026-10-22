import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makePuzzle, makeService, PROGRAM_ID } from './fixtures.ts';

const p1 = makePuzzle({ id: 'p1' });
const p2 = makePuzzle({ id: 'p2' });
const p3 = makePuzzle({ id: 'p3' });

test('new puzzles are selected in stable presentation order', async () => {
  const service = await makeService();
  await service.seedContent([p1, p2, p3]);
  const session = await service.startSession({ programId: PROGRAM_ID });

  const first = await service.selectNext({
    sessionId: session.session.sessionId,
    programId: PROGRAM_ID,
  });
  assert.equal(first.puzzleId, 'p1');
});

test('the reserved active attempt is skipped for selection', async () => {
  const service = await makeService();
  await service.seedContent([p1, p2, p3]);
  const session = await service.startSession({ programId: PROGRAM_ID });

  await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: PROGRAM_ID, puzzleId: 'p1' },
    expectedScheduleRevision: 0,
  });

  const next = await service.selectNext({
    sessionId: session.session.sessionId,
    programId: PROGRAM_ID,
  });
  assert.equal(next.puzzleId, 'p2');
});

test('completing a puzzle frees its reservation', async () => {
  const service = await makeService();
  await service.seedContent([p1, p2]);
  const session = await service.startSession({ programId: PROGRAM_ID });

  const started = await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: PROGRAM_ID, puzzleId: 'p1' },
    expectedScheduleRevision: 0,
  });
  await service.commitOutcome({
    attemptId: started.attemptId,
    outcome: 'success',
    timing: {
      activeSolvingSeconds: 3,
      correctionSeconds: 0,
      interruptionSeconds: 0,
      hiddenSeconds: 0,
      timingTrustworthy: true,
    },
    idempotencyKey: `success-${started.attemptId.value}`,
    expectedScheduleRevision: started.scheduleRevision,
  });

  const active = service.getActiveAttempt(session.session.sessionId);
  assert.equal(active, undefined);
});

// --- exclusions (owner report R53: "Next replays the puzzle I just did") -----

/** Solve one puzzle so it has a future schedule (the post-success state). */
async function solve(
  service: Awaited<ReturnType<typeof makeService>>,
  sessionId: string,
  puzzleId: string,
  collectionId?: string,
): Promise<void> {
  const started = await service.startAttempt({
    sessionId,
    progressKey: { programId: PROGRAM_ID, puzzleId, ...(collectionId ? { collectionId } : {}) },
    expectedScheduleRevision: 0,
  });
  await service.commitOutcome({
    attemptId: started.attemptId,
    outcome: 'success',
    timing: {
      activeSolvingSeconds: 3,
      correctionSeconds: 0,
      interruptionSeconds: 0,
      hiddenSeconds: 0,
      timingTrustworthy: true,
    },
    idempotencyKey: `success-${started.attemptId.value}`,
    expectedScheduleRevision: started.scheduleRevision,
  });
}

test('an excluded puzzle is not re-added by the schedule scan (the "repeat" bug)', async () => {
  const service = await makeService();
  await service.seedContent([p1, p2]);
  const collectionId = service.getActiveCollectionId();
  const session = await service.startSession({ programId: PROGRAM_ID, collectionId });

  // Both are learned: nothing is due, so selection falls to the earliest future
  // schedule. p1 was solved first, so it is that fallback — unless excluded.
  await solve(service, session.session.sessionId, 'p1', collectionId);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await solve(service, session.session.sessionId, 'p2', collectionId);

  const next = await service.selectNext({
    sessionId: session.session.sessionId,
    programId: PROGRAM_ID,
    collectionId,
    excludedKeys: ['p1'],
  });
  assert.equal(next.puzzleId, 'p2', 'the just-finished puzzle must not come back');
});

test('excluding the only puzzle reports no due work instead of the empty library', async () => {
  const service = await makeService();
  await service.seedContent([p1]);
  const collectionId = service.getActiveCollectionId();
  const session = await service.startSession({ programId: PROGRAM_ID, collectionId });
  await solve(service, session.session.sessionId, 'p1', collectionId);

  const next = await service.selectNext({
    sessionId: session.session.sessionId,
    programId: PROGRAM_ID,
    collectionId,
    excludedKeys: ['p1'],
  });
  assert.equal(next.puzzleId, null);
  assert.equal(next.reason, 'no-due-work');
  assert.ok(typeof next.nextDueAt === 'number', 'the next due time is reported');
});
