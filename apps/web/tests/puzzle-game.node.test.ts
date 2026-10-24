import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PuzzleGame, buildMoveList, buildPlaybackSteps, buildReviewLine } from '../src/puzzle-game.ts';
import { CURATED_SOLUTIONS, type CuratedSolutionEntry } from '../src/curated-solutions.ts';
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

test('isLegalSolverMove probes legality without grading', () => {
  const puzzle = makePuzzle({ id: 'probe', solution: ['e2e4', 'e7e5', 'g1f3'] });
  const game = new PuzzleGame(puzzle);
  assert.equal(game.isLegalSolverMove('e2', 'e4'), true);
  assert.equal(game.isLegalSolverMove('d2', 'd4'), true, 'legal-but-wrong stays positionally legal');
  assert.equal(game.isLegalSolverMove('e2', 'e5'), false);
  assert.equal(game.failedState, false, 'probing never grades');

  const first = game.playUserMove('e2', 'e4');
  assert.equal(first.kind, 'correct');
  // Post-reply position (white to move again): legality follows the reply.
  assert.equal(game.isLegalSolverMove('g1', 'f3'), true);
  assert.equal(game.isLegalSolverMove('e4', 'e5'), false, 'occupied square');
  assert.equal(game.failedState, false);
});

test('isLegalSolverMove handles promotion roles without playing', () => {
  const game = new PuzzleGame(promotionPuzzle);
  assert.equal(game.isLegalSolverMove('b7', 'b8', 'q'), true);
  assert.equal(game.isLegalSolverMove('b7', 'b8', 'n'), true, 'role legality only — grading decides wrong');
  assert.equal(game.isLegalSolverMove('b7', 'b8'), false, 'promotion needs a role');
  assert.equal(game.isCompleted, false);
  assert.equal(game.failedState, false);

  const promoted = game.playUserMove('b7', 'b8', 'q');
  assert.equal(promoted.kind, 'correct');
  assert.equal(game.isLegalSolverMove('b7', 'b8', 'q'), false, 'no moves after completion');
});

// --- BRD-004: remaining-line computation -------------------------------------

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('curated alternative lines grade, resume, reveal, and project the same line', () => {
  const puzzle = makePuzzle({ id: 'curated-test', solution: ['e2e4', 'e7e5', 'g1f3'] });
  const registry = CURATED_SOLUTIONS as Record<string, CuratedSolutionEntry>;
  registry[puzzle.id] = {
    canonicalSolution: [...puzzle.solution],
    alternatives: [{
      line: ['d2d4', 'd7d5', 'c2c4'],
      verification: 'Test fixture only: independently supplied legal alternate line.',
    }],
  };
  try {
    const game = new PuzzleGame(puzzle);
    assert.equal(game.playUserMove('d2', 'd4').kind, 'correct');
    assert.deepEqual([...game.solutionPlaybackLine().plies], ['c2c4']);
    assert.equal(game.playUserMove('c2', 'c4').kind, 'correct');
    assert.equal(game.isCompleted, true);

    const resumed = new PuzzleGame(puzzle);
    resumed.replaySolverMoves(['d2d4']);
    assert.deepEqual([...resumed.solutionPlaybackLine().plies], ['c2c4']);

    const attempts = [
      { uci: 'd2d4', correct: true },
      { uci: 'c2c4', correct: true },
    ];
    const moveList = buildMoveList(puzzle, attempts, { complete: true });
    assert.deepEqual(moveList.flatMap((row) => [row.white?.uci, row.black?.uci].filter(Boolean)),
      ['d2d4', 'd7d5', 'c2c4']);

    const review = buildReviewLine(puzzle, [
      { eventId: 'a1', type: 'move', occurredAt: 1, payload: { uci: 'd2d4', correct: true } },
      { eventId: 'a2', type: 'move', occurredAt: 2, payload: { uci: 'c2c4', correct: true } },
    ]);
    assert.deepEqual(review.map((step) => step.uci).filter(Boolean), ['d2d4', 'd7d5', 'c2c4']);
  } finally {
    delete registry[puzzle.id];
  }
});

test('curated alternatives are ignored if their canonical source line no longer matches', () => {
  const puzzle = makePuzzle({ id: 'curated-stale', solution: ['e2e4'] });
  const registry = CURATED_SOLUTIONS as Record<string, CuratedSolutionEntry>;
  registry[puzzle.id] = {
    canonicalSolution: ['d2d4'],
    alternatives: [{ line: ['e2e4'], verification: 'stale fixture' }],
  };
  try {
    assert.equal(new PuzzleGame(puzzle).playUserMove('d2', 'd4').kind, 'wrong');
  } finally {
    delete registry[puzzle.id];
  }
});

