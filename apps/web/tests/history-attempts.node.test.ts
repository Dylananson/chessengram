import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyAttemptOutcome, HistoryView, summarizeHistory } from '../src/history-view.ts';
import { DEFAULT_PROGRAM_ID, LocalTrainingService } from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { setLocale, t } from '../src/i18n.ts';
import { makePuzzle, timing } from './fixtures.ts';

/** Manual clock so `startedAt` ordering is deterministic. */
function manualClock(start = 1_000_000): { clock: { now: () => number }; tick: (ms?: number) => void } {
  let now = start;
  return {
    clock: { now: () => now },
    tick: (ms = 1000) => {
      now += ms;
    },
  };
}

async function makeClockedService(clock: { now: () => number }): Promise<LocalTrainingService> {
  const service = new LocalTrainingService({ store: new LocalStore(new InMemoryStorageBackend()), clock });
  await service.init();
  return service;
}

async function seedTwoPuzzles(service: LocalTrainingService): Promise<string> {
  await service.upsertPuzzles([makePuzzle({ id: 'a' }), makePuzzle({ id: 'b' })]);
  const session = await service.startSession({
    programId: DEFAULT_PROGRAM_ID,
    collectionId: 'c1',
  });
  return session.session.sessionId;
}

async function startAndCommit(
  service: LocalTrainingService,
  sessionId: string,
  puzzleId: string,
  outcome: 'success' | 'failure',
) {
  const started = await service.startAttempt({
    sessionId,
    progressKey: { programId: DEFAULT_PROGRAM_ID, puzzleId, collectionId: 'c1' },
    expectedScheduleRevision: 0,
  });
  const committed = await service.commitOutcome({
    attemptId: started.attemptId,
    outcome,
    timing: timing(),
    expectedScheduleRevision: started.scheduleRevision,
  });
  assert.equal(committed.committed, true);
  return started.attemptId;
}

test('listAttempts returns defensive copies, newest-first, with a default limit', async () => {
  const { clock, tick } = manualClock();
  const service = await makeClockedService(clock);
  const sessionId = await seedTwoPuzzles(service);

  await startAndCommit(service, sessionId, 'a', 'success');
  tick();
  await startAndCommit(service, sessionId, 'b', 'failure');

  const all = service.listAttempts();
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((a) => a.progressKey.puzzleId),
    ['b', 'a'],
    'newest-first by startedAt',
  );

  // Defensive copies: mutating the result must not affect service state.
  all[0]!.timing.activeSolvingSeconds = 9999;
  all[0]!.events.push({ eventId: 'evil', type: 'move', occurredAt: 0 });
  const again = service.listAttempts();
  assert.notEqual(again[0]!.timing.activeSolvingSeconds, 9999);
  assert.ok(!again[0]!.events.some((e) => e.eventId === 'evil'));

  // Read-only: listing never changes stored state.
  assert.equal(service.getAttemptCount(), 2);
});

test('listAttempts filters by programId/puzzleId and honors limit', async () => {
  const { clock, tick } = manualClock();
  const service = await makeClockedService(clock);
  const sessionId = await seedTwoPuzzles(service);

  await startAndCommit(service, sessionId, 'a', 'success');
  tick();
  await startAndCommit(service, sessionId, 'a', 'failure');
  tick();
  await startAndCommit(service, sessionId, 'b', 'success');

  assert.equal(service.listAttempts({ puzzleId: 'a' }).length, 2);
  assert.equal(service.listAttempts({ puzzleId: 'b' }).length, 1);
  assert.equal(service.listAttempts({ puzzleId: 'missing' }).length, 0);
  assert.equal(service.listAttempts({ programId: DEFAULT_PROGRAM_ID }).length, 3);
  assert.equal(service.listAttempts({ programId: 'other-program' }).length, 0);

  const limited = service.listAttempts({ limit: 2 });
  assert.equal(limited.length, 2);
  assert.deepEqual(
    limited.map((a) => a.progressKey.puzzleId),
    ['b', 'a'],
    'limit keeps the newest entries',
  );
  assert.deepEqual(service.listAttempts({ limit: 0 }), []);
});

