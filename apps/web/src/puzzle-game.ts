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
import { makeUci, parseSquare, parseUci, squareRank } from 'chessops/util';
import type { Color, SquareName } from 'chessops/types';
import type { AttemptEvent, NormalizedPuzzle } from '@chessreps/contracts';

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

export class PuzzleGame {
  private readonly puzzle: NormalizedPuzzle;
  private readonly solverColor: Color;
  private pos: Chess;
  private ply = 0;
  private failed = false;
  private completed = false;

  constructor(puzzle: NormalizedPuzzle) {
    const setup = parseFen(puzzle.solverFen).unwrap();
    this.puzzle = puzzle;
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
    return Math.ceil(this.puzzle.solution.length / 2);
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
    if (uci !== this.puzzle.solution[this.ply]) {
      this.failed = true;
      return { kind: 'wrong', uci, fen: this.fen };
    }

    this.pos.play(move);
    this.ply += 1;
    const fenAfterSolver = this.fen;

    if (this.ply >= this.puzzle.solution.length) {
      this.completed = true;
      return { kind: 'correct', uci, fenAfterSolver, completed: true };
    }

    const opponentUci = this.puzzle.solution[this.ply]!;
    const opponentMove = parseUci(opponentUci);
    if (!opponentMove || !this.pos.isLegal(opponentMove)) {
      // Malformed pack: never leave the board stuck; finish at the solver move.
      this.completed = true;
      return { kind: 'correct', uci, fenAfterSolver, completed: true };
    }

    this.pos.play(opponentMove);
    this.ply += 1;
    if (this.ply >= this.puzzle.solution.length) this.completed = true;

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
   * Replay already-graded correct solver moves (from the attempt event log) and
   * their opponent replies, stopping at the first inconsistency. Used on reload.
   */
  replaySolverMoves(ucis: readonly string[]): void {
    for (const uci of ucis) {
      if (this.completed) break;
      const move = parseUci(uci);
      if (!move || !this.pos.isLegal(move)) break;
      if (uci !== this.puzzle.solution[this.ply]) break;
      this.pos.play(move);
      this.ply += 1;

      if (this.ply >= this.puzzle.solution.length) {
        this.completed = true;
        break;
      }
      const opponentUci = this.puzzle.solution[this.ply]!;
      const opponentMove = parseUci(opponentUci);
      if (!opponentMove || !this.pos.isLegal(opponentMove)) break;
      this.pos.play(opponentMove);
      this.ply += 1;
    }
    if (this.ply >= this.puzzle.solution.length) this.completed = true;
  }
}

/**
 * Attempt review (AN-001a, no engine): DOM-free projection of a finished
 * attempt into navigable board positions. Review-only — never grades, never
 * touches schedule state. The UI enters it only from a completed puzzle.
 */

export type ReviewMover = 'start' | 'solver' | 'opponent' | 'wrong';

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
 * Project an attempt onto the solution line: step 0 is the solver position,
 * then one step per solver ply played plus one per auto-played opponent reply.
 * Wrong attempts become position-preserving `wrong` steps at the ply where
 * they happened (the board never changes on a wrong move). Stops at the first
 * illegal/inconsistent move, like `replaySolverMoves`. Always returns at
 * least the starting step.
 */
export function buildReviewLine(
  puzzle: NormalizedPuzzle,
  events: readonly AttemptEvent[],
): ReviewStep[] {
  const pos = Chess.fromSetup(parseFen(puzzle.solverFen).unwrap()).unwrap();
  const steps: ReviewStep[] = [
    { index: 0, uci: null, fen: makeFen(pos.toSetup()), ply: 0, mover: 'start' },
  ];
  let ply = 0;
  const push = (uci: string | null, mover: ReviewMover): void => {
    steps.push({ index: steps.length, uci, fen: makeFen(pos.toSetup()), ply, mover });
  };

  for (const attempt of orderedAttemptMoves(events)) {
    if (!attempt.correct || attempt.uci !== puzzle.solution[ply]) {
      // Wrong attempt: annotate the current position without advancing.
      push(attempt.uci, 'wrong');
      continue;
    }
    const solverMove = parseUci(attempt.uci);
    if (!solverMove || !pos.isLegal(solverMove)) break;
    pos.play(solverMove);
    ply += 1;
    push(attempt.uci, 'solver');
    if (ply >= puzzle.solution.length) break;
    const opponentUci = puzzle.solution[ply]!;
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
