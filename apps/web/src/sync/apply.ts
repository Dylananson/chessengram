/**
 * ONL-012 — inbound sync: verify, decrypt and apply `response.changes`.
 *
 * This is the missing half of the sync loop. The outbound path only uploads
 * sealed envelopes; convergence requires the other device to open every
 * envelope and merge it into its own local state. The pipeline here is
 * deliberately split from storage/business logic:
 *
 * - **Pure where possible.** Envelope validation, payload validation and the
 *   merge decisions (`collections.ts` / `woodpecker.ts`) are pure. All I/O goes
 *   through the injected {@link SyncApplyWriter}.
 * - **Fail closed per record.** An envelope that is unreadable (bad AEAD tag,
 *   wrong padding, unknown key version) or carries an invalid payload is
 *   skipped, counted and reported — it never partially mutates local state.
 * - **Batch continues.** One corrupt record does not abort the rest of the
 *   batch, but the returned cursor stops before it so the failed record is
 *   retried on the next sync instead of being silently lost. Records after it
 *   may already have been applied; that is safe because every apply is
 *   idempotent.
 * - **No plaintext logging.** The error sink receives only the envelope type,
 *   its public `recordId` and a coarse reason. Decrypted payloads and keys are
 *   never logged or attached to an error.
 */

import type { AttemptEvent, AttemptRecord, NormalizedPuzzle } from '@chessengram/contracts';
import type { WoodpeckerCycle, WoodpeckerSetRecord } from '@chessengram/scheduler';
import type {
  CollectionRecord,
  CollectionSyncStateRevs,
  SettingSyncState,
  UserPuzzleSyncState,
} from '../storage/local-store.ts';
import type {
  SyncAttemptPayload,
  SyncCollectionPayload,
  SyncEntityType,
  SyncRecordEnvelope,
  SyncSettingPayload,
  SyncUserPuzzlePayload,
  SyncWoodpeckerPayload,
  SyncWoodpeckerResultPayload,
} from './types.ts';
import { openRecord } from './envelope.ts';
import {
  applyCollectionPayload as mergeCollectionPayload,
  type CollectionSyncState,
} from './collections.ts';
import {
  applyWoodpeckerCycle as mergeWoodpeckerCycle,
  applyWoodpeckerResult as mergeWoodpeckerResult,
  applyWoodpeckerSet as mergeWoodpeckerSet,
  type WoodpeckerCycleApply,
  type WoodpeckerResultApply,
  type WoodpeckerSetApply,
} from './woodpecker.ts';

/** Coarse skip reasons safe to report (never payload/plaintext detail). */
export type SyncApplySkipReason =
  | 'unreadable_or_invalid'
  | 'unsupported_type'
  | 'apply_failed';

export type SyncApplyRecordOutcome = 'applied' | 'duplicate' | 'skipped';

/** Counts returned by {@link applyChanges}. */
export interface SyncApplyResult {
  applied: number;
  skipped: number;
  duplicates: number;
  /**
   * Last cursor the caller may safely persist. It never moves past a record
   * that was skipped, so that record is retried next sync.
   */
  cursor: number;
}

/**
 * Every write the inbound path needs. Implemented by the service-side writer
 * (see `scheduler-service.ts` / `bootstrap.ts`); tests inject an in-memory
 * implementation. No method may enqueue an outbound pointer: applying a remote
 * change must not echo it back to the server.
 */
export interface SyncApplyWriter {
  /** Append remote attempts (idempotent by `attemptId`) and rebuild affected schedules. */
  applyAttempts(
    records: readonly AttemptRecord[],
  ): Promise<{ applied: number; duplicates: number }>;

  getCollection(collectionId: string): CollectionRecord | undefined;
  loadCollectionSyncState(collectionId: string): Promise<CollectionSyncState | undefined>;
  saveCollectionSyncState(state: CollectionSyncState): Promise<void>;
  saveCollection(record: CollectionRecord): Promise<void>;
  deleteCollection(collectionId: string): Promise<void>;

