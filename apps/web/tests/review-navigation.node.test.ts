import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ReviewNavigator,
  buildReviewLine,
  orderedAttemptMoves,
} from '../src/puzzle-game.ts';
import { TrainingAdapter } from '../src/training-adapter.ts';
import { LocalTrainingService } from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { makePuzzle, setupMovePuzzle, timing } from './fixtures.ts';
import type { AttemptEvent } from '@chessreps/contracts';

function event(
  type: AttemptEvent['type'],
  uci?: string,
  correct?: boolean,
): AttemptEvent {
  return {
    eventId: `${type}-${uci ?? 'none'}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    occurredAt: 1,
    payload: uci === undefined ? {} : { uci, move: uci, correct },
  };
}

test('orderedAttemptMoves keeps only solver move attempts in order', () => {
  const events: AttemptEvent[] = [
    event('start'),
    event('move', 'e2e4', true),
    event('hint'),
    event('wrong-move', 'd2d4'),
    event('move', 'g1f3', false),
    { eventId: 'x', type: 'move', occurredAt: 1, payload: {} },
    event('complete'),
  ];
  assert.deepEqual(orderedAttemptMoves(events), [
    { uci: 'e2e4', correct: true },
    { uci: 'd2d4', correct: false },
    { uci: 'g1f3', correct: false },
  ]);
});

test('buildReviewLine walks solver plies plus opponent replies', () => {
  const puzzle = makePuzzle({ id: 'line', solution: ['e2e4', 'e7e5', 'g1f3'] });
  const steps = buildReviewLine(puzzle, [
    event('move', 'e2e4', true),
    event('move', 'g1f3', true),
  ]);
  assert.equal(steps.length, 4);
  assert.deepEqual(
    steps.map((s) => s.mover),
    ['start', 'solver', 'opponent', 'solver'],
  );
  assert.deepEqual(
    steps.map((s) => s.uci),
    [null, 'e2e4', 'e7e5', 'g1f3'],
  );
  assert.deepEqual(
    steps.map((s) => s.ply),
    [0, 1, 2, 3],
  );
  // Positions actually differ at each step.
  assert.equal(new Set(steps.map((s) => s.fen)).size, 4);
});

test('wrong attempts annotate the current position without advancing', () => {
  const puzzle = makePuzzle({ id: 'wrong-line', solution: ['e2e4', 'e7e5'] });
  const steps = buildReviewLine(puzzle, [
    event('wrong-move', 'd2d4'),
    event('move', 'e2e4', true),
  ]);
  assert.equal(steps.length, 4);
  assert.equal(steps[1]!.mover, 'wrong');
  assert.equal(steps[1]!.fen, steps[0]!.fen, 'wrong move leaves the board untouched');
  assert.equal(steps[1]!.ply, 0);
  assert.equal(steps[2]!.mover, 'solver');
  assert.equal(steps[3]!.mover, 'opponent');
});

test('a correct-flagged move off the solution line is treated as wrong, not fatal', () => {
  const puzzle = makePuzzle({ id: 'off-line', solution: ['e2e4', 'e7e5'] });
  const steps = buildReviewLine(puzzle, [
    event('move', 'd2d4', true),
    event('move', 'e2e4', true),
  ]);
  assert.deepEqual(
    steps.map((s) => s.mover),
    ['start', 'wrong', 'solver', 'opponent'],
  );
  assert.equal(steps[1]!.fen, steps[0]!.fen);
});

test('buildReviewLine always yields at least the starting step', () => {
  const puzzle = makePuzzle({ id: 'empty' });
  assert.equal(buildReviewLine(puzzle, []).length, 1);
  const line = buildReviewLine(puzzle, [event('reveal'), event('complete')]);
  assert.equal(line.length, 1);
  assert.equal(line[0]!.mover, 'start');
});

test('multi-ply setup-move puzzle projects the full attempt', () => {
  const steps = buildReviewLine(setupMovePuzzle, [
    event('move', 'g4c8', true),
    event('wrong-move', 'e2e4'),
    event('move', 'c8f8', true),
  ]);
  assert.deepEqual(
    steps.map((s) => s.mover),
    ['start', 'solver', 'opponent', 'wrong', 'solver'],
  );
  assert.equal(steps[3]!.fen, steps[2]!.fen);
  assert.equal(steps[4]!.ply, 3);
});

test('ReviewNavigator starts at the end and walks the full line both ways', () => {
  const puzzle = makePuzzle({ id: 'nav', solution: ['e2e4', 'e7e5', 'g1f3'] });
  const nav = new ReviewNavigator(
    buildReviewLine(puzzle, [event('move', 'e2e4', true), event('move', 'g1f3', true)]),
  );
  assert.equal(nav.count, 4);
  assert.equal(nav.position, 3);
  assert.equal(nav.canBack, true);
  assert.equal(nav.canForward, false);

  nav.back();
  nav.back();
  assert.equal(nav.position, 1);
  assert.equal(nav.current().uci, 'e2e4');
  nav.first();
  assert.equal(nav.position, 0);
  assert.equal(nav.current().uci, null);
  assert.equal(nav.canBack, false);

  nav.forward();
  assert.equal(nav.position, 1);
  nav.last();
  assert.equal(nav.position, 3);
  assert.equal(nav.canForward, false);
});

test('ReviewNavigator clamps out-of-range seeks and rejects empty lines', () => {
  const puzzle = makePuzzle({ id: 'clamp', solution: ['e2e4'] });
  const nav = new ReviewNavigator(buildReviewLine(puzzle, [event('move', 'e2e4', true)]));
  nav.goTo(-50);
  assert.equal(nav.position, 0);
  nav.goTo(999);
  assert.equal(nav.position, nav.count - 1);
  assert.throws(() => new ReviewNavigator([]), /non-empty/);
});

test('review reads the recorded attempt via the adapter without mutating state', async () => {
  const service = new LocalTrainingService({ store: new LocalStore(new InMemoryStorageBackend()) });
  await service.init();
  await service.seedContent([makePuzzle({ id: 'r1', solution: ['e2e4', 'e7e5'] })]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  await adapter.startAttempt(await adapter.loadPuzzle('r1'));
  await adapter.recordMove('e2e4', true);
  await adapter.commitSuccess(timing());

  const before = service.getAttemptCount();
  const [latest] = adapter.listAttemptsForPuzzle('r1', 1);
  assert.ok(latest, 'the committed attempt is readable for review');
  const steps = buildReviewLine(await adapter.loadPuzzle('r1'), latest!.events);
  assert.deepEqual(
    steps.map((s) => s.mover),
    ['start', 'solver', 'opponent'],
  );
  assert.equal(service.getAttemptCount(), before, 'review reads perform no writes');
  assert.deepEqual(adapter.listAttemptsForPuzzle('missing', 1), []);
});
