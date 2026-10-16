/**
 * Versioned local domain store (T10).
 *
 * Wraps a StorageBackend with typed collections and schema-version envelopes.
 * Derived schedule state (SchedulerState) is stored separately from raw attempt
 * history so history can outlive scheduler changes, per T03/D09.
 */

import type { Clock, SchedulerState } from '@chessreps/scheduler';
import { systemClock } from '@chessreps/scheduler';
import type {
  AttemptRecord,
  ContentSchemaVersion,
  NormalizedPuzzle,
  SessionState,
} from '@chessreps/contracts';
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
/** Pre-import recovery snapshots. Deliberately excluded from exports/imports. */
export const COLLECTION_BACKUPS = 'backups';

/** Collections that make up a full data export, in restore-safe order. */
export const STORE_COLLECTIONS = [
  COLLECTION_CONTENT,
  COLLECTION_SCHEDULES,
  COLLECTION_ATTEMPTS,
  COLLECTION_SESSIONS,
  COLLECTION_SETTINGS,
  COLLECTION_COLLECTIONS,
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

/** Export file format marker and version (PB5). Bumped to 1.1.0 for B4. */
export const EXPORT_FORMAT = 'chessreps-export';
export const EXPORT_FORMAT_VERSION = '1.1.0';

/**
 * Expected persisted schema versions. These mirror the contract literal types
 * (@chessreps/contracts). A record whose envelope version does not
 * match is treated as absent so incompatible data is never silently loaded.
 */
export const EXPECTED_CONTENT_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_SCHEDULE_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_ATTEMPT_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_SESSION_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_SETTINGS_SCHEMA_VERSION = '1.0.0';
/** New in export 1.1.0 (B4). No earlier shape exists, so this starts at 1.0.0. */
export const EXPECTED_COLLECTION_SCHEMA_VERSION = '1.0.0';

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
