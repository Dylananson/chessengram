/**
 * ONL-012 acceptance — two-device convergence over a fake server.
 *
 * Device A records attempt history (including a Woodpecker cycle with a
 * failure), pushes to a fake server, and device B pulls + applies. B's queue
 * summary, per-scope schedule states and failed-review queue must match A's,
 * and the reverse direction must work too. Re-running a sync changes nothing.
 *
 * No network, no cloud account: the transport is an in-memory fake and both
 * runtimes share one deterministic clock.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { SyncApiClient, SyncPushRequest, SyncPushResponse, SyncRecordEnvelope } from '../src/sync/types.ts';
import type { SyncEntityType } from '../src/sync/types.ts';
import type { SyncRuntime } from '../src/sync/bootstrap.ts';
import { createSyncRuntime } from '../src/sync/bootstrap.ts';
import { syncKeyStorage, syncStorage, LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import {
  LocalTrainingService,
  progressKeyToString,
  type QueueSummary,
} from '../src/scheduler-service.ts';
import { mutableClock } from '@chessengram/scheduler';
import type { ScheduleStateDetails } from '@chessengram/contracts';
import { makePuzzle } from './fixtures.ts';

const CONFIG = {
  apiBase: 'https://api.example.test',
  authAuthority: 'https://auth.example.test',
  authClientId: 'client-123',
};
const PROGRAM_ID = 'local-spaced-reps-v1';
const START = 1_700_000_000_000;

/** Poll until a pointer of `type` has been captured (capture is async). */
async function waitForPointer(store: LocalStore, type: SyncEntityType): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const entries = await store.loadSyncQueueEntries();
    if (entries.some((entry) => entry.type === type)) return;
    if (Date.now() > deadline) throw new Error(`no ${type} pointer was captured`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// --- fake server ------------------------------------------------------------

class FakeSyncServer implements SyncApiClient {
  private readonly rows = new Map<string, SyncRecordEnvelope>();
  private maxSeq = 0;
  signedIn = false;

  /**
   * When `true`, a strictly greater `(updatedAt, rev, deviceId)` for an
   * existing `dedupeKey` replaces the stored row (the design's LWW rule for
   * settings / collections / user puzzles) and gets a fresh `seq` so pullers
   * observe it. The default (`false`) is the worker's first-write-wins
   * behaviour for immutable types.
   */
  private readonly lww: boolean;

  constructor(lww = false) {
    this.lww = lww;
  }

  /** Server-side LWW winner test, mirroring `store.ts#winsLastWriteWins`. */
  private static wins(
    incoming: SyncRecordEnvelope,
    existing: SyncRecordEnvelope,
  ): boolean {
    const incomingRev = incoming.rev ?? 0;
    const existingRev = existing.rev ?? 0;
    if (incoming.updatedAt !== existing.updatedAt) {
      return incoming.updatedAt > existing.updatedAt;
    }
    if (incomingRev !== existingRev) return incomingRev > existingRev;
    return incoming.deviceId > existing.deviceId;
  }

  async getSession(): Promise<{ userId: string; expiresAt: number } | undefined> {
    return this.signedIn ? { userId: 'usr_1', expiresAt: START + 10_000_000 } : undefined;
  }

  async exchangeSession(): Promise<{ userId: string; expiresAt: number }> {
    this.signedIn = true;
    return { userId: 'usr_1', expiresAt: START + 10_000_000 };
  }

  async signOut(): Promise<void> {
    this.signedIn = false;
  }

  async registerDevice(): Promise<{ thumbprint: string }> {
    return { thumbprint: 'thumb' };
  }

  async listDevices(): Promise<Array<{ deviceId: string; addedAt: number }>> {
    return [];
  }

  async revokeDevice(): Promise<void> {}

  async deleteAccount(): Promise<void> {
    this.rows.clear();
    this.maxSeq = 0;
  }

  async push(request: SyncPushRequest): Promise<SyncPushResponse> {
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const envelope of request.push) {
      const existing = this.rows.get(envelope.dedupeKey);
      if (existing) {
        if (this.lww && FakeSyncServer.wins(envelope, existing)) {
          this.maxSeq += 1;
          this.rows.set(envelope.dedupeKey, { ...envelope, seq: this.maxSeq });
          accepted.push(envelope.dedupeKey);
          continue;
        }
        duplicates.push(envelope.dedupeKey);
        continue;
      }
      this.maxSeq += 1;
      this.rows.set(envelope.dedupeKey, { ...envelope, seq: this.maxSeq });
      accepted.push(envelope.dedupeKey);
    }
    const changes = [...this.rows.values()]
      .filter((row) => (row.seq ?? 0) > request.since)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return { cursor: this.maxSeq, accepted, duplicates, changes };
  }
}

