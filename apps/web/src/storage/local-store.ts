/**
 * Versioned local domain store (T10).
 *
 * Wraps a StorageBackend with typed collections and schema-version envelopes.
 * Derived schedule state (SchedulerState) is stored separately from raw attempt
 * history so history can outlive scheduler changes, per T03/D09.
 */

import type { Clock, SchedulerState, WoodpeckerCycle, WoodpeckerSetRecord } from '@chessengram/scheduler';
import { systemClock } from '@chessengram/scheduler';
import type {
  AttemptRecord,
  ContentSchemaVersion,
  NormalizedPuzzle,
  SessionState,
} from '@chessengram/contracts';
import type {
  SyncEntityType,
  SyncKeyStorage,
  SyncQueueEntry,
  SyncQueueStorage,
  SyncSecrets,
  SyncState,
  SyncStateStorage,
} from '../sync/types.ts';
import type { CollectionSyncState } from '../sync/collections.ts';
import type { StorageBackend } from './backend.ts';

export const COLLECTION_CONTENT = 'content';
export const COLLECTION_SCHEDULES = 'schedules';
export const COLLECTION_ATTEMPTS = 'attempts';
export const COLLECTION_SESSIONS = 'sessions';
export const COLLECTION_META = 'meta';
/**
 * Static puzzle sets with multi-membership (B4, user decision 2026-10-15).
 * One puzzle may live in many collections; schedule progress is scoped per
 * (program, collection, puzzle) so the same puzzle trains independently in
 * each collection. Deleting a collection removes only the membership list —
 * puzzles, schedules and raw attempt history are kept.
 */
export const COLLECTION_COLLECTIONS = 'collections';
export const COLLECTION_SETTINGS = 'settings';
/** Durable Woodpecker set snapshots and cycle results (F01). */
export const COLLECTION_WOODPECKER = 'woodpecker';
/** Pre-import recovery snapshots. Deliberately excluded from exports/imports. */
export const COLLECTION_BACKUPS = 'backups';
/**
 * Opt-in sync queue pointers + sync state (ONL-001). Unlike {@link COLLECTION_BACKUPS}
 * it is a normal exported/imported collection (export format 1.3.0) so a device can
 * move its queue and state with its data; it is never used as a recovery snapshot.
 */
export const COLLECTION_SYNC = 'sync';
/**
 * Device-local sync state that must never travel: the per-device P-256 signing
 * keypair (ONL-011) and the `rev` counter (ONL-016). Deliberately **not** part of
 * {@link STORE_COLLECTIONS}: this collection must never appear in exports,
 * imports or pre-import recovery snapshots, because the private signing key must
 * never leave the device that generated it. There is no master key any more
 * (ONL-020 removed the key model). It is still ordinary local persistence, so a
 * reload keeps the device syncing offline.
 */
export const COLLECTION_SYNC_SECRETS = 'sync-secrets';

/** Collections that make up a full data export, in restore-safe order. */
export const STORE_COLLECTIONS = [
  COLLECTION_CONTENT,
  COLLECTION_SCHEDULES,
  COLLECTION_ATTEMPTS,
  COLLECTION_SESSIONS,
  COLLECTION_SETTINGS,
  COLLECTION_WOODPECKER,
  COLLECTION_COLLECTIONS,
  COLLECTION_SYNC,
  COLLECTION_META,
] as const;

export type StoreCollection = (typeof STORE_COLLECTIONS)[number];

export const META_CONTENT_SET = 'content-set';
export const META_PUZZLE_ORDER = 'puzzle-order';
export const META_ACTIVE_SESSIONS = 'active-sessions';
/** Persisted id of the active (training) collection; defaults when absent. */
export const META_ACTIVE_COLLECTION = 'active-collection';
/**
 * Pack id of the bundled rating-band collections already seeded (F02). A plain
 * meta value in the existing `meta` collection — no new store or schema. It
 * makes band seeding idempotent per pack, so a deliberately deleted band
 * collection is not silently recreated on the next boot.
 */
export const META_BUNDLED_BANDS = 'bundled-bands';

/**
 * Default collection id. The bundled pack is seeded into this collection so
 * first boot is unchanged, and legacy `program:puzzle` schedules migrate
 * into this scope. Must stay stable: stored schedule keys embed it. (Re-exported
 * from scheduler-service.ts so existing import sites keep working.)
 */
export const DEFAULT_COLLECTION_ID = 'lichess-900-1099-v1';

/** Current schema version for the local store's own envelopes. */
export const LOCAL_STORE_SCHEMA_VERSION = '1.0.0';

