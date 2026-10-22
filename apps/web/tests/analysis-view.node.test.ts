/**
 * AN-002 — the analysis screen without a wasm engine: the live-analysis port is
 * faked, so these cover the *view* behaviour (free moves, navigation, the bar,
 * arrows, the engine toggle) that the browser smoke test cannot assert cheaply.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ANALYSIS_START_FEN,
  AnalysisView,
  analysisMoveText,
  fenAt,
  fenFromHash,
  playAnalysisMove,
  rememberAnalysisFen,
  rememberedAnalysisFen,
  turnOfFen,
} from '../src/analysis-view.ts';
import {
  ANALYSIS_ARROW_MIN_DEPTH,
  arrowFromUci,
  evalBarFill,
  sameFen,
  snapshotFromEvaluation,
} from '../src/engine/analysis-live.ts';

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function fakeBoard() {
  const calls: string[] = [];
  let moveHandler: ((from: string, to: string) => void) | undefined;
  return {
    calls,
    port: {
      setFen: (fen: string) => void calls.push(`fen:${fen.split(' ')[0]}`),
      setOrientation: (color: string) => void calls.push(`orientation:${color}`),
      setShapes: (shapes: Array<{ orig: string; dest?: string }>) =>
        void calls.push(`shapes:${shapes.map((s) => `${s.orig}${s.dest ?? ''}`).join(',')}`),
      onMove: (handler: (from: string, to: string) => void) => {
        moveHandler = handler;
      },
    },
    emitMove: (from: string, to: string) => moveHandler?.(from, to),
  };
}

function fakeLive() {
  const asked: string[] = [];
  let deepened = 0;
  let stopped = 0;
  return {
    asked,
    deepened: () => deepened,
    stopped: () => stopped,
    port: {
      analyze: (fen: string) => void asked.push(fen),
      deepen: () => void (deepened += 1),
      stop: () => void (stopped += 1),
      dispose: () => {},
    },
  };
}

/** Minimal element stand-in: `mount` appends one child and nothing more. */
function fakeHost() {
  const children: unknown[] = [];
  return {
    children,
    replaceChildren: () => void children.splice(0, children.length),
    appendChild: (child: unknown) => {
      children.push(child);
      return child;
    },
  } as unknown as HTMLElement;
}

function makeView(options: { initialFen?: string } = {}) {
  const board = fakeBoard();
  const live = fakeLive();
  let redraws = 0;
  const view = new AnalysisView({
    board: board.port,
    live: live.port,
    redraw: () => void (redraws += 1),
    ...(options.initialFen !== undefined ? { initialFen: options.initialFen } : {}),
  });
  return { view, board, live, redraws: () => redraws };
}

// --- pure helpers -------------------------------------------------------------

test('playAnalysisMove plays any legal move for either side', () => {
  const white = playAnalysisMove(ANALYSIS_START_FEN, 'e2', 'e4');
  assert.ok(white);
  assert.equal(white.san, 'e4');
  assert.equal(white.uci, 'e2e4');
  assert.equal(white.fen, AFTER_E4);

  const black = playAnalysisMove(AFTER_E4, 'e7', 'e5');
  assert.equal(black?.san, 'e5', 'the free board lets the other side move too');
});

test('playAnalysisMove rejects illegal moves and unreadable FENs without throwing', () => {
  assert.equal(playAnalysisMove(ANALYSIS_START_FEN, 'e2', 'e5'), undefined);
  assert.equal(playAnalysisMove(ANALYSIS_START_FEN, 'a1', 'a8'), undefined);
  assert.equal(playAnalysisMove('not a fen', 'e2', 'e4'), undefined);
});

test('analysisMoveText numbers the line like a scoresheet', () => {
  const e4 = playAnalysisMove(ANALYSIS_START_FEN, 'e2', 'e4')!;
  const e5 = playAnalysisMove(e4.fen, 'e7', 'e5')!;
  const nf3 = playAnalysisMove(e5.fen, 'g1', 'f3')!;
  assert.equal(analysisMoveText([e4, e5, nf3]), '1. e4 e5 2. Nf3');
});

