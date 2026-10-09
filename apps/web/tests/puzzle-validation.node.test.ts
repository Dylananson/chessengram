import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  normalizeUciList,
  parseJsonlPuzzles,
  validateAndNormalize,
} from '../src/validation/puzzle-validation.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PROMOTION_FEN = '7k/1P6/8/8/8/8/8/K7 w - - 0 1';
const MATE_FEN = '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';

test('valid creator input normalizes and derives fields', () => {
  const result = validateAndNormalize({
    id: 'mine1',
    solverFen: PROMOTION_FEN,
    solution: ['b7b8q'],
    rating: 1200,
    themes: ['promotion'],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.puzzle.id, 'mine1');
  assert.equal(result.puzzle.solverColor, 'white');
  assert.equal(result.puzzle.sourceFen, PROMOTION_FEN, 'no setup move means sourceFen == solverFen');
  assert.equal(result.puzzle.source, 'user');
  assert.equal(result.puzzle.contentSchemaVersion, '1.0.0');
});

test('invalid FEN, illegal ply, solverColor mismatch and mate mismatch are rejected', () => {
  assert.equal(validateAndNormalize({ solverFen: 'nonsense', solution: ['e2e4'] }).ok, false);

  const illegal = validateAndNormalize({ solverFen: START_FEN, solution: ['e2e5'] });
  assert.equal(illegal.ok, false);
  if (!illegal.ok) assert.match(illegal.errors.join(' '), /not legal/);

  const colorMismatch = validateAndNormalize({
    solverFen: START_FEN,
    solution: ['e2e4'],
    solverColor: 'black',
  });
  assert.equal(colorMismatch.ok, false);

  const mateMismatch = validateAndNormalize({
    solverFen: START_FEN,
    solution: ['e2e4'],
    themes: ['mate'],
  });
  assert.equal(mateMismatch.ok, false);
  if (!mateMismatch.ok) assert.match(mateMismatch.errors.join(' '), /checkmate/);
});

test('mate theme accepted only when the line really ends in mate', () => {
  const result = validateAndNormalize({
    id: 'mate1',
    solverFen: MATE_FEN,
    solution: ['e1e8'],
    themes: ['mate', 'mateIn1'],
  });
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join('; '));
});

test('setup move must legally bridge source FEN to solver FEN', () => {
  const sourceFen = '5r1k/pp4pp/8/3B4/1P2pRQ1/P5PP/3q4/6K1 b - - 2 33';
  const solverFen = '7k/pp4pp/8/3B4/1P2prQ1/P5PP/3q4/6K1 w - - 0 34';
  const solution = ['g4c8', 'f4f8', 'c8f8'];

  const good = validateAndNormalize({ id: 'set1', sourceFen, setupMove: 'f8f4', solverFen, solution });
  assert.equal(good.ok, true, good.ok ? '' : good.errors.join('; '));

  const mismatched = validateAndNormalize({
    id: 'set2',
    sourceFen,
    setupMove: 'f8f4',
    solverFen: sourceFen,
    solution,
  });
  assert.equal(mismatched.ok, false);

  const missingSource = validateAndNormalize({ solverFen, setupMove: 'f8f4', solution });
  assert.equal(missingSource.ok, false);
  if (!missingSource.ok) assert.match(missingSource.errors.join(' '), /source FEN is required/);
});

test('JSONL import keeps valid lines and reports rejected ones', () => {
  const good = JSON.stringify({
    id: 'good1',
    solverFen: PROMOTION_FEN,
    solution: ['b7b8q'],
    rating: 1000,
    ratingDeviation: 75,
    themes: ['endgame'],
    source: 'lichess',
    sourceId: 'good1',
    originalFields: { Popularity: '90' },
  });
  const bad = '{"id":"bad1","solverFen":"not-a-fen","solution":["zz"]}';
  const notJson = 'this is not json';
  const text = `${good}\n${bad}\n\n${notJson}\n`;

  const result = parseJsonlPuzzles(text);
  assert.equal(result.puzzles.length, 1);
  assert.equal(result.puzzles[0]!.id, 'good1');
  assert.equal(result.puzzles[0]!.ratingDeviation, 75);
  assert.deepEqual(result.puzzles[0]!.originalFields, { Popularity: '90' });
  assert.equal(result.errors.length, 2);
  assert.equal(result.examined, 2);
});

test('normalizeUciList splits on whitespace and drops blanks', () => {
  assert.deepEqual(normalizeUciList(' e2e4   e7e5\n'), ['e2e4', 'e7e5']);
});