// --- device rig -------------------------------------------------------------

interface Device {
  backend: InMemoryStorageBackend;
  store: LocalStore;
  service: LocalTrainingService;
  runtime: SyncRuntime;
}

function timing() {
  return {
    activeSolvingSeconds: 5,
    correctionSeconds: 0,
    interruptionSeconds: 0,
    hiddenSeconds: 0,
    timingTrustworthy: true,
  };
}

async function recordAttempt(
  service: LocalTrainingService,
  collectionId: string,
  puzzleId: string,
  outcome: 'success' | 'failure',
  idempotencyKey: string,
): Promise<void> {
  const session = await service.startSession({ programId: PROGRAM_ID, collectionId });
  const started = await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: PROGRAM_ID, collectionId, puzzleId },
  });
  await service.commitOutcome({
    attemptId: started.attemptId,
    outcome,
    timing: timing(),
    expectedScheduleRevision: started.scheduleRevision,
    idempotencyKey,
  });
}

function snapshot(device: Device, collectionId: string, setId: string) {
  const schedule = (puzzleId: string): ScheduleStateDetails | undefined =>
    device.service.getScheduleState(
      progressKeyToString({ programId: PROGRAM_ID, collectionId, puzzleId }),
    );
  const cycles = device.service
    .listWoodpeckerCycles(setId)
    .map(({ cycleId, cycle }) => ({
      cycleId,
      results: cycle.results.map((entry) => ({ ...entry })),
      completedAt: cycle.completedAt,
    }));
  return {
    summary: device.service.queueSummary(PROGRAM_ID, collectionId) as QueueSummary,
    p1: schedule('p1'),
    p2: schedule('p2'),
    failed: device.service.getWoodpeckerFailedPuzzleIds(setId),
    cycles,
    attempts: device.service.getAttemptCount(),
  };
}

// --- test -------------------------------------------------------------------

