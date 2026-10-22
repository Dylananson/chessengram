/**
 * AN-001b — the engine session, driven by a fake worker.
 *
 * The interesting behaviour is the UCI conversation (handshake order, MultiPV,
 * budget selection, serialisation, timeouts, dispose), so it is tested here
 * without a real engine; the browser smoke test covers the real wasm.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ENGINE_DEFAULT_NODES,
  createEngine,
  parseBestMove,
  parseInfoLine,
  type EngineWorker,
} from '../src/engine/engine.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Records what the session sent and replies like a well-behaved engine. */
class FakeWorker implements EngineWorker {
  readonly sent: string[] = [];
  terminated = false;
  private listener: ((event: { data: unknown }) => void) | undefined;

  /** Scripted replies: the engine answers each command with these lines. */
  private readonly onCommand: (command: string, reply: (line: string) => void) => void;

  constructor(onCommand: (command: string, reply: (line: string) => void) => void) {
    this.onCommand = onCommand;
  }

  postMessage(message: string): void {
    this.sent.push(message);
    this.onCommand(message, (line) => this.listener?.({ data: line }));
  }

  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.listener = listener;
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** A fake that answers `uci`, `isready` and a search, and can be tuned. */
function engineFake(options: { reply?: string; silent?: boolean } = {}) {
  const worker = new FakeWorker((command, reply) => {
    if (command === 'uci') return reply('uciok');
    if (command === 'isready') return reply('readyok');
    if (command.startsWith('go')) {
      if (options.silent) return;
      reply('info depth 4 multipv 1 score cp 24 nodes 5000 nps 250000 time 20 pv e2e4 e7e5');
      reply(`bestmove ${options.reply ?? 'e2e4'}`);
    }
  });
  return { worker, engine: createEngine({ createWorker: () => worker }) };
}

// --- parsing ------------------------------------------------------------------

test('parseInfoLine reads depth, score, nodes and the principal variation', () => {
  const info = parseInfoLine(
    'info depth 16 seldepth 22 multipv 1 score cp 24 nodes 179000 nps 469000 time 293 pv e2e4 e7e5 g1f3',
  );
  assert.deepEqual(info, {
    depth: 16,
    multipv: 1,
    score: { cp: 24 },
    nodes: 179000,
    nps: 469000,
    timeMs: 293,
    pv: ['e2e4', 'e7e5', 'g1f3'],
  });
});

test('parseInfoLine handles mate scores, negative values and MultiPV lines', () => {
  assert.deepEqual(parseInfoLine('info depth 12 multipv 2 score mate -3 pv h7h8q'), {
    depth: 12,
    multipv: 2,
    score: { mate: -3 },
    pv: ['h7h8q'],
  });
  assert.deepEqual(parseInfoLine('info depth 8 score cp -125 pv d2d4'), {
    depth: 8,
    score: { cp: -125 },
    pv: ['d2d4'],
  });
});

test('parseInfoLine ignores non-info lines and unknown tokens', () => {
  assert.equal(parseInfoLine('bestmove e2e4'), undefined);
  assert.equal(parseInfoLine('readyok'), undefined);
  const partial = parseInfoLine('info currmove e2e4 currmovenumber 1 hashfull 12 tbhits 0');
  assert.deepEqual(partial, {}, 'no recognised fields ⇒ empty object, never a throw');
  assert.deepEqual(parseInfoLine('info depth 3 lowerbound score cp 10'), {
    depth: 3,
    score: { cp: 10 },
  });
});

test('parseBestMove reads the move, including the no-legal-move case', () => {
  assert.equal(parseBestMove('bestmove e2e4 ponder e7e5'), 'e2e4');
  assert.equal(parseBestMove('bestmove (none)'), '(none)');
  assert.equal(parseBestMove('info depth 1'), undefined);
});

// --- session ------------------------------------------------------------------

test('the session handshakes before searching and returns the parsed evaluation', async () => {
  const { worker, engine } = engineFake();
  const evaluation = await engine.evaluate(START_FEN);

  assert.deepEqual(worker.sent, [
    'uci',
    'isready',
    `position fen ${START_FEN}`,
    `go nodes ${ENGINE_DEFAULT_NODES}`,
  ]);
  assert.equal(engine.isReady(), true);
  assert.equal(evaluation.bestMove, 'e2e4');
  assert.equal(evaluation.fen, START_FEN);
  assert.deepEqual(evaluation.score, { cp: 24 });
  assert.equal(evaluation.depth, 4);
  assert.deepEqual(evaluation.pv, [['e2e4', 'e7e5']]);
  engine.dispose();
});

test('depth and MultiPV are requested as UCI options, and nodes are the default budget', async () => {
  const { worker, engine } = engineFake();
  await engine.evaluate(START_FEN, { depth: 12, multiPv: 2 });
  assert.ok(worker.sent.includes('setoption name MultiPV value 2'));
  assert.ok(worker.sent.includes('go depth 12'));

  // Switching back to a single line is also an explicit option.
  await engine.evaluate(START_FEN, { nodes: 1234 });
  assert.ok(worker.sent.includes('setoption name MultiPV value 1'));
  assert.ok(worker.sent.includes('go nodes 1234'));
  engine.dispose();
});

test('two evaluations are serialised in call order', async () => {
  const order: string[] = [];
  const worker = new FakeWorker((command, reply) => {
    if (command === 'uci') return reply('uciok');
    if (command === 'isready') return reply('readyok');
    if (command === 'position fen ' + START_FEN) order.push('first:start');
    if (command.startsWith('go')) {
      reply('info depth 2 score cp 1 pv e2e4');
      reply('bestmove e2e4');
    }
  });
  const engine = createEngine({ createWorker: () => worker });

  const [a, b] = await Promise.all([engine.evaluate(START_FEN), engine.evaluate(START_FEN)]);
  assert.equal(a.bestMove, 'e2e4');
  assert.equal(b.bestMove, 'e2e4');
  assert.deepEqual(order, ['first:start', 'first:start'], 'both searches ran, one after the other');
  // Only one handshake for the whole session.
  assert.equal(worker.sent.filter((m) => m === 'uci').length, 1);
  engine.dispose();
});

test('MultiPV lines are reported with their own scores, best first', async () => {
  const worker = new FakeWorker((command, reply) => {
    if (command === 'uci') return reply('uciok');
    if (command === 'isready') return reply('readyok');
    if (command.startsWith('go')) {
      reply('info depth 10 multipv 2 score cp 5 pv d2d4 d7d5');
      reply('info depth 10 multipv 1 score cp 30 pv e2e4 e7e5');
      reply('info depth 10 multipv 3 score mate 2 pv c2c4 c7c5');
      reply('bestmove e2e4');
    }
  });
  const engine = createEngine({ createWorker: () => worker });

  const evaluation = await engine.evaluate(START_FEN, { multiPv: 3, depth: 10 });
  assert.deepEqual(evaluation.pv, [['e2e4', 'e7e5'], ['d2d4', 'd7d5'], ['c2c4', 'c7c5']]);
  assert.deepEqual(evaluation.lineScores, [{ cp: 30 }, { cp: 5 }, { mate: 2 }]);
  assert.equal(evaluation.depth, 10);
  engine.dispose();
});

test('a search that never answers is rejected by the timeout, and the queue survives', async () => {
  let searches = 0;
  const worker = new FakeWorker((command, reply) => {
    if (command === 'uci') return reply('uciok');
    if (command === 'isready') return reply('readyok');
    if (command.startsWith('go')) {
      searches += 1;
      if (searches === 1) return; // wedged
      reply('info depth 2 score cp 0 pv e2e4');
      reply('bestmove e2e4');
    }
  });
  const engine = createEngine({ createWorker: () => worker });

  await assert.rejects(() => engine.evaluate(START_FEN, { timeoutMs: 20 }), /did not finish within 20 ms/);
  assert.equal(worker.terminated, true, 'a wedged worker is replaced, not reused');
  assert.equal(engine.isReady(), false);
  const recovered = await engine.evaluate(START_FEN, { timeoutMs: 500 });
  assert.equal(recovered.bestMove, 'e2e4', 'the next search still runs');
  engine.dispose();
});

test('an engine that never answers `uci` fails the handshake, and dispose is clean', async () => {
  const silent = new FakeWorker(() => undefined);
  const engine = createEngine({ createWorker: () => silent, startupTimeoutMs: 20 });
  await assert.rejects(() => engine.evaluate(START_FEN), /did not answer `uci` within 20 ms/);

  const { worker, engine: healthy } = engineFake();
  await healthy.evaluate(START_FEN);
  healthy.dispose();
  assert.equal(healthy.isReady(), false);
  assert.deepEqual(worker.sent.slice(-1), ['quit']);
  assert.equal(worker.terminated, true);
  await assert.rejects(() => healthy.evaluate(START_FEN), /disposed/);
});

test('a blank FEN is rejected without touching the engine', async () => {
  const { worker, engine } = engineFake();
  await assert.rejects(() => engine.evaluate('   '), /requires a FEN string/);
  assert.deepEqual(worker.sent, [], 'no worker was even started');
  engine.dispose();
});

test('the no-legal-move answer round-trips as a best move', async () => {
  const { engine } = engineFake({ reply: '(none)' });
  const evaluation = await engine.evaluate(START_FEN);
  assert.equal(evaluation.bestMove, '(none)');
  engine.dispose();
});
