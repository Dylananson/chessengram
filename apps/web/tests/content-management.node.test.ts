import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LocalTrainingService } from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { makePuzzle, makeService, PROGRAM_ID } from './fixtures.ts';

test('upsertPuzzles merges: replaces same ids, appends new ones', async () => {
  const service = await makeService();
  let stats = await service.upsertPuzzles([
    makePuzzle({ id: 'a' }),
    makePuzzle({ id: 'b' }),
  ]);
  assert.deepEqual(stats, { added: 2, replaced: 0 });
  assert.deepEqual(service.listPuzzleIds(), ['a', 'b']);

  stats = await service.upsertPuzzles([
    makePuzzle({ id: 'b', rating: 1250 }),
    makePuzzle({ id: 'c' }),
  ]);
  assert.deepEqual(stats, { added: 1, replaced: 1 });
  assert.deepEqual(service.listPuzzleIds(), ['a', 'b', 'c'], 'new puzzle appended, order stable');
  assert.equal((await service.loadPuzzle({ puzzleId: 'b' })).puzzle.rating, 1250);
});

test('upserted content persists across a reload on the same backend', async () => {
  const backend = new InMemoryStorageBackend();
  const first = await makeService(backend);
  await first.upsertPuzzles([makePuzzle({ id: 'persist1' })], { packId: 'my-pack' });

  const reloaded = new LocalTrainingService({ store: new LocalStore(backend) });
  await reloaded.init();
  assert.deepEqual(reloaded.listPuzzleIds(), ['persist1']);
  assert.equal((await reloaded.loadContentMeta())?.packId, 'my-pack');
  assert.equal(reloaded.listPuzzles()[0]!.id, 'persist1');
});

test('removePuzzle deletes content and its schedule but keeps raw history', async () => {
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a' }), makePuzzle({ id: 'b' })]);

  const session = await service.startSession({ programId: PROGRAM_ID, collectionId: 'c' });
  await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: PROGRAM_ID, puzzleId: 'a' },
    expectedScheduleRevision: 0,
  });
  const attemptsBefore = service.getAttemptCount();
  assert.ok(service.getScheduleState(`${PROGRAM_ID}:a`));

  await service.removePuzzle('a');

  assert.equal(service.getScheduleState(`${PROGRAM_ID}:a`), undefined, 'derived schedule removed');
  assert.deepEqual(service.listPuzzleIds(), ['b']);
  assert.equal(service.getAttemptCount(), attemptsBefore, 'raw attempt history kept (D09)');
  await assert.rejects(() => service.loadPuzzle({ puzzleId: 'a' }));
});

test('removing a puzzle does not affect other puzzles schedules', async () => {
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a' }), makePuzzle({ id: 'b' })]);
  const session = await service.startSession({ programId: PROGRAM_ID, collectionId: 'c' });
  await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: PROGRAM_ID, puzzleId: 'b' },
    expectedScheduleRevision: 0,
  });
  await service.removePuzzle('a');
  assert.ok(service.getScheduleState(`${PROGRAM_ID}:b`), 'unrelated schedule survives');
});

test('queueSummary reflects the active library after add and remove', async () => {
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a' }), makePuzzle({ id: 'b' })]);
  assert.deepEqual(service.queueSummary(PROGRAM_ID), {
    total: 2,
    learned: 0,
    newCount: 2,
    due: 2,
  });
  await service.removePuzzle('a');
  assert.deepEqual(service.queueSummary(PROGRAM_ID), {
    total: 1,
    learned: 0,
    newCount: 1,
    due: 1,
  });
});
