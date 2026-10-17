/**
 * STAT-001 training statistics — a pure, read-only projection over existing
 * records. Nothing is persisted and no schedule/attempt state is mutated.
 *
 * Measurement model (decisions recorded 2026-10-17):
 * - **Active solving time only** is the headline. Correction time, interruption
 *   time and wall-clock cycle duration are reported separately and never added
 *   into it.
 * - **One time source: attempts.** Woodpecker cycle results are recorded with
 *   the same active seconds as their attempt, so they contribute cycle counts
 *   and wall-clock duration only. Summing both would double count.
 * - **Scored vs practice.** `outcome` success/failure is scored; anything
 *   finished without an outcome (reveal, skip, abandoned) is practice. Practice
 *   seconds are reported separately and are never folded into scored totals.
 * - Untrustworthy timing is counted, not silently included or dropped.
 * - Attempts still in flight are excluded (their time is still running).
 * - Range filtering uses attempt start time; a Woodpecker cycle falls in the
 *   range by its completion time (or start time while unfinished).
 */

import type { AttemptRecord } from '@chessreps/contracts';
import type { WoodpeckerCycle, WoodpeckerSetRecord } from '@chessreps/scheduler';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_PROGRAM_ID,
  type LocalTrainingService,
  WOODPECKER_CYCLE_PROGRAM_ID,
  WOODPECKER_FAILED_PROGRAM_ID,
  WOODPECKER_REVIEW_PROGRAM_ID,
} from './scheduler-service.ts';

export type StatsRange = '7d' | '30d' | 'all';

/** Synthetic row id for attempts whose collection no longer exists. */
export const REMOVED_COLLECTION_ID = '(removed)';

const DAY_MS = 24 * 60 * 60 * 1000;

export type ModeKey = 'spaced' | 'woodpecker' | 'failed' | 'practice' | 'other';

export interface StatTotals {
  /** Finished attempts in scope (in-flight attempts are excluded). */
  attempts: number;
  solves: number;
  failures: number;
  /** Finished attempts with no scored outcome (reveal/skip/abandon). */
  unscored: number;
  /** Active solving seconds across every finished attempt. */
  activeSeconds: number;
  /** Active seconds from scored attempts only (the headline number). */
  scoredSeconds: number;
  /** Active seconds from unscored work (the separate practice number). */
  practiceSeconds: number;
  correctionSeconds: number;
  untrustedAttempts: number;
}

export interface StatsModeRow {
  key: ModeKey;
  label: string;
  totals: StatTotals;
}

export interface StatsCollectionRow {
  id: string;
  name: string;
  spaced: StatTotals;
  woodpecker: StatTotals;
  failed: StatTotals;
  practice: StatTotals;
  other: StatTotals;
  total: StatTotals;
  /** Woodpecker cycles whose completion (or start, if open) falls in range. */
  cyclesStarted: number;
  cyclesCompleted: number;
  cycleWallClockSeconds: number;
}

export interface StatsSnapshot {
  range: StatsRange;
  /** Epoch ms cutoff, absent for all-time. */
  since?: number;
  now: number;
  totals: StatTotals;
  modes: StatsModeRow[];
  collections: StatsCollectionRow[];
  cyclesStarted: number;
  cyclesCompleted: number;
  cycleWallClockSeconds: number;
  /** Attempts excluded because they are still in progress. */
  openAttempts: number;
}

export function emptyTotals(): StatTotals {
  return {
    attempts: 0,
    solves: 0,
    failures: 0,
    unscored: 0,
    activeSeconds: 0,
    scoredSeconds: 0,
    practiceSeconds: 0,
    correctionSeconds: 0,
    untrustedAttempts: 0,
  };
}

export function addTotals(target: StatTotals, source: StatTotals): StatTotals {
  target.attempts += source.attempts;
  target.solves += source.solves;
  target.failures += source.failures;
  target.unscored += source.unscored;
  target.activeSeconds += source.activeSeconds;
  target.scoredSeconds += source.scoredSeconds;
  target.practiceSeconds += source.practiceSeconds;
  target.correctionSeconds += source.correctionSeconds;
  target.untrustedAttempts += source.untrustedAttempts;
  return target;
}

/**
 * A finished attempt is one that was scored, completed, or explicitly
 * abandoned. An attempt that is merely open (started, nothing recorded yet) is
 * still being timed and must not appear in totals.
 */
export function isFinishedAttempt(attempt: AttemptRecord): boolean {
  return (
    attempt.outcome !== undefined ||
    attempt.completedAt !== undefined ||
    attempt.events.some((event) => event.type === 'abandon')
  );
}

export function modeForProgram(programId: string): ModeKey {
  if (programId === DEFAULT_PROGRAM_ID) return 'spaced';
  if (programId === WOODPECKER_CYCLE_PROGRAM_ID) return 'woodpecker';
  if (programId === WOODPECKER_FAILED_PROGRAM_ID) return 'failed';
  if (programId === WOODPECKER_REVIEW_PROGRAM_ID) return 'practice';
  return 'other';
}

export const MODE_LABELS: Record<ModeKey, string> = {
  spaced: 'Spaced Repetition',
  woodpecker: 'Woodpecker cycles',
  failed: 'Failed review',
  practice: 'Practice (unscored)',
  other: 'Other',
};

/** Cutoff for a range, or undefined for all-time. */
export function rangeCutoff(range: StatsRange, now: number): number | undefined {
  if (range === '7d') return now - 7 * DAY_MS;
  if (range === '30d') return now - 30 * DAY_MS;
  return undefined;
}