/** Export file format marker and version (1.3.0 adds the opt-in sync collection). */
export const EXPORT_FORMAT = 'chessengram-export';
export const EXPORT_FORMAT_VERSION = '1.3.0';

/**
 * Expected persisted schema versions. These mirror the contract literal types
 * (@chessengram/contracts). A record whose envelope version does not
 * match is treated as absent so incompatible data is never silently loaded.
 */
export const EXPECTED_CONTENT_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_SCHEDULE_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_ATTEMPT_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_SESSION_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_SETTINGS_SCHEMA_VERSION = '1.0.0';
/** New in export 1.1.0 (B4). No earlier shape exists, so this starts at 1.0.0. */
export const EXPECTED_COLLECTION_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_WOODPECKER_SCHEMA_VERSION = '1.0.0';
/** New in export 1.3.0 (ONL-001). No earlier shape exists, so this starts at 1.0.0. */
export const EXPECTED_SYNC_SCHEMA_VERSION = '1.0.0';
/** Device-local secrets record version (ONL-011); never exported. */
export const EXPECTED_SYNC_SECRETS_SCHEMA_VERSION = '1.0.0';
/** Device-local `rev` counter record version (ONL-016); never exported. */
export const EXPECTED_SYNC_DEVICE_SCHEMA_VERSION = '1.0.0';

/**
 * Sync-collection record keys. Queue pointers are keyed by
 * `type + SEP + recordId`; the single state record uses a fixed, separator-free
 * key so the two can never collide when enumerating the collection.
 */
export const SYNC_STATE_KEY = 'state';
/**
 * There is exactly one secrets record per device. A fixed key keeps the read a
 * point lookup and makes accidental enumeration impossible.
 */
export const SYNC_SECRETS_KEY = 'device';
/**
 * Per-device monotonic `rev` counter (ONL-016), persisted in the same
 * non-exported {@link COLLECTION_SYNC_SECRETS} collection as the device signing
 * key, but under its own key. It is deliberately **not** in the exported
 * {@link COLLECTION_SYNC}/`SyncState`: a counter that travelled with an export
 * or sync could be shared by two devices and reintroduce same-device ties.
 * The key is distinct from {@link SYNC_SECRETS_KEY} so the two records never
 * overwrite each other.
 */
export const SYNC_DEVICE_KEY = 'device-state';
const SYNC_QUEUE_SEP = '\u0000';

function syncQueueKey(type: SyncEntityType, recordId: string): string {
  return `${type}${SYNC_QUEUE_SEP}${recordId}`;
}

/**
 * Inbound merge bookkeeping (ONL-012) lives beside the queue in the existing
 * `sync` collection, under keys that can never collide with a queue pointer
 * (`type + NUL + recordId`). It is deliberately *not* a new collection or
 * schema version: it travels with the already-exported sync collection and
 * `loadSyncQueueEntries` skips it.
 */
const SYNC_MERGE_SEP = '\u0001';
/** Prefix reserved for merge-state records; never a valid `SyncEntityType`. */
export const SYNC_MERGE_PREFIX = `merge${SYNC_MERGE_SEP}`;

function syncMergeKey(kind: string, id: string): string {
  return `${SYNC_MERGE_PREFIX}${kind}${SYNC_MERGE_SEP}${id}`;
}

/** LWW metadata for a synced setting group (inbound merge only). */
export interface SettingSyncState {
  updatedAt: number;
  updatedBy: string;
  /**
   * ONL-017: wire `rev` of the winning edit. Ordering is `(updatedAt, rev,
   * updatedBy)`, mirroring the server. Optional so a stamp written before
   * ONL-017 (or by an older client) stays valid; a missing value reads as 0.
   */
  rev?: number;
}

/** LWW metadata for an inbound user puzzle (the content carries no timestamp). */
export interface UserPuzzleSyncState {
  updatedAt: number;
  /**
   * ONL-017: wire `rev` of the winning edit; a missing value reads as 0.
   */
  rev?: number;
  /**
   * ONL-017: device id of the winning edit (the envelope's `deviceId`; a user
   * puzzle payload carries no `updatedBy`). Absent on pre-ONL-017 stamps, which
   * then cannot tie-break by device and keep the pre-ONL-017 behaviour.
   */
  updatedBy?: string;
}

/**
 * ONL-017: the wire `rev` carried alongside a collection's name/deleted LWW
 * stamps. Deliberately a separate optional shape rather than a field on the
 * frozen ONL-007 {@link CollectionSyncState}: the pure merge rules stay
 * untouched, while readers default a missing value to 0.
 */
export interface CollectionSyncStateRevs {
  nameRev?: number;
  deletedRev?: number;
}

