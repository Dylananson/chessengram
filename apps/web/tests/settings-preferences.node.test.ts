import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LocalTrainingService } from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import {
  CURATED_DEFAULTS,
  fromCurated,
  parseCurated,
  toCurated,
} from '../src/settings-preferences.ts';
import { makePuzzle, PROGRAM_ID } from './fixtures.ts';

async function serviceWith(
  settings: Partial<import('@chessengram/scheduler').SchedulerSettings> = {},
  backend = new InMemoryStorageBackend(),
): Promise<LocalTrainingService> {
  const service = new LocalTrainingService({ store: new LocalStore(backend), settings });
  await service.init();
  return service;
}

test('parseCurated clamps out-of-range values and rejects unknown presets', () => {
  const parsed = parseCurated({
    failurePreset: 'bogus',
    stepBackAmount: 999,
    retryRetainAmount: -5,
    newIntroductionLimitPerDay: 100000,
    relearningMinutes: 0,
    timingEnabled: 'yes',
  });
  assert.equal(parsed.failurePreset, CURATED_DEFAULTS.failurePreset);
  assert.equal(parsed.stepBackAmount, 10);
  assert.equal(parsed.retryRetainAmount, 0);
  assert.equal(parsed.newIntroductionLimitPerDay, 999);
  assert.equal(parsed.relearningMinutes, 1);
  assert.equal(parsed.timingEnabled, CURATED_DEFAULTS.timingEnabled);
});

test('the new-per-day default is 100 and an explicitly stored 10 survives', () => {
  assert.equal(CURATED_DEFAULTS.newIntroductionLimitPerDay, 100);
  assert.equal(parseCurated({}).newIntroductionLimitPerDay, 100);
  assert.equal(parseCurated({ newIntroductionLimitPerDay: 10 }).newIntroductionLimitPerDay, 10);
});

test('fromCurated only toggles timing.enabled and keeps the rest of the policy', () => {
  const settings = fromCurated({ ...CURATED_DEFAULTS, timingEnabled: false });
  assert.equal(settings.timing.enabled, false);
  assert.equal(settings.timing.coefficient, 0.1);
  assert.equal(settings.timing.secondsPerMove, 15);
  assert.deepEqual(toCurated(settings), { ...CURATED_DEFAULTS, timingEnabled: false });
});

test('curated settings persist across a reload on the same backend', async () => {
  const backend = new InMemoryStorageBackend();
  const first = await serviceWith({}, backend);
  await first.applyCuratedSettings({
    ...CURATED_DEFAULTS,
    failurePreset: 'step-back',
    stepBackAmount: 3,
    newIntroductionLimitPerDay: 7,
    relearningMinutes: 25,
    timingEnabled: false,
  });

  const reloaded = new LocalTrainingService({ store: new LocalStore(backend) });
  await reloaded.init();
  assert.deepEqual(reloaded.getCuratedSettings(), {
    failurePreset: 'step-back',
    stepBackAmount: 3,
    retryRetainAmount: 0,
    newIntroductionLimitPerDay: 7,
    timingEnabled: false,
    relearningMinutes: 25,
  });
});

test('the new-per-day cap stops introducing new puzzles once reached', async () => {
  const service = await serviceWith({ newIntroductionLimitPerDay: 1 });
  await service.seedContent([makePuzzle({ id: 'p1' }), makePuzzle({ id: 'p2' }), makePuzzle({ id: 'p3' })]);
  const session = await service.startSession({ programId: PROGRAM_ID });

  assert.equal(
    (await service.selectNext({ sessionId: session.session.sessionId, programId: PROGRAM_ID })).puzzleId,
    'p1',
  );

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
    idempotencyKey: 'cap-1',
    expectedScheduleRevision: started.scheduleRevision,
  });

  const continued = await service.selectNext({ sessionId: session.session.sessionId, programId: PROGRAM_ID });
  assert.equal(continued.puzzleId, 'p1', 'continue with the scheduled future review without introducing new puzzles');

  await service.applyCuratedSettings({ ...CURATED_DEFAULTS, newIntroductionLimitPerDay: 10 });
  const allowed = await service.selectNext({ sessionId: session.session.sessionId, programId: PROGRAM_ID });
  assert.equal(allowed.puzzleId, 'p2', 'raising the cap allows the next new puzzle');
});
