/**
 * Pure, immutable attempt-commit reducer (T03 §6 "exactly-once effects").
 *
 * The reducer threads a `SchedulerState` value. It owns no I/O and no timers.
 * Idempotency keys and per-attempt outcome markers are dedup bookkeeping, not
 * raw attempt history: raw move/assistance evidence stays in the append-only
 * AttemptRecord owned by the persistence/adapter layer.
 *
 * Guarantees exercised by tests:
 *  - a first wrong move produces one immutable failure that a later success
 *    (correction or replay) cannot overwrite;
 *  - duplicate deliveries return the original receipt and never re-apply
 *    counters or intervals;
 *  - stale `expectedScheduleRevision` submissions are rejected;
 *  - correction completion changes evidence only, never the schedule.
 */

import type {
  AttemptId,
  AttemptOutcome,
  FailureReason,
  ProgressKey,
  ScheduleStateDetails,
  TimingSegments,
} from "../../contracts/src/types.ts";
import { applyOutcome, createInitialSchedule, type ScoredOutcomeInput, type TransitionEffect } from "./core.ts";
import type { SchedulerSettings } from "./settings.ts";

export interface OutcomeReceipt {
  receiptId: string;
  attemptId: AttemptId;
  idempotencyKey: string;
  outcome: AttemptOutcome;
  /** Scoring instant `a` (epoch ms). */
  committedAt: number;
  previousRevision: number;
  scheduleRevision: number;
  effect: TransitionEffect;
}

export interface CommittedAttempt {
  attemptId: string;
  outcome: AttemptOutcome;
  receiptId: string;
  idempotencyKey: string;
  scheduleRevision: number;
  committedAt: number;
}

export interface CorrectionRecord {
  attemptId: string;
  completedAt: number;
  idempotencyKey: string;
}

export interface AbandonmentRecord {
  attemptId: string;
  at: number;
  hadCommittedOutcome: boolean;
}

/**
 * Derived, serializable scheduler progress for one progress key. `schedule` is
 * the T04 projection; `revision` is the monotonic commit counter used by the
 * expected-revision guard.
 */
export interface SchedulerState {
  schedule: ScheduleStateDetails;
  revision: number;
  receipts: Record<string, OutcomeReceipt>;
  attempts: Record<string, CommittedAttempt>;
  corrections: Record<string, CorrectionRecord>;
  abandonments: Record<string, AbandonmentRecord>;
  nextReceiptSequence: number;
}

export function createSchedulerState(
  settings: SchedulerSettings,
  options?: { introducedAt?: number; revision?: number },
): SchedulerState {
  return {
    schedule: createInitialSchedule(settings, options?.introducedAt),
    revision: options?.revision ?? 0,
    receipts: {},
    attempts: {},
    corrections: {},
    abandonments: {},
    nextReceiptSequence: 1,
  };
}

export interface ScoreSubmission extends ScoredOutcomeInput {
  attemptId: AttemptId;
  expectedScheduleRevision: number;
  idempotencyKey: string;
}

export type CommitResult =
  | { status: "committed"; state: SchedulerState; receipt: OutcomeReceipt; schedule: ScheduleStateDetails }
  | { status: "duplicate"; state: SchedulerState; receipt: OutcomeReceipt }
  | { status: "conflict"; state: SchedulerState; reason: "attempt-outcome-conflict" }
  | { status: "stale"; state: SchedulerState; reason: "stale-schedule-revision"; expectedRevision: number; actualRevision: number };

/**
 * Commit one scored outcome for one attempt exactly once.
 *
 * Resolution order:
 *  1. `idempotencyKey` already seen   -> duplicate (return original receipt)
 *  2. attempt already committed        -> duplicate if same outcome, else conflict
 *  3. `expectedScheduleRevision` stale -> stale (reject effect)
 *  4. otherwise apply the pure transition and bump the revision
 */
