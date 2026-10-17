# STAT-001 — Training time & activity statistics (scope + measurement model)

Status: **proposed** 2026-10-16 (user request). Tracked as `STAT-001` in
`docs/tasks/BACKLOG.md`. This note is analysis/design input only — it confirms
no decisions and changes no stored data.

## User request

"Track things like total time solving on a collection and in total across spaced
repetition and Woodpecker and all collections etc, with a good breakdown of all
data."

## Goal

One place that answers: *how much have I trained, where, and how well?* with
totals that do not lie about what they count.

- Totals across everything, and broken down by mode (Spaced Repetition,
  Woodpecker cycles, Failed review, unscored practice) and by collection.
- Per-collection solving time, and per-collection × mode.
- Activity/outcome counts: solves, failures/lapses, unscored (reveal/skip),
  accuracy, average and best time, and time trend by day/week.

## What is already recorded (no new persistence needed)

Everything below exists today; a stats view can be a **pure read-only
projection** over it.

| Source | Fields that matter | Where |
|---|---|---|
| `AttemptRecord` (append-only) | `progressKey {programId, collectionId?, puzzleId}`, `timing {activeSolvingSeconds, correctionSeconds, interruptionSeconds, hiddenSeconds, timingTrustworthy}`, `outcome?`, `failureReason?`, `startedAt`, `completedAt?`, `events[]` (assistance) | `packages/contracts/src/types.ts` |
| `SessionState` | `programId`, `collectionId?`, `startedAt`, `lastActivityAt` | same |
| `WoodpeckerCycle` | `setId`, `cycleNumber`, `startedAt`, `completedAt?`, `results[{puzzleId, result: clean\|failed, activeSeconds}]` | `packages/scheduler/src/woodpecker.ts` |
| Woodpecker set record | `sourceCollectionId` (maps a cycle back to its collection) | same |
| Collections | `id`, `name`, membership | `apps/web/src/storage/local-store.ts` |

Program scopes in use (`apps/web/src/scheduler-service.ts`):
`DEFAULT_PROGRAM_ID` (Spaced Repetition), `WOODPECKER_CYCLE_PROGRAM_ID`,
`WOODPECKER_FAILED_PROGRAM_ID`, and `WOODPECKER_REVIEW_PROGRAM_ID` (unscored
practice, WP-002).

Read access today is `listAttempts({ programId?, puzzleId?, limit? })` — **no
collection filter and no time-range filter**, default limit 100. Stats needs
either a wider filter or a dedicated aggregation read; attempts are already
in memory, but the same call must behave under Node tests.

## Measurement model (the part that must be explicit)

The main risk is double counting and mixing two different quantities. Proposed
definitions:

1. **Active solving time** — `Σ activeSolvingSeconds` of *scored* attempts.
   This is the headline "time solving".
2. **Correction time** — `Σ correctionSeconds`, reported separately. Never
   added into active solving time.
3. **Wall-clock time** — `completedAt − startedAt` for a session or Woodpecker
   cycle. A different number (includes thinking pauses, interruptions, idling);
   shown as its own column, never summed with active time.
4. **Woodpecker time comes from cycle results only.** `WoodpeckerCycleResult.
   activeSeconds` is defined as active solving time *excluding correction*, and
   the cycle is the authority for that mode. Do **not** additionally sum the
   underlying attempts for a cycle, or the same seconds are counted twice.
5. **Unscored work** (`reveal`/`skip` and `WOODPECKER_REVIEW_PROGRAM_ID`) is
   excluded from scored totals and surfaced as its own "practice/practice-review"
   row, so totals stay honest without hiding the work.
6. **Untrustworthy timing** (`timingTrustworthy === false`) is reported as a
   separate count ("attempts with untrusted timing") rather than silently
   included or silently dropped.
7. **Interruption/hidden seconds** are reported per mode but never folded into
   active time.

## Proposed breakdowns

- Overall totals; then by mode; then by collection; then collection × mode.
- Per day / per week trend of active time, solves, failures.
- Per puzzle: average and best active time, attempts, lapses (extends `STS-001`).
- Woodpecker: per collection — cycles completed, active time per cycle, cycle
  wall-clock duration, cycle accuracy, failed-review backlog.
- Reconciliation line: the sum of the per-collection numbers must equal the
  overall number (a test, not a hope).

## Surface options (decided 2026-10-17)

Decision: **its own Stats tab** (`#/stats`), not a Dashboard section, so the
breakdowns can grow. Headline = **active solving time only**; correction time
and Woodpecker wall-clock duration are shown separately. Unscored practice has
its **own row** and never enters scored totals. The screen has a **7 / 30 / all**
range filter (default all-time).

Implementation note: unscored attempts (reveal, skip, unscored review) used to
persist zero timing, so practice time would have been permanently empty. The
abandon path now records the elapsed active seconds on the attempt (`timing`
already exists — no schema change), and `TrainingAdapter.abandonCurrentAttempt`
passes the timer snapshot. Scoring and schedules are unaffected.

## Non-goals

- No new persisted schema, record type or migration: everything derives from
  append-only attempts, sessions, Woodpecker cycles and collections. Export
  1.2.0 already carries all of it.
- No engine analysis (that is `AN-001b`), no cross-device sync (`F04`).
- No writes of any kind — read-only, like History and `STS-001`.

## Risks / open questions

1. **Cost.** Years of attempts could be tens of thousands of records; a naive
   full scan at every redraw will be slow. Plan: aggregate once per screen visit
   (pure function over a snapshot), with an optional date-range filter so the
   scan is bounded.
2. **Day boundaries.** Buckets should use local midnight; note that a session
   spanning midnight must not have its active time double-attributed.
3. **Headline definition.** Is "total time" active-only (recommended), or
   active + correction? Must be labelled on screen either way.
4. **Unscored practice.** Separate total only, or also blended into an "all
   board time"? Recommend separate and clearly labelled.
5. **Empty/partial data.** Early data may predate timing (`timingTrustworthy`
   false, or zero active seconds) — show "—", not `0s`.

## Proposed acceptance (for the task)

- A pure projection module (no DOM) with tests for: per-collection → overall
  reconciliation, Woodpecker not double counted, unscored/review excluded from
  scored totals, untrustworthy timing counted separately, and local-day bucketing.
- A view rendering overall totals, per-mode and per-collection breakdowns;
  read-only; no state mutation.
- `npm test` / `typecheck` / `build` / `smoke` green, with smoke asserting the
  totals render and that per-collection figures sum to the overall figure.
- No schema/export change.