/**
 * Device-local monotonic revision counter (ONL-016). One counter per device,
 * incremented for every sealed record and stored outside the export set.
 */
export interface SyncDeviceState {
  rev: number;
}

/**
 * Plain, JSON/structured-clone-safe form of {@link CollectionSyncState}. The
 * in-memory merge state uses `Set`/`Map` (great for merging, poor for export),
 * so persistence always goes through this shape.
 */
interface StoredCollectionSyncState {
  collectionId: string;
  name: string;
  nameUpdatedAt: number;
  nameUpdatedBy: string;
  nameRev?: number;
  puzzleIds: string[];
  tombstones: Array<[string, number]>;
  addedAt: Array<[string, number]>;
  deletedAt?: number;
  deletedUpdatedAt: number;
  deletedUpdatedBy: string;
  deletedRev?: number;
}

function storeCollectionSyncState(state: CollectionSyncState): StoredCollectionSyncState {
  const revs = state as CollectionSyncStateRevs;
  const nameRev = isNumber(revs.nameRev) ? revs.nameRev : undefined;
  const deletedRev = isNumber(revs.deletedRev) ? revs.deletedRev : undefined;
  return {
    collectionId: state.collectionId,
    name: state.name,
    nameUpdatedAt: state.nameUpdatedAt,
    nameUpdatedBy: state.nameUpdatedBy,
    ...(nameRev !== undefined ? { nameRev } : {}),
    puzzleIds: [...state.puzzleIds],
    tombstones: [...state.tombstones.entries()],
    addedAt: [...state.addedAt.entries()],
    ...(state.deletedAt !== undefined ? { deletedAt: state.deletedAt } : {}),
    deletedUpdatedAt: state.deletedUpdatedAt,
    deletedUpdatedBy: state.deletedUpdatedBy,
    ...(deletedRev !== undefined ? { deletedRev } : {}),
  };
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPairArray(value: unknown): value is Array<[string, number]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) && entry.length === 2 && isString(entry[0]) && isNumber(entry[1]),
    )
  );
}

/** Rebuild the Set/Map merge state, rejecting anything structurally invalid. */
function readCollectionSyncState(
  raw: unknown,
): (CollectionSyncState & CollectionSyncStateRevs) | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Partial<StoredCollectionSyncState>;
  if (
    !isString(value.collectionId) ||
    typeof value.name !== 'string' ||
    !isNumber(value.nameUpdatedAt) ||
    typeof value.nameUpdatedBy !== 'string' ||
    !Array.isArray(value.puzzleIds) ||
    !value.puzzleIds.every(isString) ||
    !isPairArray(value.tombstones) ||
    !isPairArray(value.addedAt) ||
    !isNumber(value.deletedUpdatedAt) ||
    typeof value.deletedUpdatedBy !== 'string' ||
    (value.deletedAt !== undefined && !isNumber(value.deletedAt))
  ) {
    return undefined;
  }
  return {
    collectionId: value.collectionId,
    name: value.name,
    nameUpdatedAt: value.nameUpdatedAt,
    nameUpdatedBy: value.nameUpdatedBy,
    // ONL-017 revs are optional; a pre-ONL-017 stamp simply has neither.
    ...(isNumber(value.nameRev) ? { nameRev: value.nameRev } : {}),
    puzzleIds: new Set(value.puzzleIds),
    tombstones: new Map(value.tombstones),
    addedAt: new Map(value.addedAt),
    deletedAt: value.deletedAt,
    deletedUpdatedAt: value.deletedUpdatedAt,
    deletedUpdatedBy: value.deletedUpdatedBy,
    ...(isNumber(value.deletedRev) ? { deletedRev: value.deletedRev } : {}),
  };
}

export interface Envelope<T> {
  /** Version of the persisted record shape. */
  schemaVersion: string;
  /** When the record was written (epoch ms). */
  savedAt: number;
  /** Original domain value. */
  data: T;
}

export interface ContentSetMeta {
  packId: string;
  contentSchemaVersion: ContentSchemaVersion;
  count: number;
  loadedAt: number;
}

/** Static puzzle set (B4). Membership is a list of puzzle ids; puzzles may repeat across collections. */
export interface CollectionRecord {
  id: string;
  name: string;
  puzzleIds: string[];
  createdAt: number;
}

/**
 * Self-describing, lossless snapshot of every persisted collection. Values are
 * the raw on-disk envelopes (schemaVersion + savedAt + data) so a restore is
 * byte-faithful and per-record versions stay intact.
 */
export interface StoreExport {
  format: typeof EXPORT_FORMAT;
  formatVersion: string;
  exportedAt: number;
  backendKind: string;
  collections: Record<string, Record<string, unknown>>;
}