test('a mate-in-two accepts either checkmating move on the final solver turn', () => {
  const puzzle = makePuzzle({
    id: 'mate-in-two-alternatives',
    themes: ['mateIn2'],
    solverFen: '4k3/8/8/2K5/8/8/Q7/8 w - - 0 1',
    sourceFen: '4k3/8/8/2K5/8/8/Q7/8 w - - 0 1',
    solution: ['c5d6', 'e8d8', 'a2g8'],
  });
  const game = new PuzzleGame(puzzle);
  assert.equal(game.playUserMove('c5', 'd6').kind, 'correct');
  const outcome = game.playUserMove('a2', 'a8');
  assert.equal(outcome.kind, 'correct');
  if (outcome.kind === 'correct') assert.equal(outcome.completed, true);
  assert.equal(game.isCompleted, true);

  const attempts = [
    { uci: 'c5d6', correct: true },
    { uci: 'a2a8', correct: true },
  ];
  const moveList = buildMoveList(puzzle, attempts, { complete: true });
  assert.deepEqual(moveList.flatMap((row) => [row.white?.uci, row.black?.uci].filter(Boolean)),
    ['c5d6', 'e8d8', 'a2a8']);
  const review = buildReviewLine(puzzle, [
    { eventId: 'mate2-1', type: 'move', occurredAt: 1, payload: { uci: 'c5d6', correct: true } },
    { eventId: 'mate2-2', type: 'move', occurredAt: 2, payload: { uci: 'a2a8', correct: true } },
  ]);
  assert.deepEqual(review.map((step) => step.uci).filter(Boolean), ['c5d6', 'e8d8', 'a2a8']);
});

test('BRD-004: solutionPlaybackLine plays the remainder while still on-path', () => {
  const game = new PuzzleGame(makePuzzle({ id: 'pb-on', solution: ['e2e4', 'e7e5', 'g1f3'] }));

  const fresh = game.solutionPlaybackLine();
  assert.equal(fresh.fromStart, false);
  assert.equal(fresh.startFen, START_FEN);
  assert.deepEqual([...fresh.plies], ['e2e4', 'e7e5', 'g1f3']);

  const first = game.playUserMove('e2', 'e4');
  assert.equal(first.kind, 'correct');
  const rest = game.solutionPlaybackLine();
  assert.equal(rest.fromStart, false, 'only correct moves so far — no reset');
  assert.equal(rest.startFen, game.fen, 'remaining plies play from the current board');
  assert.deepEqual([...rest.plies], ['g1f3']);
  assert.equal(game.failedState, false, 'probing the line never grades');
});

test('BRD-004: solutionPlaybackLine resets to the full line after a wrong move', () => {
  const puzzle = makePuzzle({ id: 'pb-off', solution: ['e2e4', 'e7e5', 'g1f3'] });
  const game = new PuzzleGame(puzzle);

  const wrong = game.playUserMove('d2', 'd4');
  assert.equal(wrong.kind, 'wrong');
  const line = game.solutionPlaybackLine();
  assert.equal(line.fromStart, true, 'off-line — reset to the solver position');
  assert.equal(line.startFen, puzzle.solverFen);
  assert.deepEqual([...line.plies], ['e2e4', 'e7e5', 'g1f3']);

  // A later correction does not put the line back on-path: a wrong move went
  // first, so playback still re-anchors at the start.
  const correction = game.playUserMove('e2', 'e4');
  assert.equal(correction.kind, 'correct');
  const after = game.solutionPlaybackLine();
  assert.equal(after.fromStart, true);
  assert.deepEqual([...after.plies], ['e2e4', 'e7e5', 'g1f3']);
});

