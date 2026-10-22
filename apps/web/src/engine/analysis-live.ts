/**
 * AN-002 — continuous (progressive) analysis, the way lichess and chess.com
 * actually do it.
 *
 * What the research says (see `docs/research/analysis-modes.md`):
 * - lichess runs the local engine on the **current position** and lets it climb
 *   ("infinite analysis" is a depth-99 cap, not `go infinite`); the eval bar and
 *   lines update live, an explicit **"go deeper"** raises the cap, and the UI
 *   shows the depth. In Analysis Board the engine is already running after each
 *   move — no button press.
 * - chess.com updates the eval bar "for each move", shows **suggestion arrows**
 *   (green best move) only from **depth 14** ("to make sure the first arrow is
 *   the most accurate move"), offers engine lines *or* move feedback, and caps
 *   thinking time on iOS to protect the battery.
 *
 * So this module keeps **one** search per position and reports it as it climbs,
 * rather than the fixed-budget one-shot of `AN-001b`. Every report is a complete
 * snapshot (`depth`, `lines`, `arrow`), which is what a live UI needs; the caller
 * simply replaces what it renders.
 */
import { createEngine, type EngineScore, type EngineSession } from './engine.ts';
import {
  formatScore,
  toWhitePov,
  turnOfFen,
  uciLineToSan,
  type AnalysisLine,
} from './analysis.ts';

/** Arrows are only drawn from this depth on (chess.com's own threshold). */
export const ANALYSIS_ARROW_MIN_DEPTH = 14;
/** Depth cap for the normal continuous search; "go deeper" raises it. */
export const ANALYSIS_CONTINUOUS_MAX_DEPTH = 40;
/** The cap "go deeper" switches to (lichess uses 99; phone-friendly is lower). */
export const ANALYSIS_DEEP_MAX_DEPTH = 99;
/** How long a single continuous search may run before it is allowed to stop. */
export const ANALYSIS_CONTINUOUS_TIMEOUT_MS = 600_000;

/** One live snapshot of the search for the current position. */
export interface AnalysisSnapshot {
  fen: string;
  depth?: number;
  /** Best line first (MultiPV order). */
  lines: AnalysisLine[];
  /** `+0.24`, `−1.25`, `0.00`, `#3` … */
  scoreText: string;
  /** Raw score of the best line, for the eval bar. */
  score?: EngineScore;
  /** Best move as a board arrow, once the search is deep enough to trust it. */
  arrow?: { orig: string; dest: string };
  /** True while the search is still climbing (no more depth is coming otherwise). */
  searching: boolean;
  /**
   * Set when the engine could not run at all (missing wasm, offline first visit).
   * `searching` is then false and the UI shows a real message instead of
   * pretending a search is in progress.
   */
  error?: string;
}

/** `rnbq… w KQkq - 0 1` → the same FEN with a different side to move? No: helper. */
export function sameFen(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  // Compare the board+turn fields only: move counters do not change the position.
  const core = (fen: string): string => fen.trim().split(/\s+/).slice(0, 4).join(' ');
  return core(a) === core(b);
}

/**
 * Evaluation bar fill in `[0, 1]`, from White's point of view.
 *
 * A logistic-ish mapping like the sites use: 0.00 is half, ±1 pawn is roughly
 * 59/41, ±3 is nearly full, and mate pins the bar to an end. Not linear, because
 * a linear bar makes every normal position look equal.
 */
export function evalBarFill(score: EngineScore | undefined, turn: 'white' | 'black'): number {
  if (!score) return 0.5;
  if (typeof score.mate === 'number') {
    // Mate for the side to move is good for that side.
    const winner = score.mate >= 0 ? turn : turn === 'white' ? 'black' : 'white';
    return winner === 'white' ? 1 : 0;
  }
  if (typeof score.cp !== 'number') return 0.5;
  // Convert to White's point of view, then squash with a logistic.
  const whiteCp = turn === 'white' ? score.cp : -score.cp;
  const winProbability = 1 / (1 + Math.exp(-whiteCp / 350));
  return Math.min(1, Math.max(0, winProbability));
}

/** UCI `e2e4` / `e7e8q` → the arrow chessground draws (`e2` → `e4`). */
export function arrowFromUci(uci: string | undefined): { orig: string; dest: string } | undefined {
  if (typeof uci !== 'string') return undefined;
  const match = /^([a-h][1-8])([a-h][1-8])/.exec(uci);
  if (!match) return undefined;
  return { orig: match[1], dest: match[2] };
}

