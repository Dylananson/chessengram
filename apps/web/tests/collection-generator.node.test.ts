import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { selectCollectionPuzzles } from '../src/collection-generator.ts';
import { makePuzzle } from './fixtures.ts';

test('collection generation uses inclusive rating bounds and AND theme filters', () => {
  const matches = Array.from({ length: 100 }, (_, index) =>
    makePuzzle({ id: `match-${index}`, rating: index === 99 ? 900 : 700, themes: ['fork', 'pin'] }));
  const pool = [...matches, makePuzzle({ id: 'outside-rating', rating: 901, themes: ['fork', 'pin'] }),
    makePuzzle({ id: 'missing-tag', rating: 800, themes: ['fork'] })];
  const selected = selectCollectionPuzzles(pool, { size: 100, ratingMin: 700, ratingMax: 900, themes: ['fork', 'pin'] }, 7);
  assert.equal(selected.length, 100);
  assert.deepEqual(new Set(selected), new Set(matches.map((puzzle) => puzzle.id)));
});

test('collection generation is deterministic for the same seed and selects requested size', () => {
  const expanded = Array.from({ length: 120 }, (_, index) =>
    makePuzzle({ id: `p-${index}`, rating: 1000, themes: ['fork'] }));
  const filter = { size: 100, ratingMin: 500, ratingMax: 2500, themes: ['fork'] };
  const first = selectCollectionPuzzles(expanded, filter, 99);
  assert.deepEqual(first, selectCollectionPuzzles(expanded, filter, 99));
  assert.equal(first.length, 100);
  assert.equal(new Set(first).size, 100);
});

test('collection generation refuses undersized matches and invalid sizes', () => {
  assert.throws(
    () => selectCollectionPuzzles([], { size: 100, themes: ['not-a-theme'] }, 1),
    /Only 0 puzzles match; 100 required/,
  );
  assert.throws(() => selectCollectionPuzzles([], { size: 99 }, 1), /between 100 and 1000/);
});
