import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_PROGRAM_ID,
  LocalTrainingService,
  progressKeyToString,
} from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { parseExport } from '../src/storage/data-port.ts';
import { CollectionsView } from '../src/collections-view.ts';
import { setLocale } from '../src/i18n.ts';
import { makePuzzle, makeService, PROGRAM_ID, timing } from './fixtures.ts';

const a = makePuzzle({ id: 'a' });
const b = makePuzzle({ id: 'b' });

async function seedDefault() {
  const service = await makeService();
  await service.seedContent([a, b]);
  return service;
}

async function startAndSucceed(
  service: Awaited<ReturnType<typeof makeService>>,
  sessionId: string,
  puzzleId: string,
  collectionId: string,
  keySuffix: string,
) {
  const started = await service.startAttempt({
    sessionId,
    progressKey: { programId: PROGRAM_ID, puzzleId, collectionId },
    expectedScheduleRevision: 0,
  });
  const committed = await service.commitOutcome({
    attemptId: started.attemptId,
    outcome: 'success',
    timing: timing(),
    expectedScheduleRevision: started.scheduleRevision,
    idempotencyKey: `ok-${keySuffix}`,
  });
  assert.equal(committed.committed, true);
  return started.attemptId;
}

test('progressKeyToString scopes by collection, defaulting when absent', () => {
  assert.equal(
    progressKeyToString({ programId: 'p', puzzleId: 'z', collectionId: 'c' }),
    'p:c:z',
  );
  assert.equal(
    progressKeyToString({ programId: 'p', puzzleId: 'z' }),
    `p:${DEFAULT_COLLECTION_ID}:z`,
  );
});

test('seedContent seeds the bundled library into the default collection', async () => {
  const service = await seedDefault();
  const record = service.getCollection(DEFAULT_COLLECTION_ID);
  assert.ok(record);
  assert.deepEqual(record.puzzleIds, ['a', 'b']);
  assert.equal(service.getActiveCollectionId(), DEFAULT_COLLECTION_ID);
});

test('the same puzzle trains independently in two collections', async () => {
  const service = await seedDefault();
  const second = await service.createCollection('Second');
  await service.addPuzzleToCollection(second.id, 'a');
  const session = await service.startSession({ programId: PROGRAM_ID });

  await startAndSucceed(service, session.session.sessionId, 'a', DEFAULT_COLLECTION_ID, 'def');

  assert.notEqual(
    service.getScheduleState(`${PROGRAM_ID}:${DEFAULT_COLLECTION_ID}:a`)?.state,
    'new',
  );
  assert.equal(
    service.getScheduleState(`${PROGRAM_ID}:${second.id}:a`),
    undefined,
    'no cross-collection leakage',
  );

  const next = await service.selectNext({
    sessionId: session.session.sessionId,
    programId: PROGRAM_ID,
    collectionId: second.id,
  });
  assert.equal(next.puzzleId, 'a', 'still new in the second collection');

  await startAndSucceed(service, session.session.sessionId, 'a', second.id, 'second');
  assert.notEqual(
    service.getScheduleState(`${PROGRAM_ID}:${second.id}:a`)?.state,
    'new',
  );

  assert.deepEqual(service.queueSummary(PROGRAM_ID, second.id), {
    total: 1,
    learned: 1,
    newCount: 0,
    due: 0,
  });
});

test('selectNext and queueSummary scope to the requested collection', async () => {
  const service = await seedDefault();
  const second = await service.createCollection('Second');
  await service.addPuzzleToCollection(second.id, 'b');
  const session = await service.startSession({ programId: PROGRAM_ID });

  const next = await service.selectNext({
    sessionId: session.session.sessionId,
    programId: PROGRAM_ID,
    collectionId: second.id,
  });
  assert.equal(next.puzzleId, 'b');
  assert.deepEqual(service.queueSummary(PROGRAM_ID, second.id).total, 1);
  assert.deepEqual(service.queueSummary(PROGRAM_ID, DEFAULT_COLLECTION_ID).total, 2);
});

test('the new-per-day cap applies per collection', async () => {
  const service = new LocalTrainingService({
    store: new LocalStore(new InMemoryStorageBackend()),
    settings: { newIntroductionLimitPerDay: 1 },
  });
  await service.init();
  await service.seedContent([a, b]);
  const second = await service.createCollection('Second');
  await service.addPuzzleToCollection(second.id, 'a');
  const session = await service.startSession({ programId: PROGRAM_ID });
  const sessionId = session.session.sessionId;

  // One introduction in the default scope exhausts its daily cap: `a` is
  // learned (future-due) and `b` is still new but capped.
  await startAndSucceed(service, sessionId, 'a', DEFAULT_COLLECTION_ID, 'cap-def');

  const blocked = await service.selectNext({
    sessionId,
    programId: PROGRAM_ID,
    collectionId: DEFAULT_COLLECTION_ID,
  });
  assert.equal(blocked.puzzleId, null);
  assert.equal(blocked.reason, 'daily-limit-reached');

  // The second scope has its own cap accounting: `a` is still new there.
  const allowed = await service.selectNext({
    sessionId,
    programId: PROGRAM_ID,
    collectionId: second.id,
  });
  assert.equal(allowed.puzzleId, 'a');
});

