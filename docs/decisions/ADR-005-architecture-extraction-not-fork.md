# ADR-005: Architecture — extract and reuse, do not fork Lila

**Status:** Accepted (user decision, 2026-10-09)
**Date:** 2026-10-09
**Decision owner:** user
**Related:** Q01, G1, D01, D03, D11, D12; see ADR-001, ADR-003, ADR-004

## Context

ChessReps must support **both online and offline** operation (D03, and the user's
stated requirement), on phone and desktop, initially for personal use (D01). The
open question Q01 was whether to fork `lila` and adapt its puzzle player, or to
build a focused app that reuses Lichess libraries and content.

The project did both investigations before deciding:

- **T05 (Lichess baseline, measured):** the unchanged Lila stack was compiled and
  run at the pinned revision. It works, but it requires sbt + MongoDB + Redis, is
  server-authoritative, actively uses Redis, and its completion endpoint carries
  no durable attempt state. Evidence: `docs/research/lichess-baseline.md`.
- **T04/T06/T08/T10 (extraction spike, measured):** an architecture-neutral
  `TrainingService` boundary, a deterministic scheduler, and a FEN-rooted local
  player with IndexedDB persistence run offline from bundled content with no
  server. Evidence: `packages/contracts`, `packages/scheduler`, `apps/player-spike`.

## Decision

**Do not fork Lila.** Build ChessReps as a focused application that **reuses
Lichess libraries and content** and **owns** its training service layer:

- Reuse: `chessground` (board), `chessops` (rules/FEN/SAN), and Lichess puzzle
  content (database is CC0, snapshotted into versioned packs).
- Own: collection/attempt/session/schedule domain, scheduling, and selection
  behind the T04 `TrainingService` contract.
- Ship a **local adapter** now (`LocalTrainingService`, IndexedDB) and add a
  **remote adapter** later (a thin API implementing the same contract), not a
  self-hosted Lichess.

Online mode is achieved by adding a remote implementation of the same contract;
it does not require hosting Lila.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Full Lila fork | Server-authoritative, heavy runtime (Mongo/Redis/sbt), no clean offline path; offline would mean a second app inside the fork; "online" would just be self-hosted Lichess. |
| Embed/iframe lichess.org | No offline story; no control over scheduling/persistence; depends on an external service for core progress. |
| Lichess Flutter app fork | Separate stack; desktop/web suitability unresolved; same server-authority problem. |
| Service-worker HTTP interception over Lichess | Preserves request sites but not the server bootstrap; high lifecycle complexity for little offline gain. |

## Consequences

**Positive**
- Offline is first-class (already proven) and online is a later drop-in adapter.
- Small, comprehensible runtime; no server required for personal use.
- No upstream-merge maintenance burden; the Lichess revision is a reference, not
  a base.
- The T04 contract keeps the online/offline split reversible and testable.

**Negative / risks**
- We rebuild the polished Lichess puzzle controller/UX ourselves (partly done:
  board, grading, failure-and-continue, promotion, timing, selection).
- Library licensing: `chessground`/`chessops` are GPL; distributing the app
  carries copyleft obligations (acceptable for personal use; revisit before any
  public distribution — Q11).
- Content freshness depends on our pack pipeline, not live Lichess.

## Verification evidence

- Baseline vs. spike measurements: `docs/research/lichess-baseline.md`,
  `docs/research/player-spike.md`, `docs/research/local-persistence.md`.
- Working local loop with scheduler + persistence: `apps/player-spike` (26 tests,
  successful production build).
- Architecture-neutral boundary: `packages/contracts` (7 tests) and
  `packages/scheduler` (21 T03 acceptance tests).

## Follow-ups

- **T07 (remote adapter):** implement the `TrainingService` contract against a
  thin API; do not depend on Lila's web-internal endpoints as durable storage.
- **Sync/authority (Q02):** define conflict resolution, clock handling, and
  offline→online reconciliation using idempotency keys and revision guards.
- Public distribution would re-open Q11 (licensing/source-offer obligations).