  getWoodpeckerSet(setId: string): WoodpeckerSetRecord | undefined;
  saveWoodpeckerSet(record: WoodpeckerSetRecord): Promise<void>;
  getWoodpeckerCycle(cycleId: string): { cycleId: string; cycle: WoodpeckerCycle } | undefined;
  saveWoodpeckerCycle(cycleId: string, cycle: WoodpeckerCycle): Promise<void>;
  nextWoodpeckerCycleNumber(setId: string): number;

  loadSettingSyncState(recordId: string): Promise<SettingSyncState | undefined>;
  saveSettings(
    recordId: string,
    values: Record<string, unknown>,
    state: SettingSyncState,
  ): Promise<void>;

  loadUserPuzzleSyncState(puzzleId: string): Promise<UserPuzzleSyncState | undefined>;
  saveUserPuzzle(puzzle: NormalizedPuzzle, state: UserPuzzleSyncState): Promise<void>;
  /**
   * Remove a synced user puzzle (a remote tombstone). Follows local removal
   * semantics: the puzzle content and its derived schedules only; raw attempt
   * history and every other record are untouched. The LWW stamp is persisted so
   * an older re-delivery cannot resurrect the puzzle.
   */
  removeUserPuzzle(puzzleId: string, state: UserPuzzleSyncState): Promise<void>;
  findPuzzle(puzzleId: string): NormalizedPuzzle | undefined;
}

/** Injectable merge helpers, so tests can assert dispatch without the real rules. */
export interface SyncApplyMergeHelpers {
  collection(local: CollectionSyncState | undefined, payload: SyncCollectionPayload): CollectionSyncState;
  woodpeckerSet(
    local: WoodpeckerSetRecord | undefined,
    payload: SyncWoodpeckerPayload,
    createdAt?: number,
  ): WoodpeckerSetApply;
  woodpeckerCycle(
    local: WoodpeckerCycle | undefined,
    payload: SyncWoodpeckerPayload,
    cycleNumber?: number,
  ): WoodpeckerCycleApply;
  woodpeckerResult(
    cycle: WoodpeckerCycle,
    payload: SyncWoodpeckerResultPayload,
  ): WoodpeckerResultApply;
}

export interface SyncApplyDeps {
  writer: SyncApplyWriter;
  clock: () => number;
  /** Value-free error sink. Called once per skipped envelope. */
  onError?: (info: {
    type: SyncEntityType | string;
    recordId: string;
    reason: SyncApplySkipReason;
  }) => void;
  merge?: Partial<SyncApplyMergeHelpers>;
}

export interface ApplyChangesInput {
  changes: readonly SyncRecordEnvelope[];
  /** Cursor persisted before this batch. */
  cursor: number;
  deps: SyncApplyDeps;
}

const DEFAULT_MERGE: SyncApplyMergeHelpers = {
  collection: mergeCollectionPayload,
  woodpeckerSet: mergeWoodpeckerSet,
  woodpeckerCycle: mergeWoodpeckerCycle,
  woodpeckerResult: mergeWoodpeckerResult,
};

const KNOWN_TYPES: ReadonlySet<string> = new Set<SyncEntityType>([
  'attempt',
  'setting',
  'collection',
  'woodpecker',
  'woodpeckerResult',
  'userPuzzle',
]);

interface ApplyOneResult {
  outcome: SyncApplyRecordOutcome;
  reason?: SyncApplySkipReason;
}