export function commitScoredOutcome(
  state: SchedulerState,
  submission: ScoreSubmission,
  settings: SchedulerSettings,
): CommitResult {
  const existing = state.receipts[submission.idempotencyKey];
  if (existing) {
    return { status: "duplicate", state, receipt: existing };
  }

  const prior = state.attempts[submission.attemptId.value];
  if (prior) {
    if (prior.outcome === submission.outcome) {
      const priorReceipt = state.receipts[prior.idempotencyKey];
      if (priorReceipt) {
        return { status: "duplicate", state, receipt: priorReceipt };
      }
    }
    return { status: "conflict", state, reason: "attempt-outcome-conflict" };
  }

  if (submission.expectedScheduleRevision !== state.revision) {
    return {
      status: "stale",
      state,
      reason: "stale-schedule-revision",
      expectedRevision: submission.expectedScheduleRevision,
      actualRevision: state.revision,
    };
  }

  const transition = applyOutcome(state.schedule, submission, settings);
  const scheduleRevision = state.revision + 1;
  const receiptId = `receipt-${state.nextReceiptSequence}`;
  const receipt: OutcomeReceipt = {
    receiptId,
    attemptId: submission.attemptId,
    idempotencyKey: submission.idempotencyKey,
    outcome: submission.outcome,
    committedAt: submission.occurredAt,
    previousRevision: state.revision,
    scheduleRevision,
    effect: transition.effect,
  };

  const nextState: SchedulerState = {
    schedule: transition.next,
    revision: scheduleRevision,
    receipts: { ...state.receipts, [submission.idempotencyKey]: receipt },
    attempts: {
      ...state.attempts,
      [submission.attemptId.value]: {
        attemptId: submission.attemptId.value,
        outcome: submission.outcome,
        receiptId,
        idempotencyKey: submission.idempotencyKey,
        scheduleRevision,
        committedAt: submission.occurredAt,
      },
    },
    corrections: state.corrections,
    abandonments: state.abandonments,
    nextReceiptSequence: state.nextReceiptSequence + 1,
  };

  return { status: "committed", state: nextState, receipt, schedule: transition.next };
}

export interface FinishCorrectionInput {
  attemptId: AttemptId;
  occurredAt: number;
  idempotencyKey: string;
}

export type FinishCorrectionResult =
  | { status: "accepted"; state: SchedulerState; record: CorrectionRecord }
  | { status: "duplicate"; state: SchedulerState; record: CorrectionRecord }
  | { status: "rejected"; state: SchedulerState; reason: "no-scored-attempt" | "not-a-failure" };

/**
 * Record correction completion. Never changes the schedule or revision: a
 * committed failure is immutable and correction is evidence only (T03 §5-§6).
 */
export function finishCorrection(state: SchedulerState, input: FinishCorrectionInput): FinishCorrectionResult {
  const key = input.attemptId.value;
  const prior = state.attempts[key];
  if (!prior) {
    return { status: "rejected", state, reason: "no-scored-attempt" };
  }
  if (prior.outcome !== "failure") {
    return { status: "rejected", state, reason: "not-a-failure" };
  }
  const already = state.corrections[key];
  if (already) {
    return { status: "duplicate", state, record: already };
  }
  const record: CorrectionRecord = {
    attemptId: key,
    completedAt: input.occurredAt,
    idempotencyKey: input.idempotencyKey,
  };
  const nextState: SchedulerState = {
    ...state,
    corrections: { ...state.corrections, [key]: record },
  };
  return { status: "accepted", state: nextState, record };
}

export interface StartAttemptInput {
  attemptId: AttemptId;
  at: number;
  /** Progress key is carried for adapter bookkeeping; the schedule ignores it. */
  progressKey?: ProgressKey;
}

export interface StartAttemptResult {
  state: SchedulerState;
  /** True when this start consumed the single New introduction for the key. */
  introduced: boolean;
}

/**
 * Reserve a scored attempt. Starting a New puzzle records `introducedAt` once
 * (T03 §8): the introduction is consumed even if the attempt is abandoned, and
 * the schedule/revision are otherwise untouched.
 */
export function startAttempt(state: SchedulerState, input: StartAttemptInput): StartAttemptResult {
  if (state.schedule.state === "new" && state.schedule.introducedAt === undefined) {
    return {
      introduced: true,
      state: {
        ...state,
        schedule: { ...state.schedule, introducedAt: input.at },
      },
    };
  }
  return { state, introduced: false };
}

export interface AbandonAttemptInput {
  attemptId: AttemptId;
  at: number;
}

export interface AbandonAttemptResult {
  state: SchedulerState;
  abandonment: AbandonmentRecord;
}

/**
 * Record an unscored abandonment. Preserves any committed failure and its
 * scheduled due time (T03 §7); a pre-outcome New abandonment keeps the consumed
 * introduction but applies no schedule transition.
 */
export function abandonAttempt(state: SchedulerState, input: AbandonAttemptInput): AbandonAttemptResult {
  const abandonment: AbandonmentRecord = {
    attemptId: input.attemptId.value,
    at: input.at,
    hadCommittedOutcome: state.attempts[input.attemptId.value] !== undefined,
  };
  const key = `${input.attemptId.value}@${input.at}`;
  return {
    abandonment,
    state: {
      ...state,
      abandonments: { ...state.abandonments, [key]: abandonment },
    },
  };
}
