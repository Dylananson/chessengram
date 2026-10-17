/**
 * STAT-001 statistics projection. Locks the measurement model: active-only
 * headline, correction/wall-clock separate, practice never mixed into scored
 * totals, Woodpecker not double counted, per-collection rows reconciling with
 * the overall totals, and range filtering by attempt start time.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_PROGRAM_ID,
  LocalTrainingService,
  WOODPECKER_CYCLE_PROGRAM_ID,
  WOODPECKER_FAILED_PROGRAM_ID,
  WOODPECKER_REVIEW_PROGRAM_ID,
  woodpeckerScopeId,
} from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { TrainingAdapter } from '../src/training-adapter.ts';
import { formatStatDuration, summarizeStats } from '../src/stats.ts';
import { makePuzzle, timing } from './fixtures.ts';

const DAY = 24 * 60 * 60 * 1000;

async function makeClockedService(startAt = 1_000) {
  let now = startAt;
  const service = new LocalTrainingService({
    store: new LocalStore(new InMemoryStorageBackend()),
    clock: { now: () => now },
  });
  await service.init();
  return { service, setNow: (ms: number) => { now = ms; } };
}

interface CommitOptions {
  programId?: string;
  collectionId?: string;
  puzzleId?: string;
  active?: number;
  correction?: number;
  trustworthy?: boolean;
  key?: string;
}

/** Commit one scored attempt. */
async function commit(
  service: LocalTrainingService,
  { programId = DEFAULT_PROGRAM_ID, collectionId = DEFAULT_COLLECTION_ID, puzzleId = 'p1', active = 10, correction = 0, trustworthy = true, key = `k-${Math.random()}` }: CommitOptions = {},
) {
  const session = await service.startSession({ programId, collectionId });
  const started = await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId, collectionId, puzzleId },
    expectedScheduleRevision: 0,
  });
  await service.commitOutcome({
    attemptId: started.attemptId,
    outcome: 'success',
    timing: timing({ activeSolvingSeconds: active, correctionSeconds: correction, timingTrustworthy: trustworthy }),
    expectedScheduleRevision: started.scheduleRevision,
    idempotencyKey: key,
  });
}

/** Abandon one attempt (reveal/skip) with recorded practice time. */
async function abandon(
  service: LocalTrainingService,
  { programId = DEFAULT_PROGRAM_ID, collectionId = DEFAULT_COLLECTION_ID, puzzleId = 'p1', active = 10 }: CommitOptions = {},
) {
  const session = await service.startSession({ programId, collectionId });
  await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId, collectionId, puzzleId },
    expectedScheduleRevision: 0,
  });
  await service.abandonAttempt(session.session.sessionId, active);
}

test('scored time and practice time are measured separately (never mixed)', async () => {
  const { service } = await makeClockedService();
  await service.seedContent([makePuzzle({ id: 'p1' }), makePuzzle({ id: 'p2' })]);

  await commit(service, { puzzleId: 'p1', active: 30, correction: 5, key: 'scored' });
  await abandon(service, { puzzleId: 'p2', active: 10 });

  const stats = summarizeStats(service, 'all', 2_000);
  assert.equal(stats.totals.attempts, 2);
  assert.equal(stats.totals.solves, 1);
  assert.equal(stats.totals.failures, 0);
  assert.equal(stats.totals.unscored, 1);
  assert.equal(stats.totals.scoredSeconds, 30, 'headline is active time of scored attempts');
  assert.equal(stats.totals.practiceSeconds, 10, 'practice is reported on its own');
  assert.equal(stats.totals.correctionSeconds, 5, 'correction is separate');
  assert.equal(stats.totals.activeSeconds, 40);
});

test('a Woodpecker cycle does not double count its attempt seconds', async () => {
  const { service, setNow } = await makeClockedService(1_000);
  await service.seedContent([makePuzzle({ id: 'p1' })]);
  const set = await service.getOrCreateWoodpeckerSetForCollection(DEFAULT_COLLECTION_ID);
  const { cycleId } = await service.startWoodpeckerCycle(set.setId);

  // Cover the only puzzle five seconds later: the cycle then completes.
  setNow(6_000);
  await commit(service, {
    programId: WOODPECKER_CYCLE_PROGRAM_ID,
    collectionId: woodpeckerScopeId(set.setId),
    puzzleId: 'p1',
    active: 20,
    key: 'cycle',
  });
  // The cycle result carries the same active seconds as the attempt.
  await service.recordWoodpeckerCycleResult(cycleId, 'p1', 'clean', 20);

  const stats = summarizeStats(service, 'all', 7_000);
  assert.equal(stats.totals.scoredSeconds, 20, 'only the attempt contributes seconds');
  assert.equal(stats.cyclesStarted, 1);
  assert.equal(stats.cyclesCompleted, 1);
  assert.equal(stats.cycleWallClockSeconds, 5_000, 'wall clock is separate from active time');
  const row = stats.collections.find((c) => c.id === DEFAULT_COLLECTION_ID)!;
  assert.equal(row.woodpecker.activeSeconds, 20, 'attributed to the source collection');
  assert.equal(row.cyclesStarted, 1);
  assert.equal(row.cycleWallClockSeconds, 5_000);
});

