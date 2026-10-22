/**
 * AN-001b — position analysis for the review screen.
 *
 * This is the layer the UI talks to: one call, `analyze(fen)`, returning
 * ready-to-render lines (score + SAN). It owns the *policy* around the engine
 * (how many lines, how big a search budget, caching repeated positions) and the
 * *presentation* helpers, so `train-view.ts` stays a view.
 *
 * Budget: MultiPV 3 at ~200k nodes. From the measured throughput
 * (`docs/research/stockfish-evaluation.md`) that is a fraction of a second on a
 * laptop and a few seconds on a phone — small enough for an on-demand button,
 * large enough to be a fair verdict on the position. `CC-001b` will use its own,
 * much shallower screening budget; the two are deliberately separate knobs.
 *
 * Everything here is injectable so it can be tested without an engine.
 */
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { makeUci, parseUci } from 'chessops/util';
import { createEngine, type EngineScore, type EngineSession } from './engine.ts';

/** Lines shown in the UI (engine MultiPV). */
export const ANALYSIS_MULTI_PV = 3;
/** Search budget per analysis: a fair verdict without a phone-sized wait. */
export const ANALYSIS_NODES = 200_000;
/** Analyses kept in memory; positions repeat heavily (openings, re-review). */
export const ANALYSIS_CACHE_LIMIT = 200;

export interface AnalysisLine {
  score?: EngineScore;
  /** Human-readable score: `+0.24`, `−1.25`, `0.00`, `#3`, `−#2`. */
  scoreText: string;
  depth?: number;
  /** The principal variation in SAN. */
  san: string[];
}

export interface PositionAnalysis {
  fen: string;
  /** Best line first. */
  lines: AnalysisLine[];
}

export interface AnalysisService {
  analyze(fen: string): Promise<PositionAnalysis>;
  isBusy(): boolean;
  dispose(): void;
}

/** `{cp: 24}` → `+0.24`; `{mate: -2}` → `−#2` (being mated). */
/**
 * The side to move, from a FEN's second field.
 *
 * Engine scores are always from the side to move; users read them from White's
 * side (+ = White is better). Everything the UI displays goes through
 * {@link toWhitePov} first, while the raw engine value stays available for
 * anything that needs the mover-relative number.
 */
export function turnOfFen(fen: string): 'white' | 'black' {
  return fen.trim().split(/\s+/)[1] === 'b' ? 'black' : 'white';
}

/** Flip a mover-relative engine score to White's point of view. */
export function toWhitePov(
  score: EngineScore | undefined,
  turn: 'white' | 'black',
): EngineScore | undefined {
  if (score === undefined || turn === 'white') return score;
  if (typeof score.mate === 'number') return { mate: -score.mate };
  if (typeof score.cp === 'number') return { cp: -score.cp };
  return score;
}

export function formatScore(score: EngineScore | undefined): string {
  if (!score) return '';
  if (typeof score.mate === 'number') {
    return score.mate >= 0 ? `#${score.mate}` : `−#${Math.abs(score.mate)}`;
  }
  if (typeof score.cp !== 'number') return '';
  const pawns = score.cp / 100;
  if (pawns === 0) return '0.00';
  const sign = pawns > 0 ? '+' : '−';
  return `${sign}${Math.abs(pawns).toFixed(2)}`;
}

/**
 * Convert a UCI principal variation into SAN from `fen`.
 *
 * Stops at the first move that cannot be played (engines occasionally emit a
 * line that does not fit the position, and a review UI must never throw over
 * that). Returns `[]` for an unreadable FEN.
 */
export function uciLineToSan(fen: string, uciMoves: readonly string[]): string[] {
  const setup = parseFen(fen);
  if (setup.isErr) return [];
  const pos = Chess.fromSetup(setup.value);
  if (pos.isErr) return [];
  const chess = pos.value;

  const san: string[] = [];
  for (const uci of uciMoves) {
    const move = parseUci(uci);
    if (!move || !chess.isLegal(move)) break;
    san.push(makeSan(chess, move));
    chess.play(move);
  }
  return san;
}

export interface CreateAnalysisOptions {
  /** Injectable engine (the real one is {@link createEngine}, lazily started). */
  engine?: EngineSession;
  multiPv?: number;
  nodes?: number;
  depth?: number;
  cacheLimit?: number;
}

export function createAnalysisService(options: CreateAnalysisOptions = {}): AnalysisService {
  const multiPv = Math.max(1, Math.floor(options.multiPv ?? ANALYSIS_MULTI_PV));
  const cacheLimit = Math.max(1, Math.floor(options.cacheLimit ?? ANALYSIS_CACHE_LIMIT));
  const cache = new Map<string, PositionAnalysis>();
  let busy = false;
  let engine = options.engine;
  let disposed = false;

  function engineFor(): EngineSession {
    engine ??= createEngine();
    return engine;
  }

  function remember(analysis: PositionAnalysis): void {
    cache.set(analysis.fen, analysis);
    // Insertion-ordered eviction: good enough for a review screen and bounded.
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  return {
    isBusy: () => busy,
    async analyze(fen: string): Promise<PositionAnalysis> {
      if (disposed) throw new Error('analysis service disposed');
      const key = fen.trim();
      if (key === '') throw new Error('analyze requires a FEN');
      const cached = cache.get(key);
      if (cached) return cached;

      busy = true;
      try {
        const evaluation = await engineFor().evaluate(key, {
          multiPv,
          ...(options.depth !== undefined ? { depth: options.depth } : {}),
          ...(options.depth === undefined ? { nodes: options.nodes ?? ANALYSIS_NODES } : {}),
        });
        const turn = turnOfFen(key);
        const analysis: PositionAnalysis = {
          fen: key,
          lines: evaluation.pv.map((pv, index) => {
            // Display from White's point of view, like lichess/chess.com:
            // + means White is better, − means Black is better, whoever is
            // to move. `score` keeps the raw mover-relative value.
            const raw = evaluation.lineScores?.[index] ?? evaluation.score;
            const line: AnalysisLine = {
              scoreText: formatScore(toWhitePov(raw, turn)),
              san: uciLineToSan(key, pv),
              ...(raw !== undefined ? { score: raw } : {}),
              ...(evaluation.depth !== undefined ? { depth: evaluation.depth } : {}),
            };
            return line;
          }),
        };
        remember(analysis);
        return analysis;
      } finally {
        busy = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cache.clear();
      // The injected engine may be shared; only a self-created one is ours to close.
      if (options.engine === undefined) engine?.dispose();
      engine = undefined;
    },
  };
}

let shared: AnalysisService | undefined;

/** The app-wide service: one engine worker, one cache, reused by every screen. */
export function getAnalysisService(): AnalysisService {
  shared ??= createAnalysisService();
  return shared;
}

/** Test seam: forget the shared service (and stop its engine). */
export function resetAnalysisService(): void {
  shared?.dispose();
  shared = undefined;
}

/** UCI move list → a single readable string (`e4 e5 Nf3`). */
export function formatLine(san: readonly string[]): string {
  return san.join(' ');
}

/** The engine's own move, formatted for display (best line's first move). */
export function bestMoveOf(analysis: PositionAnalysis | undefined): string | undefined {
  const first = analysis?.lines[0]?.san[0];
  return first;
}

/** Re-export for callers that only import this module. */
export { makeUci };
