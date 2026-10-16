/**
 * F02: bundled rating-band collections. The seed must be additive — the starter
 * collection keeps its own membership — and idempotent per pack so a deleted
 * band collection is not recreated on the next boot.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_COLLECTION_ID, LocalTrainingService } from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { makePuzzle, makeService } from './fixtures.ts';

const starter = makePuzzle({ id: 'starter' });
const easy = makePuzzle({ id: 'easy-a' });
const hard = makePuzzle({ id: 'hard-a' });
const bands = [
  { id: 'band-easy', name: 'Lichess 0–999', puzzleIds: ['easy-a', 'missing-id'] },
  { id: 'band-hard', name: 'Lichess 2500+', puzzleIds: ['hard-a'] },
];

test('bundled bands add collections without changing the starter collection', async () => {
  const service = await makeService();
  await service.seedContent([starter]);
  assert.deepEqual(service.listPuzzleIds(), ['starter']);
  assert.deepEqual(service.getCollection(DEFAULT_COLLECTION_ID)?.puzzleIds, ['starter']);

  const seeded = await service.seedBundledCollections('lichess-bands-v1', [easy, hard], bands);

  assert.equal(seeded, true);
  // Library grew; default collection membership did not.
  assert.deepEqual(service.listPuzzleIds().sort(), ['easy-a', 'hard-a', 'starter']);
  assert.deepEqual(service.getCollection(DEFAULT_COLLECTION_ID)?.puzzleIds, ['starter']);
  // Band collections carry only ids that exist in the library.
  assert.deepEqual(service.getCollection('band-easy')?.puzzleIds, ['easy-a']);
  assert.deepEqual(service.getCollection('band-hard')?.puzzleIds, ['hard-a']);
  assert.equal(service.getCollection('band-easy')?.name, 'Lichess 0–999');
});

test('bundled bands seed once per pack and never resurrect a deleted collection', async () => {
  const service = await makeService();
  await service.seedContent([starter]);

  assert.equal(await service.seedBundledCollections('lichess-bands-v1', [easy, hard], bands), true);
  assert.equal(await service.bundledBandsPackId(), 'lichess-bands-v1');
  // Second call for the same pack is a no-op.
  assert.equal(await service.seedBundledCollections('lichess-bands-v1', [easy, hard], bands), false);

  await service.deleteCollection('band-hard');
  assert.equal(service.getCollection('band-hard'), undefined);
  // Re-running the same pack does not bring it back.
  assert.equal(await service.seedBundledCollections('lichess-bands-v1', [easy, hard], bands), false);
  assert.equal(service.getCollection('band-hard'), undefined);
});

test('a new band pack id seeds again', async () => {
  const service = await makeService();
  await service.seedContent([starter]);
  await service.seedBundledCollections('lichess-bands-v1', [easy], bands);
  const next = [{ id: 'band-next', name: 'Lichess next', puzzleIds: ['hard-a'] }];

  assert.equal(await service.seedBundledCollections('lichess-bands-v2', [hard], next), true);
  assert.deepEqual(service.getCollection('band-next')?.puzzleIds, ['hard-a']);
  assert.equal(await service.bundledBandsPackId(), 'lichess-bands-v2');
});

test('bundled band seeding persists across a reload', async () => {
  const backend = new InMemoryStorageBackend();
  const service = await makeService(backend);
  await service.seedContent([starter]);
  await service.seedBundledCollections('lichess-bands-v1', [easy, hard], bands);

  const reloaded = new LocalTrainingService({ store: new LocalStore(backend) });
  await reloaded.init();
  assert.deepEqual(reloaded.getCollection('band-easy')?.puzzleIds, ['easy-a']);
  assert.deepEqual(reloaded.getCollection(DEFAULT_COLLECTION_ID)?.puzzleIds, ['starter']);
  assert.equal(await reloaded.bundledBandsPackId(), 'lichess-bands-v1');
});
