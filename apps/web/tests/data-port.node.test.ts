import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LocalTrainingService } from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { parseExport, summarizeExport } from '../src/storage/data-port.ts';
import { makePuzzle, makeService } from './fixtures.ts';

test('parseExport rejects malformed and unsupported documents', () => {
  assert.deepEqual(parseExport('}{').ok, false);
  assert.deepEqual(parseExport('{"hello":1}').ok, false);
  assert.equal(parseExport('  ').ok, false);

  const future = JSON.stringify({
    format: 'chessreps-export',
    formatVersion: '9.9.9',
    exportedAt: 0,
    backendKind: 'memory',
    collections: {},
  });
  const result = parseExport(future);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(' '), /unsupported export version/);
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
  assert.equal(summary.formatVersion, '1.1.0');
});