/** Per-collection record counts, used to preview an import before applying it. */
export interface StoreExportSummary {
  formatVersion: string;
  exportedAt: number;
  backendKind: string;
  counts: Record<string, number>;
  total: number;
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    'data' in value
  );
}

/** Defensive copy of a JWK: callers never share key material objects with the store. */
function copyJwk(jwk: JsonWebKey): JsonWebKey {
  return { ...jwk };
}

/** Defensive copy of the device-local record (the signing keypair). */
function copySyncSecrets(secrets: SyncSecrets): SyncSecrets {
  return {
    devicePublicKeyJwk: copyJwk(secrets.devicePublicKeyJwk),
    devicePrivateKeyJwk: copyJwk(secrets.devicePrivateKeyJwk),
  };
}

export class LocalStore {
  private readonly backend: StorageBackend;
  private readonly clock: Clock;

  constructor(backend: StorageBackend, clock: Clock = systemClock) {
    this.backend = backend;
    this.clock = clock;
  }

  get backendKind(): string {
    return this.backend.kind;
  }

  private wrap<T>(schemaVersion: string, data: T): Envelope<T> {
    return { schemaVersion, savedAt: this.clock.now(), data };
  }

  private unwrap<T>(raw: unknown, expectedVersion: string): T | undefined {
    if (!isEnvelope(raw)) return undefined;
    if (raw.schemaVersion !== expectedVersion) return undefined;
    return raw.data as T;
  }

  // --- content ------------------------------------------------------------

  async savePuzzles(puzzles: readonly NormalizedPuzzle[]): Promise<void> {
    for (const puzzle of puzzles) {
      const version =
        (puzzle as { contentSchemaVersion?: string }).contentSchemaVersion ??
        EXPECTED_CONTENT_SCHEMA_VERSION;
      await this.backend.set(COLLECTION_CONTENT, puzzle.id, this.wrap(version, puzzle));
    }
  }

  async loadPuzzles(): Promise<NormalizedPuzzle[]> {
    const records = await this.backend.getAll(COLLECTION_CONTENT);
    const puzzles: NormalizedPuzzle[] = [];
    for (const record of records) {
      const puzzle = this.unwrap<NormalizedPuzzle>(record.value, EXPECTED_CONTENT_SCHEMA_VERSION);
      if (puzzle) puzzles.push(puzzle);
    }
    return puzzles;
  }

  async loadPuzzle(puzzleId: string): Promise<NormalizedPuzzle | undefined> {
    const raw = await this.backend.get(COLLECTION_CONTENT, puzzleId);
    if (!isEnvelope(raw)) return undefined;
    return this.unwrap<NormalizedPuzzle>(raw, EXPECTED_CONTENT_SCHEMA_VERSION);
  }

  async deletePuzzle(puzzleId: string): Promise<void> {
    await this.backend.delete(COLLECTION_CONTENT, puzzleId);
  }

  // --- scheduler state (derived) -----------------------------------------

  async saveSchedule(progressKey: string, state: SchedulerState): Promise<void> {
    await this.backend.set(
      COLLECTION_SCHEDULES,
      progressKey,
      this.wrap(state.schedule.scheduleSchemaVersion, state),
    );
  }

  async deleteSchedule(progressKey: string): Promise<void> {
    await this.backend.delete(COLLECTION_SCHEDULES, progressKey);
  }

  async loadSchedules(): Promise<Map<string, SchedulerState>> {
    const records = await this.backend.getAll(COLLECTION_SCHEDULES);
    const out = new Map<string, SchedulerState>();
    for (const record of records) {
      if (!isEnvelope(record.value)) continue;
      const state = this.unwrap<SchedulerState>(record.value, EXPECTED_SCHEDULE_SCHEMA_VERSION);
      if (state) out.set(record.key, state);
    }
    return out;
  }

  // --- attempts (raw history) --------------------------------------------

  async saveAttempt(attempt: AttemptRecord): Promise<void> {
    await this.backend.set(
      COLLECTION_ATTEMPTS,
      attempt.attemptId.value,
      this.wrap(attempt.attemptSchemaVersion, attempt),
    );
  }

  async loadAttempts(): Promise<AttemptRecord[]> {
    const records = await this.backend.getAll(COLLECTION_ATTEMPTS);
    const out: AttemptRecord[] = [];
    for (const record of records) {
      if (!isEnvelope(record.value)) continue;
      const attempt = this.unwrap<AttemptRecord>(record.value, EXPECTED_ATTEMPT_SCHEMA_VERSION);
      if (attempt) out.push(attempt);
    }
    return out;
  }

