import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LocalTrainingService } from '../src/scheduler-service.ts';
import { LocalStore, syncStorage } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { parseExport, summarizeExport } from '../src/storage/data-port.ts';
import { makePuzzle, makeService } from './fixtures.ts';

test('parseExport rejects malformed and unsupported documents', () => {
  assert.deepEqual(parseExport('}{').ok, false);
  assert.deepEqual(parseExport('{"hello":1}').ok, false);
  assert.equal(parseExport('  ').ok, false);
  // A well-formed marker but no collections object is not a ChessEngram export.
  assert.equal(
    parseExport('{"format":"chessengram-export","formatVersion":"1.3.0","exportedAt":0}').ok,
    false,
  );

  for (const formatVersion of ['9.9.9', '1.4.0']) {
    const future = JSON.stringify({
      format: 'chessengram-export',
      formatVersion,
      exportedAt: 0,
      backendKind: 'memory',
      collections: {},
    });
    const result = parseExport(future);
    assert.equal(result.ok, false, `${formatVersion} must be rejected`);
    if (!result.ok) assert.match(result.errors.join(' '), /unsupported export version/);
  }
});

test('export is lossless and restores into a fresh store', async () => {
  const backend = new InMemoryStorageBackend();
  const source = new LocalTrainingService({ store: new LocalStore(backend) });
  await source.init();
  await source.upsertPuzzles([
    makePuzzle({ id: 'a' }),
    makePuzzle({ id: 'b', rating: 1234 }),
  ]);

  const exported = await source.exportStore();
  const roundTripped = parseExport(JSON.stringify(exported));
  assert.equal(roundTripped.ok, true, !roundTripped.ok ? roundTripped.errors.join('; ') : '');
  if (!roundTripped.ok) return;

  const target = new LocalTrainingService({ store: new LocalStore(new InMemoryStorageBackend()) });
  await target.init();
  const summary = await target.importStore(roundTripped.data, 'test-import');
  assert.equal(summary.total > 0, true);
  assert.deepEqual(target.listPuzzleIds(), ['a', 'b']);
  assert.equal((await target.loadPuzzle({ puzzleId: 'b' })).puzzle.rating, 1234);
});

test('importStore snapshots current data and restoreBackup reverses an import', async () => {
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a' })]);
  const snapshot = await service.exportStore();

  await service.upsertPuzzles([makePuzzle({ id: 'b' })]);
  assert.deepEqual(service.listPuzzleIds(), ['a', 'b']);

  await service.importStore(snapshot, 'import-1');
  assert.deepEqual(service.listPuzzleIds(), ['a'], 'import replaced the store');

  assert.ok((await service.listBackups()).includes('import-1'));
  const restored = await service.restoreBackup('import-1');
  assert.ok(restored);
  assert.deepEqual(service.listPuzzleIds(), ['a', 'b'], 'backup restored the pre-import data');
});

test('summarizeExport counts each collection and the total', async () => {
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a' }), makePuzzle({ id: 'b' })]);
  const summary = summarizeExport(await service.exportStore());
  assert.equal(summary.counts.content, 2);
  assert.equal(summary.total >= 2, true);
  assert.equal(summary.formatVersion, '1.3.0');
  assert.equal(summary.counts.woodpecker, 0);
  assert.equal(summary.counts.sync, 0);
});

test('1.2.0 export migrates to 1.3.0 losslessly, adding only an empty sync collection', async () => {
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a' }), makePuzzle({ id: 'b', rating: 1234 })]);
  const current = await service.exportStore();

  // Simulate a document produced by the previous (1.2.0) build: no sync collection.
  const legacy = JSON.parse(JSON.stringify(current)) as typeof current;
  legacy.formatVersion = '1.2.0';
  delete (legacy.collections as Record<string, unknown>).sync;

  const parsed = parseExport(JSON.stringify(legacy));
  assert.equal(parsed.ok, true, !parsed.ok ? parsed.errors.join('; ') : '');
  if (!parsed.ok) return;
  assert.equal(parsed.data.formatVersion, '1.3.0');
  assert.deepEqual(parsed.data.collections.sync, {}, 'new sync collection starts empty');

  // Every other collection is preserved byte-for-byte (no dropped records).
  for (const [collection, records] of Object.entries(legacy.collections)) {
    assert.deepEqual(parsed.data.collections[collection], records, `${collection} preserved`);
  }
});

test('export/import round-trips a non-empty sync queue and sync state', async () => {
  const source = new LocalStore(new InMemoryStorageBackend());
  await source.saveSyncQueueEntry({ type: 'attempt', recordId: 'attempt-1', changedAt: 111 });
  await source.saveSyncQueueEntry({ type: 'userPuzzle', recordId: 'puzzle-9', changedAt: 222 });
  const state = {
    enabled: true,
    salt: 'ab'.repeat(32),
    deviceId: 'device-1',
    cursor: 7,
    keyVersion: 1,
    userId: 'user-1',
    lastSyncedAt: 333,
  };
  await source.saveSyncState(state);

  const exported = await source.exportData();
  assert.equal(exported.formatVersion, '1.3.0');
  assert.equal(Object.keys(exported.collections.sync).length, 3, 'two pointers + state exported');

  const parsed = parseExport(JSON.stringify(exported));
  assert.equal(parsed.ok, true, !parsed.ok ? parsed.errors.join('; ') : '');
  if (!parsed.ok) return;

  const target = new LocalStore(new InMemoryStorageBackend());
  await target.applyExport(parsed.data);

  const entries = await target.loadSyncQueueEntries();
  assert.deepEqual(
    entries.map((entry) => `${entry.type}:${entry.recordId}:${entry.changedAt}`).sort(),
    ['attempt:attempt-1:111', 'userPuzzle:puzzle-9:222'],
  );
  assert.deepEqual(await target.loadSyncState(), state);
});

test('sync storage adapter lists, deletes and persists state through the frozen seams', async () => {
  const storage = syncStorage(new LocalStore(new InMemoryStorageBackend()));
  await storage.put({ type: 'attempt', recordId: 'a1', changedAt: 1 });
  await storage.put({ type: 'setting', recordId: 's1', changedAt: 2 });
  assert.equal((await storage.list()).length, 2);

  await storage.delete('attempt', 'a1');
  assert.deepEqual(
    (await storage.list()).map((entry) => entry.recordId),
    ['s1'],
    'only the acked pointer is removed',
  );

  const state = { enabled: true, cursor: 3 };
  await storage.save(state);
  assert.deepEqual(await storage.load(), state);
  assert.equal((await storage.list()).length, 1, 'state is not returned as a queue entry');
});
