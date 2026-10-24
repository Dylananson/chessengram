/**
 * Pure puzzle game state on top of chessops.
 *
 * Chessground 9.2.1 has no promotion support and no undo, and its move events
 * fire for programmatic moves too. So the authoritative board state lives here
 * (chessops), and the UI mirrors it. This module owns:
 *   - legal-move destinations in chessground form (for `movable.dests`),
 *   - promotion detection and completion,
 *   - grading solver moves against the puzzle solution,
 *   - auto-playing the opponent reply,
 *   - replaying correct moves to resume a persisted attempt.
 *
 * Grading here is intentionally local/optimistic; the scheduler remains the
 * scoring authority and treats a first-wrong-move failure as immutable.
 */

import { Chess } from 'chessops/chess';
import { chessgroundDests } from 'chessops/compat';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { makeUci, parseSquare, parseUci, squareRank } from 'chessops/util';
import type { Color, Move, Role, SquareName } from 'chessops/types';
import type { AttemptEvent, NormalizedPuzzle } from '@chessengram/contracts';
import { CURATED_SOLUTIONS } from './curated-solutions.ts';

export type PromotionRole = 'q' | 'r' | 'b' | 'n';

export type UserMoveOutcome =
  | {
      kind: 'correct';
      uci: string;
      fenAfterSolver: string;
      fenAfterOpponent?: string;
      completed: boolean;
    }
  | { kind: 'wrong'; uci: string; fen: string }
  | { kind: 'illegal' }
  | { kind: 'needs-promotion'; from: SquareName; to: SquareName }
  | { kind: 'ignored' };

type AcceptedLines = { canonical: readonly string[]; alternatives: readonly (readonly string[])[] };

function acceptedLines(puzzle: NormalizedPuzzle): AcceptedLines {
  const entry = CURATED_SOLUTIONS[puzzle.id];
  if (
    !entry ||
    entry.canonicalSolution.length !== puzzle.solution.length ||
    entry.canonicalSolution.some((move, index) => move !== puzzle.solution[index])
  ) {
    return { canonical: puzzle.solution, alternatives: [] };
  }
  const alternatives = entry.alternatives
    .filter((item) => item.verification.trim().length > 0 && item.line.length > 0)
    .map((item) => item.line);
  return { canonical: puzzle.solution, alternatives };
}

function matchingLineForNextMove(
  puzzle: NormalizedPuzzle,
  playedSolverMoves: readonly string[],
  nextMove: string,
): readonly string[] | undefined {
  const { canonical, alternatives } = acceptedLines(puzzle);
  const matching = [canonical, ...alternatives].find((line) =>
    playedSolverMoves.every((move, index) => line[index * 2] === move) &&
    line[playedSolverMoves.length * 2] === nextMove,
  );
  if (matching) return matching;

  // The Lichess database explicitly permits any checkmating move for a
  // mate-in-one puzzle. Verify the exact position locally; do not infer
  // alternatives for any other puzzle or from engine analysis.
  if (
    playedSolverMoves.length === 0 &&
    puzzle.solution.length === 1 &&
    puzzle.themes.includes('mateIn1')
  ) {
    const position = Chess.fromSetup(parseFen(puzzle.solverFen).unwrap()).unwrap();
    const move = parseUci(nextMove);
    if (move && position.isLegal(move)) {
      position.play(move);
      if (position.isCheckmate()) return [nextMove];
    }
  }
  return undefined;
}

function solutionForAttempts(
  puzzle: NormalizedPuzzle,
  attempts: readonly OrderedAttemptMove[],
): readonly string[] {
  const solverMoves: string[] = [];
  for (const attempt of attempts) {
    if (!attempt.correct) continue;
    const line = matchingLineForNextMove(puzzle, solverMoves, attempt.uci);
    if (!line) continue;
    solverMoves.push(attempt.uci);
  }
  if (solverMoves.length === 0) return acceptedLines(puzzle).canonical;
  return (
    matchingLineForNextMove(puzzle, solverMoves.slice(0, -1), solverMoves.at(-1)!) ??
    acceptedLines(puzzle).canonical
  );
}

export class PuzzleGame {
  private readonly puzzle: NormalizedPuzzle;
  private readonly solverColor: Color;
  private pos: Chess;
  private ply = 0;
  private failed = false;
  private completed = false;
  private solution: readonly string[];
  private solverMoves: string[] = [];

