import type { NormalizedPuzzle as ContractPuzzle } from '../../../packages/contracts/src/types.ts';

export type NormalizedPuzzle = ContractPuzzle;

export interface PuzzleAttempt {
  puzzleId: string;
  failed: boolean;
  completed: boolean;
  solutionIndex: number;
  movesPlayed: string[];
}

export interface TrainingAdapter {
  recordSuccess(puzzle: NormalizedPuzzle, timing: { activeSolvingSeconds: number }): void;
  recordFailure(puzzle: NormalizedPuzzle, timing: { activeSolvingSeconds: number }): void;
  finishCorrection(puzzle: NormalizedPuzzle, timing: { activeSolvingSeconds: number }): void;
}
