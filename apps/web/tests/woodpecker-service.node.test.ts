import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LocalTrainingService } from '../src/scheduler-service.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { makePuzzle } from './fixtures.ts';

test('Woodpecker set snapshots collection membership and cycle progress survives service reload', async () => {
  const backend = new InMemoryStorageBackend();
  const service = new LocalTrainingService({ store: new LocalStore(backend), idFactory: () => 'id-1' });
  await service.init();
  await service.seedContent([makePuzzle({ id: 'p1' }), makePuzzle({ id: 'p2' })]);
  const sourceCollectionId = service.getActiveCollectionId();
  const set = await service.createWoodpeckerSet({
    name: 'First set',
    sourceCollectionId,
    puzzleIds: ['p1', 'p2'],
  });
  await service.removePuzzleFromCollection(sourceCollectionId, 'p2');
  assert.deepEqual(service.getWoodpeckerSet(set.setId)?.puzzleIds, ['p1', 'p2']);

  const { cycleId } = await service.startWoodpeckerCycle(set.setId);
  assert.equal((await service.startWoodpeckerCycle(set.setId)).cycleId, cycleId, 'starting again resumes the unfinished cycle');
  await service.recordWoodpeckerCycleResult(cycleId, 'p1', 'clean', 12);
  await service.recordWoodpeckerCycleResult(cycleId, 'p2', 'failed', 20);
  assert.deepEqual(service.getWoodpeckerFailedPuzzleIds(set.setId), ['p2']);
  assert.equal(service.selectWoodpeckerFailed(set.setId).puzzleId, 'p2');

  const exported = await new LocalStore(backend).exportData();
  const exportedWoodpecker = exported.collections.woodpecker as Record<string, unknown>;
  assert.equal(Object.keys(exportedWoodpecker).length, 2, 'set and cycle are included in export');
  const restoredBackend = new InMemoryStorageBackend();
  await new LocalStore(restoredBackend).applyExport(exported);

  const reloaded = new LocalTrainingService({ store: new LocalStore(restoredBackend) });
  await reloaded.init();
  assert.deepEqual(reloaded.getWoodpeckerSet(set.setId)?.puzzleIds, ['p1', 'p2']);
  assert.equal(reloaded.listWoodpeckerCycles(set.setId)[0]?.cycle.results.length, 2);
  assert.equal(reloaded.selectWoodpeckerFailed(set.setId).puzzleId, 'p2');
});

test('Woodpecker sets reject puzzles outside the selected source collection', async () => {
  const service = new LocalTrainingService({ store: new LocalStore(new InMemoryStorageBackend()) });
  await service.init();
  await service.seedContent([makePuzzle({ id: 'p1' }), makePuzzle({ id: 'p2' })]);
  const collectionId = service.getActiveCollectionId();
  await service.removePuzzleFromCollection(collectionId, 'p2');
  await assert.rejects(
    service.createWoodpeckerSet({ name: 'Bad', sourceCollectionId: collectionId, puzzleIds: ['p2'] }),
    /belong to the source collection/,
  );
});

test('Woodpecker starts from a collection: one internal snapshot is created and reused', async () => {
  const service = new LocalTrainingService({ store: new LocalStore(new InMemoryStorageBackend()) });
  await service.init();
  await service.seedContent([makePuzzle({ id: 'p1' }), makePuzzle({ id: 'p2' })]);
  const collectionId = service.getActiveCollectionId();

  assert.equal(service.getWoodpeckerSetForCollection(collectionId), undefined, 'no set before first start');

  const set = await service.getOrCreateWoodpeckerSetForCollection(collectionId);
  assert.equal(set.name, 'Default');
  assert.equal(set.sourceCollectionId, collectionId);
  assert.deepEqual(set.puzzleIds, ['p1', 'p2']);

  // A second start reuses the same internal set, so cycle progress is not orphaned.
  const again = await service.getOrCreateWoodpeckerSetForCollection(collectionId);
  assert.equal(again.setId, set.setId);
  assert.equal(service.getWoodpeckerSetForCollection(collectionId)?.setId, set.setId);

  // The snapshot stays fixed when the collection membership changes afterwards.
  await service.removePuzzleFromCollection(collectionId, 'p2');
  assert.deepEqual(service.getWoodpeckerSetForCollection(collectionId)?.puzzleIds, ['p1', 'p2']);
});

test('Woodpecker accepts collections larger than 500 puzzles', async () => {
  const service = new LocalTrainingService({ store: new LocalStore(new InMemoryStorageBackend()) });
  await service.init();
  const puzzles = Array.from({ length: 501 }, (_, index) => makePuzzle({ id: `large-${index}` }));
  await service.seedContent(puzzles);

  const collectionId = service.getActiveCollectionId();
  const set = await service.getOrCreateWoodpeckerSetForCollection(collectionId);

  assert.equal(set.puzzleIds.length, 501);
});

test('getWoodpeckerSetForCollection prefers a set that already has cycles', async () => {
  const service = new LocalTrainingService({ store: new LocalStore(new InMemoryStorageBackend()), idFactory: (() => { let n = 0; return () => `id-${++n}`; })() });
  await service.init();
  await service.seedContent([makePuzzle({ id: 'p1' })]);
  const collectionId = service.getActiveCollectionId();

  const withCycles = await service.createWoodpeckerSet({ name: 'Old', sourceCollectionId: collectionId, puzzleIds: ['p1'] });
  await service.startWoodpeckerCycle(withCycles.setId);
  const newer = await service.createWoodpeckerSet({ name: 'New', sourceCollectionId: collectionId, puzzleIds: ['p1'] });

  assert.ok(newer.createdAt >= withCycles.createdAt);
  assert.equal(service.getWoodpeckerSetForCollection(collectionId)?.setId, withCycles.setId, 'progress-bearing set wins');
});