  constructor(puzzle: NormalizedPuzzle) {
    const setup = parseFen(puzzle.solverFen).unwrap();
    this.puzzle = puzzle;
    this.solution = acceptedLines(puzzle).canonical;
    this.pos = Chess.fromSetup(setup).unwrap();
    this.solverColor = puzzle.solverColor;
  }

  get id(): string {
    return this.puzzle.id;
  }

  get failedState(): boolean {
    return this.failed;
  }

  get isCompleted(): boolean {
    return this.completed;
  }

  /** Chessground orientation matches the solver's color. */
  get orientation(): 'white' | 'black' {
    return this.solverColor;
  }

  get turn(): Color {
    return this.pos.turn;
  }

  /** True while it is the solver's turn and the puzzle is not finished. */
  get solverTurn(): boolean {
    return !this.completed && this.pos.turn === this.solverColor;
  }

  get fen(): string {
    return makeFen(this.pos.toSetup());
  }

  get requiredSolverMoves(): number {
    return Math.ceil(this.solution.length / 2);
  }

  legalDests(): Map<SquareName, SquareName[]> {
    if (!this.solverTurn) return new Map();
    return chessgroundDests(this.pos);
  }

  requiresPromotion(from: SquareName, to: SquareName): boolean {
    const fromSquare = parseSquare(from);
    const toSquare = parseSquare(to);
    if (fromSquare === undefined || toSquare === undefined) return false;
    const piece = this.pos.board.get(fromSquare);
    if (!piece || piece.role !== 'pawn') return false;
    const rank = squareRank(toSquare);
    return rank === 0 || rank === 7;
  }

  /**
   * BRD-001: legality probe for a queued premove. Pure: parses and tests the
   * move against the current position without playing it and without grading.
   * The caller owns the queue; `false` means silent discard, `true` routes
   * through the normal `playUserMove` grading path (a positionally legal but
   * off-solution move still grades wrong there).
   */
  isLegalSolverMove(from: SquareName, to: SquareName, promotion?: PromotionRole): boolean {
    if (this.completed || this.pos.turn !== this.solverColor) return false;
    const move = parseUci(`${from}${to}${promotion ?? ''}`);
    return !!move && this.pos.isLegal(move);
  }

  playUserMove(from: SquareName, to: SquareName, promotion?: PromotionRole): UserMoveOutcome {
    if (!this.solverTurn) return { kind: 'ignored' };
    if (this.requiresPromotion(from, to) && !promotion) {
      return { kind: 'needs-promotion', from, to };
    }

    const move = parseUci(`${from}${to}${promotion ?? ''}`);
    if (!move || !this.pos.isLegal(move)) return { kind: 'illegal' };

    const uci = makeUci(move);
    const matchingLine = matchingLineForNextMove(this.puzzle, this.solverMoves, uci);
    if (!matchingLine) {
      this.failed = true;
      return { kind: 'wrong', uci, fen: this.fen };
    }

    this.solution = matchingLine;
    this.solverMoves.push(uci);

    this.pos.play(move);
    this.ply += 1;
    const fenAfterSolver = this.fen;

    if (this.ply >= this.solution.length) {
      this.completed = true;
      return { kind: 'correct', uci, fenAfterSolver, completed: true };
    }

    const opponentUci = this.solution[this.ply]!;
    const opponentMove = parseUci(opponentUci);
    if (!opponentMove || !this.pos.isLegal(opponentMove)) {
      // Malformed pack: never leave the board stuck; finish at the solver move.
      this.completed = true;
      return { kind: 'correct', uci, fenAfterSolver, completed: true };
    }

    this.pos.play(opponentMove);
    this.ply += 1;
    if (this.ply >= this.solution.length) this.completed = true;

    return {
      kind: 'correct',
      uci,
      fenAfterSolver,
      fenAfterOpponent: this.fen,
      completed: this.completed,
    };
  }

  /** Resume a persisted failure so correction completion can be recorded. */
  markFailed(): void {
    this.failed = true;
  }

  /**
   * BRD-004: remaining-line computation for reveal playback. Pure read of
   * game state — never grades, never writes. While the board is still on the
   * solution path (no wrong move yet), the remaining plies play from the
   * current position; once a wrong move has gone off-line, the full line
   * plays from the solver position instead. (A wrong move never moves the
   * board, but the reset re-anchors the viewer at the line start.)
   */
  solutionPlaybackLine(): SolutionPlaybackLine {
    if (this.failed) {
      return {
        startFen: this.puzzle.solverFen,
        plies: [...this.solution],
        fromStart: true,
      };
    }
    return {
      startFen: this.fen,
      plies: this.solution.slice(this.ply),
      fromStart: false,
    };
  }

