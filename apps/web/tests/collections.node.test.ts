import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { VNode } from 'snabbdom/build/vnode.js';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_PROGRAM_ID,
  LocalTrainingService,
  progressKeyToString,
} from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { parseExport } from '../src/storage/data-port.ts';
import { CollectionsCtrl, CollectionsView, collectionIdFromHash, view } from '../src/collections-view.ts';
import { setLocale, t } from '../src/i18n.ts';
import { makePuzzle, makeService, PROGRAM_ID, timing } from './fixtures.ts';

const a = makePuzzle({ id: 'a' });
const b = makePuzzle({ id: 'b' });

/** Collect every text node in a vnode tree (snabbdom sets copy as text). */
function collectText(node: VNode | string | null | undefined): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  const out: string[] = [];
  if (typeof node.text === 'string') out.push(node.text);
  for (const child of node.children ?? []) out.push(...collectText(child as VNode | string));
  return out;
}

/** Every vnode in the tree matching the predicate, depth-first. */
function findVNodes(
  node: VNode | string | null | undefined,
  match: (node: VNode) => boolean,
): VNode[] {
  if (node === null || node === undefined || typeof node === 'string') return [];
  const out: VNode[] = match(node) ? [node] : [];
  for (const child of node.children ?? []) out.push(...findVNodes(child as VNode, match));
  return out;
}

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

  const continued = await service.selectNext({
    sessionId,
    programId: PROGRAM_ID,
    collectionId: DEFAULT_COLLECTION_ID,
  });
  // The capped new puzzle `b` stays unavailable, but ordinary Next continues
  // with the already-scheduled future review `a`.
  assert.equal(continued.puzzleId, 'a');

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

test('export 1.0.0 migrates through 1.1.0 to 1.3.0: schedules rekeyed, set seeded, attempts untouched', async () => {
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
  assert.equal(parsed.data.formatVersion, '1.3.0');
  assert.deepEqual(parsed.data.collections.woodpecker, {}, 'new Woodpecker collection starts empty');

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
  assert.equal(exported.formatVersion, '1.3.0');

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

test('collections grid renders one card per collection without the add-puzzle input', async () => {
  setLocale('en');
  const service = await seedDefault();
  const ctrl = new CollectionsCtrl(service);
  const root = view(ctrl);

  const grids = findVNodes(root, (node) => node.sel === 'div.collections-grid');
  assert.equal(grids.length, 1, 'list view wraps cards in a grid');

  const cards = findVNodes(
    root,
    (node) => (node.data?.attrs as Record<string, unknown> | undefined)?.['data-collection'] !== undefined,
  );
  assert.equal(cards.length, ctrl.snapshot.rows.length);
  assert.equal(
    (cards[0]!.data?.attrs as Record<string, unknown>)['data-collection'],
    DEFAULT_COLLECTION_ID,
  );

  const addInputs = findVNodes(
    root,
    (node) =>
      typeof node.sel === 'string' &&
      node.sel.startsWith('input') &&
      typeof (node.data?.attrs as Record<string, unknown> | undefined)?.['id'] === 'string' &&
      ((node.data!.attrs as Record<string, unknown>)['id'] as string).startsWith('add-'),
  );
  assert.equal(addInputs.length, 0, 'list cards have no add-puzzle input');
});

test('collectionIdFromHash parses the detail route and ignores the list route', () => {
  assert.equal(collectionIdFromHash('#/collections'), null);
  assert.equal(collectionIdFromHash('#/collections/'), null);
  assert.equal(collectionIdFromHash('#/collections/abc'), 'abc');
  assert.equal(collectionIdFromHash('#/collections/a%2Fb'), 'a/b');
  assert.equal(collectionIdFromHash('#/collections/abc?x=1'), 'abc');
  assert.equal(collectionIdFromHash('#/train'), null);
});

test('collection detail hides puzzle members by default and toggles them', async () => {
  setLocale('en');
  const service = await seedDefault();
  let redraws = 0;
  const ctrl = new CollectionsCtrl(service, () => {
    redraws += 1;
  });
  ctrl.select(DEFAULT_COLLECTION_ID);

  const collapsed = collectText(view(ctrl));
  assert.ok(collapsed.includes(t('collections.details.members.title')));
  assert.ok(collapsed.includes('Default'));
  assert.ok(collapsed.join('\n').includes('2 puzzles'));
  assert.ok(collapsed.includes(t('collections.members.show', { count: 2 })));
  assert.ok(!collapsed.includes('a'), 'puzzle ids hidden by default');
  assert.ok(!collapsed.includes('b'), 'puzzle ids hidden by default');

  await ctrl.toggleMembers(DEFAULT_COLLECTION_ID);
  const expanded = collectText(view(ctrl));
  assert.ok(expanded.includes(t('collections.members.hide', { count: 2 })));
  assert.ok(expanded.includes('a'));
  assert.ok(expanded.includes('b'));
  assert.ok(redraws >= 1, 'toggle ends in redraw');

  await ctrl.toggleMembers(DEFAULT_COLLECTION_ID);
  assert.ok(!collectText(view(ctrl)).includes('a'), 'second toggle collapses again');
});

test('cards and the detail page show Start until the collection has progress', async () => {
  setLocale('en');
  const service = await makeService();
  await service.seedContent([a, b]);
  const ctrl = new CollectionsCtrl(service);

  // Fresh collection: both modes read "Start".
  let texts = collectText(view(ctrl));
  assert.ok(texts.includes(t('collections.start.spaced')));
  assert.ok(texts.includes(t('collections.start.woodpecker')));

  // Spaced progress (default program scope): learned puzzle flips only Spaced.
  const session = await service.startSession({ programId: DEFAULT_PROGRAM_ID });
  const started = await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: DEFAULT_PROGRAM_ID, puzzleId: 'a', collectionId: DEFAULT_COLLECTION_ID },
    expectedScheduleRevision: 0,
  });
  await service.commitOutcome({
    attemptId: started.attemptId,
    outcome: 'success',
    timing: timing(),
    expectedScheduleRevision: started.scheduleRevision,
    idempotencyKey: 'resume-spaced',
  });
  ctrl.refresh();
  texts = collectText(view(ctrl));
  assert.ok(texts.includes(t('collections.resume.spaced')), 'spaced reads Resume after progress');
  assert.ok(texts.includes(t('collections.start.woodpecker')), 'woodpecker still Start');

  // Woodpecker progress: the internal set snapshot flips the Woodpecker label.
  await service.getOrCreateWoodpeckerSetForCollection(DEFAULT_COLLECTION_ID);
  ctrl.refresh();
  texts = collectText(view(ctrl));
  assert.ok(texts.includes(t('collections.resume.woodpecker')), 'woodpecker reads Resume after progress');
});