test('two devices converge in both directions and re-syncing is idempotent', async () => {
  const server = new FakeSyncServer();
  const clock = mutableClock(START);
  const puzzles = [makePuzzle({ id: 'p1' }), makePuzzle({ id: 'p2' })];
  const backendA = new InMemoryStorageBackend();
  const backendB = new InMemoryStorageBackend();

  const storeA = new LocalStore(backendA, clock);
  const serviceA = new LocalTrainingService({ store: storeA, clock });
  await serviceA.init();
  await serviceA.seedContent(puzzles);
  const collectionId = serviceA.getActiveCollectionId();

  const storeB = new LocalStore(backendB, clock);
  const serviceB = new LocalTrainingService({ store: storeB, clock });
  await serviceB.init();
  await serviceB.seedContent(puzzles);

  // A trains: a success and a later failure on p1, a success on p2, plus a
  // completed Woodpecker cycle with one failed puzzle.
  clock.advance(1_000);
  await recordAttempt(serviceA, collectionId, 'p1', 'success', 'a-1');
  clock.advance(60_000);
  await recordAttempt(serviceA, collectionId, 'p1', 'failure', 'a-2');
  clock.advance(60_000);
  await recordAttempt(serviceA, collectionId, 'p2', 'success', 'a-3');
  clock.advance(60_000);
  const set = await serviceA.getOrCreateWoodpeckerSetForCollection(collectionId);
  const { cycleId } = await serviceA.startWoodpeckerCycle(set.setId);
  await serviceA.recordWoodpeckerCycleResult(cycleId, 'p1', 'failed', 12);
  await serviceA.recordWoodpeckerCycleResult(cycleId, 'p2', 'clean', 7);

  // A opts in (adopts the history above).
  const runtimeA = createSyncRuntime({
    config: CONFIG,
    api: server,
    service: serviceA,
    storage: syncStorage(storeA),
    keyStorage: syncKeyStorage(storeA),
    clock: () => clock.now(),
  });
  await runtimeA.enable({ idToken: 'token-a' });

  // B is the same account: adopt A's master key + user salt, then reuse the
  // existing server session (no idToken) to link this device.
  const aSecrets = await storeA.loadSyncSecrets();
  const aState = await storeA.loadSyncState();
  assert.ok(aSecrets && aState);
  await storeB.saveSyncSecrets(aSecrets);
  await storeB.saveSyncState({ ...aState, deviceId: 'device-b', cursor: 0 });
  const runtimeB = createSyncRuntime({
    config: CONFIG,
    api: server,
    service: serviceB,
    storage: syncStorage(storeB),
    keyStorage: syncKeyStorage(storeB),
    clock: () => clock.now(),
  });
  await runtimeB.enable(); // session reuse: getSession(), never exchangeSession
  assert.equal((await runtimeB.state()).mode, 'syncing');

  const deviceA: Device = { backend: backendA, store: storeA, service: serviceA, runtime: runtimeA };
  const deviceB: Device = { backend: backendB, store: storeB, service: serviceB, runtime: runtimeB };

  // A pushes; B pulls and applies.
  await runtimeA.syncNow();
  const pulled = await runtimeB.pullOnly!();
  assert.ok(pulled.applied > 0, 'B applied A’s records');
  assert.equal(pulled.skipped, 0, 'nothing was skipped');

  const afterPull = snapshot(deviceB, collectionId, set.setId);
  assert.ok(afterPull.p1 !== undefined && afterPull.p2 !== undefined, 'B rebuilt both schedules');
  assert.ok(afterPull.summary.learned >= 2, 'B learned the same puzzles A did');
  assert.deepEqual(afterPull.failed, ['p1'], 'B sees the cycle failure');
  assert.deepEqual(
    afterPull,
    snapshot(deviceA, collectionId, set.setId),
    'device B matches device A after the inbound apply',
  );

  // Independent check: replay A's attempt log from scratch in a third runtime
  // and prove B's rebuilt schedules equal that pure replay (not just A's device).
  const referenceStore = new LocalStore(new InMemoryStorageBackend(), clock);
  const reference = new LocalTrainingService({ store: referenceStore, clock });
  await reference.init();
  await reference.seedContent(puzzles);
  await reference.applyRemoteAttempts(
    serviceA.listAttempts({ limit: serviceA.getAttemptCount() }),
  );
  const key = (puzzleId: string) =>
    progressKeyToString({ programId: PROGRAM_ID, collectionId, puzzleId });
  assert.deepEqual(reference.getScheduleState(key('p1')), afterPull.p1);
  assert.deepEqual(reference.getScheduleState(key('p2')), afterPull.p2);

  // Reverse direction: B trains, re-adopts (session reuse) and pushes; A pulls.
  clock.advance(60_000);
  await recordAttempt(serviceB, collectionId, 'p2', 'success', 'b-1');
  await runtimeB.enable(); // adopt B's new attempt for the queue
  await runtimeB.syncNow();
  const pulledA = await runtimeA.pullOnly!();
  assert.ok(pulledA.applied > 0, 'A applied B’s record');
  assert.equal(pulledA.skipped, 0);

  assert.deepEqual(
    snapshot(deviceA, collectionId, set.setId),
    snapshot(deviceB, collectionId, set.setId),
    'the reverse direction converges too',
  );

  // ONL-013: a change made AFTER enable is captured automatically — no
  // re-adoption (a second `enable()`) is needed to get it onto the wire.
  await runtimeA.syncNow(); // drain A's queue so the next capture is unambiguous
  clock.advance(60_000);
  await recordAttempt(serviceA, collectionId, 'p1', 'success', 'a-post-enable');
  await waitForPointer(storeA, 'attempt');
  await runtimeA.syncNow();
  const pulledPost = await runtimeB.pullOnly!();
  assert.ok(pulledPost.applied > 0, 'B applied the post-enable change');
  assert.deepEqual(
    snapshot(deviceA, collectionId, set.setId),
    snapshot(deviceB, collectionId, set.setId),
    'the post-enable change reached the other device without re-enabling',
  );

  // Idempotency: re-deliver every change (cursor reset) and prove nothing moves.
  const before = JSON.stringify(snapshot(deviceB, collectionId, set.setId));
  const bState = await storeB.loadSyncState();
  assert.ok(bState);
  await storeB.saveSyncState({ ...bState, cursor: 0 });
  const replay = await runtimeB.pullOnly!();
  assert.equal(replay.applied, 0, 'everything already applied is a duplicate');
  assert.equal(replay.skipped, 0);
  assert.ok(replay.duplicates > 0);
  assert.equal(
    JSON.stringify(snapshot(deviceB, collectionId, set.setId)),
    before,
    're-running B’s sync changes nothing',
  );

  runtimeA.dispose?.();
  runtimeB.dispose?.();
});

