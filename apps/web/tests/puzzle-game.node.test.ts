import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PuzzleGame } from '../src/puzzle-game.ts';
import { makePuzzle, promotionPuzzle, setupMovePuzzle } from './fixtures.ts';

test('correct solver move advances and auto-plays the opponent reply', () => {
  const puzzle = makePuzzle({ id: 'line', solution: ['e2e4', 'e7e5', 'g1f3'] });
  const game = new PuzzleGame(puzzle);

  assert.equal(game.solverTurn, true);
  const first = game.playUserMove('e2', 'e4');
  assert.equal(first.kind, 'correct');
  if (first.kind !== 'correct') return;
  assert.equal(first.completed, false);
  assert.ok(first.fenAfterOpponent, 'opponent reply should be applied');
  assert.equal(game.isCompleted, false);

  const second = game.playUserMove('g1', 'f3');
  assert.equal(second.kind, 'correct');
  if (second.kind !== 'correct') return;
  assert.equal(second.completed, true);
  assert.equal(game.isCompleted, true);
});

test('wrong move marks failure without changing the board position', () => {
  const game = new PuzzleGame(makePuzzle({ id: 'wrong', solution: ['e2e4'] }));
  const before = game.fen;
  const result = game.playUserMove('d2', 'd4');
  assert.equal(result.kind, 'wrong');
  assert.equal(game.failedState, true);
  assert.equal(game.fen, before, 'board should be untouched on a wrong move');
});

test('illegal move is rejected and does not fail the attempt', () => {
  const game = new PuzzleGame(makePuzzle({ id: 'illegal', solution: ['e2e4'] }));
  const result = game.playUserMove('e2', 'e5');
  assert.equal(result.kind, 'illegal');
  assert.equal(game.failedState, false);
});

test('legalDests exposes solver destinations in chessground shape', () => {
  const game = new PuzzleGame(makePuzzle({ id: 'dests' }));
  const dests = game.legalDests();
  assert.ok(dests.has('e2'));
  assert.ok(dests.get('e2')?.includes('e4'));
});

test('promotion requires a role, then completes with the chosen piece', () => {
  const game = new PuzzleGame(promotionPuzzle);
  assert.equal(game.requiresPromotion('b7', 'b8'), true);

  const needsRole = game.playUserMove('b7', 'b8');
  assert.equal(needsRole.kind, 'needs-promotion');
  assert.equal(game.failedState, false, 'prompting is not a failure');
  assert.equal(game.isCompleted, false);

  const promoted = game.playUserMove('b7', 'b8', 'q');
  assert.equal(promoted.kind, 'correct');
  if (promoted.kind !== 'correct') return;
  assert.equal(promoted.completed, true);
  assert.match(game.fen, /^1Q5k/);
});

test('under-promotion to the wrong role is graded wrong', () => {
  const game = new PuzzleGame(promotionPuzzle);
  const result = game.playUserMove('b7', 'b8', 'n');
  assert.equal(result.kind, 'wrong');
  assert.equal(game.failedState, true);
});

test('setup-move puzzle starts from solverFen and plays solver/opponent/solver', () => {
  const game = new PuzzleGame(setupMovePuzzle);
  const first = game.playUserMove('g4', 'c8');
  assert.equal(first.kind, 'correct');
  if (first.kind !== 'correct') return;
  assert.ok(first.fenAfterOpponent);
  assert.equal(first.completed, false);

  const last = game.playUserMove('c8', 'f8');
  assert.equal(last.kind, 'correct');
  if (last.kind !== 'correct') return;
  assert.equal(last.completed, true);
});

test('replaySolverMoves resumes a persisted line and stays playable', () => {
  const game = new PuzzleGame(setupMovePuzzle);
  game.replaySolverMoves(['g4c8']);
  assert.equal(game.isCompleted, false);
  assert.equal(game.solverTurn, true);

  const finish = game.playUserMove('c8', 'f8');
  assert.equal(finish.kind, 'correct');
  if (finish.kind !== 'correct') return;
  assert.equal(finish.completed, true);
});

test('replaySolverMoves ignores a move that does not match the solution', () => {
  const game = new PuzzleGame(setupMovePuzzle);
  game.replaySolverMoves(['e2e4']);
  assert.equal(game.isCompleted, false);
  assert.equal(game.turn, 'white');
});
