/**
 * Queue selection (T03 §8). Pure eligibility test that never grades.
 * Ordering: active attempt (handled outside this pure function), due
 * Learning/Relearning by dueAt then key, due Review by dueAt then key,
 * eligible New by stable order; backlog does not fabricate failures.
 */

import type { ScheduleState, ScheduleStateDetails } from "../../contracts/src/types.ts";

export interface Candidate {
  progressKey: string;
  state: ScheduleStateDetails;
  /** Suggested sequence key for deterministic ordering. */
  orderKey: string;
}

export interface SelectNextEligibleOptions {
  now: number;
  /** Progress keys that currently have an active attempt reservation. */
  reservedKeys?: Set<string>;
  /** Stable presentation order for new puzzles. */
  newOrder?: readonly string[];
}

export function isEligibleForSelection(candidate: Candidate, now: number, reserved?: Set<string>): boolean {
  if (reserved?.has(candidate.progressKey)) return false;
  if (candidate.state.state === "new") return true;
  if (candidate.state.dueAt !== undefined && candidate.state.dueAt <= now) return true;
  return false;
}

export function selectNextDue(
  candidates: readonly Candidate[],
  options: SelectNextEligibleOptions,
): string | null {
  const now = options.now;
  const reserved = options.reservedKeys;
  const newOrder = options.newOrder ?? [];
  const newIndex = new Map<string, number>();
  newOrder.forEach((k, i) => newIndex.set(k, i));

  const eligible = candidates.filter((c) => isEligibleForSelection(c, now, reserved));
  if (eligible.length === 0) return null;

  const learningRelearning: Candidate[] = [];
  const reviewDue: Candidate[] = [];
  const newEligible: Candidate[] = [];
  for (const c of eligible) {
    if (c.state.state === "learning" || c.state.state === "relearning") {
      learningRelearning.push(c);
    } else if (c.state.state === "review") {
      reviewDue.push(c);
    } else if (c.state.state === "new") {
      newEligible.push(c);
    }
  }

  const byDueThenKey = (a: Candidate, b: Candidate) => {
    const da = a.state.dueAt ?? Number.POSITIVE_INFINITY;
    const db = b.state.dueAt ?? Number.POSITIVE_INFINITY;
    if (da < db) return -1;
    if (da > db) return 1;
    if (a.orderKey < b.orderKey) return -1;
    if (a.orderKey > b.orderKey) return 1;
    return 0;
  };

  const byNewOrder = (a: Candidate, b: Candidate) => {
    const ia = newIndex.get(a.progressKey);
    const ib = newIndex.get(b.progressKey);
    const nia = ia === undefined ? Number.POSITIVE_INFINITY : ia;
    const nib = ib === undefined ? Number.POSITIVE_INFINITY : ib;
    if (nia < nib) return -1;
    if (nia > nib) return 1;
    if (a.orderKey < b.orderKey) return -1;
    if (a.orderKey > b.orderKey) return 1;
    return 0;
  };

  if (learningRelearning.length > 0) {
    learningRelearning.sort(byDueThenKey);
    return learningRelearning[0]?.progressKey ?? null;
  }
  if (reviewDue.length > 0) {
    reviewDue.sort(byDueThenKey);
    return reviewDue[0]?.progressKey ?? null;
  }
  if (newEligible.length > 0) {
    newEligible.sort(byNewOrder);
    return newEligible[0]?.progressKey ?? null;
  }
  return null;
}