  // --- sessions -----------------------------------------------------------

  async saveSession(session: SessionState): Promise<void> {
    await this.backend.set(
      COLLECTION_SESSIONS,
      session.sessionId,
      this.wrap(session.sessionSchemaVersion, session),
    );
  }

  async loadSessions(): Promise<SessionState[]> {
    const records = await this.backend.getAll(COLLECTION_SESSIONS);
    const out: SessionState[] = [];
    for (const record of records) {
      if (!isEnvelope(record.value)) continue;
      const session = this.unwrap<SessionState>(record.value, EXPECTED_SESSION_SCHEMA_VERSION);
      if (session) out.push(session);
    }
    return out;
  }

  // --- collections (static sets, B4) ------------------------------------

  async saveCollection(collection: CollectionRecord): Promise<void> {
    await this.backend.set(
      COLLECTION_COLLECTIONS,
      collection.id,
      this.wrap(EXPECTED_COLLECTION_SCHEMA_VERSION, collection),
    );
  }

  async loadCollections(): Promise<CollectionRecord[]> {
    const records = await this.backend.getAll(COLLECTION_COLLECTIONS);
    const out: CollectionRecord[] = [];
    for (const record of records) {
      if (!isEnvelope(record.value)) continue;
      const collection = this.unwrap<CollectionRecord>(
        record.value,
        EXPECTED_COLLECTION_SCHEMA_VERSION,
      );
      if (collection) out.push(collection);
    }
    return out;
  }

  async deleteCollection(collectionId: string): Promise<void> {
    await this.backend.delete(COLLECTION_COLLECTIONS, collectionId);
  }

  // --- Woodpecker sets and cycles (F01) -----------------------------------

  async saveWoodpeckerSet(set: WoodpeckerSetRecord): Promise<void> {
    await this.backend.set(
      COLLECTION_WOODPECKER,
      `set:${set.setId}`,
      this.wrap(EXPECTED_WOODPECKER_SCHEMA_VERSION, { kind: 'set', ...set }),
    );
  }

  async loadWoodpeckerSets(): Promise<WoodpeckerSetRecord[]> {
    const records = await this.backend.getAll(COLLECTION_WOODPECKER);
    return records.flatMap((record) => {
      const value = this.unwrap<{ kind: string } & WoodpeckerSetRecord>(record.value, EXPECTED_WOODPECKER_SCHEMA_VERSION);
      return value?.kind === 'set' ? [{ ...value, puzzleIds: [...value.puzzleIds] }] : [];
    });
  }

  async saveWoodpeckerCycle(cycleId: string, cycle: WoodpeckerCycle): Promise<void> {
    await this.backend.set(
      COLLECTION_WOODPECKER,
      `cycle:${cycleId}`,
      this.wrap(EXPECTED_WOODPECKER_SCHEMA_VERSION, { kind: 'cycle', cycleId, ...cycle }),
    );
  }

  async loadWoodpeckerCycles(): Promise<Array<{ cycleId: string; cycle: WoodpeckerCycle }>> {
    const records = await this.backend.getAll(COLLECTION_WOODPECKER);
    return records.flatMap((record) => {
      const value = this.unwrap<{
        kind: string;
        cycleId: string;
        setId: string;
        cycleNumber: number;
        puzzleIds: string[];
        startedAt: number;
        completedAt?: number;
        results: WoodpeckerCycle['results'];
      }>(record.value, EXPECTED_WOODPECKER_SCHEMA_VERSION);
      if (!value || value.kind !== 'cycle') return [];
      const { kind: _kind, cycleId, ...cycle } = value;
      return [{ cycleId, cycle: { ...cycle, puzzleIds: [...cycle.puzzleIds], results: [...cycle.results] } }];
    });
  }

  // --- settings (curated scheduler preferences) --------------------------

  async saveSettings<T>(key: string, value: T): Promise<void> {
    await this.backend.set(COLLECTION_SETTINGS, key, this.wrap(EXPECTED_SETTINGS_SCHEMA_VERSION, value));
  }

  async loadSettings<T>(key: string): Promise<T | undefined> {
    const raw = await this.backend.get(COLLECTION_SETTINGS, key);
    return this.unwrap<T>(raw, EXPECTED_SETTINGS_SCHEMA_VERSION);
  }

  // --- meta ---------------------------------------------------------------

  async saveMeta<T>(key: string, value: T): Promise<void> {
    await this.backend.set(COLLECTION_META, key, this.wrap(LOCAL_STORE_SCHEMA_VERSION, value));
  }

  async loadMeta<T>(key: string): Promise<T | undefined> {
    const raw = await this.backend.get(COLLECTION_META, key);
    return this.unwrap<T>(raw, LOCAL_STORE_SCHEMA_VERSION);
  }