// --- validation helpers -----------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Non-negative finite number, or a fallback (older payloads omit the field). */
function nonNegativeOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) && value >= 0 ? value : fallback;
}

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readAttemptPayload(payload: unknown): SyncAttemptPayload {
  require(isRecord(payload), 'attempt payload must be an object');
  require(isNonEmptyString(payload.attemptId), 'attemptId must be a non-empty string');
  require(isNonEmptyString(payload.programId), 'programId must be a non-empty string');
  require(isNonEmptyString(payload.puzzleId), 'puzzleId must be a non-empty string');
  if (payload.collectionId !== undefined) {
    require(isNonEmptyString(payload.collectionId), 'collectionId must be a non-empty string');
  }
  if (payload.outcome !== undefined) {
    require(
      payload.outcome === 'success' || payload.outcome === 'failure',
      'outcome must be success or failure',
    );
  }
  require(isFiniteNumber(payload.startedAt), 'startedAt must be finite');
  if (payload.completedAt !== undefined) {
    require(isFiniteNumber(payload.completedAt), 'completedAt must be finite');
  }
  require(isRecord(payload.timing), 'timing must be an object');
  require(
    isFiniteNumber(payload.timing.activeSolvingSeconds) &&
      payload.timing.activeSolvingSeconds >= 0,
    'activeSolvingSeconds must be a non-negative finite number',
  );
  require(
    isFiniteNumber(payload.timing.correctionSeconds) && payload.timing.correctionSeconds >= 0,
    'correctionSeconds must be a non-negative finite number',
  );
  // Full timing segments are optional: older payloads omit them and readers
  // default `interruptionSeconds`/`hiddenSeconds` to 0 and trust the timing.
  if (payload.timing.interruptionSeconds !== undefined) {
    require(
      isFiniteNumber(payload.timing.interruptionSeconds) && payload.timing.interruptionSeconds >= 0,
      'interruptionSeconds must be a non-negative finite number',
    );
  }
  if (payload.timing.hiddenSeconds !== undefined) {
    require(
      isFiniteNumber(payload.timing.hiddenSeconds) && payload.timing.hiddenSeconds >= 0,
      'hiddenSeconds must be a non-negative finite number',
    );
  }
  if (payload.timing.timingTrustworthy !== undefined) {
    require(
      typeof payload.timing.timingTrustworthy === 'boolean',
      'timingTrustworthy must be a boolean',
    );
  }
  if (payload.events !== undefined) require(Array.isArray(payload.events), 'events must be an array');
  return payload as unknown as SyncAttemptPayload;
}

function readCollectionPayload(payload: unknown): SyncCollectionPayload {
  require(isRecord(payload), 'collection payload must be an object');
  require(isNonEmptyString(payload.collectionId), 'collectionId must be a non-empty string');
  require(typeof payload.name === 'string', 'name must be a string');
  require(isFiniteNumber(payload.updatedAt), 'updatedAt must be finite');
  require(isNonEmptyString(payload.updatedBy), 'updatedBy must be a non-empty string');
  if (payload.puzzleIds !== undefined) {
    require(
      Array.isArray(payload.puzzleIds) && payload.puzzleIds.every(isNonEmptyString),
      'puzzleIds must be a list of ids',
    );
  }
  if (payload.removedPuzzleIds !== undefined) {
    require(
      Array.isArray(payload.removedPuzzleIds) && payload.removedPuzzleIds.every(isNonEmptyString),
      'removedPuzzleIds must be a list of ids',
    );
  }
  if (payload.deleted !== undefined) require(typeof payload.deleted === 'boolean', 'deleted must be boolean');
  return payload as unknown as SyncCollectionPayload;
}

function readSettingPayload(payload: unknown): SyncSettingPayload {
  require(isRecord(payload), 'setting payload must be an object');
  require(isRecord(payload.values), 'setting values must be an object');
  require(isFiniteNumber(payload.updatedAt), 'setting updatedAt must be finite');
  require(isNonEmptyString(payload.updatedBy), 'setting updatedBy must be a non-empty string');
  return payload as unknown as SyncSettingPayload;
}

function readWoodpeckerPayload(payload: unknown): SyncWoodpeckerPayload {
  require(isRecord(payload), 'woodpecker payload must be an object');
  require(isNonEmptyString(payload.setId), 'setId must be a non-empty string');
  if (payload.cycleId !== undefined) {
    require(isNonEmptyString(payload.cycleId), 'cycleId must be a non-empty string');
  }
  require(
    isNonEmptyString(payload.sourceCollectionId) ||
      (payload.cycleId !== undefined && payload.sourceCollectionId === ''),
    'sourceCollectionId must be a non-empty string',
  );
  if (payload.puzzleIds !== undefined) {
    require(
      Array.isArray(payload.puzzleIds) && payload.puzzleIds.every(isNonEmptyString),
      'puzzleIds must be a list of ids',
    );
  }
  return payload as unknown as SyncWoodpeckerPayload;
}

