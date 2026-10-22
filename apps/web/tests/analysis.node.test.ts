/**
 * AN-001b — the analysis layer (policy, formatting and caching) without an
 * engine: `createAnalysisService` takes an injectable `EngineSession`.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ANALYSIS_NODES,
  createAnalysisService,
  formatLine,
  formatScore,
  getAnalysisService,
  resetAnalysisService,
  uciLineToSan,
} from '../src/engine/analysis.ts';
import type { EngineSession } from '../src/engine/engine.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const OTHER_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

interface Call {
  fen: string;
  options: { multiPv?: number; nodes?: number; depth?: number } | undefined;
}

function fakeEngine(overrides: Partial<EngineSession> = {}) {
  const calls: Call[] = [];
  let disposed = false;
  const engine: EngineSession = {
    isReady: () => true,
    stop: () => {},
    dispose: () => {
      disposed = true;
    },
    async evaluate(fen, options) {
      calls.push({ fen, options });
      return {
        fen,
        bestMove: 'e2e4',
        depth: 12,
        score: { cp: 24 },
        pv: [
          ['e2e4', 'e7e5'],
          ['d2d4', 'd7d5'],
        ],
      };
    },
    ...overrides,
  };
  return { engine, calls, wasDisposed: () => disposed };
}

// --- formatting ---------------------------------------------------------------

test('formatScore renders centipawns, mates and equality', () => {
  assert.equal(formatScore({ cp: 24 }), '+0.24');
  assert.equal(formatScore({ cp: -125 }), '−1.25');
  assert.equal(formatScore({ cp: 0 }), '0.00');
  assert.equal(formatScore({ cp: 1000 }), '+10.00');
  assert.equal(formatScore({ mate: 3 }), '#3');
  assert.equal(formatScore({ mate: -2 }), '−#2');
  assert.equal(formatScore(undefined), '');
});

test('formatLine joins SAN moves for display', () => {
  assert.equal(formatLine(['e4', 'e5', 'Nf3']), 'e4 e5 Nf3');
  assert.equal(formatLine([]), '');
});

// --- UCI → SAN ----------------------------------------------------------------

test('uciLineToSan converts a principal variation from the given position', () => {
  assert.deepEqual(uciLineToSan(START_FEN, ['e2e4', 'e7e5', 'g1f3']), ['e4', 'e5', 'Nf3']);
});

test('uciLineToSan stops at the first unplayable move instead of throwing', () => {
  assert.deepEqual(uciLineToSan(START_FEN, ['e2e4', 'e7e5', 'e2e4']), ['e4', 'e5']);
  assert.deepEqual(uciLineToSan('not a fen', ['e2e4']), []);
  assert.deepEqual(uciLineToSan(START_FEN, ['zzzz']), []);
});

// --- the service --------------------------------------------------------------

test('analyze returns ready-to-render lines with SAN and scores', async () => {
  const { engine, calls } = fakeEngine();
  const service = createAnalysisService({ engine, multiPv: 2 });

  const analysis = await service.analyze(START_FEN);

  assert.equal(analysis.lines.length, 2);
  assert.equal(analysis.lines[0].scoreText, '+0.24');
  assert.deepEqual(analysis.lines[0].san, ['e4', 'e5']);
  assert.deepEqual(analysis.lines[1].san, ['d4', 'd5']);
  assert.equal(analysis.lines[0].depth, 12);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options?.multiPv, 2);
  assert.equal(calls[0].options?.nodes, ANALYSIS_NODES, 'the documented budget is the default');
  assert.equal(service.isBusy(), false);
  service.dispose();
});

test('a repeated position comes from the cache, a new one goes to the engine', async () => {
  const { engine, calls } = fakeEngine();
  const service = createAnalysisService({ engine });

  await service.analyze(START_FEN);
  await service.analyze(`  ${START_FEN}  `); // whitespace is not a different position
  assert.equal(calls.length, 1, 'the second call was served from the cache');

  await service.analyze(OTHER_FEN);
  assert.equal(calls.length, 2);
  service.dispose();
});

test('the cache is bounded, and eviction means a fresh analysis', async () => {
  const { engine, calls } = fakeEngine();
  const service = createAnalysisService({ engine, cacheLimit: 1 });

  await service.analyze(START_FEN);
  await service.analyze(OTHER_FEN);
  assert.equal(calls.length, 2);
  await service.analyze(START_FEN); // evicted by the bound
  assert.equal(calls.length, 3);
  service.dispose();
});

test('an engine failure rejects, is not cached, and the next call retries', async () => {
  let attempts = 0;
  const { engine } = fakeEngine({
    async evaluate(fen) {
      attempts += 1;
      if (attempts === 1) throw new Error('engine exploded');
      return { fen, bestMove: 'e2e4', pv: [['e2e4']], score: { cp: 5 } };
    },
  });
  const service = createAnalysisService({ engine });

  await assert.rejects(() => service.analyze(START_FEN), /engine exploded/);
  assert.equal(service.isBusy(), false, 'a failure must not leave the service stuck busy');
  const recovered = await service.analyze(START_FEN);
  assert.equal(recovered.lines[0].scoreText, '+0.05');
  service.dispose();
});

test('the service formats scores from White\'s side even when Black is to move', async () => {
  const { engine } = fakeEngine({
    async evaluate(fen) {
      return {
        fen,
        bestMove: 'e7e5',
        depth: 12,
        score: { cp: 50 }, // mover (Black) is better
        pv: [['e7e5', 'g1f3']],
      };
    },
  });
  const service = createAnalysisService({ engine });
  const analysis = await service.analyze('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  assert.equal(analysis.lines[0].scoreText, '−0.50');
  service.dispose();
});

test('depth is forwarded when configured, and an empty FEN is rejected', async () => {
  const { engine, calls } = fakeEngine();
  const service = createAnalysisService({ engine, depth: 14 });
  await service.analyze(START_FEN);
  assert.equal(calls[0].options?.depth, 14);
  assert.equal(calls[0].options?.nodes, undefined);
  await assert.rejects(() => service.analyze('   '), /requires a FEN/);
  service.dispose();
});

test('dispose closes a self-created engine but never an injected one', async () => {
  const { engine, wasDisposed } = fakeEngine();
  const service = createAnalysisService({ engine });
  await service.analyze(START_FEN);
  service.dispose();
  assert.equal(wasDisposed(), false, 'the injected engine belongs to the caller');
  await assert.rejects(() => service.analyze(START_FEN), /disposed/);
});

test('the shared service is a singleton and can be reset (test seam)', () => {
  const first = getAnalysisService();
  assert.equal(getAnalysisService(), first);
  resetAnalysisService();
  assert.notEqual(getAnalysisService(), first);
  resetAnalysisService();
});
