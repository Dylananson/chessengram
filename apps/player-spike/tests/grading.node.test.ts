import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { gradeMove, createInitialGradingState } from '../src/grading.ts';
import type { NormalizedPuzzle } from '../src/types.ts';

const puzzle: NormalizedPuzzle = {
  id: 'test1',
  contentSchemaVersion: '1.0.0',
  rating: 1000,
  source: 'lichess',
  sourceId: 'test1',
  themes: [],
  sourceFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  solverFen: 'rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  solverColor: 'white',
  solution: ['e2e4', 'e7e5'],
  originalFields: {},
};

test('correct next move advances', () => {
  const state = createInitialGradingState();
  const result = gradeMove(puzzle, state, 'e2e4');
  assert.equal(result.verdict, 'correct');
  assert.equal(result.state.solutionIndex, 1);
  assert.equal(result.state.failed, false);
  assert.equal(result.state.completed, false);
});

test('wrong move marks failure without advancing', () => {
  const state = createInitialGradingState();
  const result = gradeMove(puzzle, state, 'd2d4');
  assert.equal(result.verdict, 'wrong');
  assert.equal(result.state.solutionIndex, 0);
  assert.equal(result.state.failed, true);
  assert.equal(result.state.completed, false);
});

test('completing solution', () => {
  let state = createInitialGradingState();
  let result = gradeMove(puzzle, state, 'e2e4');
  assert.equal(result.verdict, 'correct');
  state = result.state;
  result = gradeMove(puzzle, state, 'e7e5');
  assert.equal(result.verdict, 'correct');
  assert.equal(result.state.completed, true);
});
