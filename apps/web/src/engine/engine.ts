/**
 * AN-001b — the chess engine, behind a single-position API.
 *
 * Scope, deliberately small: load the vendored Stockfish build lazily in a Web
 * Worker, expose **one position evaluation**, and nothing else. Batching hundreds
 * of games, thresholds and puzzle generation belong to `CC-001b`, which drives
 * this API — so moving to a server-side (or desktop) engine later is a change of
 * *driver*, not of engine.
 *
 * The build is `stockfish.js 19.0.1` **lite-single**: handcrafted evaluation, no
 * NNUE, no `SharedArrayBuffer`, no `eval`. That is the mobile-friendly
 * configuration chess.com itself defaults to (its owning help pages cite the
 * 108 MB NNUE and battery drain as the reasons). See
 * `docs/research/stockfish-evaluation.md` and `apps/web/THIRD-PARTY-NOTICE.md`
 * (GPL-3.0).
 *
 * Testing seam: the worker factory is injectable, so the UCI session is exercised
 * under `node --test` with a fake worker while the browser gets a real one.
 */

/** The subset of `Worker` this module needs (injectable as a fake in tests). */
export interface EngineWorker {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  terminate(): void;
}

/** Where the vendored pair is served from (`public/engine/…`). */
export const ENGINE_URL = '/engine/stockfish-19-lite-single.js';

/** Search budget used when the caller gives none: fast and phone-appropriate. */
export const ENGINE_DEFAULT_NODES = 50_000;
/** Guard against a wedged engine; generous because phones are slow. */
export const ENGINE_DEFAULT_TIMEOUT_MS = 60_000;
/** The wasm has to boot before it can answer; phones can be slow to start. */
export const ENGINE_STARTUP_TIMEOUT_MS = 30_000;

export interface EngineScore {
  /** Centipawns, from the side to move. Absent when `mate` is set. */
  cp?: number;
  /** Mate in N (negative = being mated), from the side to move. */
  mate?: number;
}

export interface EngineEvaluation {
  fen: string;
  /** UCI move, or `'(none)'` when the position has no legal move. */
  bestMove?: string;
  /** Deepest depth reached at the reported line. */
  depth?: number;
  score?: EngineScore;
  /** Principal variations, best first (one entry per MultiPV line reported). */
  pv: string[][];
  /** Score of each line, aligned with `pv`; `undefined` for unreported lines. */
  lineScores?: Array<EngineScore | undefined>;
  nodes?: number;
  nps?: number;
  timeMs?: number;
}

export interface EvaluateOptions {
  /** Search budget: nodes (preferred for batch work) or depth. */
  nodes?: number;
  depth?: number;
  /**
   * No budget at all: search until `maxDepth` (or until the caller abandons the
   * evaluation). This is the continuous-analysis shape — the engine keeps
   * climbing and every improvement is reported through `onUpdate`.
   */
  continuous?: boolean;
  /** Cap for a continuous search (also honoured when `depth` is given). */
  maxDepth?: number;
  /**
   * Called on every improvement of the current search, so a UI can render a
   * live eval bar/lines instead of waiting for the final `bestmove`.
   */
  onUpdate?: (evaluation: EngineEvaluation) => void;
  /** Number of lines to report (default 1). */
  multiPv?: number;
  /** Reject if the search does not finish in this time. 0 disables the guard. */
  timeoutMs?: number;
}

export interface EngineSession {
  evaluate(fen: string, options?: EvaluateOptions): Promise<EngineEvaluation>;
  /**
   * Ask the active search to finish now (UCI `stop`). The pending promise then
   * resolves with its best-so-far evaluation, which unblocks the queue. No-op
   * when nothing is searching. Continuous analysis calls this before switching
   * position, so a superseded search cannot hold the engine for minutes.
   */
  stop(): void;
  /** True once `uciok` has been seen (the wasm is loaded and answering). */
  isReady(): boolean;
  /** Stop the engine and release the worker. Idempotent. */
  dispose(): void;
}

/** One parsed `info` line. Unknown tokens are ignored on purpose. */
export interface ParsedInfo {
  depth?: number;
  multipv?: number;
  score?: EngineScore;
  nodes?: number;
  nps?: number;
  timeMs?: number;
  pv?: string[];
}

/**
 * Parse an engine `info` line. Returns `undefined` for anything that is not an
 * `info` line; unknown or reordered tokens are skipped rather than guessed at.
 *
 * Example: `info depth 16 multipv 1 score cp 24 nodes 179000 nps 469000 time 293
 * pv e2e4 e7e5 g1f3`.
 */
