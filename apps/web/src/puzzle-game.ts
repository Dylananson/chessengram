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
import type { NormalizedPuzzle } from '@chessreps/contracts';

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
