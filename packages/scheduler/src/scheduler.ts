/**
 * Deterministic scheduler facade. Inject a Clock; all operations are pure
 * transformations of SchedulerState. Scheduling authority and attempt identity
 * remain the responsibility of the adapter (T04/T07/T10). This is the
 * "deterministic module" for T06.
 */

import type { AttemptId, AttemptOutcome, FailureReason, ProgressKey, TimingSegments } from "@chessengram/contracts";
import type { SchedulerSettings } from "./settings.ts";
import { resolveSettings, settingsHash } from "./settings.ts";
import type { Clock } from "./clock.ts";
import type { ScheduleStateDetails } from "@chessengram/contracts";
import { applyCorrectionCompletion } from "./core.ts";
import type { Transition } from "./core.ts";
import {
  abandonAttempt,
  commitScoredOutcome,
  createSchedulerState,
  finishCorrection,
  startAttempt,
  type AbandonAttemptResult,
  type CommitResult,
  type FinishCorrectionResult,
  type SchedulerState,
  type StartAttemptResult,
} from "./commit.ts";

export interface SchedulerDependencies {
  clock: Clock;
  settings: SchedulerSettings;
}

export interface ScoreAttemptInput {
  state: SchedulerState;
  attemptId: AttemptId;
  progressKey: ProgressKey;
  outcome: AttemptOutcome;
  timing: TimingSegments;
  requiredMoves?: number;
  failureReason?: FailureReason;
  expectedScheduleRevision: number;
  idempotencyKey: string;
}

export class Scheduler {
  private readonly deps: SchedulerDependencies;

  constructor(deps: SchedulerDependencies) {
    this.deps = {
      clock: deps.clock,
      settings: resolveSettings(deps.settings),
    };
  }

  get settings(): SchedulerSettings {
    return this.deps.settings;
  }

  getSettingsHash(): string {
    return settingsHash(this.deps.settings);
  }

  createState(options?: { introducedAt?: number; revision?: number }): SchedulerState {
    return createSchedulerState(this.deps.settings, options);
  }

  startAttempt(state: SchedulerState, attemptId: AttemptId, progressKey: ProgressKey): StartAttemptResult {
    const at = this.deps.clock.now();
    return startAttempt(state, { attemptId, at, progressKey });
  }

  scoreAttempt(input: ScoreAttemptInput): CommitResult {
    return commitScoredOutcome(
      input.state,
      {
        attemptId: input.attemptId,
        expectedScheduleRevision: input.expectedScheduleRevision,
        idempotencyKey: input.idempotencyKey,
        outcome: input.outcome,
        occurredAt: this.deps.clock.now(),
        timing: input.timing,
        requiredMoves: input.requiredMoves,
        failureReason: input.failureReason,
      },
      this.deps.settings,
    );
  }

  finishCorrection(
    state: SchedulerState,
    attemptId: AttemptId,
    idempotencyKey: string,
  ): FinishCorrectionResult {
    return finishCorrection(state, {
      attemptId,
      occurredAt: this.deps.clock.now(),
      idempotencyKey,
    });
  }

  applyCorrectionCompletion(prev: ScheduleStateDetails): ScheduleStateDetails {
    return applyCorrectionCompletion(prev);
  }

  abandonAttempt(state: SchedulerState, attemptId: AttemptId): AbandonAttemptResult {
    const at = this.deps.clock.now();
    return abandonAttempt(state, { attemptId, at });
  }
}
