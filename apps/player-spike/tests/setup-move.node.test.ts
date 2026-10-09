import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { gradeMove, createInitialGradingState } from '../src/grading.ts';
import type { NormalizedPuzzle } from '../src/types.ts';

const puzzle: NormalizedPuzzle = {
  id: 'test-setup',
  contentSchemaVersion: '1.0.0',
  rating: 905,
  source: 'lichess',
  sourceId: '01q5Z',
  themes: ['endgame', 'mate', 'mateIn2', 'short'],
  sourceFen: '5r1k/pp4pp/8/3B4/1P2pRQ1/P5PP/3q4/6K1 b - - 2 33',
  setupMove: 'f8f4',
  solverFen: '7k/pp4pp/8/3B4/1P2prQ1/P5PP/3q4/6K1 w - - 0 34',
  solverColor: 'white',
  solution: ['g4c8', 'f4f8', 'c8f8'],
  originalFields: {},
};

test('setup-move - solver always starts from solverFen', () => {
  let state = createInitialGradingState();
  let result = gradeMove(puzzle, state, 'g4c8');
  assert.equal(result.verdict, 'correct');
  state = result.state;
  result = gradeMove(puzzle, state, 'f4f8');
  state = result.state;
  result = gradeMove(puzzle, state, 'c8f8');
  assert.equal(result.verdict, 'correct');
  assert.equal(result.state.completed, true);
});