test('scores are shown from White\'s side (+ White, − Black), whoever moves', () => {
  // Black to move and Black is better by 0.50: the engine says +0.50 (mover),
  // White's point of view must say −0.50.
  const black = snapshotFromEvaluation(
    {
      fen: AFTER_E4,
      depth: 15,
      score: { cp: 50 },
      pv: [['e7e5']],
      lineScores: [{ cp: 50 }],
    },
    { searching: true },
  );
  assert.equal(black.scoreText, '−0.50');
  assert.deepEqual(black.lines.map((line) => line.scoreText), ['−0.50']);

  // Mate for Black (the mover) is −#2 from White's side.
  const mated = snapshotFromEvaluation(
    {
      fen: AFTER_E4,
      depth: 15,
      score: { mate: 2 },
      pv: [['e7e5'], ['d7d5', 'd2d4']],
      lineScores: [{ mate: 2 }, { cp: -30 }],
    },
    { searching: true },
  );
  assert.equal(mated.scoreText, '−#2');
  assert.deepEqual(mated.lines.map((line) => line.scoreText), ['−#2', '+0.30']);
});

test('the remembered position is what the nav Analysis entry opens', () => {
  rememberAnalysisFen(ANALYSIS_START_FEN);
  assert.equal(rememberedAnalysisFen(), ANALYSIS_START_FEN);
  rememberAnalysisFen('');
  assert.equal(rememberedAnalysisFen(), ANALYSIS_START_FEN, 'blank input never clears it');
});

test('MultiPV lines keep their own score (not the best score repeated)', () => {
  const snapshot = snapshotFromEvaluation(
    {
      fen: ANALYSIS_START_FEN,
      depth: 15,
      score: { cp: 30 },
      pv: [['e2e4'], ['d2d4'], ['c2c4']],
      lineScores: [{ cp: 30 }, { cp: 10 }, { cp: -5 }],
    },
    { searching: true },
  );
  assert.deepEqual(
    snapshot.lines.map((line) => line.scoreText),
    ['+0.30', '+0.10', '−0.05'],
  );
  // A report without per-line scores still renders (older engines/tests).
  const fallback = snapshotFromEvaluation(
    { fen: ANALYSIS_START_FEN, score: { cp: 30 }, pv: [['e2e4'], ['d2d4']] },
    { searching: true },
  );
  assert.deepEqual(fallback.lines.map((line) => line.scoreText), ['+0.30', '+0.30']);
});

test('an engine failure is shown as unavailable, not as endless thinking', async () => {
  const { view } = makeView();
  await view.mount(fakeHost());
  view.onSnapshot({
    fen: ANALYSIS_START_FEN,
    lines: [],
    scoreText: '',
    searching: false,
    error: 'engine did not start',
  });
  const text = JSON.stringify(view.view());
  assert.ok(text.includes('could not finish'), 'the unavailable copy renders');
});

test('the eval bar maps scores and mate to a fill, from White\'s side', () => {
  assert.equal(evalBarFill({ cp: 0 }, 'white'), 0.5);
  assert.ok(evalBarFill({ cp: 300 }, 'white') > 0.6, 'a clear White edge fills more than half');
  assert.ok(evalBarFill({ cp: 300 }, 'black') < 0.4, 'the same score favours Black');
  assert.equal(evalBarFill({ mate: 3 }, 'white'), 1);
  assert.equal(evalBarFill({ mate: -2 }, 'black'), 1, 'mate for the side to move');
  assert.equal(evalBarFill(undefined, 'white'), 0.5);
});

test('arrows appear only at the documented depth, and only for real moves', () => {
  const evaluation = (depth: number) => ({
    fen: ANALYSIS_START_FEN,
    depth,
    score: { cp: 24 },
    pv: [['e2e4', 'e7e5']],
    bestMove: 'e2e4',
  });
  assert.equal(
    snapshotFromEvaluation(evaluation(ANALYSIS_ARROW_MIN_DEPTH - 1), { searching: true }).arrow,
    undefined,
    'too shallow to draw',
  );
  assert.deepEqual(
    snapshotFromEvaluation(evaluation(ANALYSIS_ARROW_MIN_DEPTH), { searching: true }).arrow,
    { orig: 'e2', dest: 'e4' },
  );
  assert.deepEqual(arrowFromUci('e7e8q'), { orig: 'e7', dest: 'e8' });
  assert.equal(arrowFromUci(undefined), undefined);
});

test('sameFen ignores the move counters but not the position', () => {
  assert.equal(sameFen(ANALYSIS_START_FEN, `${ANALYSIS_START_FEN.split(' ').slice(0, 4).join(' ')} 9 42`), true);
  assert.equal(sameFen(ANALYSIS_START_FEN, AFTER_E4), false);
});

