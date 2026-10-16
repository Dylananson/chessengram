import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEFAULT_COLLECTION_ID,
  LocalTrainingService,
  progressKeyToString,
} from '../src/scheduler-service.ts';
import { TrainingAdapter } from '../src/training-adapter.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { makePuzzle, PROGRAM_ID, timing } from './fixtures.ts';

/**
 * UX-005 regression: normal due/new selection wins; when exhausted, Next
 * falls back to scheduled future-due work, without introducing capped new work.
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

test('(a) new-cap reached falls back to earliest scheduled review, not capped new work', async () => {
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
  assert.equal(next.puzzleId, 'n1');
  assert.equal(next.reason, undefined);

  // Once the due time passes, normal eligible selection resumes (n1 due, n2 still capped).
  set(due + 1000);
  const later = await adapter.selectNext();
  assert.equal(later.puzzleId, 'n1');
});

test('(b) all future-due reviews fall back in earliest-due order', async () => {
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
  assert.equal(next.puzzleId, due1 <= due2 ? 'r1' : 'r2');
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

test('(d) fallback is limited to active collection scope and scheduled candidates', async () => {
  const { clock, set } = makeClock(T0);
  const service = await makeClockedService(clock);
  await service.seedContent([makePuzzle({ id: 'shared' }), makePuzzle({ id: 'solo' })]);
  // A second collection shares one puzzle with the default collection.
  const custom = await service.createCollection('Custom');
  await service.addPuzzleToCollection(custom.id, 'shared');

  // Advance only the default scope: learn 'shared' there.
  const adapter = new TrainingAdapter(service);
  await adapter.startSession(PROGRAM_ID);
  const picked = await adapter.selectNext();
  assert.equal(picked.puzzleId, 'shared');
  await adapter.startAttempt(await adapter.loadPuzzle('shared'));
  await adapter.commitSuccess(timing());
  const defaultDue = service.getScheduleState(
    progressKeyToString({
      programId: PROGRAM_ID,
      collectionId: DEFAULT_COLLECTION_ID,
      puzzleId: 'shared',
    }),
  )?.dueAt;
  assert.ok(defaultDue !== undefined && defaultDue > T0, 'default scope is future-due');

  // Under the custom active collection the shared puzzle is still new in
  // this scope; ordinary selection may introduce it.
  await service.setActiveCollectionId(custom.id);
  const scoped = service.getScheduleState(
    progressKeyToString({ programId: PROGRAM_ID, collectionId: custom.id, puzzleId: 'shared' }),
  );
  assert.equal(scoped, undefined);
  const legacy = service.getScheduleState(`${PROGRAM_ID}:shared`);
  assert.equal(legacy?.dueAt, defaultDue);

  const members = service.getCollection(custom.id)?.puzzleIds ?? [];
  assert.deepEqual(members, ['shared']);
  // Advance the custom scope and complete its new puzzle, then verify it
  // cannot be selected early and becomes eligible at its due time.
  set(T0 + 60 * 60 * 1000);
  const customAdapter = new TrainingAdapter(service);
  await customAdapter.startSession(PROGRAM_ID, custom.id);
  const customPick = await customAdapter.selectNext();
  assert.equal(customPick.puzzleId, 'shared');
  await customAdapter.startAttempt(await customAdapter.loadPuzzle('shared'));
  await customAdapter.commitSuccess(timing());
  const customDue = service.getScheduleState(
    progressKeyToString({ programId: PROGRAM_ID, collectionId: custom.id, puzzleId: 'shared' }),
  )?.dueAt;
  assert.ok(customDue !== undefined && customDue > defaultDue, 'scopes advance independently');

  const tooEarly = await customAdapter.selectNext();
  assert.equal(tooEarly.puzzleId, 'shared');
  set(customDue!);
  const duePick = await customAdapter.selectNext();
  assert.equal(duePick.puzzleId, 'shared');

  // The default scope still resolves its own due time when active again.
  await service.setActiveCollectionId(DEFAULT_COLLECTION_ID);
  const backInDefault = service.getScheduleState(
    progressKeyToString({
      programId: PROGRAM_ID,
      collectionId: DEFAULT_COLLECTION_ID,
      puzzleId: 'shared',
    }),
  );
  assert.equal(backInDefault?.dueAt, defaultDue);
});