test('collections support create/rename/multi-membership and validated adds', async () => {
  const service = await seedDefault();
  const created = await service.createCollection('  Drills  ');
  assert.equal(created.name, 'Drills');
  assert.deepEqual(created.puzzleIds, []);

  await service.addPuzzleToCollection(created.id, 'a');
  await service.addPuzzleToCollection(created.id, 'a');
  await service.addPuzzleToCollection(DEFAULT_COLLECTION_ID, 'a');
  assert.deepEqual(service.getCollection(created.id)?.puzzleIds, ['a']);

  const renamed = await service.renameCollection(created.id, 'Tactics');
  assert.equal(renamed.name, 'Tactics');

  await assert.rejects(() => service.createCollection('   '));
  await assert.rejects(() => service.renameCollection(created.id, ''));
  await assert.rejects(() => service.addPuzzleToCollection(created.id, 'missing'));
  await assert.rejects(() => service.addPuzzleToCollection('missing', 'a'));

  await service.removePuzzleFromCollection(created.id, 'a');
  await service.removePuzzleFromCollection(created.id, 'a');
  assert.deepEqual(service.getCollection(created.id)?.puzzleIds, []);
});

test('deleting a collection keeps puzzles, other schedules and all history', async () => {
  const service = await seedDefault();
  const second = await service.createCollection('Second');
  await service.addPuzzleToCollection(second.id, 'a');
  const session = await service.startSession({ programId: PROGRAM_ID });
  await startAndSucceed(service, session.session.sessionId, 'a', DEFAULT_COLLECTION_ID, 'keep-def');
  await startAndSucceed(service, session.session.sessionId, 'a', second.id, 'keep-second');
  const attemptsBefore = service.getAttemptCount();

  await service.deleteCollection(second.id);

  assert.equal(service.getCollection(second.id), undefined);
  assert.deepEqual(service.listPuzzleIds(), ['a', 'b'], 'puzzles kept');
  assert.ok(
    service.getScheduleState(`${PROGRAM_ID}:${DEFAULT_COLLECTION_ID}:a`),
    'other collections\u2019 schedules kept',
  );
  assert.equal(service.getAttemptCount(), attemptsBefore, 'raw history kept (D09)');
  await assert.rejects(() => service.deleteCollection(DEFAULT_COLLECTION_ID));
  await assert.rejects(() => service.deleteCollection('missing'));
});

test('deleting the active collection falls back to the default', async () => {
  const service = await seedDefault();
  const second = await service.createCollection('Second');
  await service.setActiveCollectionId(second.id);
  await service.deleteCollection(second.id);
  assert.equal(service.getActiveCollectionId(), DEFAULT_COLLECTION_ID);
  await assert.rejects(() => service.setActiveCollectionId(second.id));
});

test('active collection persists across init', async () => {
  const backend = new InMemoryStorageBackend();
  const service = await makeService(backend);
  await service.seedContent([a]);
  const second = await service.createCollection('Second');
  await service.setActiveCollectionId(second.id);

  const reloaded = await makeService(backend);
  assert.equal(reloaded.getActiveCollectionId(), second.id);
  assert.deepEqual(
    reloaded.listCollections().map((c) => c.id).sort(),
    [DEFAULT_COLLECTION_ID, second.id].sort(),
  );
});

test('upserted puzzles land in the default collection; removed puzzles leave all memberships', async () => {
  const service = await seedDefault();
  const second = await service.createCollection('Second');
  await service.upsertPuzzles([makePuzzle({ id: 'c' })]);
  assert.ok(service.getCollection(DEFAULT_COLLECTION_ID)?.puzzleIds.includes('c'));
  assert.deepEqual(service.getCollection(second.id)?.puzzleIds, []);

  await service.addPuzzleToCollection(second.id, 'c');
  await service.removePuzzle('c');
  assert.ok(!service.getCollection(DEFAULT_COLLECTION_ID)?.puzzleIds.includes('c'));
  assert.ok(!service.getCollection(second.id)?.puzzleIds.includes('c'));
});