test('a user-puzzle deletion on one device removes it on the other', async () => {
  const server = new FakeSyncServer(true);
  const clock = mutableClock(START);
  const bundled = [makePuzzle({ id: 'p1' })];

  const storeA = new LocalStore(new InMemoryStorageBackend(), clock);
  const serviceA = new LocalTrainingService({ store: storeA, clock });
  await serviceA.init();
  await serviceA.seedContent(bundled);

  const storeB = new LocalStore(new InMemoryStorageBackend(), clock);
  const serviceB = new LocalTrainingService({ store: storeB, clock });
  await serviceB.init();
  await serviceB.seedContent(bundled);

  const runtimeA = createSyncRuntime({
    config: CONFIG,
    api: server,
    service: serviceA,
    storage: syncStorage(storeA),
    keyStorage: syncKeyStorage(storeA),
    clock: () => clock.now(),
  });
  await runtimeA.enable({ idToken: 'token-a' });

  const aSecrets = await storeA.loadSyncSecrets();
  const aState = await storeA.loadSyncState();
  assert.ok(aSecrets && aState);
  await storeB.saveSyncSecrets(aSecrets);
  await storeB.saveSyncState({ ...aState, deviceId: 'device-b', cursor: 0 });
  const runtimeB = createSyncRuntime({
    config: CONFIG,
    api: server,
    service: serviceB,
    storage: syncStorage(storeB),
    keyStorage: syncKeyStorage(storeB),
    clock: () => clock.now(),
  });
  await runtimeB.enable();

  // A authors a user puzzle; B pulls it.
  clock.advance(60_000);
  await serviceA.upsertPuzzles([makePuzzle({ id: 'user-1', source: 'user' })]);
  await waitForPointer(storeA, 'userPuzzle');
  await runtimeA.syncNow();
  const pulledCreate = await runtimeB.pullOnly!();
  assert.ok(pulledCreate.applied > 0, 'B applied the user-puzzle create');
  assert.ok(serviceB.getPuzzle('user-1'), 'B received the user puzzle');

  // A deletes it; the tombstone must propagate and remove it on B too. The
  // delete lands in a later hour so its wire `updatedAt` is strictly newer.
  clock.advance(2 * 60 * 60 * 1000);
  await serviceA.removePuzzle('user-1');
  await waitForPointer(storeA, 'userPuzzle');
  await runtimeA.syncNow();
  const pulledDelete = await runtimeB.pullOnly!();
  assert.ok(pulledDelete.applied > 0, 'B applied the tombstone');
  assert.equal(serviceB.getPuzzle('user-1'), undefined, 'B removed the deleted puzzle');
  assert.ok(serviceB.getPuzzle('p1'), 'bundled content is untouched by the removal');

  // Re-delivering the delete changes nothing.
  const before = serviceB.getAttemptCount();
  const replay = await runtimeB.pullOnly!();
  assert.equal(replay.applied, 0, 'the delete is idempotent');
  assert.equal(serviceB.getPuzzle('user-1'), undefined);
  assert.equal(serviceB.getAttemptCount(), before, 'no history was lost');

  runtimeA.dispose?.();
  runtimeB.dispose?.();
});

