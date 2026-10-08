# ADR-002: Progress scope and authority

**Status:** Proposed (NOT accepted)  
**Date:** 2026-10-09  
**Task:** T04  
**Owners:** contracts design

## Context

Q09 asks: "Progress shared across collections or independent?"  
Q02 asks: "Authoritative scheduling location online?"

From T03:
- Progress key identifies which puzzle's schedule/state to update
- Active attempt reservation prevents concurrent attempts on same progress key
- Training program is a method-specific progress container (plan §Domain requirements)

Collections group puzzles (selected puzzle references and settings). A training program might use collections. We need to decide default scope.

## Alternatives considered

1. **Global/shared across all collections**  
- Pro: User sees unified progress regardless of collection browsing  
- Con: Collections might be used for different contexts/goals; mixing progress could be confusing

2. **Per-collection independent progress**  
- Pro: Clear separation between collections  
- Con: Same puzzle in multiple collections treated separately; doesn't match "training program" concept

3. **Per-training-program scope (proposed)**  
- Pro: Aligns with training program as method-specific progress container; collections within a program can share progress; flexible for future program types (spaced rep, Woodpecker, openings)  
- Con: Requires programId in all operations; collectionId is additional context

## Proposal

Define `ProgressKey` as:
```ts
interface ProgressKey {
  programId: string;      // Training program identifier (authoritative scope)
  puzzleId: string;       // Puzzle identifier
  collectionId?: string;  // Optional collection context (not scope boundary)
}
```

Rationale:
- `programId` is the scope boundary for schedule state, due times, lapse counts, daily limits
- Same puzzle in different programs has independent progress (different methods/policies)
- Same puzzle in different collections under same program shares progress (natural)
- `collectionId` is passed through for context/UI; not part of identity for scheduling

**Scheduling authority (Q02) - PROVISIONAL:**
- Contract defines invariants: idempotency, immutable outcomes, attempt reservation, schedule revision guards
- Contract does not mandate online vs local authority. Both must produce equivalent observable behavior given identical inputs/history/settings.
- Implementation details (centralized vs local-first with sync) deferred to T07/T10 and G1.

## Consequences

**Positive:**
- Matches plan's "training program" concept
- Enables program-specific policies (failure presets, ladders) without cross-contamination
- Preserves flexibility - collectionId optional if future model changes
- Active attempt keyed by progress key prevents double-attempts

**Negative:**
- Slightly more complex keys
- Need to ensure programId is consistently provided

## Evidence

- `ProgressKey` in contracts matches proposed structure
- Reference implementation uses `programId:puzzleId` key for schedule state
- Session carries `programId` and `collectionId`
- All service operations accept programId where relevant

## Open questions / follow-ups

- Confirm with actual use cases: will users want same puzzle progress shared across collections in same program? This matches intuition for SRS.
- Q02 needs concrete implementation: conflict resolution on reconnect, clock validation, event journal/outbox for offline→online sync (deferred to T07/T10)
- Study-day/time-zone scope - tied to program settings

**Status:** PROVISIONAL - not user-approved. Requires coordinator/user confirmation before accepting as final.
