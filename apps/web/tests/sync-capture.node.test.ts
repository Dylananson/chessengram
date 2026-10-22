/**
 * ONL-013 — local change capture tests (Node, no network, fake transport).
 *
 * Drives a real `LocalTrainingService` through the sync runtime:
 * - every source-record mutation enqueues exactly one coalesced pointer,
 * - derived writes (schedules/sessions/meta/events) enqueue nothing,
 * - remote applies are suppressed, so an applied change is never re-enqueued
 *   (no echo loop),
 * - `dispose()` unsubscribes the observer.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AttemptRecord } from '@chessengram/contracts';
import type { WoodpeckerCycle } from '@chessengram/scheduler';
import { mutableClock } from '@chessengram/scheduler';
import type { SyncApiClient, SyncPushRequest, SyncPushResponse } from '../src/sync/types.ts';
import {
  createSyncRuntime,
  woodpeckerResultRecordId,
  type SyncRuntime,
} from '../src/sync/bootstrap.ts';
import {
  DEFAULT_COLLECTION_ID,
  LocalStore,
  syncKeyStorage,
  syncStorage,
} from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { LocalTrainingService } from '../src/scheduler-service.ts';
import { makePuzzle, timing } from './fixtures.ts';

const CONFIG = {
  apiBase: 'https://api.example.test',
  authAuthority: 'https://auth.example.test',
  authClientId: 'client-123',
};
const PROGRAM_ID = 'local-spaced-reps-v1';
const START = 1_700_000_000_000;

/** Accepts every pointer and returns no remote changes. */
class AcceptAllApi implements SyncApiClient {
  pushes = 0;

  async getSession(): Promise<{ userId: string; expiresAt: number }> {
    return { userId: 'usr_1', expiresAt: START + 10_000_000 };
  }

  async exchangeSession(): Promise<{ userId: string; expiresAt: number }> {
    return { userId: 'usr_1', expiresAt: START + 10_000_000 };
  }

  async signOut(): Promise<void> {}

  async registerDevice(): Promise<{ thumbprint: string }> {
    return { thumbprint: 'thumb' };
  }

  async listDevices(): Promise<Array<{ deviceId: string; addedAt: number }>> {
    return [];
  }

  async revokeDevice(): Promise<void> {}

  async deleteAccount(): Promise<void> {}

  async push(request: SyncPushRequest): Promise<SyncPushResponse> {
    this.pushes += 1;
    return {
      cursor: request.since + request.push.length,
      accepted: request.push.map((envelope) => envelope.dedupeKey),
      duplicates: [],
      changes: [],
    };
  }
}

interface Rig {
  clock: ReturnType<typeof mutableClock>;
  store: LocalStore;
  service: LocalTrainingService;
  runtime: SyncRuntime;
}

/** Enabled runtime over a real service + store, with the adoption queue drained. */
async function rig(): Promise<Rig> {
  const clock = mutableClock(START);
  const store = new LocalStore(new InMemoryStorageBackend(), clock);
  const service = new LocalTrainingService({ store, clock });
  await service.init();
  await service.seedContent([makePuzzle({ id: 'p1' }), makePuzzle({ id: 'p2' })]);
  const runtime = createSyncRuntime({
    config: CONFIG,
    api: new AcceptAllApi(),
    service,
    storage: syncStorage(store),
    keyStorage: syncKeyStorage(store),
    clock: () => clock.now(),
  });
  await runtime.enable({ idToken: 'token' });
  await runtime.syncNow(); // drain adoption
  return { clock, store, service, runtime };
}

/** Let the async capture path (storage.load → queue.enqueue) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Pending pointers as sorted `type:recordId` keys. */
async function pending(store: LocalStore): Promise<string[]> {
  const entries = await store.loadSyncQueueEntries();
  return entries.map((entry) => `${entry.type}:${entry.recordId}`).sort();
}