export function parseInfoLine(line: string): ParsedInfo | undefined {
  if (typeof line !== 'string') return undefined;
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'info') return undefined;

  const parsed: ParsedInfo = {};
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    const value = tokens[i + 1];
    switch (token) {
      case 'depth':
        parsed.depth = Number(value);
        i += 1;
        break;
      case 'multipv':
        parsed.multipv = Number(value);
        i += 1;
        break;
      case 'nodes':
        parsed.nodes = Number(value);
        i += 1;
        break;
      case 'nps':
        parsed.nps = Number(value);
        i += 1;
        break;
      case 'time':
        parsed.timeMs = Number(value);
        i += 1;
        break;
      case 'score': {
        const kind = tokens[i + 1];
        const amount = Number(tokens[i + 2]);
        if (kind === 'cp') parsed.score = { cp: amount };
        else if (kind === 'mate') parsed.score = { mate: amount };
        i += 2; // consumes `score`, the kind and the amount
        break;
      }
      case 'pv':
        parsed.pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
      default:
        // seldepth, currmove, currmovenumber, hashfull, tbhits, lowerbound,
        // upperbound, refutation, string … — deliberately ignored.
        break;
    }
  }
  return parsed;
}

/** The engine reports `(none)` when the position has no legal move. */
export function parseBestMove(line: string): string | undefined {
  if (typeof line !== 'string') return undefined;
  const match = /^bestmove\s+(\S+)/.exec(line.trim());
  return match ? match[1] : undefined;
}

function defaultEngineWorker(url: string): EngineWorker {
  return new Worker(url) as unknown as EngineWorker;
}

export interface CreateEngineOptions {
  /** Injectable worker factory; defaults to a real `Worker`. */
  createWorker?: () => EngineWorker;
  /** Engine script URL (defaults to {@link ENGINE_URL}). */
  engineUrl?: string;
  /** Default search budget in nodes for `evaluate()`. */
  defaultNodes?: number;
  /** Default per-search timeout in ms (0 = no guard). */
  timeoutMs?: number;
  /** Startup timeout in ms (0 = no guard). */
  startupTimeoutMs?: number;
}

interface Pending {
  fen: string;
  lines: Map<number, ParsedInfo>;
  options: EvaluateOptions;
  /** Best move seen so far, so a live snapshot can draw an arrow mid-search. */
  bestKnown?: string;
  /** `stop()` was called: settle at the next `bestmove`, ignore further info. */
  cancelled?: boolean;
  resolve: (evaluation: EngineEvaluation) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * A lazily started, single-instance UCI session. Searches are serialised (one
 * engine, one search at a time) and queued in call order.
 */
export function createEngine(options: CreateEngineOptions = {}): EngineSession {
  const defaultNodes = options.defaultNodes ?? ENGINE_DEFAULT_NODES;
  const defaultTimeoutMs = options.timeoutMs ?? ENGINE_DEFAULT_TIMEOUT_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? ENGINE_STARTUP_TIMEOUT_MS;
  const spawn = options.createWorker ?? (() => defaultEngineWorker(options.engineUrl ?? ENGINE_URL));

  let worker: EngineWorker | undefined;
  let ready = false;
  let disposed = false;
  let current: Pending | undefined;
  let multiPv = 1;
  let startup: Promise<void> | undefined;
  let resolveStartup: (() => void) | undefined;
  let rejectStartup: ((error: Error) => void) | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  function collect(fen: string, lines: Map<number, ParsedInfo>): Omit<EngineEvaluation, 'bestMove'> {
    const entries = [...lines.entries()].sort((a, b) => a[0] - b[0]); // multipv 1 = best
    // Report the *best* line's depth/counters: that is the depth the player is
    // being shown, even if a lower MultiPV line happens to be one ply deeper.
    const best = entries[0]?.[1];
    const reported = entries.filter(([, info]) => (info.pv?.length ?? 0) > 0);
    return {
      fen,
      pv: reported.map(([, info]) => info.pv ?? []),
      lineScores: reported.map(([, info]) => info.score),
      ...(best?.depth !== undefined ? { depth: best.depth } : {}),
      ...(best?.score !== undefined ? { score: best.score } : {}),
      ...(best?.nodes !== undefined ? { nodes: best.nodes } : {}),
      ...(best?.nps !== undefined ? { nps: best.nps } : {}),
      ...(best?.timeMs !== undefined ? { timeMs: best.timeMs } : {}),
    };
  }

  function onLine(raw: unknown): void {
    if (typeof raw !== 'string') return;
    const line = raw.trim();

    if (line === 'uciok' && !ready) {
      ready = true;
      const settle = resolveStartup;
      resolveStartup = undefined;
      rejectStartup = undefined;
      // Ask for readiness confirmation before the first search, so the caller's
      // first `go` cannot race the wasm.
      worker?.postMessage('isready');
      settle?.();
      return;
    }

    const pending = current;
    if (!pending) return;

    const bestMove = parseBestMove(line);
    if (bestMove !== undefined) {
      current = undefined;
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ ...collect(pending.fen, pending.lines), bestMove });
      return;
    }

    // A stopped search may still emit a few lines before its `bestmove`; they
    // are about a position the caller already left, so never report them.
    if (pending.cancelled) return;

