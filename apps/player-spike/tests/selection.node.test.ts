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