test('per-collection rows reconcile with the overall totals', async () => {
  const { service } = await makeClockedService();
  await service.seedContent([makePuzzle({ id: 'p1' }), makePuzzle({ id: 'p2' })]);
  const second = await service.createCollection('Second');
  await service.addPuzzleToCollection(second.id, 'p2');

  await commit(service, { collectionId: DEFAULT_COLLECTION_ID, puzzleId: 'p1', active: 30, key: 'a' });
  await commit(service, { collectionId: second.id, puzzleId: 'p2', active: 12, key: 'b' });
  await abandon(service, { collectionId: second.id, puzzleId: 'p2', active: 8 });

  const stats = summarizeStats(service, 'all', 2_000);
  const sum = (pick: (row: (typeof stats.collections)[number]) => number) =>
    stats.collections.reduce((total, row) => total + pick(row), 0);

  assert.equal(sum((row) => row.total.scoredSeconds), stats.totals.scoredSeconds);
  assert.equal(sum((row) => row.total.practiceSeconds), stats.totals.practiceSeconds);
  assert.equal(sum((row) => row.total.attempts), stats.totals.attempts);

  const secondRow = stats.collections.find((row) => row.id === second.id)!;
  assert.equal(secondRow.spaced.scoredSeconds, 12);
  assert.equal(secondRow.spaced.practiceSeconds, 8);
  assert.equal(stats.collections[0]!.id, DEFAULT_COLLECTION_ID, 'largest active time first');
});

test('failed-review and unscored-review attempts stay in their own modes', async () => {
  const { service } = await makeClockedService();
  await service.seedContent([makePuzzle({ id: 'p1' })]);
  const set = await service.getOrCreateWoodpeckerSetForCollection(DEFAULT_COLLECTION_ID);
  const scope = woodpeckerScopeId(set.setId);

  await commit(service, { programId: WOODPECKER_FAILED_PROGRAM_ID, collectionId: scope, puzzleId: 'p1', active: 7, key: 'failed' });
  await abandon(service, { programId: WOODPECKER_REVIEW_PROGRAM_ID, collectionId: scope, puzzleId: 'p1', active: 4 });

  const stats = summarizeStats(service, 'all', 2_000);
  const mode = (key: string) => stats.modes.find((row) => row.key === key)!.totals;
  assert.equal(mode('failed').scoredSeconds, 7);
  assert.equal(mode('practice').practiceSeconds, 4);
  assert.equal(mode('spaced').attempts, 0);
  assert.equal(stats.totals.scoredSeconds, 7, 'unscored review is not scored training');
  assert.equal(stats.totals.practiceSeconds, 4);

  const row = stats.collections.find((c) => c.id === DEFAULT_COLLECTION_ID)!;
  assert.equal(row.failed.activeSeconds, 7, 'Woodpecker scope maps back to the collection');
  assert.equal(row.practice.activeSeconds, 4);
});

test('the range filter uses attempt start time', async () => {
  const now = 1_700_000_000_000;
  const { service, setNow } = await makeClockedService(now - 10 * DAY);
  await service.seedContent([makePuzzle({ id: 'p1' })]);

  await commit(service, { puzzleId: 'p1', active: 40, key: 'old' });
  setNow(now - 60 * 60 * 1000);
  await commit(service, { puzzleId: 'p1', active: 25, key: 'recent' });

  const week = summarizeStats(service, '7d', now);
  assert.equal(week.totals.scoredSeconds, 25, 'only the attempt inside 7 days counts');
  assert.equal(week.since, now - 7 * DAY);

  const all = summarizeStats(service, 'all', now);
  assert.equal(all.totals.scoredSeconds, 65);
  assert.equal(all.since, undefined);
});

test('in-flight attempts are excluded and untrustworthy timing is flagged', async () => {
  const { service } = await makeClockedService();
  await service.seedContent([makePuzzle({ id: 'p1' }), makePuzzle({ id: 'p2' })]);

  await commit(service, { puzzleId: 'p1', active: 15, trustworthy: false, key: 'untrusted' });
  const session = await service.startSession({ programId: DEFAULT_PROGRAM_ID, collectionId: DEFAULT_COLLECTION_ID });
  await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: DEFAULT_PROGRAM_ID, collectionId: DEFAULT_COLLECTION_ID, puzzleId: 'p2' },
    expectedScheduleRevision: 0,
  });

  const stats = summarizeStats(service, 'all', 2_000);
  assert.equal(stats.totals.attempts, 1);
  assert.equal(stats.totals.untrustedAttempts, 1);
  assert.equal(stats.openAttempts, 1, 'the open attempt is reported, not counted');
});

test('durations are formatted compactly with an em dash for zero', () => {
  assert.equal(formatStatDuration(0), '—');
  assert.equal(formatStatDuration(42), '42s');
  assert.equal(formatStatDuration(312), '5m 12s');
  assert.equal(formatStatDuration(3_900), '1h 05m');
});

test('abandoning through the adapter records the practice time', async () => {
  const { service } = await makeClockedService();
  await service.seedContent([makePuzzle({ id: 'p1' })]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession(DEFAULT_PROGRAM_ID, DEFAULT_COLLECTION_ID);
  await adapter.loadPuzzle('p1');
  await adapter.startAttempt(await adapter.loadPuzzle('p1'));

  await adapter.abandonCurrentAttempt({ skip: false, activeSeconds: 9 });

  const stats = summarizeStats(service, 'all', 2_000);
  assert.equal(stats.totals.unscored, 1);
  assert.equal(stats.totals.practiceSeconds, 9, 'reveal/skip time survives for the stats');
  assert.equal(stats.totals.scoredSeconds, 0, 'and never leaks into scored totals');
});