function remoteAttempt(id: string): AttemptRecord {
  return {
    attemptSchemaVersion: '1.0.0',
    attemptId: { value: id },
    progressKey: { programId: PROGRAM_ID, puzzleId: 'p1', collectionId: DEFAULT_COLLECTION_ID },
    sessionId: 'sync',
    scheduleRevisionBefore: 0,
    contentHash: 'p1:1.0.0:fen',
    startingFen: 'fen',
    outcome: 'success',
    timing: timing(),
    events: [],
    startedAt: START,
    completedAt: START + 1_000,
    settingsHash: 'sync',
  };
}

function remoteCycle(): WoodpeckerCycle {
  return {
    setId: 'remote-set',
    cycleNumber: 1,
    puzzleIds: ['p1'],
    startedAt: START,
    results: [],
  };
}

test('attempt mutations enqueue one attempt pointer each (success/failure/correction/abandon)', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.dispose?.());

  const session = await r.service.startSession({
    programId: PROGRAM_ID,
    collectionId: DEFAULT_COLLECTION_ID,
  });
  const key = { programId: PROGRAM_ID, collectionId: DEFAULT_COLLECTION_ID, puzzleId: 'p1' };

  const a1 = await r.service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: key,
    expectedScheduleRevision: 0,
  });
  await r.service.commitOutcome({
    attemptId: a1.attemptId,
    outcome: 'success',
    timing: timing({ activeSolvingSeconds: 4 }),
    expectedScheduleRevision: a1.scheduleRevision,
    idempotencyKey: 'success-1',
  });
  await flush();
  assert.deepEqual(await pending(r.store), [`attempt:${a1.attemptId.value}`]);

  await r.runtime.syncNow();
  const a2 = await r.service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { ...key, puzzleId: 'p2' },
    expectedScheduleRevision: 0,
  });
  await r.service.commitOutcome({
    attemptId: a2.attemptId,
    outcome: 'failure',
    failureReason: 'wrong-move',
    timing: timing(),
    expectedScheduleRevision: a2.scheduleRevision,
    idempotencyKey: 'failure-1',
  });
  await flush();
  assert.deepEqual(await pending(r.store), [`attempt:${a2.attemptId.value}`]);

  await r.runtime.syncNow();
  await r.service.finishCorrection({
    attemptId: a2.attemptId,
    timing: timing({ correctionSeconds: 3 }),
    idempotencyKey: 'correction-1',
  });
  await flush();
  assert.deepEqual(await pending(r.store), [`attempt:${a2.attemptId.value}`]);

  await r.runtime.syncNow();
  const a3 = await r.service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: key,
    expectedScheduleRevision: 0,
  });
  await flush();
  assert.deepEqual(await pending(r.store), [], 'startAttempt is not a captured source mutation');

  await r.service.abandonAttempt(session.session.sessionId, 2);
  await flush();
  assert.deepEqual(await pending(r.store), [`attempt:${a3.attemptId.value}`]);
});

test('collection mutations enqueue one collection pointer each', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.dispose?.());

  const created = await r.service.createCollection('Endgames');
  await flush();
  assert.deepEqual(await pending(r.store), [`collection:${created.id}`]);

  await r.runtime.syncNow();
  await r.service.renameCollection(created.id, 'Endgame drills');
  await flush();
  assert.deepEqual(await pending(r.store), [`collection:${created.id}`]);

  await r.runtime.syncNow();
  await r.service.addPuzzleToCollection(created.id, 'p1');
  await flush();
  assert.deepEqual(await pending(r.store), [`collection:${created.id}`]);

  await r.runtime.syncNow();
  await r.service.addPuzzleToCollection(created.id, 'p1'); // duplicate membership
  await flush();
  assert.deepEqual(await pending(r.store), [], 'a no-op membership add is not captured');

  await r.runtime.syncNow();
  await r.service.removePuzzleFromCollection(created.id, 'p1');
  await flush();
  assert.deepEqual(await pending(r.store), [`collection:${created.id}`]);

  await r.runtime.syncNow();
  await r.service.deleteCollection(created.id);
  await flush();
  assert.deepEqual(await pending(r.store), [`collection:${created.id}`]);
});