test('a same-millisecond double edit to one record propagates via the rev counter', async () => {
  // ONL-016: two edits to the same record with an identical wire `updatedAt`
  // (and identical `deviceId`) used to tie on the server and drop the second.
  // The per-device `rev` makes the second win, and the other device pulls it.
  const server = new FakeSyncServer(true);
  const clock = mutableClock(START);
  const bundled = [makePuzzle({ id: 'p1' })];

  const storeA = new LocalStore(new InMemoryStorageBackend(), clock);
  const serviceA = new LocalTrainingService({ store: storeA, clock });
  await serviceA.init();
  await serviceA.seedContent(bundled);

  const storeB = new LocalStore(new InMemoryStorageBackend(), clock);
  const serviceB = new LocalTrainingService({ store: storeB, clock });
  await serviceB.init();
  await serviceB.seedContent(bundled);

  const runtimeA = createSyncRuntime({
    config: CONFIG,
    api: server,
    service: serviceA,
    storage: syncStorage(storeA),
    keyStorage: syncKeyStorage(storeA),
    clock: () => clock.now(),
  });
  await runtimeA.enable({ idToken: 'token-a' });

  const aSecrets = await storeA.loadSyncSecrets();
  const aState = await storeA.loadSyncState();
  assert.ok(aSecrets && aState);
  await storeB.saveSyncSecrets(aSecrets);
  await storeB.saveSyncState({ ...aState, deviceId: 'device-b', cursor: 0 });
  const runtimeB = createSyncRuntime({
    config: CONFIG,
    api: server,
    service: serviceB,
    storage: syncStorage(storeB),
    keyStorage: syncKeyStorage(storeB),
    clock: () => clock.now(),
  });
  await runtimeB.enable();

  // Drain A's adoption at START (the clock never advances in this test).
  await runtimeA.syncNow();
  const initialLimit = serviceA.getCuratedSettings().newIntroductionLimitPerDay;
  assert.notEqual(initialLimit, 22, 'the target value differs from the default');

  // Edit 1: same exact millisecond as adoption.
  await serviceA.applyCuratedSettings({
    ...serviceA.getCuratedSettings(),
    newIntroductionLimitPerDay: 11,
  });
  await waitForPointer(storeA, 'setting');
  await runtimeA.syncNow();

  // Edit 2: still the same millisecond, so the wire `updatedAt` is unchanged.
  await serviceA.applyCuratedSettings({
    ...serviceA.getCuratedSettings(),
    newIntroductionLimitPerDay: 22,
  });
  await waitForPointer(storeA, 'setting');
  await runtimeA.syncNow();

  // B pulls once, after both edits: the server kept only the newer row, so B
  // receives edit 2 — the same-millisecond second edit was not dropped.
  const pulled = await runtimeB.pullOnly!();
  assert.ok(pulled.applied > 0, 'B applied the surviving setting');
  assert.equal(
    serviceB.getCuratedSettings().newIntroductionLimitPerDay,
    22,
    'the second same-millisecond edit won on the other device',
  );
  assert.equal(
    serviceA.getCuratedSettings().newIntroductionLimitPerDay,
    22,
    'A keeps its own newest edit',
  );

  runtimeA.dispose?.();
  runtimeB.dispose?.();
});

