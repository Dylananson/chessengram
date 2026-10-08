# ADR-001: Training service boundary and adapter strategy

**Status:** Proposed (NOT accepted)  
**Date:** 2026-10-09  
**Task:** T04  
**Owners:** contracts design

## Context

ChessReps needs a puzzle player that works both online and offline. The plan shows:
```
Lichess-derived puzzle player
              |
      Training service interface
              |
      +-------+--------+
      |                |
 Online adapter    Local adapter
      |                |
 Application API   Browser storage + local training logic
```

But Q01 (full fork vs extraction) remains unresolved. We need the boundary defined now so both T07 (online adapter) and T10 (local adapter) can build against it, without committing to fork/extraction.

Key requirements from T03/T04:
- Same UI-facing interface for online and local
- Async operations (promises) to fit HTTP and local DB
- Immutable scored outcomes (failure cannot be overwritten by correction)
- Exactly-once/idempotency for scheduling effects
- Distinguish failure from correction completion
- Content seam separate from Lichess presentation
- Schema versioning and raw history separation

## Alternatives considered

1. **Direct Lichess API calls from UI**  
- Pro: minimal abstraction  
- Con: tightly couples to Lichess server API; blocks offline; hard to swap backends

2. **Backend-specific adapters without shared contract**  
- Pro: each adapter optimized for its backend  
- Con: interface drift, duplicated types/tests, harder to ensure behavior parity

3. **Shared architecture-neutral `TrainingService` contract (proposed)**  
- Pro: single contract, testable with in-memory double, preserves Q01 flexibility, enforces invariants  
- Con: abstraction cost, may need to evolve as implementations mature

## Proposal

Define `@chessreps/contracts` package with:
- **Types**: NormalizedPuzzle (with setup move convention), ScheduleState (new/learning/review/relearning), AttemptRecord/Event, SessionState, schema versioning, etc.
- **Interface**: `TrainingService` with operations: startSession, loadPuzzle, startAttempt, recordEvent, commitOutcome, finishCorrection, selectNext, getSession, getAttempt. All async.
- **Invariants**: commitOutcome requires idempotencyKey; duplicate returns original receipt; conflicting commits rejected; correction via finishCorrection never changes committed outcome.
- **Test double**: `InMemoryTrainingService` for contract tests.

This contract is dependency-free and framework-free. Adapters implement the same interface.

## Consequences

**Positive:**
- Same interface works online/local (core requirement)
- Contract tests verify boundary behavior independently of adapters
- Q01 remains open - both fork and extraction can use this boundary
- Enforces T03 requirements (immutable failure, idempotency, history separation)

**Negative:**
- Additional layer of indirection
- Contract may need refinement as T07/T10/T06 progress
- Some transport concerns (retries, timeouts) not fully specified yet

## Evidence

- Contract types follow T03 spec (states, timing segments, attempt integrity)
- Contract tests use real fixtures from `data/puzzles/lichess-900-1099-v1/pack.jsonl` (first 3 entries)
- Tests pass with Node v25.9.0 built-in test runner (`node --test --experimental-strip-types`)
- TypeScript compiles with `tsc --noEmit`

## Open questions / follow-ups

- Q02 (scheduling authority): contract defines invariants but not who is authoritative - needs resolution in T07/T10 context
- Transport semantics (timeouts, network errors) - may need error types
- Event ordering/sequence numbers details
- Clock skew handling

**Status:** PROVISIONAL - not user-approved. Record as proposed for T04 handoff.
