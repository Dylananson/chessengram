/**
 * AN-002 — continuous analysis orchestration, with an injected engine so the
 * timing/superseding behaviour is deterministic.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ANALYSIS_ARROW_MIN_DEPTH,
  ANALYSIS_CONTINUOUS_MAX_DEPTH,
  ANALYSIS_DEEP_MAX_DEPTH,
  canDeepen,
  createLiveAnalysis,
  type AnalysisSnapshot,
} from '../src/engine/analysis-live.ts';
import type { EngineEvaluation, EngineSession, EvaluateOptions } from '../src/engine/engine.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

interface Call {
  fen: string;
  options: EvaluateOptions;
  /** Let the test drive the engine's progress. */
  emit: (depth: number, cp: number) => void;
  finish: () => void;
  fail: () => void;
}

/** An engine whose searches the test controls. */
function controlledEngine() {
  const calls: Call[] = [];
  const stops: string[] = [];
  let activeFen: string | undefined;
  const engine: EngineSession = {
    isReady: () => true,
    stop: () => {
      if (activeFen !== undefined) stops.push(activeFen);
      activeFen = undefined;
    },
    dispose: () => {},
    evaluate(fen, options = {}) {
      activeFen = fen;
      return new Promise<EngineEvaluation>((resolve, reject) => {
        const evaluation = (depth: number, cp: number): EngineEvaluation => ({
          fen,
          depth,
          score: { cp },
          pv: [['e2e4', 'e7e5']],
          bestMove: 'e2e4',
        });
        calls.push({
          fen,
          options,
          emit: (depth, cp) => options.onUpdate?.(evaluation(depth, cp)),
          finish: () => resolve(evaluation(20, 30)),
          fail: () => reject(new Error('aborted')),
        });
      });
    },
  };
  return { engine, calls, stops };
}

function collect() {
  const snapshots: AnalysisSnapshot[] = [];
  return { snapshots, onSnapshot: (snapshot: AnalysisSnapshot) => snapshots.push(snapshot) };
}

test('entering a position starts one continuous search with the documented cap', () => {
  const { engine, calls } = controlledEngine();
  const sink = collect();
  const live = createLiveAnalysis({ engine, onSnapshot: sink.onSnapshot });

  live.analyze(START);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.continuous, true, 'not a fixed node budget');
  assert.equal(calls[0].options.maxDepth, ANALYSIS_CONTINUOUS_MAX_DEPTH);
  assert.equal(calls[0].options.multiPv, 3, 'three lines, like the sites');
  live.dispose();
});

test('progress is reported as the engine climbs, and the final state is not "searching"', async () => {
  const { engine, calls } = controlledEngine();
  const sink = collect();
  const live = createLiveAnalysis({ engine, onSnapshot: sink.onSnapshot, minIntervalMs: 0 });

  live.analyze(START);
  calls[0].emit(8, 12);
  calls[0].emit(ANALYSIS_ARROW_MIN_DEPTH, 24);
  calls[0].finish();
  await new Promise<void>((resolve) => setImmediate(resolve)); // the finish is async

  assert.ok(sink.snapshots.length >= 3);
  assert.equal(sink.snapshots[0].searching, true, 'the position starts as searching');
  const atDepth = sink.snapshots.find((snapshot) => snapshot.depth === 8);
  assert.equal(atDepth?.scoreText, '+0.12', 'the score updates live');
  assert.equal(atDepth?.arrow, undefined, 'no arrow below the depth threshold');
  const deep = sink.snapshots.find((snapshot) => snapshot.depth === ANALYSIS_ARROW_MIN_DEPTH);
  assert.deepEqual(deep?.arrow, { orig: 'e2', dest: 'e4' }, 'the arrow appears at the threshold');
  assert.equal(sink.snapshots.at(-1)?.searching, false, 'finishing clears the searching state');
  live.dispose();
});

