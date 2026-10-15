# ADR sweep for T16 (recommendations only — NOT decisions)

Scope: ADR-001..004 are all **Proposed**. Accepting them is a user/coordinator
decision. Nothing here edits `docs/decisions/**` or `docs/PROJECT_PLAN.md`.

## ADR-001 — Training service boundary

- **Accept for T16 means:** lock the `TrainingService` interface and its
  invariants (async, idempotent `commitOutcome`, immutable scored failure,
  correction via `finishCorrection`) as stable through the release.
- **Defer means:** keep the contract provisional; adapters may still evolve it.
- **Recommendation:** ACCEPT the boundary invariants for T16 (local scope).
  The contract is implemented, has 7 contract tests, and is exercised
  end-to-end by `LocalTrainingService`. Leave transport/online error semantics
  (timeouts, retries) explicitly open for T07/post-T16.

## ADR-002 — Progress scope and authority (Q09/Q02)

- **Accept for T16 means:** lock per-training-program progress scope
  (`programId:puzzleId`; `collectionId` as context only) and the provisional
  authority stance (local behavior defined; online authority deferred).
- **Defer means:** ship the same behavior as provisional; B4 Collections UI
  stays free to revisit scope once Q09 is answered.
- **Recommendation:** DEFER acceptance until the Q09 user-scope decision (B4).
  Shipping T16 on the provisional per-program behavior is fine, but accepting
  now would prejudge the blocked Collections design. Accept only the
  non-controversial part if useful: `collectionId` travels as context.

## ADR-003 — Scheduler defaults (ladder-v1)

- **Accept for T16 means:** bless the numeric defaults (8-rung ladder to 240d,
  10-min confirmation / 1-min retry / 10-min relearning, ±10% bounded timing,
  10 new/day, `retry-reset`) as validated product choices.
- **Defer means:** ship them as a tunable provisional baseline; settings stay
  replaceable via `resolveSettings` + `settingsHash`.
- **Recommendation:** DEFER numeric acceptance; ACCEPT only the mechanism
  (replaceable policy, frozen-per-attempt settings, rung-anchored bases, raw
  history preserved). The numbers are empirically unvalidated (ADR states this);
  revisit after real usage. No code change needed — the mechanism already
  supports this stance.

## ADR-004 — Local storage and selection

- **Accept for T16 means:** lock the single-IDB-store + versioned-envelope
  layout, `programId:puzzleId` schedule keys, reuse of pure `selectNextDue`,
  and reload/resume + attempt-id-derived idempotency keys.
- **Defer means:** keep the storage shape provisional; future migrations stay
  unconstrained.
- **Recommendation:** ACCEPT for T16 local scope. Reload/resume (incl.
  correction-in-progress), export/import + pre-import snapshots (PB5), and the
  versioned `settings` collection (PB4) are verified. Record known follow-ups
  as post-T16: attempt-history pruning/quota handling, cross-tab coordination.

## T13 status note (recommendation only)

- **Discrepancy:** `docs/PROJECT_PLAN.md` marks **T13 Done** ("Collections
  screen stub exists and PGN import … is implemented in Puzzles view"), while
  `apps/web/src/screens.ts` still ships `collections` as the sole stub and
  the GRAPH tracks a **T13-followup/B4 (blocked: needs user scope Q09)** for
  the real Collections screen.
- **What is actually done:** Puzzles-view import surface (pack library, JSONL,
  creator/editor/removal, Lichess CSV, PGN preview/confirm) + curated Settings
  (PB4) — i.e. the import half of T13.
- **What is pending:** the real Collections screen (B4), gated on the Q09
  progress-scope user decision.
- **Recommendation:** keep the shipped behavior unchanged; ask the coordinator
  to reword the T13 board entry (e.g. "T13 import surface Done; Collections UI
  split to T13-followup/B4, blocked on Q09") rather than treating the stub as
  the finished Collections screen. No plan edit made here.
