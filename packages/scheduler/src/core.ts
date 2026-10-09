/**
 * Pure schedule transition core (T03 §4-§5).
 *
 * This module is a side-effect-free projection: given the previous derived
 * schedule, one immutable scored outcome and a frozen settings snapshot it
 * returns the next derived schedule plus an effect record. It performs no I/O,
 * keeps no state and does not read the ambient clock. Attempt identity,
 * idempotency and revisions live in `commit.ts`.
 */

import type {
  AttemptOutcome,
  FailureReason,
  ScheduleState,
  ScheduleStateDetails,
  TimingSegments,
} from "../../contracts/src/types.ts";
import { settingsHash, type SchedulerSettings } from "./settings.ts";

export const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 86_400_000;
export const SECONDS_PER_DAY = 86_400;

export type TimingIneligibilityReason =
  | "timing-disabled"
  | "invalid-timing"
  | "unknown-move-count"
  | "timing-untrustworthy"
  | "interrupted"
  | "not-review-success";

export interface TimingApplication {
  eligible: boolean;
  reason?: TimingIneligibilityReason;
  /** Recorded active solving seconds, when finite. */
  activeSeconds?: number;
  /** Number of required solver moves, when known. */
  requiredMoves?: number;
  /** Target seconds T = max(minTargetSeconds, secondsPerMove*n). */
  targetSeconds?: number;
  /** Bounded multiplier in [minFactor, maxFactor]. Neutral is 1. */
  factor: number;
  /** Exact ladder base interval before the factor, in seconds. */
  baseSeconds?: number;
  /** Final interval awarded, in seconds. */
  intervalSeconds?: number;
}

export interface TransitionEffect {
  fromState: ScheduleState;
  toState: ScheduleState;
  outcome: AttemptOutcome;
  rungBefore?: number;
  rungAfter?: number;
  returnRung?: number;
  lapseIncremented: boolean;
  /** True when a short-term (learning/relearning) failure counter was bumped. */
  shortStepFailureIncremented: boolean;
  /** Set when this transition registered a Review lapse and entered relearning. */
  enteredRelearning: boolean;
  timing: TimingApplication;
}

export interface Transition {
  next: ScheduleStateDetails;
  effect: TransitionEffect;
}

export interface ScoredOutcomeInput {
  outcome: AttemptOutcome;
  /** Authoritative scoring instant `a` (epoch ms). */
  occurredAt: number;
  timing: TimingSegments;
  /** Required solver moves; needed only for the bounded timing policy. */
  requiredMoves?: number;
  failureReason?: FailureReason;
}

/** Initial derived schedule for a puzzle. Always starts in `new`. */
export function createInitialSchedule(settings: SchedulerSettings, introducedAt?: number): ScheduleStateDetails {
  return {
    scheduleSchemaVersion: "1.0.0",
    state: "new",
    algorithmId: settings.algorithmId,
    algorithmVersion: settings.algorithmVersion,
    settingsHash: settingsHash(settings),
    lapseCount: 0,
    currentStepFailureCount: 0,
    ...(introducedAt !== undefined ? { introducedAt } : {}),
  };
}

