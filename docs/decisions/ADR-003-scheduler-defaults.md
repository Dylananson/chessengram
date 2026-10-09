# ADR-003: Scheduler defaults and policy choices

**Status:** Proposed (NOT accepted)  
**Date:** 2026-10-09  
**Task:** T06  
**Owners:** scheduler implementation

## Context

T03 specifies the Anki-inspired scheduling model, behavior and 21 acceptance scenarios, but it explicitly leaves numeric defaults as proposals (not user-approved). T06 must implement a deterministic scheduler core against the T04 `ScheduleStateDetails` contract. This ADR records the concrete defaults chosen for the initial implementation and the rationale, alternatives, consequences and evidence as requested.

## Proposal: concrete defaults (provisional)

All values align with T03 §4–§5. These are implementation defaults only; settings are frozen per attempt (settings hash) and the policy is replaceable.

| Setting | Value | Notes |
|---|---|---|
| algorithmId | `ladder-v1` | Explicit algorithm identity; separate from contract versions. |
| algorithmVersion | `1.0.0` | Version for schema/migration awareness. |
| ladderDays | `[1, 3, 7, 14, 30, 60, 120, 240]` | Review rung indices 0–7; graduation assigns rung 0; success moves forward by 1, capped at 7. |
| maxIntervalDays | `240` | Absolute cap for any computed interval (top-rung guard; timing factor cannot exceed cap). |
| learningConfirmationMinutes | `10` | New→Learning success due in 10 minutes (confirmation step). |
| learningRetryMinutes | `1` | New/Learning failure retry due in 1 minute. |
| relearningMinutes | `10` | Review failure relearning step delay. |
| failurePreset | `retry-reset` | T03 default: Review failure enters Relearning (10 min), successful exit returns to rung 0. |
| stepBackAmount | `1` | When using `step-back`, decrease Review rung by at least 1. |
| retryRetainAmount | `0` | When using `retry-retain`, b=0 retains prior rung after relearning exit. |
| newIntroductionLimitPerDay | `10` | Introductions per study day per program scope, no carryover. |
| timing.enabled | `true` | Isolate bounded timing influence. |
| timing.coefficient | `0.10` | f = 1 + 0.10*clamp((T-t)/T, -1,1). |
| timing.minTargetSeconds | `30` | T = max(30, 15*n). |
| timing.secondsPerMove | `15` | Target seconds per required solver move. |
| timing.maxFactor | `1.10` | Upper clamp for factor. |
| timing.minFactor | `0.90` | Lower clamp for factor. |

Eligibility: timing adjustment applies only to a clean, unassisted, uninterrupted Review→Review success with trustworthy timing and a known number of required solver moves (n>0). Failure never consults time; Learning/Relearning transitions and graduations use exact base intervals. When not eligible, factor is exactly 1.

## Alternatives considered

| Choice | Alternatives | Rationale for selected |
|---|---|---|
| Ladder shape | SM-2 ease (not used), FSRS, shorter/longer steps | Small, explicit, replaceable baseline matching T03 proposal; avoids compounding by anchoring to base intervals. |
| failurePreset | `step-back` (b=1), `retry-retain` (b>=1) | `retry-reset` is the clearest borrowing from Anki-like short-retry semantics while keeping explicit return-to-rung behavior; kept configurable. |
| Timing bounds | ±5%, ±15%, unbounded | ±10% matches T03's "small adjustment" and keeps policy isolated; factor clamped to [0.90,1.10]; absolute cap 240d applies after scaling. |
| Target formula | Linear per move only, fixed 60s | T = max(30, 15*n) scales with solution length without over-penalizing very short or long tactical lines; requires move count. |
| Interval arithmetic | Multiply prior adjusted interval | Each transition starts from ladder base (not compounded) to avoid runaway timing effects and keep determinism transparent. |

## Consequences

**Positive:**
- Deterministic implementation matches all 21 T03 acceptance scenarios.
- Policy is fully replaceable (timing isolated; settings frozen; settings hash recorded).
- Raw history remains separate; derived `ScheduleStateDetails` carries algorithm identity, version and settings hash for migration awareness.
- Exactly-once semantics: immutable failure, duplicate idempotency, stale revision rejection are enforced.

**Negative/risks:**
- Numeric values are empirically unvalidated for chess retention; this is a POC baseline. They must be treated as provisional and subject to revision under evidence.
- Timing requires `requiredMoves` and trustworthy timing segments; unavailability forces factor 1 (safe, but reduces expressiveness).
- Rung-anchored bases (no compounding) differ from legacy ease multipliers; behavior change if future algorithms switch to compounding models.

## Verification evidence

Implemented in `packages/scheduler/src/settings.ts` (defaults, `resolveSettings`, `settingsHash`), `core.ts` (transitions/timing), `commit.ts` (idempotency/revisions/corrections/abandonment), `transition.ts`, `selection.ts`, `scheduler.ts`. Tests:

- 21 acceptance scenarios from T03 as named tests: pass (AC01–AC21 covered)
- Unit tests run with Node v25.9.0: `node --test --experimental-strip-types` in `packages/scheduler/` → 21 tests pass, 0 failures.
- Typecheck: `tsc --noEmit` in `packages/scheduler/` → clean.
- Contracts tests still pass: 7 tests pass in `packages/contracts/`.

Exact commands and outputs recorded in handoff below.

## Open questions / follow-ups

- Q04/Q05: accept/revise ladder, timing target/bound, default preset parameters — this ADR makes a concrete proposal for T06 implementation; requires coordinator confirmation before accepting as final product decision.
- Q07/Q08: assistance/reveal semantics interact with failure reasons (contract allows them; grading policy TBD).
- Q12: backup/migration policy — `algorithmId`, `algorithmVersion`, `settingsHash` and schema versions exist; concrete migration rules deferred.
- Empirical tuning: intervals/target need observation once player/POC runs (T08/T09).

**Status:** PROVISIONAL (Proposed, NOT accepted). This documents the implementation's chosen defaults transparently per the T03 specification's "numeric defaults remain proposals" constraint.
