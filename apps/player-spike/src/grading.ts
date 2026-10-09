import type { NormalizedPuzzle } from './types.js';

export type MoveVerdict = 'correct' | 'wrong' | 'incomplete';

export interface GradingState {
  /** Index of next move in solution (0-based for solver moves) */
  solutionIndex: number;
  /** Whether the attempt has been marked as failed */
  failed: boolean;
  /** Whether puzzle is completed */
  completed: boolean;
}

export interface GradeResult {
  verdict: MoveVerdict;
  state: GradingState;
}

export function createInitialGradingState(): GradingState {
  return {
    solutionIndex: 0,
    failed: false,
    completed: false,
  };
}

export function gradeMove(
  puzzle: NormalizedPuzzle,
  state: GradingState,
  moveUci: string
): GradeResult {
  if (state.completed) {
    return {
      verdict: 'incomplete',
      state: { ...state },
    };
  }

  if (state.solutionIndex >= puzzle.solution.length) {
    return {
      verdict: 'incomplete',
      state: { ...state, completed: true },
    };
  }

  const expectedMove = puzzle.solution[state.solutionIndex];

  if (moveUci === expectedMove) {
    // Correct move
    const nextIndex = state.solutionIndex + 1;
    const completed = nextIndex >= puzzle.solution.length;
    return {
      verdict: 'correct',
      state: {
        ...state,
        solutionIndex: nextIndex,
        completed,
      },
    };
  } else {
    // Wrong move - mark failed, do NOT advance
    return {
      verdict: 'wrong',
      state: {
        ...state,
        failed: true,
      },
    };
  }
}