test('Woodpecker set, cycle and result mutations enqueue their pointers', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.dispose?.());

  const set = await r.service.getOrCreateWoodpeckerSetForCollection(DEFAULT_COLLECTION_ID);
  await flush();
  assert.deepEqual(await pending(r.store), [`woodpecker:${set.setId}`]);

  await r.runtime.syncNow();
  const { cycleId } = await r.service.startWoodpeckerCycle(set.setId);
  await flush();
  assert.deepEqual(await pending(r.store), [`woodpecker:${cycleId}`]);

  await r.runtime.syncNow();
  await r.service.recordWoodpeckerCycleResult(cycleId, 'p1', 'clean', 3);
  await flush();
  assert.deepEqual(await pending(r.store), [
    `woodpeckerResult:${woodpeckerResultRecordId(cycleId, 'p1')}`,
  ]);
});

test('applying curated settings enqueues the single setting pointer', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.dispose?.());

  await r.service.applyCuratedSettings({
    ...r.service.getCuratedSettings(),
    failurePreset: 'step-back',
  });
  await flush();
  assert.deepEqual(await pending(r.store), ['setting:scheduler']);
});

test('only user-authored puzzles are captured (bundled content is not)', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.dispose?.());

  await r.service.upsertPuzzles([makePuzzle({ id: 'lib-1' })]);
  await flush();
  assert.deepEqual(await pending(r.store), [], 'bundled content is not user data');

  await r.runtime.syncNow();
  await r.service.upsertPuzzles([makePuzzle({ id: 'user-1', source: 'user' })]);
  await flush();
  assert.deepEqual(await pending(r.store), ['userPuzzle:user-1']);

  await r.runtime.syncNow();
  await r.service.removePuzzle('user-1');
  await flush();
  assert.deepEqual(await pending(r.store), ['userPuzzle:user-1'], 'user-puzzle removal is captured');

  await r.runtime.syncNow();
  await r.service.removePuzzle('lib-1');
  await flush();
  assert.deepEqual(await pending(r.store), [], 'removing bundled content is not captured');
});

test('changes made while paused are queued and pushed once the session recovers', async (t) => {
  const clock = mutableClock(START);
  const store = new LocalStore(new InMemoryStorageBackend(), clock);
  const service = new LocalTrainingService({ store, clock });
  await service.init();
  await service.seedContent([makePuzzle({ id: 'p1' })]);

  let fail401 = false;
  class FlakyApi implements SyncApiClient {
    pushes = 0;
    async getSession(): Promise<{ userId: string; expiresAt: number }> {
      return { userId: 'usr_1', expiresAt: START + 10_000_000 };
    }
    async exchangeSession(): Promise<{ userId: string; expiresAt: number }> {
      return { userId: 'usr_1', expiresAt: START + 10_000_000 };
    }
    async signOut(): Promise<void> {}
    async registerDevice(): Promise<{ thumbprint: string }> {
      return { thumbprint: 'thumb' };
    }
    async listDevices(): Promise<Array<{ deviceId: string; addedAt: number }>> {
      return [];
    }
    async revokeDevice(): Promise<void> {}
    async deleteAccount(): Promise<void> {}
    async push(request: SyncPushRequest): Promise<SyncPushResponse> {
      if (fail401) throw Object.assign(new Error('unauthenticated'), { status: 401 });
      this.pushes += 1;
      return {
        cursor: request.since + request.push.length,
        accepted: request.push.map((envelope) => envelope.dedupeKey),
        duplicates: [],
        changes: [],
      };
    }
  }

  const api = new FlakyApi();
  const runtime = createSyncRuntime({
    config: CONFIG,
    api,
    service,
    storage: syncStorage(store),
    keyStorage: syncKeyStorage(store),
    clock: () => clock.now(),
  });
  await runtime.enable({ idToken: 'token' });
  await runtime.syncNow(); // drain adoption while healthy
  assert.deepEqual(await pending(store), [], 'adoption drained before pausing');

  // A 401 pauses the session; the queue is empty at this point.
  fail401 = true;
  await runtime.syncNow();
  assert.equal((await runtime.state()).mode, 'paused');

  // A change made while paused must still be recorded, not dropped.
  const created = await service.createCollection('Paused work');
  await flush();
  assert.deepEqual(
    await pending(store),
    [`collection:${created.id}`],
    'paused work is queued while the session is down',
  );

  // Recovery: the queued pointer is pushed, not lost.
  fail401 = false;
  await runtime.enable(); // session reuse clears paused
  await runtime.syncNow();
  assert.ok(api.pushes > 0, 'the queued change was pushed after recovery');
  assert.deepEqual(await pending(store), [], 'the queue drains once the session recovers');
  runtime.dispose?.();
});