/** Build a snapshot from one engine report. */
export function snapshotFromEvaluation(
  evaluation: {
    fen: string;
    depth?: number;
    score?: EngineScore;
    pv: string[][];
    lineScores?: Array<EngineScore | undefined>;
    bestMove?: string;
  },
  options: { searching: boolean; minArrowDepth?: number } = { searching: false },
): AnalysisSnapshot {
  const minArrowDepth = options.minArrowDepth ?? ANALYSIS_ARROW_MIN_DEPTH;
  const depth = evaluation.depth;
  // Users read evaluations from White's side (+ = White better, − = Black
  // better), while engines report from the mover's side. The bar gets the same
  // treatment through its `turn` argument, so text and bar always agree.
  const turn = turnOfFen(evaluation.fen);
  const lines: AnalysisLine[] = evaluation.pv.map((pv, index) => {
    // MultiPV lines have *different* scores; falling back to the best score
    // would show the same number three times, which is exactly the bug this
    // field exists to avoid.
    const raw = evaluation.lineScores?.[index] ?? evaluation.score;
    return {
      scoreText: formatScore(toWhitePov(raw, turn)),
      san: uciLineToSan(evaluation.fen, pv),
      ...(raw !== undefined ? { score: raw } : {}),
      ...(depth !== undefined ? { depth } : {}),
    };
  });
  const arrow =
    depth !== undefined && depth >= minArrowDepth
      ? arrowFromUci(evaluation.bestMove ?? evaluation.pv[0]?.[0])
      : undefined;
  return {
    fen: evaluation.fen,
    lines,
    scoreText: formatScore(toWhitePov(evaluation.score, turn)),
    ...(evaluation.score !== undefined ? { score: evaluation.score } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(arrow !== undefined ? { arrow } : {}),
    searching: options.searching,
  };
}

/** Live analysis of one position, as the UI consumes it. */
export interface LiveAnalysis {
  /** Start (or restart) analysing `fen`, reporting every improvement. */
  analyze(fen: string, options?: { maxDepth?: number }): void;
  /** Ask the current search to go deeper (raises the cap and restarts it). */
  deepen(): void;
  /** Abandon the current search (position changed, screen closed, toggle off). */
  stop(): void;
  /** The latest snapshot, or undefined before the first report. */
  current(): AnalysisSnapshot | undefined;
  dispose(): void;
}

export interface CreateLiveAnalysisOptions {
  engine?: EngineSession;
  multiPv?: number;
  onSnapshot: (snapshot: AnalysisSnapshot) => void;
  /** Cap for the ordinary continuous search. */
  maxDepth?: number;
  /** Cap after "go deeper". */
  deepMaxDepth?: number;
  /** Report threshold (ms) — the engine emits many lines per second. */
  minIntervalMs?: number;
  /** Injectable clock for the throttle. */
  now?: () => number;
}

/**
 * Continuous analysis with **one search per position**.
 *
 * Deliberately not "restart at increasing depths": that throws work away and
 * makes the bar jump. The engine climbs one search; every improvement is
 * throttled into a snapshot. Changing position cancels the old search (the
 * engine's timeout/abort path) and starts the new one, so a tap-happy user never
 * queues stale searches.
 */
export function createLiveAnalysis(options: CreateLiveAnalysisOptions): LiveAnalysis {
  const multiPv = Math.max(1, Math.floor(options.multiPv ?? 3));
  const maxDepth = options.maxDepth ?? ANALYSIS_CONTINUOUS_MAX_DEPTH;
  const deepMaxDepth = options.deepMaxDepth ?? ANALYSIS_DEEP_MAX_DEPTH;
  const minIntervalMs = options.minIntervalMs ?? 120;
  const now = options.now ?? (() => Date.now());

  let engine = options.engine;
  let snapshot: AnalysisSnapshot | undefined;
  let currentFen: string | undefined;
  let generation = 0;
  let lastReport: number | undefined;
  let disposed = false;

  function engineFor(): EngineSession {
    engine ??= createEngine();
    return engine;
  }

  function publish(next: AnalysisSnapshot, force = false): void {
    const at = now();
    // Throttle only *between* reports: a fresh position must always publish its
    // first update (otherwise the bar sits blank until the second one).
    if (!force && lastReport !== undefined && at - lastReport < minIntervalMs) return;
    lastReport = at;
    snapshot = next;
    options.onSnapshot(next);
  }

  function run(fen: string, budget: number): void {
    generation += 1;
    const mine = generation;
    currentFen = fen;
    lastReport = undefined; // the next report is not throttled against the old one
    // Free the engine before asking about the new position: the serialised queue
    // would otherwise wait for the old search to reach its depth cap (minutes on
    // a phone). The superseded promise resolves and its report is dropped.
    engine?.stop();
    // Mark the new position immediately (depth 0, searching) so the UI can reset
    // the bar rather than showing the previous position's score.
    publish({ fen, lines: [], scoreText: '', searching: true }, true);

    void engineFor()
      .evaluate(fen, {
        continuous: true,
        maxDepth: budget,
        multiPv,
        timeoutMs: ANALYSIS_CONTINUOUS_TIMEOUT_MS,
        onUpdate: (evaluation) => {
          if (disposed || mine !== generation) return; // superseded
          publish(snapshotFromEvaluation(evaluation, { searching: true }));
        },
      })
      .then((evaluation) => {
        if (disposed || mine !== generation) return;
        publish(snapshotFromEvaluation(evaluation, { searching: false }), true);
      })
      .catch((error: unknown) => {
        if (disposed || mine !== generation) return;
        // A stopped search is expected (generation moved on and we never get
        // here); a genuine failure means the engine is unavailable — say so.
        publish(
          {
            fen,
            lines: [],
            scoreText: '',
            searching: false,
            error: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      });
  }

  return {
    analyze(fen, analyzeOptions = {}) {
      if (disposed) return;
      const next = fen.trim();
      if (next === '') return;
      if (sameFen(next, currentFen) && snapshot?.searching === true) return; // already climbing
      run(next, analyzeOptions.maxDepth ?? maxDepth);
    },
    deepen() {
      if (disposed || currentFen === undefined) return;
      run(currentFen, Math.max(deepMaxDepth, maxDepth));
    },
    stop() {
      generation += 1; // ignore anything still in flight
      currentFen = undefined;
      // Stop the actual search too: abandoning it in the UI must also stop the
      // CPU work (the screen may be closed or the tool was toggled off).
      engine?.stop();
      if (disposed) return;
      snapshot = undefined;
    },
    current: () => snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      snapshot = undefined;
      if (options.engine === undefined) engine?.dispose();
      engine = undefined;
    },
  };
}

/** True when "go deeper" is meaningful (a search finished at the normal cap). */
export function canDeepen(snapshot: AnalysisSnapshot | undefined): boolean {
  return Boolean(snapshot && snapshot.searching === false && snapshot.depth !== undefined);
}
