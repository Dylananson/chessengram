/**
 * Queue selection (T03 §8). Pure eligibility test that never grades.
 * Ordering: active attempt (handled outside this pure function), due
 * Learning/Relearning by dueAt then key, due Review by dueAt then key,
 * eligible New by stable order; backlog does not fabricate failures.
 *
 * UX-004 tiebreaker rule (locked — do not reorder without a new ADR):
 * 1. Tier priority is strict: due Learning/Relearning > due Review > New.
 *    A lower tier is only reached when no candidate in any higher tier is
 *    eligible, so due work can delay — but never permanently deny — New
 *    puzzles: once higher tiers drain, New is always served.
 * 2. Within Learning/Relearning and within Review, ties break by `dueAt`
 *    ascending, then `orderKey` ascending (`byDueThenKey`). Simultaneous-due
 *    items therefore resolve in a stable, repeatable sequence.
 * 3. Within New, ties break by `newOrder` index ascending, then `orderKey`
 *    ascending (`byNewOrder`); candidates absent from `newOrder` sort after
 *    listed ones. Identical inputs always yield the identical pick.
 * 4. "No starvation" means: draining the queue (repeatedly selecting and
 *    removing/reserving the winner) visits every eligible candidate exactly
 *    in the order above. `selectNextDue` itself is stateless — repeat calls
 *    with identical inputs return the identical key; progress comes from the
 *    caller advancing state, never from randomness or call counting here.
 */

import type { ScheduleState, ScheduleStateDetails } from "@chessreps/contracts";

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

export interface EarliestFutureDueOptions {
  now: number;
  /** Progress keys that currently have an active attempt reservation. */
  reservedKeys?: Set<string>;
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

  // UX-004: total order within a due tier — dueAt, then orderKey.
  // Simultaneous-due items resolve deterministically by orderKey.
  const byDueThenKey = (a: Candidate, b: Candidate) => {
    const da = a.state.dueAt ?? Number.POSITIVE_INFINITY;
    const db = b.state.dueAt ?? Number.POSITIVE_INFINITY;
    if (da < db) return -1;
    if (da > db) return 1;
    if (a.orderKey < b.orderKey) return -1;
    if (a.orderKey > b.orderKey) return 1;
    return 0;
  };

  // UX-004: total order for New — stable newOrder index, then orderKey.
  // Unlisted keys sort after listed ones; never random, never call-counted.
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

/**
 * UX-001 fallback: earliest future-due candidate for explicit opt-in
 * "practice ahead" (never auto-selected by `selectNextDue`).
 *
 * Returns the candidate with the smallest `dueAt` strictly after `now`,
 * skipping reserved keys and anything without a future due time (new
 * puzzles and due-now work are never practice-ahead targets). Ties break by
 * `dueAt` then `orderKey`, mirroring `byDueThenKey` above without changing
 * it: due-priority ordering in `selectNextDue` is intentionally untouched.
 */
export function selectEarliestFutureDue(
  candidates: readonly Candidate[],
  options: EarliestFutureDueOptions,
): Candidate | null {
  const now = options.now;
  const reserved = options.reservedKeys;
  let best: Candidate | null = null;
  let bestDue = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (reserved?.has(candidate.progressKey)) continue;
    const due = candidate.state.dueAt;
    if (due === undefined || due <= now) continue;
    if (due < bestDue || (due === bestDue && best !== null && candidate.orderKey < best.orderKey)) {
      best = candidate;
      bestDue = due;
    }
  }
  return best;
}