test('rapid changes to one record coalesce into a single newest pointer', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.dispose?.());

  const created = await r.service.createCollection('One');
  await flush();
  const first = (await r.store.loadSyncQueueEntries()).find((entry) => entry.recordId === created.id);
  assert.ok(first);
  const firstChangedAt = first.changedAt;

  r.clock.advance(1_000);
  await r.service.renameCollection(created.id, 'Two');
  r.clock.advance(1_000);
  await r.service.renameCollection(created.id, 'Three');
  await flush();

  const entries = (await r.store.loadSyncQueueEntries()).filter(
    (entry) => entry.type === 'collection' && entry.recordId === created.id,
  );
  assert.equal(entries.length, 1, 'one pointer per (type, recordId)');
  assert.ok(entries[0]!.changedAt > firstChangedAt, 'the newest change time wins');
  assert.equal(entries[0]!.changedAt, r.clock.now());
});

test('remote applies notify no observer and enqueue nothing (echo suppression)', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.dispose?.());

  const observed: string[] = [];
  const unsubscribe = r.service.onLocalChange((change) =>
    observed.push(`${change.type}:${change.recordId}`),
  );

  await r.service.applyRemoteAttempts([remoteAttempt('remote-attempt')]);
  await r.service.applyRemoteCollection('remote-collection', {
    id: 'remote-collection',
    name: 'Remote',
    puzzleIds: [],
    createdAt: START,
  });
  await r.service.applyRemoteWoodpeckerSet({
    setId: 'remote-set',
    name: 'Remote set',
    sourceCollectionId: DEFAULT_COLLECTION_ID,
    puzzleIds: ['p1'],
    createdAt: START,
  });
  await r.service.applyRemoteWoodpeckerCycle('remote-cycle', remoteCycle());
  await r.service.applyRemotePuzzle(makePuzzle({ id: 'remote-puzzle', source: 'user' }));
  await r.service.applyRemoteSettings('scheduler', { failurePreset: 'step-back' });
  await flush();

  assert.deepEqual(observed, [], 'no observer fired during a remote apply');
  assert.deepEqual(await pending(r.store), [], 'nothing was re-enqueued');
  unsubscribe();
});

test('derived writes (session, schedule, event, active collection) enqueue nothing', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.dispose?.());

  const session = await r.service.startSession({
    programId: PROGRAM_ID,
    collectionId: DEFAULT_COLLECTION_ID,
  });
  const started = await r.service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: PROGRAM_ID, collectionId: DEFAULT_COLLECTION_ID, puzzleId: 'p1' },
    expectedScheduleRevision: 0,
  });
  await r.service.recordEvent({
    attemptId: started.attemptId,
    event: { eventId: 'e1', type: 'move', occurredAt: START },
  });
  await r.service.setActiveCollectionId(DEFAULT_COLLECTION_ID);
  await flush();

  assert.deepEqual(await pending(r.store), []);
});

test('dispose unsubscribes the observer and is idempotent', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.dispose?.());

  r.runtime.dispose?.();
  r.runtime.dispose?.();

  await r.service.createCollection('After dispose');
  await flush();
  assert.deepEqual(await pending(r.store), [], 'no capture after dispose');
});