test('reports are throttled so a fast engine cannot flood the UI', () => {
  const { engine, calls } = controlledEngine();
  const sink = collect();
  let clock = 0;
  const live = createLiveAnalysis({
    engine,
    onSnapshot: sink.onSnapshot,
    minIntervalMs: 100,
    now: () => clock,
  });

  live.analyze(START); // publishes the reset marker (depth undefined) at t=0
  // Within the window nothing else is published — including a report 1 ms later,
  // which is exactly the flood the throttle exists to prevent.
  clock += 1;
  calls[0].emit(2, 1);
  calls[0].emit(4, 2);
  calls[0].emit(6, 3);
  assert.equal(
    sink.snapshots.filter((snapshot) => snapshot.depth !== undefined).length,
    0,
    'no update inside the throttle window',
  );

  clock += 150;
  calls[0].emit(8, 4); // past the window: reported
  clock += 150;
  calls[0].emit(10, 5); // and again
  const reported = sink.snapshots.map((snapshot) => snapshot.depth).filter((depth) => depth !== undefined);
  assert.deepEqual(reported, [8, 10], 'one report per window, not one per engine line');
  calls[0].finish();
  live.dispose();
});

test('changing position supersedes the old search: its late reports are ignored', () => {
  const { engine, calls, stops } = controlledEngine();
  const sink = collect();
  const live = createLiveAnalysis({ engine, onSnapshot: sink.onSnapshot, minIntervalMs: 0 });

  live.analyze(START);
  live.analyze(AFTER_E4);
  assert.equal(calls.length, 2);
  assert.deepEqual(stops, [START], 'the old search is actually stopped');

  // The first search reports late, after the user moved on.
  calls[0].emit(18, 999);
  assert.equal(
    sink.snapshots.some((snapshot) => snapshot.scoreText === '+9.99'),
    false,
    'a stale report never reaches the UI',
  );
  calls[1].emit(10, 20);
  assert.equal(sink.snapshots.at(-1)?.fen, AFTER_E4);
  live.dispose();
});

test('re-asking about the position already climbing does not restart it', () => {
  const { engine, calls } = controlledEngine();
  const live = createLiveAnalysis({ engine, onSnapshot: () => {} });
  live.analyze(START);
  live.analyze(START);
  assert.equal(calls.length, 1, 'one search per position');
  live.dispose();
});

test('"go deeper" raises the cap and restarts the current position', () => {
  const { engine, calls } = controlledEngine();
  const sink = collect();
  const live = createLiveAnalysis({ engine, onSnapshot: sink.onSnapshot });

  live.analyze(START);
  calls[0].finish();
  live.deepen();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.maxDepth, ANALYSIS_DEEP_MAX_DEPTH);
  live.dispose();
});

test('stop() silences the current search, and dispose closes a self-created engine', () => {
  const { engine, calls, stops } = controlledEngine();
  const sink = collect();
  const live = createLiveAnalysis({ engine, onSnapshot: sink.onSnapshot, minIntervalMs: 0 });

  live.analyze(START);
  const before = sink.snapshots.length;
  live.stop();
  assert.deepEqual(stops, [START], 'stop() also stops the engine search');
  calls[0].emit(12, 40);
  assert.equal(sink.snapshots.length, before, 'nothing is reported after stop()');
  assert.equal(live.current(), undefined);

  live.dispose();
  assert.doesNotThrow(() => live.dispose(), 'dispose is idempotent');
});

test('a failing engine reports the error instead of pretending to search', () => {
  const { engine, calls } = controlledEngine();
  const sink = collect();
  const live = createLiveAnalysis({ engine, onSnapshot: sink.onSnapshot });

  live.analyze(START);
  calls[0].fail();
  return new Promise<void>((resolve) =>
    setImmediate(() => {
      const last = sink.snapshots.at(-1);
      assert.equal(last?.searching, false);
      assert.equal(last?.error, 'aborted', 'the reason reaches the UI');
      live.dispose();
      resolve();
    }),
  );
});

test('canDeepen is only true for a finished search with a depth', () => {
  assert.equal(canDeepen(undefined), false);
  assert.equal(canDeepen({ fen: START, lines: [], scoreText: '', searching: true, depth: 10 }), false);
  assert.equal(canDeepen({ fen: START, lines: [], scoreText: '', searching: false, depth: 10 }), true);
  assert.equal(canDeepen({ fen: START, lines: [], scoreText: '', searching: false }), false);
});