function addAttempt(target: StatTotals, attempt: AttemptRecord): void {
  const active = Math.max(0, attempt.timing.activeSolvingSeconds);
  target.attempts += 1;
  target.activeSeconds += active;
  target.correctionSeconds += Math.max(0, attempt.timing.correctionSeconds);
  if (!attempt.timing.timingTrustworthy) target.untrustedAttempts += 1;
  if (attempt.outcome === 'success') {
    target.solves += 1;
    target.scoredSeconds += active;
  } else if (attempt.outcome === 'failure') {
    target.failures += 1;
    target.scoredSeconds += active;
  } else {
    target.unscored += 1;
    target.practiceSeconds += active;
  }
}

function emptyCollectionRow(id: string, name: string): StatsCollectionRow {
  return {
    id,
    name,
    spaced: emptyTotals(),
    woodpecker: emptyTotals(),
    failed: emptyTotals(),
    practice: emptyTotals(),
    other: emptyTotals(),
    total: emptyTotals(),
    cyclesStarted: 0,
    cyclesCompleted: 0,
    cycleWallClockSeconds: 0,
  };
}

function modeTotals(row: StatsCollectionRow, mode: ModeKey): StatTotals {
  return row[mode];
}

/**
 * Snapshot every finished attempt and Woodpecker cycle in range and group them
 * by program mode and by collection. Uses only public service getters, so it is
 * read-only and safe to call from a view redraw.
 */
export function summarizeStats(
  service: LocalTrainingService,
  range: StatsRange = 'all',
  now: number = Date.now(),
): StatsSnapshot {
  const since = rangeCutoff(range, now);
  const collections = service.listCollections();
  const rows = new Map<string, StatsCollectionRow>();
  for (const collection of collections) {
    rows.set(collection.id, emptyCollectionRow(collection.id, collection.name));
  }
  const removed = emptyCollectionRow(REMOVED_COLLECTION_ID, 'Removed collection');

  // Woodpecker attempts are scoped by `woodpecker-set-<setId>`; map that back
  // to the collection the snapshot came from so per-collection rows stay true.
  const sets: WoodpeckerSetRecord[] = service.listWoodpeckerSets();
  const scopeToCollection = new Map<string, string>();
  const setsById = new Map<string, WoodpeckerSetRecord>();
  for (const set of sets) {
    setsById.set(set.setId, set);
    scopeToCollection.set(`woodpecker-set-${set.setId}`, set.sourceCollectionId);
  }

  const totals = emptyTotals();
  const modes: Record<ModeKey, StatTotals> = {
    spaced: emptyTotals(),
    woodpecker: emptyTotals(),
    failed: emptyTotals(),
    practice: emptyTotals(),
    other: emptyTotals(),
  };
  let openAttempts = 0;

  const attempts = service.listAttempts({ limit: Math.max(1, service.getAttemptCount()) });
  for (const attempt of attempts) {
    if (!isFinishedAttempt(attempt)) {
      openAttempts += 1;
      continue;
    }
    if (since !== undefined && attempt.startedAt < since) continue;

    const mode = modeForProgram(attempt.progressKey.programId);
    const rawCollectionId = attempt.progressKey.collectionId;
    const collectionId =
      mode === 'spaced'
        ? rawCollectionId ?? DEFAULT_COLLECTION_ID
        : scopeToCollection.get(rawCollectionId ?? '') ?? REMOVED_COLLECTION_ID;
    const row = rows.get(collectionId) ?? removed;
    addAttempt(row[mode], attempt);
    addAttempt(modes[mode], attempt);
    addAttempt(totals, attempt);
  }

  let cyclesStarted = 0;
  let cyclesCompleted = 0;
  let cycleWallClockSeconds = 0;
  for (const set of sets) {
    const cycles: Array<{ cycleId: string; cycle: WoodpeckerCycle }> = service.listWoodpeckerCycles(set.setId);
    for (const { cycle } of cycles) {
      const stamp = cycle.completedAt ?? cycle.startedAt;
      if (since !== undefined && stamp < since) continue;
      cyclesStarted += 1;
      const row = rows.get(set.sourceCollectionId) ?? removed;
      row.cyclesStarted += 1;
      if (cycle.completedAt !== undefined) {
        const wall = Math.max(0, cycle.completedAt - cycle.startedAt);
        cyclesCompleted += 1;
        cycleWallClockSeconds += wall;
        row.cyclesCompleted += 1;
        row.cycleWallClockSeconds += wall;
      }
    }
  }

  const collectionRows = [...rows.values()];
  if (removed.total.attempts > 0 || removed.cyclesStarted > 0) {
    collectionRows.push(removed);
  }
  for (const row of collectionRows) {
    for (const mode of ['spaced', 'woodpecker', 'failed', 'practice', 'other'] as const) {
      addTotals(row.total, modeTotals(row, mode));
    }
  }
  // Most recently trained/largest first; ties keep collection order.
  collectionRows.sort((a, b) => b.total.activeSeconds - a.total.activeSeconds || a.name.localeCompare(b.name));

  return {
    range,
    ...(since !== undefined ? { since } : {}),
    now,
    totals,
    modes: (['spaced', 'woodpecker', 'failed', 'practice', 'other'] as const)
      .map((key) => ({ key, label: MODE_LABELS[key], totals: modes[key] }))
      .filter((row) => row.totals.attempts > 0 || row.key !== 'other'),
    collections: collectionRows,
    cyclesStarted,
    cyclesCompleted,
    cycleWallClockSeconds,
    openAttempts,
  };
}

/** `1h 05m` / `5m 12s` / `42s`, or an em dash for zero. */
export function formatStatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

/** Scored accuracy as a percentage, or undefined when nothing was scored. */
export function statAccuracy(totals: StatTotals): number | undefined {
  const scored = totals.solves + totals.failures;
  return scored === 0 ? undefined : (totals.solves / scored) * 100;
}
