import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadPuzzlesFromPack } from '../src/pack-loader.ts';

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