  // --- sync queue + state (ONL-001) ---------------------------------------

  /** Persist (or supersede) one queue pointer; values are copied defensively. */
  async saveSyncQueueEntry(entry: SyncQueueEntry): Promise<void> {
    await this.backend.set(
      COLLECTION_SYNC,
      syncQueueKey(entry.type, entry.recordId),
      this.wrap(EXPECTED_SYNC_SCHEMA_VERSION, {
        type: entry.type,
        recordId: entry.recordId,
        changedAt: entry.changedAt,
      }),
    );
  }

  /** Load every queue pointer (never the sync state record). */
  async loadSyncQueueEntries(): Promise<SyncQueueEntry[]> {
    const records = await this.backend.getAll(COLLECTION_SYNC);
    const out: SyncQueueEntry[] = [];
    for (const record of records) {
      if (record.key === SYNC_STATE_KEY) continue;
      if (record.key.startsWith(SYNC_MERGE_PREFIX)) continue;
      const entry = this.unwrap<SyncQueueEntry>(record.value, EXPECTED_SYNC_SCHEMA_VERSION);
      if (entry) out.push({ type: entry.type, recordId: entry.recordId, changedAt: entry.changedAt });
    }
    return out;
  }

  /** Drop one queue pointer on ack. */
  async deleteSyncQueueEntry(type: SyncEntityType, recordId: string): Promise<void> {
    await this.backend.delete(COLLECTION_SYNC, syncQueueKey(type, recordId));
  }

  /** Persist the single sync state record (cursor, device, user id). */
  async saveSyncState(state: SyncState): Promise<void> {
    await this.backend.set(
      COLLECTION_SYNC,
      SYNC_STATE_KEY,
      this.wrap(EXPECTED_SYNC_SCHEMA_VERSION, { ...state }),
    );
  }

  async loadSyncState(): Promise<SyncState | undefined> {
    const raw = await this.backend.get(COLLECTION_SYNC, SYNC_STATE_KEY);
    const state = this.unwrap<SyncState>(raw, EXPECTED_SYNC_SCHEMA_VERSION);
    return state ? { ...state } : undefined;
  }

  // --- inbound sync merge state (ONL-012) ---------------------------------
  //
  // Inbound merging needs a little history that the domain records do not
  // carry (collection tombstones / LWW stamps, setting LWW stamps, user-puzzle
  // timestamps). It is stored in the existing `sync` collection behind the
  // reserved {@link SYNC_MERGE_PREFIX}, so exports/imports keep working with no
  // schema change and queue enumeration never mistakes it for a pointer.

  async saveCollectionSyncState(state: CollectionSyncState): Promise<void> {
    await this.backend.set(
      COLLECTION_SYNC,
      syncMergeKey('collection', state.collectionId),
      this.wrap(EXPECTED_SYNC_SCHEMA_VERSION, storeCollectionSyncState(state)),
    );
  }

  async loadCollectionSyncState(collectionId: string): Promise<CollectionSyncState | undefined> {
    const raw = await this.backend.get(
      COLLECTION_SYNC,
      syncMergeKey('collection', collectionId),
    );
    const value = this.unwrap<unknown>(raw, EXPECTED_SYNC_SCHEMA_VERSION);
    return value === undefined ? undefined : readCollectionSyncState(value);
  }

  async saveSettingSyncState(recordId: string, state: SettingSyncState): Promise<void> {
    await this.backend.set(
      COLLECTION_SYNC,
      syncMergeKey('setting', recordId),
      this.wrap(EXPECTED_SYNC_SCHEMA_VERSION, {
        updatedAt: state.updatedAt,
        updatedBy: state.updatedBy,
        ...(isNumber(state.rev) ? { rev: state.rev } : {}),
      }),
    );
  }

  async loadSettingSyncState(recordId: string): Promise<SettingSyncState | undefined> {
    const raw = await this.backend.get(COLLECTION_SYNC, syncMergeKey('setting', recordId));
    const value = this.unwrap<SettingSyncState>(raw, EXPECTED_SYNC_SCHEMA_VERSION);
    if (!value || !isNumber(value.updatedAt) || typeof value.updatedBy !== 'string') {
      return undefined;
    }
    return {
      updatedAt: value.updatedAt,
      updatedBy: value.updatedBy,
      ...(isNumber(value.rev) ? { rev: value.rev } : {}),
    };
  }