    const info = parseInfoLine(line);
    if (!info) return;
    // Keep the deepest info per MultiPV line: the engine emits progressively
    // deeper lines and we want the last/best of each.
    const index = info.multipv ?? 1;
    const existing = pending.lines.get(index);
    if (!existing || (info.depth ?? 0) >= (existing.depth ?? 0)) {
      pending.lines.set(index, info);
      // Live progress: report every improvement to the caller (continuous mode).
      pending.options.onUpdate?.({
        ...collect(pending.fen, pending.lines),
        ...(pending.bestKnown !== undefined ? { bestMove: pending.bestKnown } : {}),
      });
    }
    if (info.pv !== undefined) pending.bestKnown = info.pv[0];
  }

  function start(): Promise<void> {
    if (disposed) return Promise.reject(new Error('engine session disposed'));
    if (ready) return Promise.resolve();
    if (startup) return startup;

    startup = new Promise<void>((resolve, reject) => {
      const timer =
        startupTimeoutMs > 0
          ? setTimeout(() => {
              const fail = rejectStartup;
              resolveStartup = undefined;
              rejectStartup = undefined;
              startup = undefined;
              fail?.(new Error(`engine did not answer \`uci\` within ${startupTimeoutMs} ms`));
            }, startupTimeoutMs)
          : undefined;

      resolveStartup = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      rejectStartup = (error: Error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      };

      try {
        worker = spawn();
      } catch (error) {
        const fail = rejectStartup;
        resolveStartup = undefined;
        rejectStartup = undefined;
        startup = undefined;
        fail?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      worker.addEventListener('message', (event) => onLine(event.data));
      worker.postMessage('uci');
    });

    // A failed handshake must be retryable rather than poisoning the session.
    startup = startup.catch((error: unknown) => {
      startup = undefined;
      ready = false;
      throw error;
    });
    return startup;
  }

  /**
   * The `go` arguments. A continuous search is a depth cap rather than
   * `go infinite`: the engine then *finishes* at the cap and sends `bestmove`,
   * so no `stop` bookkeeping is needed — and abandoning it early is just the
   * timeout/abort path (lichess's "infinite analysis" is likewise a depth-99 cap).
   */
  function goBudget(evaluateOptions: EvaluateOptions, defaultNodes: number): string {
    const cap = evaluateOptions.maxDepth ?? evaluateOptions.depth;
    if (evaluateOptions.continuous === true || (cap !== undefined && evaluateOptions.depth === undefined)) {
      return `depth ${Math.max(1, Math.floor(cap ?? 99))}`;
    }
    if (evaluateOptions.depth !== undefined) {
      return `depth ${Math.max(1, Math.floor(evaluateOptions.depth))}`;
    }
    return `nodes ${Math.max(1, Math.floor(evaluateOptions.nodes ?? defaultNodes))}`;
  }

  function search(fen: string, evaluateOptions: EvaluateOptions): Promise<EngineEvaluation> {
    const active = worker;
    if (!active || disposed) return Promise.reject(new Error('engine session is not available'));

    const wanted = Math.max(1, Math.floor(evaluateOptions.multiPv ?? 1));
    if (wanted !== multiPv) {
      multiPv = wanted;
      active.postMessage(`setoption name MultiPV value ${wanted}`);
    }

    return new Promise<EngineEvaluation>((resolve, reject) => {
      const pending: Pending = { fen, lines: new Map(), options: evaluateOptions, resolve, reject };
      current = pending;

      const timeoutMs = evaluateOptions.timeoutMs ?? defaultTimeoutMs;
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (current === pending) current = undefined;
          // A search that will not answer cannot be reasoned with: replace the
          // worker so the next call starts from a known-good session (otherwise
          // the unblocked queue would interleave with the runaway search).
          const wedged = worker;
          worker = undefined;
          ready = false;
          startup = undefined;
          wedged?.postMessage('quit');
          wedged?.terminate();
          reject(new Error(`engine did not finish within ${timeoutMs} ms`));
        }, timeoutMs);
      }

      active.postMessage(`position fen ${fen}`);
      const budget = goBudget(evaluateOptions, defaultNodes);
      active.postMessage(`go ${budget}`);
    });
  }

  return {
    isReady: () => ready,
    stop() {
      const pending = current;
      if (!pending || pending.cancelled) return;
      pending.cancelled = true;
      if (pending.timer) clearTimeout(pending.timer);
      worker?.postMessage('stop');
    },
    evaluate(fen, evaluateOptions = {}) {
      if (typeof fen !== 'string' || fen.trim() === '') {
        return Promise.reject(new Error('evaluate requires a FEN string'));
      }
      const runOnce = async (): Promise<EngineEvaluation> => {
        await start();
        return search(fen.trim(), evaluateOptions);
      };
      // Serialise in call order; `runOnce` is used for both the fulfilled and
      // rejected paths of the previous job, so one failure cannot wedge the queue.
      const next = queue.then(runOnce, runOnce);
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ready = false;
      startup = undefined;
      const failStartup = rejectStartup;
      resolveStartup = undefined;
      rejectStartup = undefined;
      if (current) {
        if (current.timer) clearTimeout(current.timer);
        current.reject(new Error('engine session disposed'));
        current = undefined;
      }
      const active = worker;
      worker = undefined;
      failStartup?.(new Error('engine session disposed'));
      if (active) {
        active.postMessage('quit');
        active.terminate();
      }
    },
  };
}