  /**
   * Replay already-graded correct solver moves (from the attempt event log) and
   * their opponent replies, stopping at the first inconsistency. Used on reload.
   */
  replaySolverMoves(ucis: readonly string[]): void {
    for (const uci of ucis) {
      if (this.completed) break;
      const move = parseUci(uci);
      if (!move || !this.pos.isLegal(move)) break;
      const matchingLine = matchingLineForNextMove(this.puzzle, this.solverMoves, uci);
      if (!matchingLine) break;
      this.solution = matchingLine;
      this.solverMoves.push(uci);
      this.pos.play(move);
      this.ply += 1;

      if (this.ply >= this.solution.length) {
        this.completed = true;
        break;
      }
      const opponentUci = this.solution[this.ply]!;
      const opponentMove = parseUci(opponentUci);
      if (!opponentMove || !this.pos.isLegal(opponentMove)) break;
      this.pos.play(opponentMove);
      this.ply += 1;
    }
    if (this.ply >= this.solution.length) this.completed = true;
  }
}

/**
 * Solution playback (BRD-004, reveal): DOM-free projection of the solution
 * line into board positions. Playback-only — never grades, never touches
 * schedule or attempt state, and never reads attempt history (unlike
 * `buildReviewLine`, which projects recorded attempts). The UI plays these
 * steps after a reveal-abandon at a watchable pace.
 */

export interface SolutionPlaybackLine {
  /** FEN playback starts from: current position on-path, solverFen off-line. */
  readonly startFen: string;
  /** Solution plies to play, in order (may include promotion plies). */
  readonly plies: readonly string[];
  /** True when off-line: the board resets to the solver position first. */
  readonly fromStart: boolean;
}

export interface PlaybackStep {
  /** 0-based ply position within the playback (step 0 is the first ply). */
  readonly index: number;
  readonly uci: string;
  readonly fen: string;
}

/**
 * Expand playback plies into per-ply board positions from `startFen`. Stops
 * at the first malformed/illegal ply (like `buildReviewLine`); an
 * unparseable start FEN yields no steps. Promotion plies and terminal mates
 * flow through chessops, so they render exactly as played.
 */
export function buildPlaybackSteps(
  startFen: string,
  plies: readonly string[],
): PlaybackStep[] {
  let pos: Chess;
  try {
    pos = Chess.fromSetup(parseFen(startFen).unwrap()).unwrap();
  } catch {
    return [];
  }
  const steps: PlaybackStep[] = [];
  for (const uci of plies) {
    const move = parseUci(uci);
    if (!move || !pos.isLegal(move)) break;
    pos.play(move);
    steps.push({ index: steps.length, uci, fen: makeFen(pos.toSetup()) });
  }
  return steps;
}

/**
 * Attempt review (AN-001a, no engine): DOM-free projection of a finished
 * attempt into navigable board positions. Review-only — never grades, never
 * touches schedule state. The UI enters it only from a completed puzzle.
 */

export type ReviewMover = 'start' | 'setup' | 'solver' | 'opponent' | 'wrong';

export interface ReviewStep {
  /** 0-based position in the review line (step 0 is the starting position). */
  readonly index: number;
  /** Move that produced this step, or null for the starting position. */
  readonly uci: string | null;
  readonly fen: string;
  /** Solution plies consumed to reach this step (wrong attempts add none). */
  readonly ply: number;
  readonly mover: ReviewMover;
}

export interface OrderedAttemptMove {
  readonly uci: string;
  /** True for a graded-correct solver move, false for a wrong attempt. */
  readonly correct: boolean;
}

function eventUci(event: AttemptEvent): string {
  const payload = event.payload ?? {};
  const raw = payload['uci'] ?? payload['move'];
  return typeof raw === 'string' ? raw : '';
}

/**
 * Attempt events in chronological order, reduced to solver move attempts.
 * `move` events carry a `correct` flag; legacy `wrong-move` events are always
 * wrong attempts. Anything without a UCI is ignored. Pure over the event log.
 */
export function orderedAttemptMoves(
  events: readonly AttemptEvent[],
): OrderedAttemptMove[] {
  const moves: OrderedAttemptMove[] = [];
  for (const event of events) {
    if (event.type === 'move') {
      const uci = eventUci(event);
      if (!uci) continue;
      moves.push({ uci, correct: event.payload?.['correct'] === true });
    } else if (event.type === 'wrong-move') {
      const uci = eventUci(event);
      if (!uci) continue;
      moves.push({ uci, correct: false });
    }
  }
  return moves;
}