  async saveUserPuzzleSyncState(puzzleId: string, state: UserPuzzleSyncState): Promise<void> {
    await this.backend.set(
      COLLECTION_SYNC,
      syncMergeKey('userPuzzle', puzzleId),
      this.wrap(EXPECTED_SYNC_SCHEMA_VERSION, {
        updatedAt: state.updatedAt,
        ...(isNumber(state.rev) ? { rev: state.rev } : {}),
        ...(typeof state.updatedBy === 'string' ? { updatedBy: state.updatedBy } : {}),
      }),
    );
  }

  async loadUserPuzzleSyncState(puzzleId: string): Promise<UserPuzzleSyncState | undefined> {
    const raw = await this.backend.get(COLLECTION_SYNC, syncMergeKey('userPuzzle', puzzleId));
    const value = this.unwrap<UserPuzzleSyncState>(raw, EXPECTED_SYNC_SCHEMA_VERSION);
    if (!value || !isNumber(value.updatedAt)) return undefined;
    return {
      updatedAt: value.updatedAt,
      ...(isNumber(value.rev) ? { rev: value.rev } : {}),
      ...(typeof value.updatedBy === 'string' ? { updatedBy: value.updatedBy } : {}),
    };
  }

  // --- device-local sync secrets (ONL-011, never exported) ----------------

  /** Persist the master key + device keypair; values are copied defensively. */
  async saveSyncSecrets(secrets: SyncSecrets): Promise<void> {
    await this.backend.set(
      COLLECTION_SYNC_SECRETS,
      SYNC_SECRETS_KEY,
      this.wrap(EXPECTED_SYNC_SECRETS_SCHEMA_VERSION, copySyncSecrets(secrets)),
    );
  }

  /** Load this device's secrets, or `undefined` when it has never unlocked. */
  async loadSyncSecrets(): Promise<SyncSecrets | undefined> {
    const raw = await this.backend.get(COLLECTION_SYNC_SECRETS, SYNC_SECRETS_KEY);
    const secrets = this.unwrap<SyncSecrets>(raw, EXPECTED_SYNC_SECRETS_SCHEMA_VERSION);
    return secrets ? copySyncSecrets(secrets) : undefined;
  }

  /** Forget this device's stored signing keypair (a fresh one is generated). */
  async deleteSyncSecrets(): Promise<void> {
    await this.backend.delete(COLLECTION_SYNC_SECRETS, SYNC_SECRETS_KEY);
  }

  // --- device-local rev counter (ONL-016, never exported) -----------------

  /**
   * Persist this device's monotonic `rev` counter. Lives beside the secrets in
   * the non-exported {@link COLLECTION_SYNC_SECRETS} collection so it can never
   * ride along with an export or reach the server through `SyncState`.
   */
  async saveSyncDeviceState(state: SyncDeviceState): Promise<void> {
    await this.backend.set(
      COLLECTION_SYNC_SECRETS,
      SYNC_DEVICE_KEY,
      this.wrap(EXPECTED_SYNC_DEVICE_SCHEMA_VERSION, { rev: state.rev }),
    );
  }

  /** Load this device's `rev` counter, or `undefined` when it has none yet. */
  async loadSyncDeviceState(): Promise<SyncDeviceState | undefined> {
    const raw = await this.backend.get(COLLECTION_SYNC_SECRETS, SYNC_DEVICE_KEY);
    const state = this.unwrap<SyncDeviceState>(raw, EXPECTED_SYNC_DEVICE_SCHEMA_VERSION);
    if (!state || !isNumber(state.rev) || state.rev < 0) return undefined;
    return { rev: state.rev };
  }

  /** Remove all persisted data (documented reset path). */
  async reset(): Promise<void> {
    await this.backend.clear();
  }

  // --- export / import (PB5 data safety) ---------------------------------

  /** Snapshot every persisted collection as a lossless, self-describing export. */
  async exportData(): Promise<StoreExport> {
    const collections: Record<string, Record<string, unknown>> = {};
    for (const collection of STORE_COLLECTIONS) {
      const records = await this.backend.getAll(collection);
      const map: Record<string, unknown> = {};
      for (const record of records) map[record.key] = record.value;
      collections[collection] = map;
    }
    return {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: this.clock.now(),
      backendKind: this.backend.kind,
      collections,
    };
  }

  /**
   * Replace the entire store with an already-validated, migrated export.
   * Callers MUST back up first (see `saveBackup`) — this clears each collection.
   */
  async applyExport(exported: StoreExport): Promise<void> {
    for (const collection of STORE_COLLECTIONS) await this.backend.clear(collection);
    for (const collection of STORE_COLLECTIONS) {
      const records = exported.collections[collection] ?? {};
      for (const [key, value] of Object.entries(records)) {
        await this.backend.set(collection, key, value);
      }
    }
  }