test('a same-millisecond double edit applies on a device that already saw the first edit', async () => {
  // ONL-017: B pulls edit 1, then A makes a second same-millisecond edit (same
  // device, higher `rev`). B's inbound merge must order by the wire `rev`, not
  // only `(updatedAt, updatedBy)` — otherwise it treats edit 2 as a duplicate
  // and keeps the stale content, silently defeating the `rev` counter.
  const server = new FakeSyncServer(true);
  const clock = mutableClock(START);
  const bundled = [makePuzzle({ id: 'p1' })];

  const storeA = new LocalStore(new InMemoryStorageBackend(), clock);
  const serviceA = new LocalTrainingService({ store: storeA, clock });
  await serviceA.init();
  await serviceA.seedContent(bundled);

  const storeB = new LocalStore(new InMemoryStorageBackend(), clock);
  const serviceB = new LocalTrainingService({ store: storeB, clock });
  await serviceB.init();
  await serviceB.seedContent(bundled);

  const runtimeA = createSyncRuntime({
    config: CONFIG,
    api: server,
    service: serviceA,
    storage: syncStorage(storeA),
    keyStorage: syncKeyStorage(storeA),
    clock: () => clock.now(),
  });
  await runtimeA.enable({ idToken: 'token-a' });

  const aSecrets = await storeA.loadSyncSecrets();
  const aState = await storeA.loadSyncState();
  assert.ok(aSecrets && aState);
  await storeB.saveSyncSecrets(aSecrets);
  await storeB.saveSyncState({ ...aState, deviceId: 'device-b', cursor: 0 });
  const runtimeB = createSyncRuntime({
    config: CONFIG,
    api: server,
    service: serviceB,
    storage: syncStorage(storeB),
    keyStorage: syncKeyStorage(storeB),
    clock: () => clock.now(),
  });
  await runtimeB.enable();

  // Drain A's adoption at START (the clock never advances in this test).
  await runtimeA.syncNow();

  // Edit 1: same exact millisecond as adoption.
  await serviceA.applyCuratedSettings({
    ...serviceA.getCuratedSettings(),
    newIntroductionLimitPerDay: 11,
  });
  await waitForPointer(storeA, 'setting');
  await runtimeA.syncNow();

  // B applies edit 1 first, so it now holds an LWW stamp for that millisecond.
  const pulledFirst = await runtimeB.pullOnly!();
  assert.ok(pulledFirst.applied > 0, 'B applied the first edit');
  assert.equal(
    serviceB.getCuratedSettings().newIntroductionLimitPerDay,
    11,
    'B holds the first edit',
  );

  // Edit 2: still the same millisecond, so `updatedAt` and `updatedBy` are
  // unchanged; only the per-device `rev` is higher.
  await serviceA.applyCuratedSettings({
    ...serviceA.getCuratedSettings(),
    newIntroductionLimitPerDay: 22,
  });
  await waitForPointer(storeA, 'setting');
  await runtimeA.syncNow();

  // B pulls again: the second edit must win on `rev`, not be a duplicate.
  const pulledSecond = await runtimeB.pullOnly!();
  assert.ok(pulledSecond.applied > 0, 'B applied the second same-millisecond edit');
  assert.equal(
    serviceB.getCuratedSettings().newIntroductionLimitPerDay,
    22,
    'B ends on the second edit’s content',
  );

  runtimeA.dispose?.();
  runtimeB.dispose?.();
});