/**
 * Lichess-style move list (PZL-002/PZL-003): DOM-free projection of the puzzle
 * line as played, grouped into numbered rows with white then black. SAN is
 * produced by replaying from the source position (via the setup move when it
 * is present and consistent with `solverFen`), so the display is locale
 * independent and validated rather than trusted. Each cell also carries the
 * moving piece's glyph. Wrong attempts are reverted on the board and never
 * advance the line, so they are omitted: the list is the played mainline (the
 * puzzle PGN), not raw input history. Pure: never grades, never writes, and
 * never reveals plies that have not been played unless `complete` is set (the
 * completed or revealed state).
 */

/** Unicode chess glyphs by color and role (display only). */
export const PIECE_GLYPHS: Record<Color, Record<Role, string>> = {
  white: { pawn: '♙', knight: '♘', bishop: '♗', rook: '♖', queen: '♕', king: '♔' },
  black: { pawn: '♟', knight: '♞', bishop: '♝', rook: '♜', queen: '♛', king: '♚' },
};

export interface MoveListCell {
  readonly uci: string;
  readonly san: string;
  readonly color: Color;
  /** Full-move number for this ply (shared by the row's white and black). */
  readonly number: number;
  /** Glyph of the piece that made the move (pawn for promotions, king for O-O). */
  readonly glyph: string;
  /** True for the pre-solution setup move (shown as previous-move context). */
  readonly setup: boolean;
}

export interface MoveListRow {
  readonly number: number;
  readonly white: MoveListCell | null;
  readonly black: MoveListCell | null;
}

export interface MoveListOptions {
  /** Append the remaining solution plies (completed or revealed states). */
  readonly complete?: boolean;
}

/** Replay from the source position through the setup move when consistent. */
function moveListStart(
  puzzle: NormalizedPuzzle,
): { pos: Chess; setupMove: Move | undefined; number: number; turn: Color } | null {
  let solver: Chess;
  try {
    solver = Chess.fromSetup(parseFen(puzzle.solverFen).unwrap()).unwrap();
  } catch {
    return null;
  }
  const fromSolver = { pos: solver, setupMove: undefined, number: solver.fullmoves, turn: solver.turn };
  if (!puzzle.setupMove) return fromSolver;
  const candidate = parseUci(puzzle.setupMove);
  if (!candidate) return fromSolver;
  try {
    const source = Chess.fromSetup(parseFen(puzzle.sourceFen).unwrap()).unwrap();
    if (!source.isLegal(candidate)) return fromSolver;
    const number = source.fullmoves;
    const turn = source.turn;
    const after = source.clone();
    after.play(candidate);
    const reachesSolver =
      makeFen(after.toSetup(), { epd: true }) === makeFen(solver.toSetup(), { epd: true });
    if (!reachesSolver) return fromSolver;
    return { pos: source, setupMove: candidate, number, turn };
  } catch {
    return fromSolver;
  }
}

export function buildMoveList(
  puzzle: NormalizedPuzzle,
  attempts: readonly OrderedAttemptMove[],
  opts: MoveListOptions = {},
): MoveListRow[] {
  const start = moveListStart(puzzle);
  if (!start) return [];
  const pos = start.pos;
  let number = start.number;
  let turn = start.turn;
  const cells: MoveListCell[] = [];

  const record = (move: Move, flags: { setup?: boolean } = {}): void => {
    const piece = 'from' in move ? pos.board.get(move.from) : undefined;
    cells.push({
      uci: makeUci(move),
      san: makeSan(pos, move),
      color: turn,
      number,
      glyph: piece ? PIECE_GLYPHS[piece.color][piece.role] : PIECE_GLYPHS[turn].pawn,
      setup: flags.setup === true,
    });
    pos.play(move);
    if (turn === 'black') number += 1;
    turn = turn === 'white' ? 'black' : 'white';
  };

  if (start.setupMove) record(start.setupMove, { setup: true });

  // Only moves actually applied to the board appear — a wrong attempt is
  // reverted and never advances the line, so the list is the played mainline
  // (the puzzle PGN) rather than raw input history.
  const ordered = attempts;
  const solution = solutionForAttempts(puzzle, ordered);
  let ply = 0;
  for (const attempt of ordered) {
    if (ply >= solution.length) break;
    const move = parseUci(attempt.uci);
    if (!attempt.correct || attempt.uci !== solution[ply] || !move || !pos.isLegal(move)) continue;
    record(move);
    ply += 1;
    const reply = ply < solution.length ? parseUci(solution[ply]!) : undefined;
    if (!reply || !pos.isLegal(reply)) break;
    record(reply);
    ply += 1;
  }

  if (opts.complete) {
    while (ply < solution.length) {
      const move = parseUci(solution[ply]!);
      if (!move || !pos.isLegal(move)) break;
      record(move);
      ply += 1;
    }
  }

  // Lichess-style grouping: a white move starts a new numbered row; black
  // attaches to the current row.
  const rows: MoveListRow[] = [];
  for (const cell of cells) {
    const last = rows[rows.length - 1];
    const startNew = !last || cell.color === 'white' || last.black !== null || last.number !== cell.number;
    if (startNew) {
      rows.push(
        cell.color === 'white'
          ? { number: cell.number, white: cell, black: null }
          : { number: cell.number, white: null, black: cell },
      );
    } else {
      rows[rows.length - 1] = { ...last, black: cell };
    }
  }
  return rows;
}