test('init live-migrates legacy program:puzzle schedules into the default scope', async () => {
  const backend = new InMemoryStorageBackend();
  const setup = await makeService(backend);
  await setup.seedContent([a, b]);
  const session = await setup.startSession({ programId: PROGRAM_ID });
  const started = await setup.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: PROGRAM_ID, puzzleId: 'a' },
    expectedScheduleRevision: 0,
  });
  await setup.commitOutcome({
    attemptId: started.attemptId,
    outcome: 'success',
    timing: timing(),
    expectedScheduleRevision: started.scheduleRevision,
    idempotencyKey: 'legacy-1',
  });

  // Rewrite storage to the pre-B4 shape: 2-part schedule key, no collections.
  const store = new LocalStore(backend);
  for (const [key, state] of await store.loadSchedules()) {
    const parts = key.split(':');
    assert.equal(parts.length, 3);
    await store.deleteSchedule(key);
    await store.saveSchedule(`${parts[0]}:${parts[2]}`, state);
  }
  for (const collection of await store.loadCollections()) {
    await store.deleteCollection(collection.id);
  }

  const migrated = await makeService(backend);
  const schedule = migrated.getScheduleState(`${PROGRAM_ID}:${DEFAULT_COLLECTION_ID}:a`);
  assert.ok(schedule, 'legacy schedule moved into the default scope');
  assert.notEqual(schedule.state, 'new');
  assert.deepEqual(migrated.getCollection(DEFAULT_COLLECTION_ID)?.puzzleIds, ['a', 'b']);

  const [attempt] = migrated.listAttempts();
  assert.deepEqual(attempt!.progressKey, { programId: PROGRAM_ID, puzzleId: 'a' });
});

test('export 1.0.0 migrates to 1.1.0: schedules rekeyed, default seeded, attempts untouched', async () => {
  const source = await makeService();
  await source.seedContent([a]);
  const session = await source.startSession({ programId: PROGRAM_ID });
  const started = await source.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: PROGRAM_ID, puzzleId: 'a' },
    expectedScheduleRevision: 0,
  });
  await source.commitOutcome({
    attemptId: started.attemptId,
    outcome: 'success',
    timing: timing(),
    expectedScheduleRevision: started.scheduleRevision,
    idempotencyKey: 'mig-1',
  });

  const current = await source.exportStore();
  const legacy = JSON.parse(JSON.stringify(current));
  legacy.formatVersion = '1.0.0';
  const legacySchedules: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(legacy.collections.schedules)) {
    const parts = key.split(':');
    legacySchedules[parts.length === 3 ? `${parts[0]}:${parts[2]}` : key] = value;
  }
  legacy.collections.schedules = legacySchedules;
  delete legacy.collections.collections;
  delete legacy.collections.meta['active-collection'];

  const parsed = parseExport(JSON.stringify(legacy));
  assert.equal(parsed.ok, true, !parsed.ok ? parsed.errors.join('; ') : '');
  if (!parsed.ok) return;
  assert.equal(parsed.data.formatVersion, '1.1.0');

  const keys = Object.keys(parsed.data.collections.schedules ?? {});
  assert.deepEqual(keys, [`${PROGRAM_ID}:${DEFAULT_COLLECTION_ID}:a`]);
  const defaultRecord = (parsed.data.collections.collections as Record<string, any>)[
    DEFAULT_COLLECTION_ID
  ];
  assert.deepEqual(defaultRecord.data.puzzleIds, ['a']);
  const attempts = Object.values(parsed.data.collections.attempts ?? {}) as Array<any>;
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].data.progressKey, { programId: PROGRAM_ID, puzzleId: 'a' });
});

test('export/import round-trips collections and the active selection', async () => {
  const source = await seedDefault();
  const second = await source.createCollection('Second');
  await source.addPuzzleToCollection(second.id, 'b');
  await source.setActiveCollectionId(second.id);
  const exported = await source.exportStore();
  assert.ok(exported.collections.collections);
  assert.equal(exported.formatVersion, '1.1.0');

  const target = await makeService();
  const roundTripped = parseExport(JSON.stringify(exported));
  assert.equal(roundTripped.ok, true);
  if (!roundTripped.ok) return;
  await target.importStore(roundTripped.data, 'b4-test');
  assert.deepEqual(
    target.getCollection(second.id)?.puzzleIds,
    source.getCollection(second.id)?.puzzleIds,
  );
  assert.equal(target.getActiveCollectionId(), second.id);
});

test('CollectionsView renders collections with membership and due counts', async () => {
  setLocale('en');
  const service = await seedDefault();
  const view = new CollectionsView({ service, adapter: undefined as never });
  const host = { innerHTML: '' } as unknown as HTMLElement;
  view.mount(host);
  assert.ok(host.innerHTML.includes('Collections'));
  assert.ok(host.innerHTML.includes('Default'));
  assert.ok(host.innerHTML.includes('2 puzzles'));
  view.unmount();
});

test('collections summary counts use the default program scope', async () => {
  const service = await seedDefault();
  const session = await service.startSession({ programId: DEFAULT_PROGRAM_ID });
  const started = await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: DEFAULT_PROGRAM_ID, puzzleId: 'a' },
    expectedScheduleRevision: 0,
  });
  await service.commitOutcome({
    attemptId: started.attemptId,
    outcome: 'success',
    timing: timing(),
    expectedScheduleRevision: started.scheduleRevision,
    idempotencyKey: 'prog-1',
  });
  const summary = service.queueSummary(DEFAULT_PROGRAM_ID, DEFAULT_COLLECTION_ID);
  assert.equal(summary.total, 2);
  assert.equal(summary.learned, 1);
});