test('ctrl mutations end in redraw and refresh the snapshot', async () => {
  setLocale('en');
  const service = await seedDefault();
  let redraws = 0;
  const ctrl = new CollectionsCtrl(service, () => {
    redraws += 1;
  });
  assert.equal(ctrl.snapshot.rows.length, 1);

  ctrl.newName = '  Drills  ';
  await ctrl.create();
  assert.equal(ctrl.message?.kind, 'ok');
  assert.equal(ctrl.snapshot.rows.length, 2);
  const created = ctrl.snapshot.rows.find((row) => row.name === 'Drills')!;
  assert.ok(created);
  assert.equal(ctrl.newName, '', 'create draft resets like the old innerHTML rebuild');
  const before = redraws;
  assert.ok(before >= 1, 'create ends in redraw');

  ctrl.addValues.set(created.id, 'a');
  await ctrl.addMember(created.id);
  assert.equal(ctrl.message?.kind, 'ok');
  assert.deepEqual(
    ctrl.snapshot.rows.find((row) => row.id === created.id)?.puzzleIds,
    ['a'],
  );

  await ctrl.removeMember(created.id, 'a');
  assert.deepEqual(
    ctrl.snapshot.rows.find((row) => row.id === created.id)?.puzzleIds,
    [],
  );

  await ctrl.deleteCollection(created.id);
  assert.equal(ctrl.message?.kind, 'ok');
  assert.equal(ctrl.snapshot.rows.length, 1);
  assert.ok(redraws > before, 'every mutation path ends in redraw');
});

test('rename is a two-step start/save flow with validation errors', async () => {
  setLocale('en');
  const service = await seedDefault();
  let redraws = 0;
  const ctrl = new CollectionsCtrl(service, () => {
    redraws += 1;
  });
  const target = ctrl.snapshot.rows[0]!;

  await ctrl.rename(target.id);
  assert.equal(ctrl.renamingId, target.id, 'first click starts renaming');
  assert.equal(ctrl.renameValue, target.name, 'rename draft prefilled');

  ctrl.renameValue = '';
  await ctrl.rename(target.id);
  assert.equal(ctrl.message?.kind, 'error', 'blank names are rejected');
  assert.equal(ctrl.renamingId, target.id, 'failed save keeps renaming open');
  assert.equal(
    ctrl.snapshot.rows.find((row) => row.id === target.id)?.name,
    target.name,
    'failed save keeps the old name',
  );

  ctrl.renameValue = 'Tactics';
  await ctrl.rename(target.id);
  assert.equal(ctrl.message?.kind, 'ok');
  assert.equal(ctrl.renamingId, null);
  assert.equal(
    ctrl.snapshot.rows.find((row) => row.id === target.id)?.name,
    'Tactics',
  );
  assert.ok(redraws >= 3, 'each rename step ends in redraw');
});

test('default collection detail renders badges and a disabled delete', async () => {
  setLocale('en');
  const service = await seedDefault();
  const ctrl = new CollectionsCtrl(service);
  ctrl.select(DEFAULT_COLLECTION_ID);
  const root = view(ctrl);
  const texts = collectText(root);
  assert.ok(texts.includes(t('collections.badge.default')));

  const buttons = findVNodes(
    root,
    (node) => typeof node.sel === 'string' && node.sel.startsWith('button'),
  );
  const deletes = buttons.filter((node) => collectText(node).includes(t('collections.delete')));
  assert.equal(deletes.length, 1);
  assert.equal(
    (deletes[0]!.data?.attrs as Record<string, unknown> | undefined)?.['disabled'],
    true,
    'default collection cannot be deleted',
  );
});

test('unmount without mount is safe', async () => {
  const service = await seedDefault();
  const screen = new CollectionsView({ service, adapter: undefined as never });
  screen.unmount();
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