/**
 * Project an attempt onto the solution line: step 0 is the position the puzzle
 * began from, then the opponent's setup move (when present) as the first
 * reviewable move, then one step per solver ply played plus one per auto-played
 * opponent reply. Including the setup move lets the stepper rewind all the way
 * to the move that played when the puzzle loaded (PZL-005). Wrong attempts
 * become position-preserving `wrong` steps at the ply where they happened (the
 * board never changes on a wrong move). Stops at the first illegal/inconsistent
 * move, like `replaySolverMoves`. Always returns at least the starting step.
 */
export function buildReviewLine(
  puzzle: NormalizedPuzzle,
  events: readonly AttemptEvent[],
): ReviewStep[] {
  const start = moveListStart(puzzle);
  if (!start) return [];
  const pos = start.pos;
  const steps: ReviewStep[] = [
    { index: 0, uci: null, fen: makeFen(pos.toSetup()), ply: 0, mover: 'start' },
  ];
  let ply = 0;
  const push = (uci: string | null, mover: ReviewMover): void => {
    steps.push({ index: steps.length, uci, fen: makeFen(pos.toSetup()), ply, mover });
  };

  if (start.setupMove) {
    pos.play(start.setupMove);
    push(makeUci(start.setupMove), 'setup');
  }

  const ordered = orderedAttemptMoves(events);
  const solution = solutionForAttempts(puzzle, ordered);
  for (const attempt of ordered) {
    if (!attempt.correct || attempt.uci !== solution[ply]) {
      // Wrong attempt: annotate the current position without advancing.
      push(attempt.uci, 'wrong');
      continue;
    }
    const solverMove = parseUci(attempt.uci);
    if (!solverMove || !pos.isLegal(solverMove)) break;
    pos.play(solverMove);
    ply += 1;
    push(attempt.uci, 'solver');
    if (ply >= solution.length) break;
    const opponentUci = solution[ply]!;
    const opponentMove = parseUci(opponentUci);
    if (!opponentMove || !pos.isLegal(opponentMove)) break;
    pos.play(opponentMove);
    ply += 1;
    push(opponentUci, 'opponent');
  }
  return steps;
}

/**
 * Cursor over a review line. Starts at the final position (the user just
 * finished the puzzle and steps back). All navigation clamps; never throws
 * for in-range use. Construct with a non-empty line from `buildReviewLine`.
 */
export class ReviewNavigator {
  private readonly steps: readonly ReviewStep[];
  private cursor: number;

  constructor(steps: readonly ReviewStep[]) {
    if (steps.length === 0) throw new Error('ReviewNavigator needs a non-empty review line');
    this.steps = steps;
    this.cursor = steps.length - 1;
  }

  get count(): number {
    return this.steps.length;
  }

  /** 0-based cursor position. */
  get position(): number {
    return this.cursor;
  }

  current(): ReviewStep {
    return this.steps[this.cursor]!;
  }

  get canBack(): boolean {
    return this.cursor > 0;
  }

  get canForward(): boolean {
    return this.cursor < this.steps.length - 1;
  }

  back(): ReviewStep {
    if (this.canBack) this.cursor -= 1;
    return this.current();
  }

  forward(): ReviewStep {
    if (this.canForward) this.cursor += 1;
    return this.current();
  }

  first(): ReviewStep {
    this.cursor = 0;
    return this.current();
  }

  last(): ReviewStep {
    this.cursor = this.steps.length - 1;
    return this.current();
  }

  goTo(index: number): ReviewStep {
    if (Number.isNaN(index)) return this.current();
    this.cursor = Math.min(Math.max(Math.trunc(index), 0), this.steps.length - 1);
    return this.current();
  }
}
