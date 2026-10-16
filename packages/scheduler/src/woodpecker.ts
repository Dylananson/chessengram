/**
 * Pure, non-persisted accounting for a Woodpecker-style fixed-set cycle.
 *
 * This module deliberately does not schedule failed puzzles, write attempts,
 * or change the normal scheduler. It records one scored result per set member
 * for one cycle; a failed result is exposed for the caller's separate review
 * queue. Durable cycle/review state needs a separately approved schema.
 */

export type WoodpeckerResult = 'clean' | 'failed';

export interface WoodpeckerSetSnapshot {
  readonly setId: string;
  /** Stable membership and presentation order for this run. */
  readonly puzzleIds: readonly string[];
}

export interface WoodpeckerCycleResult {
  readonly puzzleId: string;
  readonly result: WoodpeckerResult;
  /** Active solving time in seconds; correction time is not included. */
  readonly activeSeconds: number;
}

export interface WoodpeckerCycle {
  readonly setId: string;
  readonly cycleNumber: number;
  readonly puzzleIds: readonly string[];
  readonly startedAt: number;
  /** Set when every snapshotted puzzle has a scored result. */
  readonly completedAt?: number;
  readonly results: readonly WoodpeckerCycleResult[];
}

/** Durable set definition; membership is a snapshot, not a live collection view. */
export interface WoodpeckerSetRecord extends WoodpeckerSetSnapshot {
  readonly name: string;
  readonly sourceCollectionId: string;
  readonly createdAt: number;
}

export interface WoodpeckerCycleSummary {
  readonly total: number;
  readonly attempted: number;
  readonly remaining: number;
  readonly clean: number;
  readonly failed: number;
  readonly accuracy: number;
  readonly activeSeconds: number;
  readonly complete: boolean;
  /** Unique failures in cycle order, suitable for a separate review queue. */
  readonly failedPuzzleIds: readonly string[];
}

/** Create a cycle from a fixed, non-empty snapshot. Duplicate IDs are rejected. */
export function startWoodpeckerCycle(
  snapshot: WoodpeckerSetSnapshot,
  cycleNumber: number,
  startedAt: number,
): WoodpeckerCycle {
  if (!snapshot.setId.trim()) throw new Error('setId must not be empty');
  if (snapshot.puzzleIds.length === 0) throw new Error('a Woodpecker set must contain at least one puzzle');
  if (new Set(snapshot.puzzleIds).size !== snapshot.puzzleIds.length) {
    throw new Error('a Woodpecker set cannot contain duplicate puzzle ids');
  }
  if (!Number.isInteger(cycleNumber) || cycleNumber < 1) throw new Error('cycleNumber must be a positive integer');
  if (!Number.isFinite(startedAt)) throw new Error('startedAt must be finite');
  if (snapshot.puzzleIds.some((id) => !id.trim())) throw new Error('puzzle ids must not be empty');

  return {
    setId: snapshot.setId,
    cycleNumber,
    puzzleIds: [...snapshot.puzzleIds],
    startedAt,
    results: [],
  };
}

/**
 * Record the single scored result for a puzzle in this cycle.
 * Existing attempt scoring remains authoritative: correction completion
 * cannot change a `failed` result into `clean`.
 */
export function recordWoodpeckerResult(
  cycle: WoodpeckerCycle,
  puzzleId: string,
  result: WoodpeckerResult,
  activeSeconds: number,
  recordedAt?: number,
): WoodpeckerCycle {
  if (!cycle.puzzleIds.includes(puzzleId)) throw new Error(`puzzle ${puzzleId} is not in this cycle`);
  if (cycle.results.some((entry) => entry.puzzleId === puzzleId)) {
    throw new Error(`puzzle ${puzzleId} already has a result in this cycle`);
  }
  if (result !== 'clean' && result !== 'failed') throw new Error('result must be clean or failed');
  if (!Number.isFinite(activeSeconds) || activeSeconds < 0) {
    throw new Error('activeSeconds must be a finite non-negative number');
  }
  if (recordedAt !== undefined && !Number.isFinite(recordedAt)) {
    throw new Error('recordedAt must be finite');
  }

  const results = [...cycle.results, { puzzleId, result, activeSeconds }];
  return {
    ...cycle,
    puzzleIds: [...cycle.puzzleIds],
    results,
    ...(results.length === cycle.puzzleIds.length && recordedAt !== undefined ? { completedAt: recordedAt } : {}),
  };
}

/** Pure summary; failures are surfaced without mutating schedule state. */
export function summarizeWoodpeckerCycle(cycle: WoodpeckerCycle): WoodpeckerCycleSummary {
  const clean = cycle.results.filter((entry) => entry.result === 'clean').length;
  const failedResults = cycle.results.filter((entry) => entry.result === 'failed');
  const attempted = cycle.results.length;
  return {
    total: cycle.puzzleIds.length,
    attempted,
    remaining: cycle.puzzleIds.length - attempted,
    clean,
    failed: failedResults.length,
    accuracy: attempted === 0 ? 0 : clean / attempted,
    activeSeconds: cycle.results.reduce((sum, entry) => sum + entry.activeSeconds, 0),
    complete: attempted === cycle.puzzleIds.length,
    failedPuzzleIds: failedResults.map((entry) => entry.puzzleId),
  };
}