test('BRD-004: buildPlaybackSteps expands plies to positions, stopping at illegal', () => {
  const steps = buildPlaybackSteps(START_FEN, ['e2e4', 'e7e5']);
  assert.equal(steps.length, 2);
  assert.deepEqual(
    steps.map((s) => s.uci),
    ['e2e4', 'e7e5'],
  );
  assert.deepEqual(
    steps.map((s) => s.index),
    [0, 1],
  );
  assert.notEqual(steps[0]!.fen, START_FEN);
  assert.notEqual(steps[1]!.fen, steps[0]!.fen);

  const stopped = buildPlaybackSteps(START_FEN, ['e2e4', 'e2e5']);
  assert.equal(stopped.length, 1, 'stops at the first illegal ply');

  assert.deepEqual(buildPlaybackSteps(START_FEN, []), [], 'empty line, no steps');
  assert.deepEqual(buildPlaybackSteps('not-a-fen', ['e2e4']), [], 'bad FEN never throws');
  assert.deepEqual(buildPlaybackSteps(START_FEN, ['zzz']), [], 'malformed UCI never throws');
});

test('BRD-004: buildPlaybackSteps renders promotion plies and the final mate', () => {
  const promo = buildPlaybackSteps(promotionPuzzle.solverFen, promotionPuzzle.solution);
  assert.equal(promo.length, 1);
  assert.equal(promo[0]!.uci, 'b7b8q');
  assert.match(promo[0]!.fen, /^1Q5k/, 'promoted queen on b8');

  const mateFen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1';
  const mate = buildPlaybackSteps(mateFen, ['h5f7']);
  assert.equal(mate.length, 1);
  assert.ok(mate[0]!.fen.includes('pppp1Qpp'), 'queen delivered mate on f7');
});

test('PZL-002: buildMoveList pairs white and black by move number with SAN and glyphs', () => {
  const puzzle = makePuzzle({ id: 'list', solution: ['e2e4', 'e7e5', 'g1f3'] });
  const rows = buildMoveList(
    puzzle,
    [{ uci: 'e2e4', correct: true }, { uci: 'g1f3', correct: true }],
    { complete: true },
  );
  assert.deepEqual(
    rows.map((row) => row.number),
    [1, 2],
  );
  assert.equal(rows[0]!.white!.san, 'e4');
  assert.equal(rows[0]!.white!.glyph, '♙');
  assert.equal(rows[0]!.black!.san, 'e5');
  assert.equal(rows[0]!.black!.glyph, '♟');
  assert.equal(rows[1]!.white!.san, 'Nf3');
  assert.equal(rows[1]!.white!.glyph, '♘');
  assert.equal(rows[1]!.black, null, 'unplayed black slot stays empty');
});

test('PZL-002: buildMoveList keeps the setup move as numbered context', () => {
  const rows = buildMoveList(setupMovePuzzle, []);
  assert.equal(rows.length, 1);
  const setup = rows[0]!.black!;
  assert.equal(rows[0]!.number, 33, 'setup ply keeps the source move number');
  assert.equal(rows[0]!.white, null);
  assert.equal(setup.san, 'Rxf4');
  assert.equal(setup.glyph, '♜');
  assert.equal(setup.setup, true);
});

test('PZL-003: reverted wrong attempts are omitted from the played line', () => {
  const puzzle = makePuzzle({ id: 'list-wrong', solution: ['e2e4', 'e7e5'] });
  const rows = buildMoveList(puzzle, [
    { uci: 'd2d4', correct: false },
    { uci: 'e2e4', correct: true },
  ]);
  assert.equal(rows.length, 1, 'the reverted attempt leaves no row');
  assert.equal(rows[0]!.white!.san, 'e4');
  assert.equal(rows[0]!.black!.san, 'e5');

  const onlyWrong = buildMoveList(puzzle, [{ uci: 'd2d4', correct: false }]);
  assert.deepEqual(onlyWrong, [], 'a reverted attempt alone shows no moves');
});

test('PZL-002: a completed line reveals the remaining solution; spoiler-free when incomplete', () => {
  const puzzle = makePuzzle({ id: 'list-complete', solution: ['e2e4', 'e7e5', 'g1f3'] });
  const partial = buildMoveList(puzzle, [{ uci: 'e2e4', correct: true }]);
  assert.equal(partial.length, 1, 'only played plies are shown while solving');
  assert.equal(partial[0]!.black!.san, 'e5');
  const full = buildMoveList(puzzle, [{ uci: 'e2e4', correct: true }], { complete: true });
  assert.equal(full.length, 2);
  assert.equal(full[1]!.white!.san, 'Nf3');
});

test('PZL-002: promotion plies show the pawn glyph and promotion SAN', () => {
  const rows = buildMoveList(promotionPuzzle, [{ uci: 'b7b8q', correct: true }], { complete: true });
  assert.equal(rows[0]!.white!.glyph, '♙');
  assert.match(rows[0]!.white!.san, /^b8=Q/);
});
