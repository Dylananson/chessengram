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

export const META_CONTENT_SET = 'content-set';
export const META_PUZZLE_ORDER = 'puzzle-order';
export const META_ACTIVE_SESSIONS = 'active-sessions';

/** Current schema version for the local store's own envelopes. */
export const LOCAL_STORE_SCHEMA_VERSION = '1.0.0';

/**
 * Expected persisted schema versions. These mirror the contract literal types
 * (@chessreps/contracts). A record whose envelope version does not
 * match is treated as absent so incompatible data is never silently loaded.
 */
export const EXPECTED_CONTENT_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_SCHEDULE_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_ATTEMPT_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_SESSION_SCHEMA_VERSION = '1.0.0';

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
      await this.backend.set(
        COLLECTION_CONTENT,
        puzzle.id,
        this.wrap(puzzle.contentSchemaVersion, puzzle),
      );
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
}
