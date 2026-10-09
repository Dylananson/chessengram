import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TrainingAdapter } from '../src/training-adapter.ts';
import { makePuzzle, makeService, PROGRAM_ID, timing } from './fixtures.ts';

const puzzle = makePuzzle({ id: 'flow-test-puzzle', solution: ['e2e4'] });

test('a first wrong move commits one immutable failure; correction changes evidence only', async () => {
  const service = await makeService();
  await service.seedContent([puzzle]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession(PROGRAM_ID);

  const started = await adapter.startAttempt(puzzle);
  await adapter.recordWrongMove('d2d4');
  await adapter.commitFailure(timing({ activeSolvingSeconds: 5 }));
  await adapter.finishCorrection(timing({ activeSolvingSeconds: 5, correctionSeconds: 8 }));

  const record = await service.getAttempt({ attemptId: { value: started.attemptId } });
  assert.equal(record.outcome, 'failure');
  assert.equal(record.failureReason, 'wrong-move');
  assert.ok(record.completedAt);
  assert.ok(record.events.some((event) => event.type === 'correction-complete'));
});

test('a duplicate commit returns the original receipt without re-applying the effect', async () => {
  const service = await makeService();
  await service.seedContent([puzzle]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession(PROGRAM_ID);

  const started = await adapter.startAttempt(puzzle);
  await adapter.commitFailure(timing());

  const afterFirst = await service.getAttempt({ attemptId: { value: started.attemptId } });
  const revisionAfterFirst = afterFirst.outcomeReceipt?.scheduleRevision;

  const duplicate = await service.commitOutcome({
    attemptId: { value: started.attemptId },
    outcome: 'failure',
    failureReason: 'wrong-move',
    timing: timing(),
    idempotencyKey: `fail-${started.attemptId}`,
    expectedScheduleRevision: 0,
  });

  assert.equal(duplicate.committed, true);
  assert.equal(duplicate.receipt?.scheduleRevision, revisionAfterFirst);
});

test('success is committed and moves the puzzle out of the New state', async () => {
  const service = await makeService();
  await service.seedContent([puzzle]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession(PROGRAM_ID);

  const started = await adapter.startAttempt(puzzle);
  await adapter.recordMove('e2e4', true);
  await adapter.commitSuccess(timing({ activeSolvingSeconds: 12 }));

  const record = await service.getAttempt({ attemptId: { value: started.attemptId } });
  assert.equal(record.outcome, 'success');
  assert.ok(record.completedAt);

  const schedule = service.getScheduleState(`${PROGRAM_ID}:${puzzle.id}`);
  assert.ok(schedule);
  assert.notEqual(schedule.state, 'new');
});
