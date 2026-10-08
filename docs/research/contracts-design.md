# Contracts design (T04)

Status: **Proposed** (not user-approved). See ADR-001 and ADR-002 for provisional decisions.

## Goal
Define an architecture-neutral TypeScript contracts package `@chessreps/contracts` that defines the boundary between a puzzle player UI and a training service. The same interface must serve an online (server) adapter and a bundled local (browser) adapter. Must not presuppose the unresolved full-fork vs extraction decision (Q01). Keep dependency-free and framework-free.

## Design principles
- **Boundary clarity**: UI depends only on contracts; adapters implement `TrainingService`.
- **Async-first**: All operations return `Promise<T>` so HTTP and local DB both fit.
- **Immutable scored outcomes**: Once committed, failure cannot be overwritten by correction (T03 §6). Correction completion is recorded as evidence only.
- **Exactly-once safety**: Idempotency keys and outcome receipts prevent duplicate scheduling effects. Conflicting submissions are rejected, not silently applied.
- **Raw history separation**: Attempt events/history are append-only evidence; schedule state is a derived projection (T03 §3).
- **Schema versioning**: All persisted entities carry schema versions for migration safety.
- **Content seam**: Normalized puzzle is separate from Lichess presentation envelope. Respects T02 setup-move convention.

## Core types

### NormalizedPuzzle
Represents content at the boundary:
- `sourceFen`, `setupMove` (optional), `solverFen`, `solverColor` - respects setup move convention (initialize from `solverFen` OR from `sourceFen` + animate `setupMove` once).
- `solution` excludes setup move; alternates as per T02.
- `originalFields` preserves full original data for provenance without polluting domain types.
- `contentSchemaVersion` enables content migrations.

### ScheduleState/ScheduleStateDetails
Types for `new | learning | review | relearning` states (T03). Includes algorithm identity, settings hash, rung/returnRung, due times, lapse counts. Algorithm-specific payload is opaque for forward compatibility.

### AttemptRecord & AttemptEvent
Append-only history with ordered events, timing segments (active solving, correction, interruptions, hidden time), and timingTrustworthy flag. Correction completion is recorded as event but does not alter outcome.

### SessionState
Tracks active attempt reservation to prevent concurrent attempts on same progress key (T03 §6).

## TrainingService interface operations
1. `startSession` - create/resume session
2. `loadPuzzle` - fetch normalized puzzle content
3. `startAttempt` - begin scored attempt; reserves active attempt
4. `recordEvent` - log moves/pauses/backgrounding etc.
5. `commitOutcome` - commit immutable success/failure with idempotency; returns receipt
6. `finishCorrection` - mark correction complete after failure; no outcome change
7. `selectNext` - choose next puzzle per scheduling rules
8. `getSession`/`getAttempt` - read state/history

## Scheduling authority & progress scope (PROVISIONAL)
- **Q02 (scheduling authority)**: Both adapters must produce equivalent behavior given same history/settings. The contract defines inputs/outputs and invariants (idempotency, immutable failure, reservation) rather than imposing location. Implementation choice (online authoritative vs local with sync) is deferred.
- **Q09 (progress scope)**: Propose per-training-program scope (`programId` in `ProgressKey`). `collectionId` is optional to allow future shared-progress models without breaking contract. Active attempt is keyed by progress key to prevent concurrent scored attempts.

## Attempt identity, idempotency, and exactly-once (PROVISIONAL)
- Each attempt gets stable `AttemptId`.
- `commitOutcome` requires `idempotencyKey`; duplicate submissions return the original `OutcomeReceipt`.
- Conflicting submissions (e.g. trying to commit success after failure already committed) must be rejected. Contract tests assert this behavior.
- After failure, puzzle/attempt remain open for correction; `finishCorrection` records completion without mutating outcome.
- A scheduled retry starts a new attempt ID from original solver position.
- Schedule revision and expected revision guards prevent applying effects based on stale state.

## Reference implementation
`InMemoryTrainingService` is provided as a contract test double ONLY. It:
- Enforces idempotency and basic state transitions for testing
- Maintains attempt reservation semantics conceptually
- Distinguishes failure from correction
- Implements minimal stub transitions (new→learning on success, review→relearning on failure, etc.) sufficient for contract tests
- Does NOT implement full scheduler logic (that belongs to T06)

## Contract tests
Located in `test/contracts.test.ts`, run with `node --test --experimental-strip-types`. Tests:
1. Session creation
2. Puzzle loading with normalized schema
3. Attempt start with correct position
4. Success commit updates schedule
5. Idempotency via idempotencyKey
6. Correction doesn't change scored outcome
7. Next puzzle selection

Fixtures are derived from first 3 real entries in `data/puzzles/lichess-900-1099-v1/pack.jsonl` - exact fields preserved via `originalFields`.

## ADRs created (PROVISIONAL)

### ADR-001: Training service boundary and adapter strategy
- **Status**: Proposed (NOT accepted)
- **Context**: Need common interface for online (server) and local (browser) adapters without presupposing Q01 (full fork vs extraction).
- **Proposal**: Define architecture-neutral `TrainingService` contract with async methods, schema versioning, idempotency, immutable outcomes.
- **Alternatives**: 
  1. UI directly calls Lichess APIs (tight coupling, blocks offline)
  2. Adapter per backend without shared contract (duplication, drift)
  3. Shared contract (proposed)
- **Consequences**: Enables testing with in-memory double, supports both adapters, preserves Q01 flexibility. Adds abstraction cost.
- **Open**: Scheduling authority (Q02) implementation details.

### ADR-002: Progress scope and authority
- **Status**: Proposed (NOT accepted)
- **Context**: Q09 asks whether progress is shared across collections or independent. Q02 about scheduling authority.
- **Proposal**: Progress scoped per training program (`programId` in `ProgressKey`). `collectionId` optional. Contract enforces invariants (attempt reservation, idempotency) but defers final authority model.
- **Alternatives**:
  1. Global progress across all collections
  2. Per-collection independent progress
  3. Per-training-program (proposed) - allows collections within program to share progress
- **Consequences**: Matches training program concept in plan; flexible enough for different program types.
- **Open**: Need to validate against actual collection usage patterns.

## Verification
- `npm test` in packages/contracts - all contract tests pass
- `npm run typecheck` - TypeScript compiles with `tsc --noEmit`

## Open items
- Q02: Online vs local scheduling authority - need to specify commit boundary, conflict protocol, clock handling
- Q09: Confirm progress scope after collection UI design
- Q06: Pause/backgrounding semantics on mobile
- Q07/Q08: Assistance semantics (hints/reveals) - contract allows failure reasons but grading policy TBD
- Clock skew handling for due times (store client occurrence + server receipt)
- Event ordering guarantees and sequence numbers
