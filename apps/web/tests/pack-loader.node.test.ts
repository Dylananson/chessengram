import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadBundledCustomCollections, loadPuzzlesFromPack } from '../src/pack-loader.ts';

test('pack loading stamps contentSchemaVersion and maps original -> originalFields', async () => {
  const line = JSON.stringify({
    id: 'pack1',
    original: { PuzzleId: 'pack1' },
    rating: 1000,
    solverFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    solverColor: 'white',
    source: 'lichess',
    sourceFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    solution: ['e2e4'],
    themes: [],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => `${line}\nnot json\n`,
  })) as unknown as typeof fetch;
  try {
    const pack = await loadPuzzlesFromPack('/fake', 'test-pack');
    assert.equal(pack.parseErrors, 1);
    assert.equal(pack.puzzles.length, 1);
    const puzzle = pack.puzzles[0]!;
    assert.equal(puzzle.contentSchemaVersion, '1.0.0');
    assert.deepEqual(puzzle.originalFields, { PuzzleId: 'pack1' });
    assert.equal(puzzle.id, 'pack1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('custom site catalog loads pack puzzles and collection definitions', async () => {
  const line = JSON.stringify({
    id: 'custom1', rating: 900, source: 'lichess', sourceId: 'custom1', themes: ['fork'],
    sourceFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w KQkq - 0 1',
    solverFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w KQkq - 0 1',
    solverColor: 'white', solution: ['e2e4'],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return {
      ok: true, status: 200,
      text: async () => `${line}\n`,
      json: async () => ({ collections: [{ id: 'forks', name: 'Forks', ratingMin: 500, ratingMax: 2500, themes: ['fork'], puzzleIds: ['custom1'] }] }),
    } as Response;
  }) as typeof fetch;
  try {
    const loaded = await loadBundledCustomCollections();
    assert.equal(loaded.puzzles[0]?.id, 'custom1');
    assert.deepEqual(loaded.collections[0]?.puzzleIds, ['custom1']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
