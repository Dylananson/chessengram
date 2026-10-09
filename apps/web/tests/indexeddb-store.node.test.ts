import 'fake-indexeddb/auto';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { IndexedDbStorageBackend } from '../src/storage/indexeddb-backend.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { makePuzzle } from './fixtures.ts';

test('IndexedDB backend persists content and meta across connections', async () => {
  const name = `chessreps-test-${Date.now()}`;
  const backend = new IndexedDbStorageBackend(name);
  const store = new LocalStore(backend);
  await store.savePuzzles([makePuzzle({ id: 'idx1' })]);
  await store.saveMeta('flag', { ok: true });
  await backend.close();

  const reopened = new LocalStore(new IndexedDbStorageBackend(name));
  const puzzles = await reopened.loadPuzzles();
  assert.equal(puzzles.length, 1);
  assert.equal(puzzles[0]?.id, 'idx1');
  assert.deepEqual(await reopened.loadMeta('flag'), { ok: true });

  await reopened.reset();
  assert.equal((await reopened.loadPuzzles()).length, 0);
});
