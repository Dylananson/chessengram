# ADR-004: Local storage and next-due selection

**Status:** Proposed (NOT accepted)  
**Date:** 2026-10-09  
**Task:** T10 (with T09-lite)  
**Owners:** player-spike / local training adapter

## Context

T10 asks how local (browser) progress should be stored and how the player picks
the next puzzle offline. The T04 `TrainingService` boundary is architecture
neutral and Q02 (online vs local authority) is deliberately unresolved. The
T06 scheduler is pure and side-effect free; T03 defines selection ordering and
the active-attempt reservation but not storage. The spike needs concrete,
reversible choices to prove reload/resume before committing to a production
local-first design.

## Proposal

1. **Storage seam.** Persist through a small `StorageBackend` interface
   (`get/set/delete/getAll/clear`) with an IndexedDB implementation for the
   browser and an in-memory implementation for tests and as a fallback when
   IndexedDB is unavailable.
2. **One object store, logical collections.** Use a single IndexedDB object
   store keyed by a composite `collection\0key`, with a `by-collection` index.
   Collections are a code concept, not an IDB schema change.
3. **Versioned envelopes; separate derived and raw data.** Every record is
   `{ schemaVersion, savedAt, data }`. Derived `SchedulerState` (with revisions
   and commit receipts) lives in `schedules`; raw `AttemptRecord` history lives
   in `attempts`. A version mismatch makes the record skipped, not fatal.
4. **Progress key.** Use the string form `"${programId}:${puzzleId}"` as the
   schedule key, consistent with ADR-002 (program is the scope boundary;
   `collectionId` travels as context, not identity).
5. **Selection.** Reuse the pure `selectNextDue` from `@chessreps/scheduler`
   unchanged. The adapter supplies candidates from stored schedules plus
   not-yet-introduced puzzles in stable pack order, reserves the progress key of
   the session's active attempt, and converts the returned key back to a puzzle
   id.
6. **Reload/resume.** Persist a `meta` pointer from program to active session id
   and keep `SessionState.activeAttemptId` up to date. On startup, resume the
   session and, if an attempt is open, replay its logged correct moves to
   reconstruct the board; a previously scored failure resumes as correction.
7. **Idempotency.** Derive commit idempotency keys from the attempt id (never
   the clock) so reload/retry/double-submit deduplicates.

## Alternatives considered

| Choice | Alternatives | Rationale for selected |
|---|---|---|
| Backend abstraction | Two concrete stores with duplicated logic; use `localStorage` | One interface enables Node tests of the real service and lets the app fall back instead of breaking. `localStorage` is synchronous, size-limited, and string-only. |
| IDB layout | One object store per collection; `localStorage` | No migration when adding collections; indexed enumeration; simpler versioning. |
| Value shape | Raw values only; opaque per-domain schemas | A uniform envelope makes version/skip behavior and timestamps consistent across collections. |
| Derived vs raw | Store only schedule; store only events and recompute | Storing both matches T03/D09, keeps fast reads, and preserves migratable history. |
| Selection | Reimplement ordering in the adapter | Reusing the tested `selectNextDue` avoids drift from T03 semantics; the adapter only maps candidates/reservations. |
| Contents cache | Always refetch the pack; cache the pack blob | Caching normalized content makes reloads fully offline and keeps `loadPuzzle` uniform; a pack-blob optimization is deferred. |

## Consequences

**Positive**
- Entire service is unit-testable in Node; the browser path is exercised with
  `fake-indexeddb`.
- Reload/resume works offline, including correction-in-progress.
- Scheduler invariants preserved: immutable failure, exactly-once commits,
  stale-revision rejection, active-attempt reservation.
- Reversible: storage is behind one interface; selection is the untouched
  scheduler function.

**Negative / risks**
- No schema migration runner yet; version bumps currently skip old records.
- Unbounded attempt history; no pruning/quota handling.
- No cross-tab coordination; the revision guard rejects stale commits but the UI
  does not yet prompt for refresh.
- `SchedulerState` is persisted as-is, so its shape is coupled to the scheduler
  package until a rebuild-from-history migration exists.

## Evidence

- `apps/web/src/storage/{backend,memory-backend,indexeddb-backend,local-store}.ts`
- `apps/web/src/scheduler-service.ts` (`LocalTrainingService implements TrainingService`)
- `apps/web/src/training-adapter.ts`, `src/puzzle-game.ts`, `src/timing.ts`, `src/i18n.ts`, `src/main.ts`
- `docs/research/local-persistence.md`
- Tests (26 total, Node v25.9.0):
  `cd apps/web && npm test`
  - failure-flow: immutable failure, duplicate receipt, success leaves `new`
  - persistence: store round-trip, full service reload + active attempt resume, reset
  - indexeddb-store: real backend across connections
  - selection: stable new order, active reservation skipped, completion frees reservation
  - puzzle-game: grading, illegal move, promotion/underpromotion, setup-move, replay
  - timing: active/correction split, hidden time + trust, repeatable snapshots
- Build: `cd apps/web && npm run build` → tsc clean, Vite build succeeds.

## Open questions / follow-ups

- Q02 (authority): this ADR proves local persistence only. Online authority,
  conflict resolution, and offline→online sync remain open (T07/T10 follow-ups).
- Concrete migration policy for envelope/schema version changes.
- Retention/compaction of attempt history and IndexedDB quota behavior.
- Multi-tab coordination and user-facing conflict handling.
- Whether content caching should be a pack blob + index rather than per-puzzle
  records.

**Status:** PROVISIONAL (Proposed, NOT accepted). Requires coordinator/user
confirmation before being treated as a product decision.
