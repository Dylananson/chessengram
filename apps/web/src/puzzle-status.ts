/** Read-only, scheduler-agnostic status summary for one puzzle. */
export interface PuzzleStatusAttempt {
  outcome?: 'success' | 'failure';
  timing: { activeSolvingSeconds: number; timingTrustworthy?: boolean };
}

export interface PuzzleStatusSchedule {
  state: 'new' | 'learning' | 'review' | 'relearning';
  algorithmId?: string;
  rung?: number;
  dueAt?: number;
  lapseCount?: number;
}

export interface PuzzleStatusSummary {
  state: PuzzleStatusSchedule['state'];
  algorithm: string;
  rung?: number;
  dueAt?: number;
  successfulSolves: number;
  averageActiveSeconds?: number;
  bestActiveSeconds?: number;
  lapses: number;
}

/** Pure projection; no scheduler payload or ladder-specific data is inspected. */
export function projectPuzzleStatus(
  schedule: PuzzleStatusSchedule | undefined,
  attempts: readonly PuzzleStatusAttempt[],
): PuzzleStatusSummary {
  const successes = attempts.filter((attempt) => attempt.outcome === 'success');
  const times = successes
    .filter((attempt) => attempt.timing.timingTrustworthy !== false)
    .map((attempt) => attempt.timing.activeSolvingSeconds)
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 0);
  return {
    state: schedule?.state ?? (attempts.length ? 'learning' : 'new'),
    algorithm: schedule?.algorithmId ?? '—',
    rung: schedule?.rung,
    dueAt: schedule?.dueAt,
    successfulSolves: successes.length,
    averageActiveSeconds: times.length ? times.reduce((sum, n) => sum + n, 0) / times.length : undefined,
    bestActiveSeconds: times.length ? Math.min(...times) : undefined,
    lapses: Math.max(schedule?.lapseCount ?? 0, attempts.filter((a) => a.outcome === 'failure').length),
  };
}