test('fenFromHash reads a valid position and ignores junk', () => {
  assert.equal(fenFromHash(`#/analysis?fen=${encodeURIComponent(AFTER_E4)}`), AFTER_E4);
  assert.equal(fenFromHash('#/analysis?fen=nonsense'), undefined);
  assert.equal(
    fenFromHash(`#/analysis?fen=${encodeURIComponent('4k3/8/8/8/8/8/8/3qK3 b - - 0 1')}`),
    undefined,
    'a syntactically valid but illegal position is refused',
  );
  assert.equal(fenFromHash('#/analysis'), undefined);
});

test('turnOfFen reads the side to move', () => {
  assert.equal(turnOfFen(ANALYSIS_START_FEN), 'white');
  assert.equal(turnOfFen(AFTER_E4), 'black');
});

// --- the view -----------------------------------------------------------------

test('mounting analyses the initial position immediately (continuous, no button)', async () => {
  const { view, live } = makeView();
  await view.mount(fakeHost());
  assert.deepEqual(live.asked, [ANALYSIS_START_FEN]);
});

test('a free move extends the line and re-analyses the new position', async () => {
  const { view, live } = makeView();
  await view.mount(fakeHost());
  view.playMove('e2', 'e4');

  assert.equal(fenAt(view.currentState()), AFTER_E4);
  assert.equal(live.asked.length, 2);
  assert.equal(live.asked[1], AFTER_E4, 'the engine is asked about the new position');
  assert.equal(view.currentState().history[0].san, 'e4');
});

test('an illegal move is ignored (the board is snapped back)', async () => {
  const { view, live, board } = makeView();
  await view.mount(fakeHost());
  const before = live.asked.length;
  view.playMove('e2', 'e5');
  assert.equal(view.currentState().history.length, 0);
  assert.equal(live.asked.length, before);
  assert.ok(board.calls.some((call) => call.startsWith('fen:')), 'the board was re-synced');
});

test('stepping back and forward re-analyses each position and bounds at the ends', async () => {
  const { view, live } = makeView();
  await view.mount(fakeHost());
  view.playMove('e2', 'e4');
  view.playMove('e7', 'e5');
  const askedAfterTwo = live.asked.length;

  view.step(-1);
  assert.equal(fenAt(view.currentState()), AFTER_E4);
  assert.equal(live.asked.length, askedAfterTwo + 1);
  view.step(-1);
  assert.equal(fenAt(view.currentState()), ANALYSIS_START_FEN);
  view.step(-1); // already at the start
  assert.equal(fenAt(view.currentState()), ANALYSIS_START_FEN);
  view.step(1);
  assert.equal(fenAt(view.currentState()), AFTER_E4);
});

test('playing from an earlier position truncates the line', async () => {
  const { view } = makeView();
  await view.mount(fakeHost());
  view.playMove('e2', 'e4');
  view.playMove('e7', 'e5');
  view.step(-2);
  view.playMove('d2', 'd4');
  const state = view.currentState();
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].san, 'd4');
});

test('the engine toggle stops and restarts continuous analysis', async () => {
  const { view, live } = makeView();
  await view.mount(fakeHost());
  view.toggleEngine();
  assert.equal(live.stopped(), 1, 'turning it off stops the search');
  assert.equal(view.currentState().enabled, false);

  view.toggleEngine();
  assert.equal(view.currentState().enabled, true);
  assert.equal(live.asked.length, 2, 'turning it back on analyses the current position');
});

test('"go deeper" is forwarded to the engine', async () => {
  const { view, live } = makeView();
  await view.mount(fakeHost());
  view.deepen();
  assert.equal(live.deepened(), 1);
});

test('leaving the screen stops the engine (no background analysis)', async () => {
  const { view, live } = makeView();
  await view.mount(fakeHost());
  await view.unmount();
  assert.equal(live.stopped(), 1);
});

test('a snapshot renders the bar, the score, the depth and the arrow', async () => {
  const { view, board } = makeView();
  await view.mount(fakeHost());
  view.onSnapshot(
    snapshotFromEvaluation(
      { fen: ANALYSIS_START_FEN, depth: 16, score: { cp: 24 }, pv: [['e2e4', 'e7e5']], bestMove: 'e2e4' },
      { searching: false },
    ),
  );
  const tree = view.view();
  const text = JSON.stringify(tree);
  assert.ok(text.includes('+0.24'), 'the score renders');
  assert.ok(text.includes('d16'), 'the depth renders');
  assert.ok(text.includes('e4 e5'), 'the line renders in SAN');
  assert.ok(
    board.calls.some((call) => call === 'shapes:e2e4'),
    'the best-move arrow is drawn on the board',
  );
});
