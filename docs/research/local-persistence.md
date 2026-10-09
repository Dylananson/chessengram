# Local persistence for the player spike (T10)

**Task:** T10 (with T09-lite wiring)
**Status:** implementation notes for a spike; the storage decisions are recorded
as `ADR-004` (Proposed, not accepted).

## Goal

Make local puzzle progress survive a page reload without a server, while
preserving the T03/T04 invariants (derived schedule vs raw history, exactly-once
commits, immutable failures, attempt reservation). T10 is explicitly a spike:
the point is to validate the storage seam and reload/resume flow, not to freeze
a production schema.

## Design

The training service never talks to IndexedDB directly. It talks to a tiny
`StorageBackend` interface (`src/storage/backend.ts`):

```
get / set / delete / getAll(collection) / clear(collection?)
```

Two implementations provide the same contract:

| Backend | File | Used for |
|---|---|---|
| `InMemoryStorageBackend` | `src/storage/memory-backend.ts` | Node tests; browser fallback when IndexedDB is unavailable (e.g. private mode) |
| `IndexedDbStorageBackend` | `src/storage/indexeddb-backend.ts` | Browser persistence |

This is what lets the whole service be unit-tested in Node with no browser, and
lets the app degrade gracefully instead of failing when IndexedDB is blocked.

### One object store, logical collections

`IndexedDbStorageBackend` uses a single object store (`kv`) with a composite
primary key (`collection\0key`) and a non-unique `by-collection` index. Adding a
new logical collection is a code change only — no schema migration, no new
object store. `getAll(collection)` is served by the index.

### Versioned envelopes and separated data

`LocalStore` (`src/storage/local-store.ts`) wraps every value in an envelope:

```ts
interface Envelope<T> { schemaVersion: string; savedAt: number; data: T; }
```

Collections:

| Collection | Key | Value |
|---|---|---|
| `content` | puzzle id | `NormalizedPuzzle` (enveloped with its `contentSchemaVersion`) |
| `schedules` | `programId:puzzleId` | `SchedulerState` (derived schedule + revisions + receipts) |
| `attempts` | attempt id | `AttemptRecord` (raw, append-only history) |
| `sessions` | session id | `SessionState` |
| `meta` | fixed keys | content-set meta, puzzle presentation order, active-session pointers |

Derived schedule state is stored **separately** from raw attempt history, per
T03/D09: history can outlive a scheduler change, and a future migration can
rebuild `SchedulerState` from raw events. `unwrap` returns `undefined` on an
envelope version mismatch rather than throwing, so an older/newer record is
skipped instead of crashing startup.

### Reload and resume flow

On startup the service:

1. `init()` loads content, schedules, attempts, sessions, meta, and the
   `active-sessions` pointer map into memory.
2. If no content is stored, it fetches the T02 JSONL pack once and `seedContent`
   persists it (so subsequent loads are offline).
3. `startSession` resumes the persisted session for the program (from the
   `active-sessions` meta pointer) instead of creating a new one.
4. If the session has `activeAttemptId`, the UI rebuilds the attempt: it replays
   the stored **correct** solver moves (with opponent replies) through chessops
   and, if the attempt was already scored as a failure, resumes the correction.
   Otherwise it selects the next due puzzle.

`?reset=1` invokes `LocalTrainingService.reset()` (clears every collection and
all in-memory maps) for a clean start without devtools.

## What is persisted for an attempt

`AttemptRecord.events` is the raw log. The UI appends `move` events with
`payload.correct` and `wrong-move` events; the first failure is committed via the
scheduler (one immutable failure), and correction completion is recorded as a
`correction-complete` event plus the scheduler's `finishCorrection` evidence.
Because correct moves are logged, the board can be reconstructed exactly on
reload.

Idempotency keys are derived from the attempt id only (`success-<attemptId>`,
`fail-<attemptId>`, `correction-<attemptId>`), never from the clock, so a
duplicate submit or a reload mid-commit maps to the original receipt.

## Tests

`tests/persistence.node.test.ts` and `tests/indexeddb-store.node.test.ts` cover:

- `LocalStore` content/meta round-trip through a dumped backend.
- Full service reload: content, puzzle order, content meta, schedule
  (`introducedAt`), and the resumable active attempt with its move events.
- `reset()` clears content and derived state.
- The real `IndexedDbStorageBackend` (via `fake-indexeddb`) persists across
  connections and supports `reset`.

## Limitations / known gaps

- No schema migration runner yet: envelopes carry `schemaVersion`, but a changed
  shape currently means the old record is ignored. A migration policy is a
  follow-up (see ADR-004 open questions).
- No compaction/quota management. Attempt history grows unbounded in the spike;
  a real client would prune or aggregate derived history.
- Content is stored as full normalized objects; a real client may store a pack
  blob plus an index.
- `IndexedDbStorageBackend` uses one store for everything; fine at spike scale,
  revisit if write concurrency or large payloads matter.
- No multi-tab coordination: two tabs could interleave commits for the same
  progress key. The scheduler's revision guard rejects stale commits, but the
  UI does not yet surface a refresh prompt.