test('history snapshot classifies success/failure/unscored/abandoned attempts', async () => {
  const { clock, tick } = manualClock();
  const service = await makeClockedService(clock);
  const sessionId = await seedTwoPuzzles(service);

  await startAndCommit(service, sessionId, 'a', 'success');
  tick();
  await startAndCommit(service, sessionId, 'b', 'failure');
  tick();
  // Unscored: started but never committed.
  const pending = await service.startAttempt({
    sessionId,
    progressKey: { programId: DEFAULT_PROGRAM_ID, puzzleId: 'a', collectionId: 'c1' },
    expectedScheduleRevision: 0,
  });
  tick();
  // Abandoned: started, then skipped without scoring.
  const doomed = await service.startAttempt({
    sessionId,
    progressKey: { programId: DEFAULT_PROGRAM_ID, puzzleId: 'b', collectionId: 'c1' },
    expectedScheduleRevision: 0,
  });
  await service.abandonAttempt(sessionId);

  const snapshot = summarizeHistory(service, DEFAULT_PROGRAM_ID);
  assert.equal(snapshot.attempts.length, 4);
  const byId = new Map(snapshot.attempts.map((row) => [row.attemptId, row]));
  assert.equal(byId.get(doomed.attemptId.value)!.outcome, 'abandoned');
  assert.equal(byId.get(pending.attemptId.value)!.outcome, 'unscored');

  const outcomes = new Set(snapshot.attempts.map((row) => row.outcome));
  assert.ok(outcomes.has('success'));
  assert.ok(outcomes.has('failure'));

  // Newest-first in the snapshot too.
  const started = snapshot.attempts.map((row) => row.startedAt);
  assert.deepEqual([...started].sort((a, b) => b - a), started);

  // Per-attempt detail exposes timing, event counts and timestamps.
  const successRow = snapshot.attempts.find((row) => row.outcome === 'success')!;
  assert.equal(successRow.activeSolvingSeconds, timing().activeSolvingSeconds);
  assert.equal(successRow.correctionSeconds, timing().correctionSeconds);
  assert.ok(successRow.eventCount >= 1);
  assert.ok(typeof successRow.startedAt === 'number');
  assert.ok(typeof successRow.completedAt === 'number');

  // classifyAttemptOutcome is pure over the record shape.
  const abandoned = await service.getAttempt({ attemptId: doomed.attemptId });
  assert.equal(classifyAttemptOutcome(abandoned), 'abandoned');

  // Read-only: the projection performs no writes.
  assert.equal(service.getAttemptCount(), 4);
});

test('HistoryView renders the per-attempt table without touching service state', async () => {
  setLocale('en');
  const { clock, tick } = manualClock();
  const service = await makeClockedService(clock);
  const sessionId = await seedTwoPuzzles(service);
  await startAndCommit(service, sessionId, 'a', 'success');
  tick();
  const doomed = await service.startAttempt({
    sessionId,
    progressKey: { programId: DEFAULT_PROGRAM_ID, puzzleId: 'b', collectionId: 'c1' },
    expectedScheduleRevision: 0,
  });
  await service.abandonAttempt(sessionId);
  void doomed;

  const view = new HistoryView({ service, adapter: undefined as never });
  const host = { innerHTML: '' } as unknown as HTMLElement;
  const before = service.getAttemptCount();
  view.mount(host);

  assert.ok(host.innerHTML.includes(t('history.attempts.title')));
  assert.ok(host.innerHTML.includes(t('history.outcome.success')));
  assert.ok(host.innerHTML.includes(t('history.outcome.abandoned')));
  assert.match(host.innerHTML, /attempt-table/);
  assert.equal(service.getAttemptCount(), before, 'mount performs no writes');
  view.unmount();
});
