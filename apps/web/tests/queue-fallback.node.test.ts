import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LocalTrainingService } from '../src/scheduler-service.ts';
import { TrainingAdapter } from '../src/training-adapter.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { makePuzzle, PROGRAM_ID, timing } from './fixtures.ts';

/**
 * UX-001 regression: `selectNext` must never strand the user with a
 * non-empty library. The daily new-puzzle cap surfaces as
 * `daily-limit-reached`, plain all-future-due as `no-due-work`, both with the
 * earliest future due time; an empty library still reports `queue-empty`.
 */

// Local noon avoids day-boundary surprises in the new-per-day cap accounting.
const T0 = new Date(2026, 9, 15, 12, 0, 0).getTime();

function makeClock(start: number): { clock: { now(): number }; set(ms: number): void } {
  let current = start;
  return {
    clock: { now: () => current },
    set(ms: number) {
      current = ms;
    },
  };
}

async function makeClockedService(
  clock: { now(): number },
  settings?: { newIntroductionLimitPerDay: number },
): Promise<LocalTrainingService> {
  const service = new LocalTrainingService({
    store: new LocalStore(new InMemoryStorageBackend()),
    clock,
    ...(settings ? { settings } : {}),
  });
  await service.init();
  return service;
}

test('(a) new-cap reached + learning future-due reports daily-limit-reached with nextDueAt', async () => {
  const { clock, set } = makeClock(T0);
  const service = await makeClockedService(clock, { newIntroductionLimitPerDay: 1 });
  await service.seedContent([makePuzzle({ id: 'n1' }), makePuzzle({ id: 'n2' })]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession(PROGRAM_ID);

  const first = await adapter.selectNext();
  assert.equal(first.puzzleId, 'n1');
  await adapter.startAttempt(await adapter.loadPuzzle('n1'));
  await adapter.commitSuccess(timing());

  const due = service.getScheduleState(`${PROGRAM_ID}:n1`)?.dueAt;
  assert.ok(due !== undefined && due > T0, 'learned puzzle is due in the future');

  // n2 is still new but the cap (1/day) is exhausted; n1 is future-due.
  const next = await adapter.selectNext();
  assert.equal(next.puzzleId, null);
  assert.equal(next.reason, 'daily-limit-reached');
  assert.equal(next.nextDueAt, due);

  // Once the due time passes, normal eligible selection resumes (n1 due, n2 still capped).
  set(due + 1000);
  const later = await adapter.selectNext();
  assert.equal(later.puzzleId, 'n1');
});

test('(b) all future-due without cap pressure reports no-due-work with nextDueAt', async () => {
  const { clock } = makeClock(T0);
  const service = await makeClockedService(clock);
  await service.seedContent([makePuzzle({ id: 'r1' }), makePuzzle({ id: 'r2' })]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession(PROGRAM_ID);

  for (const id of ['r1', 'r2']) {
    const picked = await adapter.selectNext();
    assert.equal(picked.puzzleId, id);
    await adapter.startAttempt(await adapter.loadPuzzle(id));
    await adapter.commitSuccess(timing());
  }

  const due1 = service.getScheduleState(`${PROGRAM_ID}:r1`)?.dueAt;
  const due2 = service.getScheduleState(`${PROGRAM_ID}:r2`)?.dueAt;
  assert.ok(due1 !== undefined && due1 > T0);
  assert.ok(due2 !== undefined && due2 > T0);

  const next = await adapter.selectNext();
  assert.equal(next.puzzleId, null);
  assert.equal(next.reason, 'no-due-work');
  assert.equal(next.nextDueAt, Math.min(due1, due2));
});

test('(c) empty library still returns queue-empty', async () => {
  const { clock } = makeClock(T0);
  const service = await makeClockedService(clock);
  const session = await service.startSession({ programId: PROGRAM_ID });
  const next = await service.selectNext({
    sessionId: session.session.sessionId,
    programId: PROGRAM_ID,
  });
  assert.equal(next.puzzleId, null);
  assert.equal(next.reason, 'queue-empty');
});