function carry(prev: ScheduleStateDetails, settings: SchedulerSettings): ScheduleStateDetails {
  return {
    scheduleSchemaVersion: prev.scheduleSchemaVersion,
    state: prev.state,
    algorithmId: settings.algorithmId,
    algorithmVersion: settings.algorithmVersion,
    settingsHash: settingsHash(settings),
    lapseCount: prev.lapseCount,
    currentStepFailureCount: prev.currentStepFailureCount,
    ...(prev.dueAt !== undefined ? { dueAt: prev.dueAt } : {}),
    ...(prev.rung !== undefined ? { rung: prev.rung } : {}),
    ...(prev.returnRung !== undefined ? { returnRung: prev.returnRung } : {}),
    ...(prev.introducedAt !== undefined ? { introducedAt: prev.introducedAt } : {}),
    ...(prev.algorithmPayload !== undefined ? { algorithmPayload: prev.algorithmPayload } : {}),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function maxRung(settings: SchedulerSettings): number {
  return Math.max(0, settings.ladderDays.length - 1);
}

function rungDays(settings: SchedulerSettings, rung: number): number {
  const index = clamp(rung, 0, maxRung(settings));
  return settings.ladderDays[index] ?? 1;
}

function neutralTiming(reason?: TimingIneligibilityReason): TimingApplication {
  return reason ? { eligible: false, reason, factor: 1 } : { eligible: false, factor: 1 };
}

/**
 * Bounded timing policy (T03 §4). Eligible only for a clean, unassisted,
 * uninterrupted Review->Review success with trustworthy timing and a known
 * move count. Never consulted on failure or short-term transitions.
 */
export function evaluateTiming(
  input: ScoredOutcomeInput,
  settings: SchedulerSettings,
  baseDays: number,
  eligibleState: boolean,
): TimingApplication {
  if (!eligibleState) return neutralTiming("not-review-success");
  if (!settings.timing.enabled) return neutralTiming("timing-disabled");

  const active = input.timing.activeSolvingSeconds;
  if (!Number.isFinite(active) || active < 0) return neutralTiming("invalid-timing");

  const requiredMoves = input.requiredMoves;
  if (requiredMoves === undefined || !Number.isFinite(requiredMoves) || requiredMoves <= 0) {
    return neutralTiming("unknown-move-count");
  }

  if (!input.timing.timingTrustworthy) return neutralTiming("timing-untrustworthy");
  if (input.timing.interruptionSeconds > 0 || input.timing.hiddenSeconds > 0) {
    return neutralTiming("interrupted");
  }

  const target = Math.max(settings.timing.minTargetSeconds, settings.timing.secondsPerMove * requiredMoves);
  const ratio = clamp((target - active) / target, -1, 1);
  const factor = clamp(1 + settings.timing.coefficient * ratio, settings.timing.minFactor, settings.timing.maxFactor);
  const baseSeconds = baseDays * SECONDS_PER_DAY;
  const maxSeconds = settings.maxIntervalDays * SECONDS_PER_DAY;
  const intervalSeconds = Math.min(maxSeconds, Math.floor(baseSeconds * factor + 0.5));

  return {
    eligible: true,
    activeSeconds: active,
    requiredMoves,
    targetSeconds: target,
    factor,
    baseSeconds,
    intervalSeconds,
  };
}

function baseTiming(baseDays: number): TimingApplication {
  return {
    eligible: false,
    reason: "not-review-success",
    factor: 1,
    baseSeconds: baseDays * SECONDS_PER_DAY,
    intervalSeconds: baseDays * SECONDS_PER_DAY,
  };
}

function dueFrom(a: number, intervalSeconds: number): number {
  return a + intervalSeconds * 1000;
}

function failedOutcome(input: ScoredOutcomeInput): boolean {
  return input.outcome === "failure";
}

/**
 * Apply exactly one scored outcome to exactly one previous schedule.
 *
 * Explicit transition table (T03 §5):
 *   New        + S -> Learning due a+confirmation
 *   New        + F -> Learning due a+learningRetry
 *   Learning   + S -> Review rung 0 due a+L[0]
 *   Learning   + F -> Learning due a+learningRetry
 *   Review(i)  + S -> Review rung min(i+1,max) due a+adjusted(L[next])
 *   Review(i)  + F -> preset-specific (retry-reset | retry-retain | step-back)
 *   Relearning(k)+S -> Review rung k due a+L[k]
 *   Relearning(k)+F -> Relearning same k due a+relearning
 */
export function applyOutcome(
  prev: ScheduleStateDetails,
  input: ScoredOutcomeInput,
  settings: SchedulerSettings,
): Transition {
  const a = input.occurredAt;
  const success = !failedOutcome(input);
  const from: ScheduleState = prev.state;
  const next = carry(prev, settings);

  let effect: TransitionEffect = {
    fromState: from,
    toState: from,
    outcome: input.outcome,
    rungBefore: prev.rung,
    lapseIncremented: false,
    shortStepFailureIncremented: false,
    enteredRelearning: false,
    timing: neutralTiming(),
  };

  if (from === "new") {
    if (success) {
      const baseSeconds = settings.learningConfirmationMinutes * 60;
      next.state = "learning";
      next.dueAt = dueFrom(a, baseSeconds);
      effect = {
        ...effect,
        toState: "learning",
        timing: {
          eligible: false,
          reason: "not-review-success",
          factor: 1,
          baseSeconds,
          intervalSeconds: baseSeconds,
        },
      };
    } else {
      next.state = "learning";
      next.dueAt = dueFrom(a, settings.learningRetryMinutes * 60);
      next.currentStepFailureCount = prev.currentStepFailureCount + 1;
      effect = {
        ...effect,
        toState: "learning",
        shortStepFailureIncremented: true,
        timing: neutralTiming("not-review-success"),
      };
    }
    return { next, effect };
  }

  if (from === "learning") {
    if (success) {
      const rung = 0;
      const baseDays = rungDays(settings, rung);
      next.state = "review";
      next.rung = rung;
      delete next.returnRung;
      next.currentStepFailureCount = 0;
      next.dueAt = dueFrom(a, baseDays * SECONDS_PER_DAY);
      effect = {
        ...effect,
        toState: "review",
        rungAfter: rung,
        timing: baseTiming(baseDays),
      };
    } else {
      next.state = "learning";
      next.dueAt = dueFrom(a, settings.learningRetryMinutes * 60);
      next.currentStepFailureCount = prev.currentStepFailureCount + 1;
      effect = {
        ...effect,
        toState: "learning",
        shortStepFailureIncremented: true,
        timing: neutralTiming("not-review-success"),
      };
    }
    return { next, effect };
  }

  if (from === "review") {
    const rungBefore = prev.rung ?? 0;
    if (success) {
      const rungAfter = Math.min(rungBefore + 1, maxRung(settings));
      const baseDays = rungDays(settings, rungAfter);
      const timing = evaluateTiming(input, settings, baseDays, true);
      const intervalSeconds = timing.intervalSeconds ?? baseDays * SECONDS_PER_DAY;
      next.state = "review";
      next.rung = rungAfter;
      delete next.returnRung;
      next.dueAt = dueFrom(a, intervalSeconds);
      effect = {
        ...effect,
        toState: "review",
        rungBefore,
        rungAfter,
        timing,
      };
      return { next, effect };
    }

    const lapse = prev.lapseCount + 1;
    if (settings.failurePreset === "step-back") {
      const amount = Math.max(1, Math.floor(settings.stepBackAmount));
      const rungAfter = Math.max(0, rungBefore - amount);
      const baseDays = rungDays(settings, rungAfter);
      next.state = "review";
      next.rung = rungAfter;
      delete next.returnRung;
      next.lapseCount = lapse;
      next.dueAt = dueFrom(a, baseDays * SECONDS_PER_DAY);
      effect = {
        ...effect,
        toState: "review",
        rungBefore,
        rungAfter,
        lapseIncremented: true,
        timing: baseTiming(baseDays),
      };
      return { next, effect };
    }

    const returnRung =
      settings.failurePreset === "retry-retain"
        ? Math.max(0, rungBefore - Math.max(0, Math.floor(settings.retryRetainAmount)))
        : 0;
    next.state = "relearning";
    next.returnRung = returnRung;
    next.lapseCount = lapse;
    delete next.rung;
    next.dueAt = dueFrom(a, settings.relearningMinutes * 60);
    effect = {
      ...effect,
      toState: "relearning",
      rungBefore,
      returnRung,
      lapseIncremented: true,
      enteredRelearning: true,
      timing: neutralTiming("not-review-success"),
    };
    return { next, effect };
  }

  // from === "relearning"
  const returnRung = prev.returnRung ?? 0;
  if (success) {
    const baseDays = rungDays(settings, returnRung);
    next.state = "review";
    next.rung = returnRung;
    delete next.returnRung;
    next.currentStepFailureCount = 0;
    next.dueAt = dueFrom(a, baseDays * SECONDS_PER_DAY);
    effect = {
      ...effect,
      toState: "review",
      rungAfter: returnRung,
      returnRung,
      timing: baseTiming(baseDays),
    };
  } else {
    next.state = "relearning";
    next.returnRung = returnRung;
    next.currentStepFailureCount = prev.currentStepFailureCount + 1;
    next.dueAt = dueFrom(a, settings.relearningMinutes * 60);
    effect = {
      ...effect,
      toState: "relearning",
      returnRung,
      shortStepFailureIncremented: true,
      timing: neutralTiming("not-review-success"),
    };
  }
  return { next, effect };
}

/**
 * Correction completion projection (T03 §5: "correction completed ... schedule
 * unchanged"). Returns a shallow clone so callers cannot mutate the prior state.
 * Immutability of the scored failure is enforced by `commit.ts`.
 */
export function applyCorrectionCompletion(prev: ScheduleStateDetails): ScheduleStateDetails {
  return { ...prev };
}