function readWoodpeckerResultPayload(payload: unknown): SyncWoodpeckerResultPayload {
  require(isRecord(payload), 'woodpecker result payload must be an object');
  require(isNonEmptyString(payload.cycleId), 'cycleId must be a non-empty string');
  require(isNonEmptyString(payload.puzzleId), 'puzzleId must be a non-empty string');
  require(
    payload.result === 'clean' || payload.result === 'failed',
    'result must be clean or failed',
  );
  require(
    isFiniteNumber(payload.activeSeconds) && payload.activeSeconds >= 0,
    'activeSeconds must be a non-negative finite number',
  );
  return payload as unknown as SyncWoodpeckerResultPayload;
}

function readUserPuzzlePayload(payload: unknown): {
  payload: SyncUserPuzzlePayload;
  puzzle: NormalizedPuzzle | undefined;
} {
  require(isRecord(payload), 'user puzzle payload must be an object');
  require(isNonEmptyString(payload.puzzleId), 'puzzleId must be a non-empty string');
  require(isFiniteNumber(payload.updatedAt), 'updatedAt must be finite');
  if (payload.deleted !== undefined) {
    require(typeof payload.deleted === 'boolean', 'deleted must be boolean');
  }
  // A tombstone carries no content: LWW decides whether the puzzle is removed.
  if (payload.deleted === true) {
    return { payload: payload as unknown as SyncUserPuzzlePayload, puzzle: undefined };
  }
  require(isRecord(payload.puzzle), 'puzzle content must be an object');
  const puzzle = payload.puzzle as Record<string, unknown>;
  require(puzzle.id === payload.puzzleId, 'puzzle id must match puzzleId');
  require(isNonEmptyString(puzzle.contentSchemaVersion), 'contentSchemaVersion is required');
  require(isFiniteNumber(puzzle.rating), 'rating must be finite');
  require(isNonEmptyString(puzzle.source), 'source is required');
  require(isNonEmptyString(puzzle.sourceId), 'sourceId is required');
  require(Array.isArray(puzzle.themes), 'themes must be an array');
  require(typeof puzzle.sourceFen === 'string', 'sourceFen must be a string');
  require(typeof puzzle.solverFen === 'string', 'solverFen must be a string');
  require(
    puzzle.solverColor === 'white' || puzzle.solverColor === 'black',
    'solverColor must be white or black',
  );
  require(
    Array.isArray(puzzle.solution) && puzzle.solution.every(isNonEmptyString),
    'solution must be a list of moves',
  );
  require(isRecord(puzzle.originalFields), 'originalFields must be an object');
  return {
    payload: payload as unknown as SyncUserPuzzlePayload,
    puzzle: puzzle as unknown as NormalizedPuzzle,
  };
}

// --- merge-state helpers ----------------------------------------------------

/**
 * ONL-017: normalize the wire `rev` the way the server does — a missing,
 * non-finite or non-positive value reads as `0`, so an envelope sealed by an
 * older client is ordered exactly as before.
 */
