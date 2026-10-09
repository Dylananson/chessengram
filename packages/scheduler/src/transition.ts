/**
 * Convenience helpers and the canonical pure transition function for "score once"
 * as specified by T03. Used by scheduler facade and tests.
 */

import type { AttemptOutcome, FailureReason, TimingSegments } from "../../contracts/src/types.ts";
import type { SchedulerSettings } from "./settings.ts";
import type { ScheduleStateDetails } from "../../contracts/src/types.ts";
import { applyOutcome, type Transition } from "./core.ts";

export interface ScoreOnceInput {
  prev: ScheduleStateDetails;
  outcome: AttemptOutcome;
  occurredAt: number;
  timing: TimingSegments;
  requiredMoves?: number;
  failureReason?: FailureReason;
}

export function scoreOnce(input: ScoreOnceInput, settings: SchedulerSettings): Transition {
  return applyOutcome(
    input.prev,
    {
      outcome: input.outcome,
      occurredAt: input.occurredAt,
      timing: input.timing,
      requiredMoves: input.requiredMoves,
      failureReason: input.failureReason,
    },
    settings,
  );
}