  /** Store a recovery snapshot of the current data (kept out of exports). */
  async saveBackup(snapshot: StoreExport, label: string): Promise<void> {
    await this.backend.set(
      COLLECTION_BACKUPS,
      label,
      this.wrap(LOCAL_STORE_SCHEMA_VERSION, snapshot),
    );
  }

  /** Load a previously stored recovery snapshot, if any. */
  async loadBackup(label: string): Promise<StoreExport | undefined> {
    const raw = await this.backend.get(COLLECTION_BACKUPS, label);
    return this.unwrap<StoreExport>(raw, LOCAL_STORE_SCHEMA_VERSION);
  }

  /** List available recovery snapshot labels, newest first when timestamped. */
  async listBackups(): Promise<string[]> {
    const records = await this.backend.getAll(COLLECTION_BACKUPS);
    return records.map((record) => record.key).sort().reverse();
  }
}

/** Inbound merge bookkeeping persisted beside the queue (ONL-012). */
export interface SyncMergeStorage {
  loadCollectionSyncState(collectionId: string): Promise<CollectionSyncState | undefined>;
  saveCollectionSyncState(state: CollectionSyncState): Promise<void>;
  loadSettingSyncState(recordId: string): Promise<SettingSyncState | undefined>;
  saveSettingSyncState(recordId: string, state: SettingSyncState): Promise<void>;
  loadUserPuzzleSyncState(puzzleId: string): Promise<UserPuzzleSyncState | undefined>;
  saveUserPuzzleSyncState(puzzleId: string, state: UserPuzzleSyncState): Promise<void>;
}

/**
 * Persistence adapter for the sync queue/state modules (ONL-001).
 *
 * Implements the frozen `SyncQueueStorage` + `SyncStateStorage` seams so the
 * queue and settings code never touches `LocalStore` (or IndexedDB) directly.
 * It also exposes the ONL-012 merge-state methods; extra methods are harmless
 * for callers typed against the frozen seams.
 */
export function syncStorage(
  store: LocalStore,
): SyncQueueStorage &
  SyncStateStorage &
  SyncMergeStorage & {
    loadRev(): Promise<number | undefined>;
    saveRev(rev: number): Promise<void>;
  } {
  return {
    list: () => store.loadSyncQueueEntries(),
    put: (entry) => store.saveSyncQueueEntry(entry),
    delete: (type, recordId) => store.deleteSyncQueueEntry(type, recordId),
    load: () => store.loadSyncState(),
    save: (state) => store.saveSyncState(state),
    loadCollectionSyncState: (collectionId) => store.loadCollectionSyncState(collectionId),
    saveCollectionSyncState: (state) => store.saveCollectionSyncState(state),
    loadSettingSyncState: (recordId) => store.loadSettingSyncState(recordId),
    saveSettingSyncState: (recordId, state) => store.saveSettingSyncState(recordId, state),
    loadUserPuzzleSyncState: (puzzleId) => store.loadUserPuzzleSyncState(puzzleId),
    saveUserPuzzleSyncState: (puzzleId, state) =>
      store.saveUserPuzzleSyncState(puzzleId, state),
    // ONL-016: the device-local `rev` counter rides the same seam so the app's
    // existing `syncStorage(store)` wiring persists it without extra plumbing.
    ...syncDeviceStorage(store),
  };
}

/**
 * Persistence adapter for the device-local monotonic `rev` counter (ONL-016).
 *
 * Like {@link syncKeyStorage}, it targets the non-exported
 * {@link COLLECTION_SYNC_SECRETS} collection so the counter never travels with
 * an export or a sync. `syncStorage` also exposes these methods, so the runtime
 * can pick them up from either seam.
 */
export function syncDeviceStorage(store: LocalStore): {
  loadRev(): Promise<number | undefined>;
  saveRev(rev: number): Promise<void>;
} {
  return {
    loadRev: async () => (await store.loadSyncDeviceState())?.rev,
    saveRev: (rev) => store.saveSyncDeviceState({ rev }),
  };
}

/**
 * Persistence adapter for device-local sync secrets (ONL-011).
 *
 * Implements the frozen `SyncKeyStorage` seam so the runtime never imports a
 * concrete store. These values are intentionally *not* part of `syncStorage`
 * (which is exported): keeping the two seams separate makes it hard to leak
 * keys into a backup by accident.
 */
export function syncKeyStorage(store: LocalStore): SyncKeyStorage {
  return {
    load: () => store.loadSyncSecrets(),
    save: (secrets) => store.saveSyncSecrets(secrets),
    clear: () => store.deleteSyncSecrets(),
  };
}
