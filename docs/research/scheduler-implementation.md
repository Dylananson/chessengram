# Scheduler implementation (T06)

Status: Implemented (provisional). This documents the mapping from T03 to the code in `packages/scheduler/**`, chosen defaults (recorded in ADR-003), what was deferred, and verification.

## Mapping to T03 sections

| T03 section | Implementation location | Notes |
|---|---|---|
| §3 Replaceable components | `src/core.ts` (pure transitions), `src/timing` logic in `core.ts`, `src/clock.ts` (injectable), `src/settings.ts` (policy snapshot) | Scheduler is a pure projection + transition result; no I/O or side effects. Clock injected; settings frozen per evaluation. |
| §4 Defaults/arithmetic | `src/settings.ts` (DEFAULT_SETTINGS, DEFAULT_LADDER_DAYS, DEFAULT_TIMING_POLICY), `src/core.ts::evaluateTiming` | T = max(30, 15*n), factor ±10%, clamped [0.90,1.10], rounded to nearest second (floor(base*factor+0.5)), interval capped at `maxIntervalDays*86400`. Each transition anchors to ladder base (no compounding). |
| §5 Transitions | `src/core.ts::applyOutcome` | New/Learning/Review/Relearning explicit transitions implemented. Presets: retry-reset, retry-retain, step-back. Relearning returns to `returnRung` on success. |
| §5 Correction | `src/core.ts::applyCorrectionCompletion`, `src/commit.ts::finishCorrection` | Correction completion leaves schedule unchanged; commit layer enforces failure immutability and dedup. |
| §6 Exactly-once/integrity | `src/commit.ts` (`commitScoredOutcome`, `finishCorrection`, `startAttempt`, `abandonAttempt`) | Idempotency by `idempotencyKey`, duplicate returns original receipt, attempt-outcome conflict rejected, stale schedule revision rejected. |
| §7 Timing/interruption | `src/core.ts::evaluateTiming` | Requires timingTrustworthy, no interruptionSeconds/hiddenSeconds, finite active time, n>0, and Review→Review success. Otherwise factor 1 with reason. |
| §8 Queue/eligibility | `src/selection.ts` | Ordering: due Learning/Relearning first (by dueAt), then due Review, then eligible New by stable order; reservations exclude from selection; no synthetic failures; backlog behavior preserved. |
| §9 Acceptance scenarios | `test/t03-acceptance*.test.ts` | AC01–AC21 implemented as named tests (21 total). |

## State machine summary

States: `new | learning | review | relearning` (from T04 `ScheduleState`). Transitions:
- new+S → learning (due a + confirmationMinutes*60)
- new+F → learning (due a + retryMinutes*60); short-step failure count incremented
- learning+S → review rung 0 (due a + L[0])
- learning+F → learning (retry)
- review(i)+S → review min(i+1,max) (base L[next], adjusted by timing only if eligible)
- review(i)+F, retry-reset → relearning returnRung=0 (lapse++)
- review(i)+F, retry-retain → relearning returnRung=max(0,i-b), b=retryRetainAmount
- review(i)+F, step-back → review max(0,i-b), b=stepBackAmount, no short relearning
- relearning(k)+S → review rung k (L[k])
- relearning(k)+F → relearning same k (retry); no extra lapse

Timing eligible only for clean Review→Review success; else factor 1. No compounding across attempts.

## Chosen defaults (ADR-003)

See `docs/decisions/ADR-003-scheduler-defaults.md` for full table and rationale. Key values: ladder [1,3,7,14,30,60,120,240], max 240d, failurePreset `retry-reset`, timing ±10% with T=max(30,15*n), coefficients/clamps as above.

## Implementation notes

- Pure modules: no Date.now() calls outside `src/clock.ts`; all time comes via injected Clock or explicit `occurredAt`.
- `settingsHash` uses stable canonical JSON (sorted keys) + FNV-1a 64-bit hex; format `fnv1a64:<hex>`.
- `ScheduleStateDetails` fields from T04: state, dueAt?, rung?, returnRung?, algorithmId, algorithmVersion, settingsHash, lapseCount, currentStepFailureCount, introducedAt?, algorithmPayload?. Schema version fixed to "1.0.0".
- `SchedulerState` in commit layer is the in-memory projection (revision counter, receipts by idempotency key, committed attempts, corrections, abandonments). Raw attempt events live in AttemptRecord (adapter/persistence).
- Selection is a pure eligibility/order function; daily limits/New allowance and exact study-day rollover are selector/adapter concerns (not fully encoded here except introducedAt semantics).
- Correction never mutates schedule or revision.

## Deferred (per requirements)

- Daily limits/New allowance enforcement and study-day rollover logic beyond `introducedAt` and basic selection hints (T03 §8 still leaves some policy choices to adapter/UI).
- Pause/background/abandonment lifecycle nuances beyond the pure record (timing segments validation details) — contract layer owns segments; scheduler reacts to scoring inputs.
- Assistance/hint/reveal failure reasons: contract allows them; grading policy mapping to failure outcome is adapter concern; scheduler treats "failure" outcome uniformly by preset.
- FSRS integration/migration: algorithm is `ladder-v1` now; versioning in place for future replacement.
- UI "Next" behavior, reservation across tabs (adapter/session ownership).

## Verification

Commands run:
- `cd /home/dtans/code/chessreps/packages/scheduler && node --test --experimental-strip-types test/*.test.ts`  
  Result: 21 tests pass, 0 failures. Duration ~110ms.
- `cd /home/dtans/code/chessreps/packages/scheduler && ./node_modules/.bin/tsc --noEmit`  
  Result: clean (no errors).
- `cd /home/dtans/code/chessreps/packages/contracts && node --test --experimental-strip-types`  
  Result: 7 tests pass, 0 failures.
- `cd /home/dtans/code/chessreps/packages/contracts && ./node_modules/.bin/tsc --noEmit`  
  Result: clean.

All tests pass; typecheck clean. Contracts unaffected.

## Files created/modified

Created under `packages/scheduler/`:
- `package.json`, `tsconfig.json`
- `src/settings.ts`, `src/clock.ts`, `src/core.ts`, `src/commit.ts`, `src/transition.ts`, `src/selection.ts`, `src/scheduler.ts`, `src/index.ts`
- `test/t03-acceptance.test.ts`, `test/t03-acceptance2.test.ts`, `test/t03-acceptance3.test.ts`

Docs:
- `docs/decisions/ADR-003-scheduler-defaults.md` (Proposed, NOT accepted)
- `docs/research/scheduler-implementation.md` (this file)