function envelopeRev(envelope: SyncRecordEnvelope): number {
  const value = envelope.rev;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * ONL-017 LWW comparison shared by settings, user puzzles and the collection
 * name/deleted stamps: newer `updatedAt` wins, then higher `rev`, then the
 * lexicographically larger `updatedBy`. Mirrors the server's
 * `winsLastWriteWins` (`services/sync-worker/src/store.ts`).
 */
function isNewerRev(
  updatedAt: number,
  rev: number,
  updatedBy: string,
  currentAt: number,
  currentRev: number,
  currentBy: string,
): boolean {
  if (updatedAt !== currentAt) return updatedAt > currentAt;
  if (rev !== currentRev) return rev > currentRev;
  return updatedBy > currentBy;
}

/**
 * User-puzzle variant. A pre-ONL-017 stamp stores no device id, so no
 * deterministic device tie-break exists: an equal `(updatedAt, rev)` stays a
 * duplicate, exactly as the old `updatedAt`-only rule did.
 */
function isNewerUserPuzzle(
  updatedAt: number,
  rev: number,
  updatedBy: string,
  currentAt: number,
  currentRev: number,
  currentBy: string | undefined,
): boolean {
  if (updatedAt !== currentAt) return updatedAt > currentAt;
  if (rev !== currentRev) return rev > currentRev;
  if (currentBy === undefined) return false;
  return updatedBy > currentBy;
}

/** Read a collection's name LWW rev, defaulting a missing/legacy value to 0. */
function collectionNameRev(state: CollectionSyncState): number {
  const rev = (state as CollectionSyncStateRevs).nameRev;
  return typeof rev === 'number' && Number.isFinite(rev) && rev > 0 ? rev : 0;
}

/** Read a collection's deleted LWW rev, defaulting a missing/legacy value to 0. */
function collectionDeletedRev(state: CollectionSyncState): number {
  const rev = (state as CollectionSyncStateRevs).deletedRev;
  return typeof rev === 'number' && Number.isFinite(rev) && rev > 0 ? rev : 0;
}

/**
 * ONL-017: re-resolve a collection's name and deleted LWW with the wire `rev`.
 *
 * The pure ONL-007 merge (`collections.ts`) compares `(updatedAt, updatedBy)`
 * only, so a same-millisecond edit from the same device ties there and is
 * dropped. This re-decides *only* name and deleted using the wire
 * `(updatedAt, rev, updatedBy)` and carries the winning revs forward; membership
 * keeps the pure merge's `addedAt`/`removedAt` tombstone semantics untouched.
 */
function withCollectionRevOrdering(
  merged: CollectionSyncState,
  baseline: CollectionSyncState | undefined,
  payload: SyncCollectionPayload,
  incomingRev: number,
): CollectionSyncState & CollectionSyncStateRevs {
  const current = baseline ?? merged;
  const baseNameRev = collectionNameRev(current);
  const baseDeletedRev = collectionDeletedRev(current);
  const nameWins = isNewerRev(
    payload.updatedAt,
    incomingRev,
    payload.updatedBy,
    current.nameUpdatedAt,
    baseNameRev,
    current.nameUpdatedBy,
  );
  const deletedWins = isNewerRev(
    payload.updatedAt,
    incomingRev,
    payload.updatedBy,
    current.deletedUpdatedAt,
    baseDeletedRev,
    current.deletedUpdatedBy,
  );
  return {
    collectionId: merged.collectionId,
    name: nameWins ? payload.name : current.name,
    nameUpdatedAt: nameWins ? payload.updatedAt : current.nameUpdatedAt,
    nameUpdatedBy: nameWins ? payload.updatedBy : current.nameUpdatedBy,
    nameRev: nameWins ? incomingRev : baseNameRev,
    puzzleIds: merged.puzzleIds,
    tombstones: merged.tombstones,
    addedAt: merged.addedAt,
    deletedAt: deletedWins
      ? payload.deleted === true
        ? payload.updatedAt
        : undefined
      : current.deletedAt,
    deletedUpdatedAt: deletedWins ? payload.updatedAt : current.deletedUpdatedAt,
    deletedUpdatedBy: deletedWins ? payload.updatedBy : current.deletedUpdatedBy,
    deletedRev: deletedWins ? incomingRev : baseDeletedRev,
  };
}

/**
 * Best-effort merge state for a collection that exists locally but predates
 * inbound sync (or was created before merge bookkeeping was stored). Its only
 * timestamps are `createdAt`, which is the most honest baseline available.
 */
function collectionStateFromRecord(record: CollectionRecord): CollectionSyncState {
  return {
    collectionId: record.id,
    name: record.name,
    nameUpdatedAt: record.createdAt,
    nameUpdatedBy: '',
    puzzleIds: new Set(record.puzzleIds),
    tombstones: new Map(),
    addedAt: new Map(record.puzzleIds.map((id) => [id, record.createdAt] as [string, number])),
    deletedAt: undefined,
    deletedUpdatedAt: record.createdAt,
    deletedUpdatedBy: '',
  };
}

function numbersEqual(a: number | undefined, b: number | undefined): boolean {
  return a === b;
}

function mapsEqual<K>(a: ReadonlyMap<K, number>, b: ReadonlyMap<K, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function collectionStatesEqual(a: CollectionSyncState, b: CollectionSyncState): boolean {
  return (
    a.collectionId === b.collectionId &&
    a.name === b.name &&
    a.nameUpdatedAt === b.nameUpdatedAt &&
    a.nameUpdatedBy === b.nameUpdatedBy &&
    collectionNameRev(a) === collectionNameRev(b) &&
    setsEqual(a.puzzleIds, b.puzzleIds) &&
    mapsEqual(a.tombstones, b.tombstones) &&
    mapsEqual(a.addedAt, b.addedAt) &&
    numbersEqual(a.deletedAt, b.deletedAt) &&
    a.deletedUpdatedAt === b.deletedUpdatedAt &&
    a.deletedUpdatedBy === b.deletedUpdatedBy &&
    collectionDeletedRev(a) === collectionDeletedRev(b)
  );
}

function cyclesEqual(a: WoodpeckerCycle, b: WoodpeckerCycle): boolean {
  if (
    a.setId !== b.setId ||
    a.cycleNumber !== b.cycleNumber ||
    a.startedAt !== b.startedAt ||
    !numbersEqual(a.completedAt, b.completedAt) ||
    a.puzzleIds.length !== b.puzzleIds.length ||
    a.results.length !== b.results.length
  ) {
    return false;
  }
  for (let i = 0; i < a.puzzleIds.length; i += 1) {
    if (a.puzzleIds[i] !== b.puzzleIds[i]) return false;
  }
  for (let i = 0; i < a.results.length; i += 1) {
    const left = a.results[i]!;
    const right = b.results[i]!;
    if (
      left.puzzleId !== right.puzzleId ||
      left.result !== right.result ||
      left.activeSeconds !== right.activeSeconds
    ) {
      return false;
    }
  }
  return true;
}

/** Materialise a merged collection state back into the domain record. */
function collectionRecordFromState(
  state: CollectionSyncState,
  createdAt: number,
): CollectionRecord {
  return {
    id: state.collectionId,
    name: state.name,
    puzzleIds: [...state.puzzleIds].filter((id) => !state.tombstones.has(id)).sort(),
    createdAt,
  };
}

/** Convert an attempt payload into the raw history record the service stores. */
function attemptRecordFromPayload(
  payload: SyncAttemptPayload,
  puzzle: NormalizedPuzzle | undefined,
): AttemptRecord {
  const contentHash = puzzle
    ? `${puzzle.id}:${puzzle.contentSchemaVersion}:${puzzle.solverFen}`
    : `${payload.puzzleId}:sync`;
  return {
    attemptSchemaVersion: '1.0.0',
    attemptId: { value: payload.attemptId },
    progressKey: {
      programId: payload.programId,
      puzzleId: payload.puzzleId,
      ...(payload.collectionId !== undefined ? { collectionId: payload.collectionId } : {}),
    },
    sessionId: 'sync',
    scheduleRevisionBefore: 0,
    contentHash,
    startingFen: puzzle?.solverFen ?? '',
    ...(payload.outcome !== undefined ? { outcome: payload.outcome } : {}),
    // Full timing segments round-trip; older payloads default to uninterrupted
    // and trustworthy, which is the common case.
    timing: {
      activeSolvingSeconds: payload.timing.activeSolvingSeconds,
      correctionSeconds: payload.timing.correctionSeconds,
      interruptionSeconds: nonNegativeOr(payload.timing.interruptionSeconds, 0),
      hiddenSeconds: nonNegativeOr(payload.timing.hiddenSeconds, 0),
      timingTrustworthy: payload.timing.timingTrustworthy !== false,
    },
    events: Array.isArray(payload.events) ? (payload.events as AttemptEvent[]) : [],
    startedAt: payload.startedAt,
    ...(payload.completedAt !== undefined ? { completedAt: payload.completedAt } : {}),
    settingsHash: 'sync',
  };
}

// --- per-record dispatch ----------------------------------------------------

async function applyOne(
  envelope: SyncRecordEnvelope,
  deps: SyncApplyDeps,
  helpers: SyncApplyMergeHelpers,
): Promise<ApplyOneResult> {
  if (!isRecord(envelope)) return { outcome: 'skipped', reason: 'unreadable_or_invalid' };
  if (!KNOWN_TYPES.has(envelope.type)) {
    return { outcome: 'skipped', reason: 'unsupported_type' };
  }
  if (!isNonEmptyString(envelope.recordId)) {
    return { outcome: 'skipped', reason: 'unreadable_or_invalid' };
  }
  let payload: unknown;
  try {
    payload = await openRecord<unknown>(envelope);
  } catch {
    return { outcome: 'skipped', reason: 'unreadable_or_invalid' };
  }

  const { writer } = deps;

  switch (envelope.type) {
    case 'attempt': {
      const attempt = readAttemptPayload(payload);
      const record = attemptRecordFromPayload(attempt, writer.findPuzzle(attempt.puzzleId));
      const result = await writer.applyAttempts([record]);
      return { outcome: result.applied > 0 ? 'applied' : 'duplicate' };
    }

    case 'collection': {
      // The Worker orders mutable envelopes by their signed top-level timestamp.
      // Do not trust the nested timestamp for conflict resolution: older clients
      // could populate it from immutable collection.createdAt.
      const collection = { ...readCollectionPayload(payload), updatedAt: envelope.updatedAt };
      const localRecord = writer.getCollection(collection.collectionId);
      const localState = await writer.loadCollectionSyncState(collection.collectionId);
      const baseline = localState ?? (localRecord ? collectionStateFromRecord(localRecord) : undefined);
      const merged = helpers.collection(baseline, collection);
      // ONL-017: re-decide name/deleted with the wire `rev`; membership is the
      // pure merge's (ONL-007 tombstone/re-add semantics stay intact).
      const next = withCollectionRevOrdering(merged, baseline, collection, envelopeRev(envelope));
      const changed = localState === undefined || !collectionStatesEqual(localState, next);
      if (!changed) return { outcome: 'duplicate' };

      // Domain first, bookkeeping second: a crash between the two leaves the
      // visible record correct and a retry can still persist the merge state.
      if (next.deletedAt !== undefined) {
        await writer.deleteCollection(next.collectionId);
      } else {
        const createdAt = localRecord?.createdAt ?? collection.updatedAt;
        await writer.saveCollection(collectionRecordFromState(next, createdAt));
      }
      await writer.saveCollectionSyncState(next);
      return { outcome: 'applied' };
    }

    case 'woodpecker': {
      const woodpecker = readWoodpeckerPayload(payload);
      if (woodpecker.cycleId !== undefined) {
        const existing = writer.getWoodpeckerCycle(woodpecker.cycleId);
        const cycleNumber =
          existing?.cycle.cycleNumber ?? writer.nextWoodpeckerCycleNumber(woodpecker.setId);
        const merged = helpers.woodpeckerCycle(existing?.cycle, woodpecker, cycleNumber);
        if (!merged.created && existing && cyclesEqual(existing.cycle, merged.cycle)) {
          return { outcome: 'duplicate' };
        }
        await writer.saveWoodpeckerCycle(woodpecker.cycleId, merged.cycle);
        return { outcome: 'applied' };
      }

      const existing = writer.getWoodpeckerSet(woodpecker.setId);
      const merged = helpers.woodpeckerSet(
        existing,
        woodpecker,
        woodpecker.startedAt ?? deps.clock(),
      );
      if (!merged.created) return { outcome: 'duplicate' };
      await writer.saveWoodpeckerSet(merged.record);
      return { outcome: 'applied' };
    }

    case 'woodpeckerResult': {
      const resultPayload = readWoodpeckerResultPayload(payload);
      const existing = writer.getWoodpeckerCycle(resultPayload.cycleId);
      if (!existing) throw new Error('woodpecker cycle is not available yet');
      const merged = helpers.woodpeckerResult(existing.cycle, resultPayload);
      if (!merged.applied) return { outcome: 'duplicate' };
      await writer.saveWoodpeckerCycle(resultPayload.cycleId, merged.cycle);
      return { outcome: 'applied' };
    }

    case 'setting': {
      const setting = readSettingPayload(payload);
      const local = await writer.loadSettingSyncState(envelope.recordId);
      const incomingRev = envelopeRev(envelope);
      if (
        local &&
        !isNewerRev(
          setting.updatedAt,
          incomingRev,
          setting.updatedBy,
          local.updatedAt,
          local.rev ?? 0,
          local.updatedBy,
        )
      ) {
        return { outcome: 'duplicate' };
      }
      await writer.saveSettings(envelope.recordId, setting.values, {
        updatedAt: setting.updatedAt,
        updatedBy: setting.updatedBy,
        rev: incomingRev,
      });
      return { outcome: 'applied' };
    }

    case 'userPuzzle': {
      const { payload: puzzlePayload, puzzle } = readUserPuzzlePayload(payload);
      const local = await writer.loadUserPuzzleSyncState(puzzlePayload.puzzleId);
      const incomingRev = envelopeRev(envelope);
      // A user-puzzle payload carries no `updatedBy`; the signed envelope's
      // `deviceId` is the device that produced it (mirrors the server rule).
      const incomingBy = typeof envelope.deviceId === 'string' ? envelope.deviceId : '';
      if (
        local &&
        !isNewerUserPuzzle(
          puzzlePayload.updatedAt,
          incomingRev,
          incomingBy,
          local.updatedAt,
          local.rev ?? 0,
          local.updatedBy,
        )
      ) {
        return { outcome: 'duplicate' };
      }
      const state: UserPuzzleSyncState = {
        updatedAt: puzzlePayload.updatedAt,
        rev: incomingRev,
        updatedBy: incomingBy,
      };
      if (puzzlePayload.deleted === true) {
        await writer.removeUserPuzzle(puzzlePayload.puzzleId, state);
        return { outcome: 'applied' };
      }
      await writer.saveUserPuzzle(puzzle!, state);
      return { outcome: 'applied' };
    }

    default:
      return { outcome: 'skipped', reason: 'unsupported_type' };
  }
}

/**
 * Verify, decrypt and apply a batch of server changes.
 *
 * Records are applied independently. A skipped record is counted and reported
 * but does not abort the batch; the returned cursor stops before the first
 * skipped record so it is retried next time. Duplicate records (already present
 * locally) count as progress for the cursor because there is nothing left to do
 * for them.
 */
export async function applyChanges(input: ApplyChangesInput): Promise<SyncApplyResult> {
  const deps = input.deps;
  const helpers: SyncApplyMergeHelpers = { ...DEFAULT_MERGE, ...(deps.merge ?? {}) };
  let applied = 0;
  let skipped = 0;
  let duplicates = 0;
  let cursor = isFiniteNumber(input.cursor) && input.cursor >= 0 ? input.cursor : 0;
  let blocked = false;
  // Highest cursor value the batch may safely return: one below the lowest
  // skipped sequence. Computed defensively so an out-of-order batch can never
  // move the cursor past a record that failed to apply.
  let ceiling = Number.POSITIVE_INFINITY;

  for (const envelope of input.changes) {
    let result: ApplyOneResult;
    try {
      result = await applyOne(envelope, deps, helpers);
    } catch {
      result = { outcome: 'skipped', reason: 'apply_failed' };
    }

    if (result.outcome === 'skipped') {
      skipped += 1;
      blocked = true;
      if (isFiniteNumber(envelope.seq)) ceiling = Math.min(ceiling, envelope.seq - 1);
      deps.onError?.({
        type: isRecord(envelope) && typeof envelope.type === 'string' ? envelope.type : 'unknown',
        recordId:
          isRecord(envelope) && typeof envelope.recordId === 'string' ? envelope.recordId : '',
        reason: result.reason ?? 'apply_failed',
      });
      continue;
    }

    if (result.outcome === 'duplicate') duplicates += 1;
    else applied += 1;

    if (
      !blocked &&
      isFiniteNumber(envelope.seq) &&
      envelope.seq > cursor
    ) {
      cursor = envelope.seq;
    }
  }

  if (ceiling !== Number.POSITIVE_INFINITY) {
    cursor = Math.max(0, Math.min(cursor, ceiling));
  }

  return { applied, skipped, duplicates, cursor };
}
