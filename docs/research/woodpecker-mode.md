# F01 — Woodpecker training mode: initial design brief

Status: **implementation in progress**. User reprioritized feature work ahead of release sign-off/device checks on 2026-10-16 and approved a Woodpecker record category, isolated failed-review scheduler scope, and sequential export migration from 1.1.0 to 1.2.0. The set/cycle screen and trainer path now distinguish Woodpecker from ordinary spaced repetition; progress includes scored-attempt totals, active solving time, and cycle wall-clock start/end. Full acceptance and verification remain open.

## Confirmed user direction

- Start with Woodpecker-style fixed-set training.
- About **500 puzzles** is a reference scale based on the Disco Chess mode the user is trying; it is not a maximum.
- 2026-10-24 clarification: Woodpecker must be available for any non-empty collection, with no puzzle-count cap.
- Repeat the same set in cycles and compare cycle speed and mistakes; the aim is to complete later cycles faster with fewer errors.
- A puzzle failed during a cycle should also enter a separate **Failed** section for spaced repetition.
- This feature is prioritized ahead of first-release sign-off and real-device verification. Those tasks are deferred, not cancelled.

## Product model to design

Keep three concepts distinct:

1. **Set snapshot** — the exact puzzle membership for a Woodpecker run. Changes to a source collection after starting should not silently change an active run.
2. **Cycle** — one pass over that fixed membership, recording coverage, clean solves, errors, and elapsed active time. A later cycle can be compared against earlier cycles.
3. **Failed review queue** — puzzles missed in the cycle, scheduled for later repetition separately from the main cycle. The existing ChessReps scheduler is the candidate scheduler, but how this queue shares normal per-collection progress is not decided.

### Candidate first experience (recommendation)

- Let the user start with any non-empty collection; around 500 puzzles is a useful reference size, not a cap. Do not pad or duplicate smaller collections.
- Retain set membership as a snapshot for the run. Allow an explicit new run to refresh the snapshot.
- Show cycle number, completion, elapsed active time, first-pass errors, and comparison with the previous completed cycle.
- On a miss, record the normal immutable failed attempt and add the puzzle to the Woodpecker Failed queue. Do not let correction moves retroactively turn the failed scored attempt into a success.
- Allow the main cycle to continue after a miss, while Failed review is practiced on its own schedule. A puzzle can be marked cycle-mastered only after a clean scored solve in the cycle or a clearly defined later retry.
- Keep this mode separate from ordinary Next / due selection; do not change the existing daily introduction cap or normal scheduler queue behavior.

These are recommendations to focus discussion, **not settled behavior**.

## Provisional semantics used in the first implementation

1. Sets are created from a collection with selectable membership; puzzle IDs are snapshotted. (The initial 500-puzzle cap was removed after the 2026-10-24 user clarification.)
2. A cycle covers each puzzle after one scored result, clean or failed. Failed correction does not rewrite that result.
3. Failed reviews use a distinct program and set scope, never changing ordinary collection schedules.
4. Cycle metrics count clean/failed scored outcomes and active solving time; failed reviews remain schedulable over time.
5. Incomplete cycles can be resumed; completed cycles are retained for comparisons.
6. These semantics are provisional and should be revisited from user feedback; they are not additional user-approved product requirements.

## Data-safety and architecture gates

- Current attempt scoring is immutable after a first failure; correction completion is evidence, not a score rewrite. Woodpecker must preserve this invariant.
- Current puzzle schedules are scoped by collection and puzzle, and raw attempts are append-only. Avoid silently making a cycle another schedule authority.
- `apps/web/src/storage/data-port.ts` requires sequential export migrations and snapshots current data before import. Existing content/schedule schema versions and the IndexedDB DB name are protected. Any persisted cycle/failed-queue state needs an approved record shape plus tests for older exports, import/export round trips, reload, and non-loss of existing progress.
- Approved persistence plan: separate `woodpecker` raw record collection for saved set snapshots and cycle results; failed review schedules use a dedicated Woodpecker program/scope; export version 1.2.0 adds the collection via a lossless 1.1.0→1.2.0 migration. Existing store name, schemas, ordinary schedules, and older record contents remain unchanged.

## Next bounded task

The first pure model now exists in `packages/scheduler/src/woodpecker.ts`, with focused tests and no persistence/UI integration. It is groundwork—not a usable release. Its deliberately small **provisional** assumptions are: one scored result per puzzle per cycle; cycle coverage is complete after every snapshotted member has a scored result (clean or failed); only `failed` results are handed to the caller as failed-queue puzzle IDs; active time is summed separately; input cycle state is immutable. It does not decide how the caller schedules Failed review, how an unscored/revealed attempt is retried, or whether Failed review later changes cycle status.

F01 acceptance must cover: a discoverable screen; set creation/selection and fixed membership; starting, resuming and completing cycles; visible cycle time/accuracy/error comparisons; a separate usable Failed review queue; durable reload behavior; and lossless export/import/restore compatibility. Current implementation has these main paths but requires complete gates and review, especially crash recovery across attempt commit versus cycle-record writes and failed-review due-state presentation.

## Sources

- User's direct description of the Disco Chess experience, 2026-10-16: set of 500, repeated Woodpecker cycles, failed items separated into a spaced-repetition section.
- Existing project future-work outline: `docs/PROJECT_PLAN.md` F01 says fixed-set snapshots, cycle coverage, shorter cycle targets, accuracy/active-time comparisons, correction semantics, transition to maintenance. Project plan is coordinator-owned and was not edited.
- Existing invariants inspected: `docs/research/scheduling-behavior.md`, `packages/contracts/src/types.ts`, `apps/web/src/storage/data-port.ts`, and `apps/web/src/storage/local-store.ts`.
