/**
 * LocalTrainingService (T09-lite + T10).
 *
 * Implements the T04 `TrainingService` boundary over the real T06 scheduler
 * (`@chessengram/scheduler`) and a persistent `LocalStore`. It is the single
 * place that owns:
 *   - the map progressKey -> SchedulerState (derived schedule),
 *   - raw AttemptRecord history (separate from derived state),
 *   - session state and the active-attempt reservation,
 *   - next-due selection via `selectNextDue`.
 *
 * Failure semantics are inherited from the scheduler commit layer: the first
 * wrong move commits ONE immutable scored failure; correction completion is
 * evidence only and can never overwrite it. Duplicate deliveries are answered
 * idempotently and stale revisions are rejected.
 */

import {
  Scheduler,
  commitScoredOutcome,
  resolveSettings,
  selectNextDue,
  startAttempt as reserveSchedulerAttempt,
  startWoodpeckerCycle as createWoodpeckerCycle,
  recordWoodpeckerResult as appendWoodpeckerResult,
  summarizeWoodpeckerCycle,
  type Candidate,
  type Clock,
  type CommitResult,
  type SchedulerSettings,
  type SchedulerState,
  type WoodpeckerCycle,
  type WoodpeckerSetRecord,
  systemClock,
} from '@chessengram/scheduler';
import type {
  AttemptId,
  AttemptRecord,
  NormalizedPuzzle,
  OutcomeReceipt,
  ProgressKey,
  ScheduleStateDetails,
  SessionState,
  TimingSegments,
} from '@chessengram/contracts';
import type {
  CommitOutcomeRequest,
  CommitOutcomeResponse,
  FinishCorrectionRequest,
  FinishCorrectionResponse,
  GetAttemptRequest,
  GetSessionRequest,
  LoadPuzzleRequest,
  LoadPuzzleResponse,
  RecordEventRequest,
  RecordEventResponse,
  SelectNextRequest,
  SelectNextResponse,
  StartAttemptRequest,
  StartAttemptResponse,
  StartSessionRequest,
  StartSessionResponse,
  TrainingService,
} from '@chessengram/contracts';
import { LocalStore, META_ACTIVE_SESSIONS, META_BUNDLED_BANDS, META_CONTENT_SET, META_PUZZLE_ORDER } from './storage/local-store.ts';
import {
  DEFAULT_COLLECTION_ID,
  META_ACTIVE_COLLECTION,
  type CollectionRecord,
  type ContentSetMeta,
  type StoreExport,
  type StoreExportSummary,
} from './storage/local-store.ts';

/** Re-exported so existing import sites keep working (canonical home: storage/local-store.ts). */
export { DEFAULT_COLLECTION_ID };
import { summarizeExport } from './storage/data-port.ts';
import {
  fromCurated,
  parseCurated,
  SCHEDULER_SETTINGS_KEY,
  toCurated,
  type CuratedSettings,
} from './settings-preferences.ts';
import type { SyncEntityType } from './sync/types.ts';

export const DEFAULT_PROGRAM_ID = 'local-spaced-reps-v1';
export const WOODPECKER_CYCLE_PROGRAM_ID = 'woodpecker-cycle-v1';
export const WOODPECKER_FAILED_PROGRAM_ID = 'woodpecker-failed-review-v1';
/**
 * User request 2026-10-16: revisiting an earlier cycle puzzle runs as unscored
 * practice. Attempts land in this isolated program scope so they never touch the
 * cycle/failed schedule or the cycle result list (and stay out of the Woodpecker
 * attempt stats, which only count the cycle + failed programs).
 */
export const WOODPECKER_REVIEW_PROGRAM_ID = 'woodpecker-review-v1';
export function woodpeckerScopeId(setId: string): string {
  return `woodpecker-set-${setId}`;
}

/**
 * Schedule scope is (programId, collectionId, puzzleId) — per-collection
 * SEPARATE progress (user decision 2026-10-15, B4; overrides the ADR-002
 * per-program proposal — see the `ProgressKey` comment in
 * `@chessengram/contracts`). A missing `collectionId` defaults to
 * `DEFAULT_COLLECTION_ID`, so legacy callers keep working.
 */
export function progressKeyToString(key: ProgressKey): string {
  return `${key.programId}:${effectiveCollectionId(key)}:${key.puzzleId}`;
}

interface ParsedScheduleKey {
  programId: string;
  /** Undefined for legacy pre-B4 `program:puzzle` keys (default scope). */
  collectionId: string | undefined;
  puzzleId: string;
}

/** Split a persisted schedule key; ids never contain `:`, puzzle ids may. */
export function parseScheduleKey(key: string): ParsedScheduleKey | undefined {
  const parts = key.split(':');
  if (parts.length < 2) return undefined;
  if (parts.length === 2) {
    return { programId: parts[0]!, collectionId: undefined, puzzleId: parts.slice(1).join(':') };
  }
  return {
    programId: parts[0]!,
    collectionId: parts[1]!,
    puzzleId: parts.slice(2).join(':'),
  };
}

/** Effective collection scope for a progress key (missing → default). */
export function effectiveCollectionId(key: ProgressKey): string {
  return key.collectionId ?? DEFAULT_COLLECTION_ID;
}

/**
 * Whether two scheduler states project the same schedule. Replay receipts and
 * idempotency keys are bookkeeping only, so an inbound re-apply that produces
 * the same projection must not rewrite the stored schedule.
 */
function sameScheduleProjection(a: SchedulerState, b: SchedulerState): boolean {
  return a.revision === b.revision && JSON.stringify(a.schedule) === JSON.stringify(b.schedule);
}

function cloneCycle(cycle: WoodpeckerCycle): WoodpeckerCycle {
  return {
    ...cycle,
    puzzleIds: [...cycle.puzzleIds],
    results: cycle.results.map((entry) => ({ ...entry })),
  };
}

function emptyTiming(): TimingSegments {
  return {
    activeSolvingSeconds: 0,
    correctionSeconds: 0,
    interruptionSeconds: 0,
    hiddenSeconds: 0,
    timingTrustworthy: true,
  };
}

function makeId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toContractReceipt(receipt: {
  receiptId: string;
  attemptId: AttemptId;
  committedAt: number;
  scheduleRevision: number;
}): OutcomeReceipt {
  return {
    receiptId: receipt.receiptId,
    attemptId: receipt.attemptId,
    committedAt: receipt.committedAt,
    scheduleRevision: receipt.scheduleRevision,
  };
}

/**
 * Composite pointer id for one Woodpecker cycle result. Must match
 * `woodpeckerResultRecordId` in `sync/bootstrap.ts`: the synced pointer's
 * `recordId` and the `cycleId\0puzzleId` dedupe scope both rely on this shape.
 */
function woodpeckerResultPointerId(cycleId: string, puzzleId: string): string {
  return `${cycleId}\u0000${puzzleId}`;
}

/** A source-record change the sync layer can capture (ONL-013). */
export interface SyncLocalChange {
  type: SyncEntityType;
  recordId: string;
}

/** Observer callback registered through {@link LocalTrainingService.onLocalChange}. */
export type SyncLocalChangeListener = (change: SyncLocalChange) => void;

export interface LocalTrainingServiceOptions {
  store: LocalStore;
  clock?: Clock;
  settings?: Partial<SchedulerSettings>;
  idFactory?: () => string;
}

export interface QueueSummary {
  total: number;
  learned: number;
  newCount: number;
  due: number;
}

export class LocalTrainingService implements TrainingService {
  private scheduler: Scheduler;
  private settings: SchedulerSettings;
  private readonly store: LocalStore;
  private readonly clock: Clock;
  private readonly idFactory: () => string;

  private readonly schedules = new Map<string, SchedulerState>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly puzzles = new Map<string, NormalizedPuzzle>();
  private readonly activeSessionByProgram = new Map<string, string>();
  private readonly collections = new Map<string, CollectionRecord>();
  private readonly woodpeckerSets = new Map<string, WoodpeckerSetRecord>();
  private readonly woodpeckerCycles = new Map<string, { cycleId: string; cycle: WoodpeckerCycle }>();
  private activeCollectionId: string = DEFAULT_COLLECTION_ID;
  private puzzleOrder: string[] = [];
  private initialized = false;
  /** ONL-013 change observers; empty until the sync runtime subscribes. */
  private readonly localChangeListeners = new Set<SyncLocalChangeListener>();
  /**
   * Non-zero while a remote apply runs. Remote applies must never echo back
   * outbound pointers, so notifications are suppressed for their duration.
   */
  private remoteApplyDepth = 0;

  constructor(options: LocalTrainingServiceOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? makeId;
    this.settings = resolveSettings(options.settings);
    this.scheduler = new Scheduler({
      clock: this.clock,
      settings: this.settings,
    });
  }

  /** Load persisted content, schedules, history and sessions into memory. */
  async init(): Promise<void> {
    const puzzles = await this.store.loadPuzzles();
    this.puzzles.clear();
    for (const puzzle of puzzles) this.puzzles.set(puzzle.id, puzzle);

    const savedOrder = await this.store.loadMeta<string[]>(META_PUZZLE_ORDER);
    this.puzzleOrder = savedOrder
      ? savedOrder.filter((id) => this.puzzles.has(id))
      : [...this.puzzles.keys()];

    this.schedules.clear();
    for (const [key, state] of await this.store.loadSchedules()) {
      this.schedules.set(key, state);
    }
    await this.migrateLegacyScheduleKeys();

    this.collections.clear();
    for (const collection of await this.store.loadCollections()) {
      this.collections.set(collection.id, {
        ...collection,
        puzzleIds: [...new Set(collection.puzzleIds)],
      });
    }
    await this.ensureDefaultCollection();

    this.woodpeckerSets.clear();
    for (const set of await this.store.loadWoodpeckerSets()) this.woodpeckerSets.set(set.setId, set);
    this.woodpeckerCycles.clear();
    for (const saved of await this.store.loadWoodpeckerCycles()) {
      this.woodpeckerCycles.set(saved.cycleId, saved);
    }

    const storedActive = await this.store.loadMeta<string>(META_ACTIVE_COLLECTION);
    this.activeCollectionId =
      storedActive && this.collections.has(storedActive)
        ? storedActive
        : DEFAULT_COLLECTION_ID;
    await this.persistActiveCollection();

    this.attempts.clear();
    for (const attempt of await this.store.loadAttempts()) {
      this.attempts.set(attempt.attemptId.value, attempt);
    }

    this.sessions.clear();
    for (const session of await this.store.loadSessions()) {
      this.sessions.set(session.sessionId, session);
    }

    this.activeSessionByProgram.clear();
    const active = await this.store.loadMeta<Record<string, string>>(META_ACTIVE_SESSIONS);
    if (active) {
      for (const [programId, sessionId] of Object.entries(active)) {
        if (this.sessions.has(sessionId)) this.activeSessionByProgram.set(programId, sessionId);
      }
    }

    const storedSettings = await this.store.loadSettings<unknown>(SCHEDULER_SETTINGS_KEY);
    if (storedSettings !== undefined) this.applySettings(parseCurated(storedSettings));

    this.initialized = true;
  }

  /**
   * Live migration for pre-B4 data already in the backend: legacy
   * `program:puzzle` schedule keys move into the default collection scope.
   * Raw AttemptRecords keep their recorded keys untouched (auditable
   * as-recorded). Export/import of old documents is handled separately by
   * the 1.0.0 → 1.1.0 migration in storage/data-port.ts.
   */
  private async migrateLegacyScheduleKeys(): Promise<void> {
    for (const [key, state] of [...this.schedules]) {
      const parsed = parseScheduleKey(key);
      if (parsed && parsed.collectionId === undefined) {
        const scoped = `${parsed.programId}:${DEFAULT_COLLECTION_ID}:${parsed.puzzleId}`;
        if (!this.schedules.has(scoped)) {
          this.schedules.set(scoped, state);
          await this.store.saveSchedule(scoped, state);
        }
        this.schedules.delete(key);
        await this.store.deleteSchedule(key);
      }
    }
  }

  /** Create the default collection (seeded with the library) when missing. */
  private async ensureDefaultCollection(): Promise<void> {
    if (!this.collections.has(DEFAULT_COLLECTION_ID)) {
      const record: CollectionRecord = {
        id: DEFAULT_COLLECTION_ID,
        name: 'Default',
        puzzleIds: [...this.puzzleOrder],
        createdAt: this.clock.now(),
      };
      this.collections.set(record.id, record);
      await this.store.saveCollection(record);
    }
  }

  private async persistActiveCollection(): Promise<void> {
    await this.store.saveMeta(META_ACTIVE_COLLECTION, this.activeCollectionId);
  }

  /** Rebuild the scheduler from a curated settings value (no persistence). */
  private applySettings(curated: CuratedSettings): void {
    this.settings = fromCurated(curated);
    this.scheduler = new Scheduler({ clock: this.clock, settings: this.settings });
  }

  getCuratedSettings(): CuratedSettings {
    return toCurated(this.settings);
  }

  // --- local change observation (ONL-013) ---------------------------------

  /**
   * Observe source-record mutations that sync cares about (attempts,
   * collections, Woodpecker sets/cycles/results, settings and user-authored
   * puzzles). Returns an unsubscribe function.
   *
   * Derived writes (schedules, sessions, meta) and remote applies never notify:
   * a remote change must not be re-enqueued as an outbound pointer (no echo
   * loop). A listener that throws is ignored so an observer can never break a
   * training mutation.
   */
  onLocalChange(listener: SyncLocalChangeListener): () => void {
    this.localChangeListeners.add(listener);
    return () => {
      this.localChangeListeners.delete(listener);
    };
  }

  /** Notify observers unless a remote apply is in progress. */
  private notifyLocalChange(type: SyncEntityType, recordId: string): void {
    if (this.remoteApplyDepth > 0) return;
    for (const listener of this.localChangeListeners) {
      try {
        listener({ type, recordId });
      } catch {
        // A capture observer must never break a training mutation.
      }
    }
  }

  /**
   * Run a remote apply with local-change notifications suppressed. All the
   * `applyRemote*` writers go through this so applying a remote record is never
   * captured back into the outbound queue.
   */
  private async withRemoteApply<T>(operation: () => Promise<T>): Promise<T> {
    this.remoteApplyDepth += 1;
    try {
      return await operation();
    } finally {
      this.remoteApplyDepth -= 1;
    }
  }

  /** Persist and apply curated scheduler preferences. Takes effect on new attempts. */
  async applyCuratedSettings(curated: CuratedSettings): Promise<CuratedSettings> {
    const safe = parseCurated(curated);
    this.applySettings(safe);
    await this.store.saveSettings(SCHEDULER_SETTINGS_KEY, safe);
    this.notifyLocalChange('setting', SCHEDULER_SETTINGS_KEY);
    return safe;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  hasContent(): boolean {
    return this.puzzles.size > 0;
  }

  getSettingsHash(): string {
    return this.scheduler.getSettingsHash();
  }

  getBackendKind(): string {
    return this.store.backendKind;
  }

  /** Delete all persisted data and clear in-memory state (documented reset). */
  async reset(): Promise<void> {
    await this.store.reset();
    this.schedules.clear();
    this.attempts.clear();
    this.sessions.clear();
    this.puzzles.clear();
    this.activeSessionByProgram.clear();
    this.collections.clear();
    this.activeCollectionId = DEFAULT_COLLECTION_ID;
    this.puzzleOrder = [];
    this.settings = resolveSettings();
    this.scheduler = new Scheduler({ clock: this.clock, settings: this.settings });
    this.initialized = false;
  }

  /** Persist a validated content pack and remember its presentation order. */
  async seedContent(
    puzzles: readonly NormalizedPuzzle[],
    meta: { packId?: string } = {},
  ): Promise<void> {
    if (puzzles.length === 0) return;
    await this.store.savePuzzles(puzzles);
    this.puzzles.clear();
    this.puzzleOrder = [];
    for (const puzzle of puzzles) {
      this.puzzles.set(puzzle.id, puzzle);
      this.puzzleOrder.push(puzzle.id);
    }
    await this.store.saveMeta(META_PUZZLE_ORDER, [...this.puzzleOrder]);
    // Seeding a pack defines the default collection: first boot trains the
    // bundled pack unchanged. User-created collections keep their (possibly
    // now-stale) membership lists; stale ids are filtered at read time.
    const record: CollectionRecord = {
      id: DEFAULT_COLLECTION_ID,
      name: this.collections.get(DEFAULT_COLLECTION_ID)?.name ?? 'Default',
      puzzleIds: [...this.puzzleOrder],
      createdAt: this.collections.get(DEFAULT_COLLECTION_ID)?.createdAt ?? this.clock.now(),
    };
    this.collections.set(record.id, record);
    await this.store.saveCollection(record);
    const contentMeta: ContentSetMeta = {
      packId: meta.packId ?? '',
      contentSchemaVersion: puzzles[0]!.contentSchemaVersion,
      count: puzzles.length,
      loadedAt: this.clock.now(),
    };
    await this.store.saveMeta(META_CONTENT_SET, contentMeta);
  }

  async loadContentMeta(): Promise<ContentSetMeta | undefined> {
    return this.store.loadMeta<ContentSetMeta>(META_CONTENT_SET);
  }

  listPuzzleIds(): string[] {
    return [...this.puzzleOrder];
  }

  listPuzzles(): NormalizedPuzzle[] {
    return this.puzzleOrder.flatMap((id) => {
      const puzzle = this.puzzles.get(id);
      return puzzle ? [puzzle] : [];
    });
  }

  /**
   * Merge puzzles into the library (PB3). Existing ids are replaced in place;
   * new ids are appended to the presentation order. Progress/history for an id
   * that is only replaced is intentionally left untouched (same id, new content).
   */
  async upsertPuzzles(
    puzzles: readonly NormalizedPuzzle[],
    meta: { packId?: string } = {},
  ): Promise<{ added: number; replaced: number }> {
    if (puzzles.length === 0) return { added: 0, replaced: 0 };
    let added = 0;
    let replaced = 0;
    for (const puzzle of puzzles) {
      if (this.puzzles.has(puzzle.id)) {
        replaced += 1;
      } else {
        added += 1;
        if (!this.puzzleOrder.includes(puzzle.id)) this.puzzleOrder.push(puzzle.id);
      }
      this.puzzles.set(puzzle.id, puzzle);
    }
    await this.store.savePuzzles(puzzles);
    await this.store.saveMeta(META_PUZZLE_ORDER, [...this.puzzleOrder]);
    await this.refreshContentMeta(meta.packId);
    // Newly imported puzzles land in the default collection so they stay
    // trainable; other collections are untouched (explicit membership only).
    if (added > 0) {
      await this.ensureDefaultCollection();
      const record = this.collections.get(DEFAULT_COLLECTION_ID)!;
      let changed = false;
      for (const puzzle of puzzles) {
        if (!record.puzzleIds.includes(puzzle.id)) {
          record.puzzleIds.push(puzzle.id);
          changed = true;
        }
      }
      if (changed) await this.store.saveCollection({ ...record, puzzleIds: [...record.puzzleIds] });
    }
    // Only user-authored puzzles are synced; bundled/CC0 content is not user data.
    for (const puzzle of puzzles) {
      if (puzzle.source === 'user') this.notifyLocalChange('userPuzzle', puzzle.id);
    }
    return { added, replaced };
  }

  // --- bundled rating-band collections (F02) --------------------------------

  /** Pack id already seeded as bundled bands, if any (meta read, no writes). */
  async bundledBandsPackId(): Promise<string | undefined> {
    return this.store.loadMeta<string>(META_BUNDLED_BANDS);
  }

  /**
   * Seed bundled rating-band content exactly once per `packId`. Unlike
   * {@link upsertPuzzles}, this never adds the new puzzles to the default (or
   * any existing) collection: the starter collection keeps its original
   * membership and each band becomes its own collection. Idempotent per pack
   * via {@link META_BUNDLED_BANDS}, so a deleted band collection stays deleted.
   */
  async seedBundledCollections(
    packId: string,
    puzzles: readonly NormalizedPuzzle[],
    collections: ReadonlyArray<{ id: string; name: string; puzzleIds: readonly string[] }>,
  ): Promise<boolean> {
    if ((await this.bundledBandsPackId()) === packId) return false;
    if (puzzles.length > 0) {
      for (const puzzle of puzzles) {
        if (!this.puzzles.has(puzzle.id)) this.puzzleOrder.push(puzzle.id);
        this.puzzles.set(puzzle.id, puzzle);
      }
      await this.store.savePuzzles(puzzles);
      await this.store.saveMeta(META_PUZZLE_ORDER, [...this.puzzleOrder]);
      await this.refreshContentMeta();
    }
    for (const definition of collections) {
      if (this.collections.has(definition.id)) continue;
      const record: CollectionRecord = {
        id: definition.id,
        name: definition.name,
        // Stale ids are filtered now and at read time, like other collections.
        puzzleIds: definition.puzzleIds.filter((id) => this.puzzles.has(id)),
        createdAt: this.clock.now(),
      };
      this.collections.set(record.id, record);
      await this.store.saveCollection(record);
    }
    await this.store.saveMeta(META_BUNDLED_BANDS, packId);
    return true;
  }

  /**
   * Remove a puzzle's content and its derived schedule state. Raw attempt
   * history is deliberately kept (D09: history outlives content), so previous
   * attempts on the removed puzzle remain auditable.
   */
  async removePuzzle(puzzleId: string): Promise<void> {
    const removed = this.puzzles.get(puzzleId);
    const wasUserPuzzle = removed?.source === 'user';
    this.puzzles.delete(puzzleId);
    this.puzzleOrder = this.puzzleOrder.filter((id) => id !== puzzleId);
    const scheduleKeys = [...this.schedules.keys()].filter((key) =>
      key.endsWith(`:${puzzleId}`),
    );
    for (const key of scheduleKeys) {
      this.schedules.delete(key);
      await this.store.deleteSchedule(key);
    }
    for (const collection of this.collections.values()) {
      if (collection.puzzleIds.includes(puzzleId)) {
        collection.puzzleIds = collection.puzzleIds.filter((id) => id !== puzzleId);
        await this.store.saveCollection({ ...collection, puzzleIds: [...collection.puzzleIds] });
      }
    }
    await this.store.deletePuzzle(puzzleId);
    await this.store.saveMeta(META_PUZZLE_ORDER, [...this.puzzleOrder]);
    await this.refreshContentMeta();
    if (wasUserPuzzle) this.notifyLocalChange('userPuzzle', puzzleId);
  }

  // --- collections (static sets, B4) ----------------------------------------

  private copyCollection(record: CollectionRecord): CollectionRecord {
    return { ...record, puzzleIds: [...record.puzzleIds] };
  }

  /** All collections, oldest first. Defensive copies. */
  listCollections(): CollectionRecord[] {
    return [...this.collections.values()]
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((record) => this.copyCollection(record));
  }

  getCollection(collectionId: string): CollectionRecord | undefined {
    const record = this.collections.get(collectionId);
    return record ? this.copyCollection(record) : undefined;
  }

  /** Persisted active-collection selection (Train picker). */
  getActiveCollectionId(): string {
    return this.activeCollectionId;
  }

  async setActiveCollectionId(collectionId: string): Promise<void> {
    if (!this.collections.has(collectionId)) {
      throw new Error(`Collection not found: ${collectionId}`);
    }
    this.activeCollectionId = collectionId;
    await this.persistActiveCollection();
  }

  async createCollection(name: string): Promise<CollectionRecord> {
    const clean = name.trim();
    if (!clean) throw new Error('Collection name must not be empty.');
    const record: CollectionRecord = {
      id: `collection-${this.idFactory()}`,
      name: clean,
      puzzleIds: [],
      createdAt: this.clock.now(),
    };
    this.collections.set(record.id, record);
    await this.store.saveCollection(record);
    this.notifyLocalChange('collection', record.id);
    return this.copyCollection(record);
  }

  async renameCollection(collectionId: string, name: string): Promise<CollectionRecord> {
    const record = this.collections.get(collectionId);
    if (!record) throw new Error(`Collection not found: ${collectionId}`);
    const clean = name.trim();
    if (!clean) throw new Error('Collection name must not be empty.');
    record.name = clean;
    await this.store.saveCollection(this.copyCollection(record));
    this.notifyLocalChange('collection', collectionId);
    return this.copyCollection(record);
  }

  /**
   * Delete a collection's membership list and its collection-scoped derived
   * schedules. Puzzles, other collections' schedules, and all raw attempt
   * history are kept (D09: history outlives content and derived state). The
   * default collection cannot be deleted; deleting the active collection
   * falls back to the default.
   */
  async deleteCollection(collectionId: string): Promise<void> {
    if (!this.collections.has(collectionId)) {
      throw new Error(`Collection not found: ${collectionId}`);
    }
    if (collectionId === DEFAULT_COLLECTION_ID) {
      throw new Error('The default collection cannot be deleted.');
    }
    this.collections.delete(collectionId);
    await this.store.deleteCollection(collectionId);
    for (const key of [...this.schedules.keys()]) {
      const parsed = parseScheduleKey(key);
      if (parsed?.collectionId === collectionId) {
        this.schedules.delete(key);
        await this.store.deleteSchedule(key);
      }
    }
    if (this.activeCollectionId === collectionId) {
      this.activeCollectionId = DEFAULT_COLLECTION_ID;
      await this.persistActiveCollection();
    }
    this.notifyLocalChange('collection', collectionId);
  }

  // --- Woodpecker F01 ------------------------------------------------------

  listWoodpeckerSets(): WoodpeckerSetRecord[] {
    return [...this.woodpeckerSets.values()].map((set) => ({ ...set, puzzleIds: [...set.puzzleIds] }));
  }

  getWoodpeckerSet(setId: string): WoodpeckerSetRecord | undefined {
    const set = this.woodpeckerSets.get(setId);
    return set ? { ...set, puzzleIds: [...set.puzzleIds] } : undefined;
  }

  /** Internal Woodpecker sets whose fixed snapshot came from this collection. */
  listWoodpeckerSetsForCollection(collectionId: string): WoodpeckerSetRecord[] {
    return this.listWoodpeckerSets().filter((set) => set.sourceCollectionId === collectionId);
  }

  /**
   * The collection's canonical internal Woodpecker set, if one exists. The UI
   * works in collections; sets stay an internal snapshot. When several sets
   * point at the collection, prefer one that already has cycles (so progress is
   * never orphaned), then the newest snapshot.
   */
  getWoodpeckerSetForCollection(collectionId: string): WoodpeckerSetRecord | undefined {
    const sets = this.listWoodpeckerSetsForCollection(collectionId);
    if (sets.length === 0) return undefined;
    const withCycles = sets.filter((set) => this.listWoodpeckerCycles(set.setId).length > 0);
    const pool = withCycles.length > 0 ? withCycles : sets;
    return pool.reduce((best, set) => (set.createdAt >= best.createdAt ? set : best));
  }

  /**
   * User request 2026-10-16: Woodpecker starts from a collection, so reuse the
   * collection's canonical set or snapshot its current members into a new one on
   * first use. Empty/>500 collections reject via {@link createWoodpeckerSet};
   * callers gate the action on those limits.
   */
  async getOrCreateWoodpeckerSetForCollection(collectionId: string): Promise<WoodpeckerSetRecord> {
    const existing = this.getWoodpeckerSetForCollection(collectionId);
    if (existing) return existing;
    const collection = this.collections.get(collectionId);
    if (!collection) throw new Error('Collection not found.');
    return this.createWoodpeckerSet({
      name: collection.name,
      sourceCollectionId: collectionId,
      puzzleIds: [...collection.puzzleIds],
    });
  }

  async createWoodpeckerSet(input: {
    name: string;
    sourceCollectionId: string;
    puzzleIds: readonly string[];
  }): Promise<WoodpeckerSetRecord> {
    const name = input.name.trim();
    const source = this.collections.get(input.sourceCollectionId);
    if (!name) throw new Error('Set name must not be empty.');
    if (!source) throw new Error('Source collection not found.');
    if (input.puzzleIds.length === 0) throw new Error('Choose at least one puzzle.');
    if (new Set(input.puzzleIds).size !== input.puzzleIds.length) throw new Error('Puzzle selection contains duplicates.');
    if (input.puzzleIds.length > 500) throw new Error('A Woodpecker set can contain at most 500 puzzles.');
    if (input.puzzleIds.some((id) => !source.puzzleIds.includes(id) || !this.puzzles.has(id))) {
      throw new Error('Every selected puzzle must belong to the source collection.');
    }
    const set: WoodpeckerSetRecord = {
      setId: `woodpecker-${this.idFactory()}`,
      name,
      sourceCollectionId: source.id,
      puzzleIds: [...input.puzzleIds],
      createdAt: this.clock.now(),
    };
    await this.store.saveWoodpeckerSet(set);
    this.woodpeckerSets.set(set.setId, set);
    this.notifyLocalChange('woodpecker', set.setId);
    return { ...set, puzzleIds: [...set.puzzleIds] };
  }

  listWoodpeckerCycles(setId: string): Array<{ cycleId: string; cycle: WoodpeckerCycle }> {
    return [...this.woodpeckerCycles.values()]
      .filter((saved) => saved.cycle.setId === setId)
      .sort((a, b) => a.cycle.cycleNumber - b.cycle.cycleNumber)
      .map((saved) => ({ cycleId: saved.cycleId, cycle: { ...saved.cycle, puzzleIds: [...saved.cycle.puzzleIds], results: [...saved.cycle.results] } }));
  }

  getActiveWoodpeckerCycle(setId: string): { cycleId: string; cycle: WoodpeckerCycle } | undefined {
    return this.listWoodpeckerCycles(setId).find(({ cycle }) => !summarizeWoodpeckerCycle(cycle).complete);
  }

  getWoodpeckerCycle(cycleId: string): { cycleId: string; cycle: WoodpeckerCycle } | undefined {
    const saved = this.woodpeckerCycles.get(cycleId);
    return saved ? { cycleId, cycle: { ...saved.cycle, puzzleIds: [...saved.cycle.puzzleIds], results: [...saved.cycle.results] } } : undefined;
  }

  async startWoodpeckerCycle(setId: string): Promise<{ cycleId: string; cycle: WoodpeckerCycle }> {
    const set = this.woodpeckerSets.get(setId);
    if (!set) throw new Error('Woodpecker set not found.');
    const active = this.getActiveWoodpeckerCycle(setId);
    if (active) return active;
    const cycleNumber = this.listWoodpeckerCycles(setId).length + 1;
    const cycleId = `woodpecker-cycle-${this.idFactory()}`;
    const cycle = createWoodpeckerCycle(set, cycleNumber, this.clock.now());
    await this.store.saveWoodpeckerCycle(cycleId, cycle);
    const saved = { cycleId, cycle };
    this.woodpeckerCycles.set(cycleId, saved);
    this.notifyLocalChange('woodpecker', cycleId);
    return { cycleId, cycle: { ...cycle, puzzleIds: [...cycle.puzzleIds], results: [] } };
  }

  async recordWoodpeckerCycleResult(
    cycleId: string,
    puzzleId: string,
    result: 'clean' | 'failed',
    activeSeconds: number,
    recordedAt = this.clock.now(),
  ): Promise<WoodpeckerCycle> {
    const saved = this.woodpeckerCycles.get(cycleId);
    if (!saved) throw new Error('Woodpecker cycle not found.');
    const cycle = appendWoodpeckerResult(saved.cycle, puzzleId, result, activeSeconds, recordedAt);
    await this.store.saveWoodpeckerCycle(cycleId, cycle);
    this.woodpeckerCycles.set(cycleId, { cycleId, cycle });
    this.notifyLocalChange('woodpeckerResult', woodpeckerResultPointerId(cycleId, puzzleId));
    return { ...cycle, puzzleIds: [...cycle.puzzleIds], results: [...cycle.results] };
  }

  getWoodpeckerAttemptStats(setId: string): {
    scoredAttempts: number;
    cleanSolves: number;
    failedAttempts: number;
    activeSeconds: number;
  } {
    const scopeId = woodpeckerScopeId(setId);
    const programs = new Set([WOODPECKER_CYCLE_PROGRAM_ID, WOODPECKER_FAILED_PROGRAM_ID]);
    const attempts = [...this.attempts.values()].filter(
      (attempt) => programs.has(attempt.progressKey.programId)
        && attempt.progressKey.collectionId === scopeId
        && attempt.outcome !== undefined,
    );
    return {
      scoredAttempts: attempts.length,
      cleanSolves: attempts.filter((attempt) => attempt.outcome === 'success').length,
      failedAttempts: attempts.filter((attempt) => attempt.outcome === 'failure').length,
      activeSeconds: attempts.reduce((sum, attempt) => sum + attempt.timing.activeSolvingSeconds, 0),
    };
  }

  /**
   * When this collection's Woodpecker work was last touched (epoch ms), across
   * the cycle, failed-review and unscored-review programs. The Dashboard uses it
   * to put the most recently trained collection first. Falls back to the most
   * recent cycle start so a cycle that was started but not yet solved still
   * ranks by when it was opened. `undefined` when there is no Woodpecker work.
   */
  getWoodpeckerLastActivityAt(setId: string): number | undefined {
    const scopeId = woodpeckerScopeId(setId);
    const programs = new Set([
      WOODPECKER_CYCLE_PROGRAM_ID,
      WOODPECKER_FAILED_PROGRAM_ID,
      WOODPECKER_REVIEW_PROGRAM_ID,
    ]);
    let latest: number | undefined;
    const consider = (at: number | undefined): void => {
      if (at === undefined) return;
      if (latest === undefined || at > latest) latest = at;
    };
    for (const attempt of this.attempts.values()) {
      if (!programs.has(attempt.progressKey.programId)) continue;
      if (attempt.progressKey.collectionId !== scopeId) continue;
      consider(attempt.completedAt ?? attempt.startedAt);
    }
    for (const { cycle } of this.listWoodpeckerCycles(setId)) {
      consider(cycle.completedAt ?? cycle.startedAt);
    }
    return latest;
  }

  getWoodpeckerFailedPuzzleIds(setId: string): string[] {
    const failed = new Set<string>();
    for (const { cycle } of this.listWoodpeckerCycles(setId)) {
      for (const puzzleId of summarizeWoodpeckerCycle(cycle).failedPuzzleIds) failed.add(puzzleId);
    }
    return [...failed];
  }

  /**
   * Select from failures only, using an isolated scheduler scope/program.
   *
   * `excludePuzzleIds` works like the ordinary selection's: the failed set is
   * derived from the cycle's results, which a review attempt does not change,
   * so without the exclusion the puzzle just reviewed came straight back.
   */
  selectWoodpeckerFailed(
    setId: string,
    options: { excludePuzzleIds?: readonly string[] } = {},
  ): SelectNextResponse {
    const allIds = this.getWoodpeckerFailedPuzzleIds(setId);
    const excluded = new Set(options.excludePuzzleIds ?? []);
    const ids = allIds.filter((puzzleId) => !excluded.has(puzzleId));
    if (ids.length === 0) {
      return {
        puzzleId: null,
        reason: allIds.length > 0 ? 'woodpecker-review-complete' : 'queue-empty',
      };
    }
    const collectionId = woodpeckerScopeId(setId);
    const candidates: Candidate[] = ids.map((puzzleId) => {
      const key = `${WOODPECKER_FAILED_PROGRAM_ID}:${collectionId}:${puzzleId}`;
      const state = this.schedules.get(key)?.schedule ?? this.scheduler.createState().schedule;
      return { progressKey: key, state, orderKey: puzzleId };
    });
    const newOrder = candidates.filter((candidate) => candidate.state.state === 'new').map((candidate) => candidate.progressKey);
    const selected = selectNextDue(candidates, { now: this.clock.now(), newOrder });
    if (selected) return { puzzleId: parseScheduleKey(selected)?.puzzleId ?? selected };
    const next = candidates
      .filter((candidate) => candidate.state.dueAt !== undefined)
      .sort((a, b) => a.state.dueAt! - b.state.dueAt!)[0];
    return { puzzleId: null, reason: 'no-due-work', nextDueAt: next?.state.dueAt };
  }

  async addPuzzleToCollection(collectionId: string, puzzleId: string): Promise<void> {
    const record = this.collections.get(collectionId);
    if (!record) throw new Error(`Collection not found: ${collectionId}`);
    if (!this.puzzles.has(puzzleId)) throw new Error(`Puzzle not found: ${puzzleId}`);
    if (!record.puzzleIds.includes(puzzleId)) {
      record.puzzleIds.push(puzzleId);
      await this.store.saveCollection(this.copyCollection(record));
      this.notifyLocalChange('collection', collectionId);
    }
  }

  async removePuzzleFromCollection(collectionId: string, puzzleId: string): Promise<void> {
    const record = this.collections.get(collectionId);
    if (!record) throw new Error(`Collection not found: ${collectionId}`);
    if (record.puzzleIds.includes(puzzleId)) {
      record.puzzleIds = record.puzzleIds.filter((id) => id !== puzzleId);
      await this.store.saveCollection(this.copyCollection(record));
      this.notifyLocalChange('collection', collectionId);
    }
  }

  // --- inbound sync writer (ONL-012) ---------------------------------------
  //
  // These are append-only / idempotent entry points for remote records. They
  // deliberately never enqueue any outbound pointer (the sync runtime owns the
  // queue) and never delete local history.

  /** Read puzzle content synchronously for inbound attempt reconstruction. */
  getPuzzle(puzzleId: string): NormalizedPuzzle | undefined {
    const puzzle = this.puzzles.get(puzzleId);
    return puzzle ? structuredClone(puzzle) : undefined;
  }

  /** Next presentation cycle number for a set (payloads do not carry it). */
  nextWoodpeckerCycleNumber(setId: string): number {
    let max = 0;
    for (const saved of this.woodpeckerCycles.values()) {
      if (saved.cycle.setId !== setId) continue;
      max = Math.max(max, saved.cycle.cycleNumber);
    }
    return max + 1;
  }

  /**
   * Append remote raw attempts (same `attemptId` twice is a no-op) and rebuild
   * the affected `(program, collection, puzzle)` schedules by replaying the
   * merged attempt log through the deterministic scheduler reducer.
   *
   * Replay is the reason schedules converge across devices: both sides feed
   * the same attempt records, in scoring order, into the same pure transition
   * rules. Local schedules are only replaced when the replay projects a
   * different state, so an idempotent re-apply changes nothing.
   */
  async applyRemoteAttempts(
    records: readonly AttemptRecord[],
  ): Promise<{ applied: number; duplicates: number }> {
    return this.withRemoteApply(() => this.applyRemoteAttemptsInner(records));
  }

  private async applyRemoteAttemptsInner(
    records: readonly AttemptRecord[],
  ): Promise<{ applied: number; duplicates: number }> {
    let applied = 0;
    let duplicates = 0;
    const affected = new Set<string>();

    for (const record of records) {
      const attemptId = record?.attemptId?.value;
      if (typeof attemptId !== 'string' || attemptId === '') continue;
      if (this.attempts.has(attemptId)) {
        duplicates += 1;
        affected.add(progressKeyToString(record.progressKey));
        continue;
      }
      const attempt = structuredClone(record);
      await this.store.saveAttempt(attempt);
      this.attempts.set(attemptId, attempt);
      applied += 1;
      affected.add(progressKeyToString(attempt.progressKey));
    }

    for (const key of affected) await this.rebuildScheduleFromAttempts(key);
    return { applied, duplicates };
  }

  /**
   * Rebuild one schedule scope from the merged attempt log. Attempts without an
   * outcome still reserve the New introduction (`introducedAt`) exactly like
   * `startAttempt`, so an abandoned-but-synced attempt converges too.
   */
  private async rebuildScheduleFromAttempts(key: string): Promise<void> {
    const parsed = parseScheduleKey(key);
    if (!parsed || parsed.collectionId === undefined) return;

    const progressKey: ProgressKey = {
      programId: parsed.programId,
      collectionId: parsed.collectionId,
      puzzleId: parsed.puzzleId,
    };
    const history = [...this.attempts.values()]
      .filter((attempt) => progressKeyToString(attempt.progressKey) === key)
      .sort((a, b) => {
        if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
        return a.attemptId.value < b.attemptId.value
          ? -1
          : a.attemptId.value > b.attemptId.value
            ? 1
            : 0;
      });
    if (history.length === 0) return;

    let state = this.scheduler.createState();
    for (const attempt of history) {
      state = reserveSchedulerAttempt(state, {
        attemptId: attempt.attemptId,
        at: attempt.startedAt,
        progressKey,
      }).state;
      if (attempt.outcome === undefined) continue;

      const puzzle = this.puzzles.get(attempt.progressKey.puzzleId);
      const requiredMoves = puzzle ? Math.ceil(puzzle.solution.length / 2) : undefined;
      const result = commitScoredOutcome(
        state,
        {
          attemptId: attempt.attemptId,
          expectedScheduleRevision: state.revision,
          // Replay identity only needs to be stable and per-attempt unique.
          idempotencyKey: `sync:${attempt.attemptId.value}`,
          outcome: attempt.outcome,
          occurredAt: attempt.completedAt ?? attempt.startedAt,
          timing: attempt.timing,
          ...(requiredMoves !== undefined ? { requiredMoves } : {}),
          ...(attempt.failureReason !== undefined ? { failureReason: attempt.failureReason } : {}),
        },
        this.settings,
      );
      if (result.status === 'committed' || result.status === 'duplicate') {
        state = result.state;
      }
    }

    const previous = this.schedules.get(key);
    if (previous && sameScheduleProjection(previous, state)) return;
    this.schedules.set(key, state);
    await this.store.saveSchedule(key, state);
  }

  /** Replace (or delete) one collection from an already-merged remote state. */
  async applyRemoteCollection(
    collectionId: string,
    record: CollectionRecord | undefined,
  ): Promise<void> {
    return this.withRemoteApply(() => this.applyRemoteCollectionInner(collectionId, record));
  }

  private async applyRemoteCollectionInner(
    collectionId: string,
    record: CollectionRecord | undefined,
  ): Promise<void> {
    if (record === undefined) {
      this.collections.delete(collectionId);
      await this.store.deleteCollection(collectionId);
      return;
    }
    if (record.id !== collectionId) {
      throw new Error(`Collection id mismatch: ${collectionId}`);
    }
    const copy = this.copyCollection(record);
    this.collections.set(copy.id, copy);
    await this.store.saveCollection(copy);
  }

  async applyRemoteWoodpeckerSet(record: WoodpeckerSetRecord): Promise<void> {
    return this.withRemoteApply(() => this.applyRemoteWoodpeckerSetInner(record));
  }

  private async applyRemoteWoodpeckerSetInner(record: WoodpeckerSetRecord): Promise<void> {
    const copy: WoodpeckerSetRecord = { ...record, puzzleIds: [...record.puzzleIds] };
    this.woodpeckerSets.set(copy.setId, copy);
    await this.store.saveWoodpeckerSet(copy);
  }

  async applyRemoteWoodpeckerCycle(cycleId: string, cycle: WoodpeckerCycle): Promise<void> {
    return this.withRemoteApply(() => this.applyRemoteWoodpeckerCycleInner(cycleId, cycle));
  }

  private async applyRemoteWoodpeckerCycleInner(
    cycleId: string,
    cycle: WoodpeckerCycle,
  ): Promise<void> {
    const copy = cloneCycle(cycle);
    this.woodpeckerCycles.set(cycleId, { cycleId, cycle: copy });
    await this.store.saveWoodpeckerCycle(cycleId, copy);
  }

  /**
   * Persist synced user-puzzle content without touching collection membership:
   * membership arrives separately through collection envelopes and must not be
   * silently widened by content arriving first.
   */
  async applyRemotePuzzle(puzzle: NormalizedPuzzle): Promise<void> {
    return this.withRemoteApply(() => this.applyRemotePuzzleInner(puzzle));
  }

  private async applyRemotePuzzleInner(puzzle: NormalizedPuzzle): Promise<void> {
    const copy = structuredClone(puzzle);
    if (!this.puzzles.has(copy.id)) {
      this.puzzleOrder.push(copy.id);
      await this.store.saveMeta(META_PUZZLE_ORDER, [...this.puzzleOrder]);
    }
    this.puzzles.set(copy.id, copy);
    await this.store.savePuzzles([copy]);
    await this.refreshContentMeta();
  }

  /**
   * Inbound tombstone (ONL-014): a user puzzle was deleted on another device.
   * Runs the same removal path as {@link removePuzzle} under the remote-apply
   * guard, so content and this puzzle's derived schedules go away while raw
   * attempt history and every other record are kept — and no outbound pointer
   * is echoed back.
   */
  async applyRemotePuzzleRemoval(puzzleId: string): Promise<void> {
    return this.withRemoteApply(() => this.removePuzzle(puzzleId));
  }

  /** Apply one remote setting group (validated/clamped by the caller's parser). */
  async applyRemoteSettings(recordId: string, values: Record<string, unknown>): Promise<void> {
    return this.withRemoteApply(() => this.applyRemoteSettingsInner(recordId, values));
  }

  private async applyRemoteSettingsInner(
    recordId: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    if (recordId === SCHEDULER_SETTINGS_KEY) {
      await this.applyCuratedSettings(parseCurated(values));
      return;
    }
    await this.store.saveSettings(recordId, values);
  }

  // --- data safety (PB5) --------------------------------------------------

  /** Full, lossless snapshot of all persisted data (content, progress, history). */
  async exportStore(): Promise<StoreExport> {
    return this.store.exportData();
  }

  async exportStoreSummary(): Promise<StoreExportSummary> {
    return summarizeExport(await this.store.exportData());
  }

  /**
   * Replace the whole store with a validated export. The current data is
   * snapshotted to the `backups` collection first, so the import is reversible.
   */
  async importStore(exported: StoreExport, label: string): Promise<StoreExportSummary> {
    const current = await this.store.exportData();
    await this.store.saveBackup(current, label);
    await this.store.applyExport(exported);
    await this.init();
    return summarizeExport(exported);
  }

  listBackups(): Promise<string[]> {
    return this.store.listBackups();
  }

  /** Restore a recovery snapshot; the data being replaced is itself backed up. */
  async restoreBackup(label: string): Promise<StoreExportSummary | undefined> {
    const backup = await this.store.loadBackup(label);
    if (!backup) return undefined;
    const current = await this.store.exportData();
    await this.store.saveBackup(current, `pre-restore-${this.clock.now()}`);
    await this.store.applyExport(backup);
    await this.init();
    return summarizeExport(backup);
  }

  private async refreshContentMeta(packId?: string): Promise<void> {
    const existing = await this.loadContentMeta();
    const first = this.puzzles.values().next().value as NormalizedPuzzle | undefined;
    const meta: ContentSetMeta = {
      packId: packId ?? existing?.packId ?? '',
      contentSchemaVersion: first?.contentSchemaVersion ?? '1.0.0',
      count: this.puzzles.size,
      loadedAt: existing?.loadedAt ?? this.clock.now(),
    };
    await this.store.saveMeta(META_CONTENT_SET, meta);
  }

  getScheduleState(key: string): ScheduleStateDetails | undefined {
    const direct = this.schedules.get(key);
    if (direct) return direct.schedule;
    // Legacy pre-B4 `program:puzzle` lookup: resolve across collection scopes
    // so old callers (History, Puzzles screens, existing tests) keep working.
    // Prefers the active collection, then the default, then first inserted.
    const parsed = parseScheduleKey(key);
    if (parsed && parsed.collectionId === undefined) {
      return this.legacyScheduleFor(parsed.programId, parsed.puzzleId).schedule;
    }
    return undefined;
  }

  /**
   * Resolve a (program, puzzle) pair across collection scopes for legacy
   * callers that do not pass a collection. Returns the matching schedule, if
   * any, and the key to use for it (existing scope, else the default scope).
   */
  private legacyScheduleFor(
    programId: string,
    puzzleId: string,
  ): { key: string; schedule: ScheduleStateDetails | undefined } {
    let fallback: { key: string; schedule: ScheduleStateDetails | undefined } | undefined;
    for (const [key, state] of this.schedules) {
      const parsed = parseScheduleKey(key);
      if (!parsed || parsed.programId !== programId || parsed.puzzleId !== puzzleId) continue;
      if (parsed.collectionId === this.activeCollectionId) {
        return { key, schedule: state.schedule };
      }
      if (parsed.collectionId === DEFAULT_COLLECTION_ID && !fallback) {
        fallback = { key, schedule: state.schedule };
      }
      fallback ??= { key, schedule: state.schedule };
    }
    return (
      fallback ?? {
        key: `${programId}:${DEFAULT_COLLECTION_ID}:${puzzleId}`,
        schedule: undefined,
      }
    );
  }

  /** Exact schedule lookup within one collection scope (no cross-scope fallback). */
  private scopedScheduleFor(
    programId: string,
    collectionId: string,
    puzzleId: string,
  ): { key: string; schedule: ScheduleStateDetails | undefined } {
    const key = `${programId}:${collectionId}:${puzzleId}`;
    return { key, schedule: this.schedules.get(key)?.schedule };
  }

  getAttemptCount(): number {
    return this.attempts.size;
  }

  /** The open (not-yet-finished) attempt for a session, if any. */
  getActiveAttempt(sessionId: string): AttemptRecord | undefined {
    const session = this.sessions.get(sessionId);
    const id = session?.activeAttemptId?.value;
    return id ? this.attempts.get(id) : undefined;
  }

  /** Current persisted session for a program, for dashboard/resume affordances. */
  getActiveSession(programId: string): SessionState | undefined {
    const sessionId = this.activeSessionByProgram.get(programId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    return session ? { ...session, activeAttemptId: session.activeAttemptId ? { ...session.activeAttemptId } : undefined } : undefined;
  }

  // --- TrainingService ----------------------------------------------------

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const programId = request.programId;
    let sessionId = request.sessionId ?? this.activeSessionByProgram.get(programId);
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    const now = this.clock.now();

    if (!session) {
      sessionId = sessionId ?? this.idFactory();
      session = {
        sessionSchemaVersion: '1.0.0',
        sessionId,
        programId,
        collectionId: request.collectionId,
        scheduleRevision: 0,
        startedAt: now,
        lastActivityAt: now,
      };
    } else {
      session.lastActivityAt = now;
      if (request.collectionId) session.collectionId = request.collectionId;
    }

    this.sessions.set(session.sessionId, session);
    this.activeSessionByProgram.set(programId, session.sessionId);
    await this.store.saveSession(session);
    await this.persistActiveSessions();

    const scheduleStates: Record<string, ScheduleStateDetails> = {};
    for (const [key, state] of this.schedules) {
      const parsed = parseScheduleKey(key);
      if (!parsed || parsed.programId !== programId) continue;
      if (request.collectionId && parsed.collectionId !== request.collectionId) continue;
      scheduleStates[key] = { ...state.schedule };
    }

    return { session: { ...session }, scheduleStates };
  }

  async loadPuzzle(request: LoadPuzzleRequest): Promise<LoadPuzzleResponse> {
    const puzzle = this.puzzles.get(request.puzzleId);
    if (!puzzle) throw new Error(`Puzzle not found: ${request.puzzleId}`);
    return { puzzle: { ...puzzle } };
  }

  async startAttempt(request: StartAttemptRequest): Promise<StartAttemptResponse> {
    const puzzle = this.puzzles.get(request.progressKey.puzzleId);
    if (!puzzle) throw new Error(`Puzzle not found: ${request.progressKey.puzzleId}`);

    const key = progressKeyToString(request.progressKey);
    let state = this.schedules.get(key);
    if (!state) {
      state = this.scheduler.createState();
      this.schedules.set(key, state);
    }

    const attemptId: AttemptId = { value: this.idFactory() };
    const started = this.scheduler.startAttempt(state, attemptId, request.progressKey);
    state = started.state;
    this.schedules.set(key, state);
    await this.store.saveSchedule(key, state);

    const now = this.clock.now();
    const attempt: AttemptRecord = {
      attemptSchemaVersion: '1.0.0',
      attemptId,
      progressKey: request.progressKey,
      sessionId: request.sessionId,
      scheduleRevisionBefore: state.revision,
      contentHash: `${puzzle.id}:${puzzle.contentSchemaVersion}:${puzzle.solverFen}`,
      startingFen: puzzle.solverFen,
      timing: emptyTiming(),
      events: [{ eventId: this.idFactory(), type: 'start', occurredAt: now }],
      startedAt: now,
      settingsHash: this.scheduler.getSettingsHash(),
    };
    this.attempts.set(attemptId.value, attempt);
    await this.store.saveAttempt(attempt);

    const session = this.sessions.get(request.sessionId);
    if (session) {
      session.activeAttemptId = attemptId;
      session.lastActivityAt = now;
      session.scheduleRevision = state.revision;
      this.sessions.set(session.sessionId, session);
      await this.store.saveSession(session);
    }

    return {
      attemptId,
      startingFen: puzzle.solverFen,
      scheduleRevision: state.revision,
    };
  }

  async recordEvent(request: RecordEventRequest): Promise<RecordEventResponse> {
    const attempt = this.attempts.get(request.attemptId.value);
    if (!attempt) {
      return { accepted: false, reason: 'attempt-not-found', sequenceAck: 0 };
    }
    const event = {
      ...request.event,
      eventId: request.event.eventId || this.idFactory(),
      occurredAt: request.event.occurredAt || this.clock.now(),
    };
    attempt.events.push(event);
    this.attempts.set(attempt.attemptId.value, attempt);
    await this.store.saveAttempt(attempt);
    return { accepted: true, sequenceAck: attempt.events.length };
  }

  async commitOutcome(request: CommitOutcomeRequest): Promise<CommitOutcomeResponse> {
    const attempt = this.attempts.get(request.attemptId.value);
    if (!attempt) {
      return { committed: false, reason: 'attempt-not-found', scheduleRevision: 0 };
    }

    const key = progressKeyToString(attempt.progressKey);
    const state = this.schedules.get(key);
    if (!state) {
      return { committed: false, reason: 'no-schedule', scheduleRevision: 0 };
    }

    const puzzle = this.puzzles.get(attempt.progressKey.puzzleId);
    const requiredMoves = puzzle ? Math.ceil(puzzle.solution.length / 2) : undefined;

    const result: CommitResult = this.scheduler.scoreAttempt({
      state,
      attemptId: request.attemptId,
      progressKey: attempt.progressKey,
      outcome: request.outcome,
      timing: request.timing,
      requiredMoves,
      failureReason: request.failureReason,
      expectedScheduleRevision: request.expectedScheduleRevision,
      idempotencyKey: request.idempotencyKey,
    });

    if (result.status === 'committed') {
      this.schedules.set(key, result.state);
      await this.store.saveSchedule(key, result.state);

      attempt.outcome = request.outcome;
      attempt.failureReason = request.failureReason;
      attempt.timing = request.timing;
      attempt.completedAt = result.receipt.committedAt;
      attempt.scheduleRevisionAfter = result.receipt.scheduleRevision;
      attempt.outcomeReceipt = toContractReceipt(result.receipt);
      if (request.finalEvents) {
        for (const event of request.finalEvents) {
          attempt.events.push({
            ...event,
            eventId: event.eventId || this.idFactory(),
            occurredAt: event.occurredAt || this.clock.now(),
          });
        }
      }
      this.attempts.set(attempt.attemptId.value, attempt);
      await this.store.saveAttempt(attempt);
      this.notifyLocalChange('attempt', attempt.attemptId.value);

      if (request.outcome === 'success') {
        await this.clearActiveAttempt(attempt.sessionId);
      }

      return {
        committed: true,
        receipt: toContractReceipt(result.receipt),
        newScheduleState: result.schedule,
        scheduleRevision: result.receipt.scheduleRevision,
      };
    }

    if (result.status === 'duplicate') {
      return {
        committed: true,
        receipt: toContractReceipt(result.receipt),
        newScheduleState: result.state.schedule,
        scheduleRevision: result.state.revision,
      };
    }

    return {
      committed: false,
      reason: result.reason,
      scheduleRevision: result.state.revision,
    };
  }

  async finishCorrection(request: FinishCorrectionRequest): Promise<FinishCorrectionResponse> {
    const attempt = this.attempts.get(request.attemptId.value);
    if (!attempt) return { accepted: false, reason: 'attempt-not-found' };

    const key = progressKeyToString(attempt.progressKey);
    const state = this.schedules.get(key);
    if (!state) return { accepted: false, reason: 'no-schedule' };

    const result = this.scheduler.finishCorrection(
      state,
      request.attemptId,
      request.idempotencyKey,
    );

    if (result.status === 'accepted') {
      this.schedules.set(key, result.state);
      await this.store.saveSchedule(key, result.state);

      attempt.timing = request.timing;
      const correctionEvent = request.correctionEvent ?? {
        eventId: this.idFactory(),
        type: 'correction-complete' as const,
        occurredAt: this.clock.now(),
      };
      attempt.events.push({
        ...correctionEvent,
        eventId: correctionEvent.eventId || this.idFactory(),
        occurredAt: correctionEvent.occurredAt || this.clock.now(),
      });
      this.attempts.set(attempt.attemptId.value, attempt);
      await this.store.saveAttempt(attempt);
      this.notifyLocalChange('attempt', attempt.attemptId.value);

      await this.clearActiveAttempt(attempt.sessionId);
      return { accepted: true };
    }

    // Duplicate delivery: already recorded; do not append another event.
    if (result.status === 'duplicate') {
      await this.clearActiveAttempt(attempt.sessionId);
      return { accepted: true };
    }

    return { accepted: false, reason: result.reason };
  }

  async selectNext(request: SelectNextRequest): Promise<SelectNextResponse> {
    const now = this.clock.now();
    const programId = request.programId;
    const reserved = new Set<string>();

    if (request.sessionId) {
      const session = this.sessions.get(request.sessionId);
      const activeId = session?.activeAttemptId?.value;
      if (activeId) {
        const attempt = this.attempts.get(activeId);
        if (attempt) reserved.add(progressKeyToString(attempt.progressKey));
      }
    }

    const candidates: Candidate[] = [];
    const newOrder: string[] = [];
    const seen = new Set<string>();
    const seenPuzzles = new Set<string>();
    const excluded = new Set(request.excludedKeys ?? []);
    // Scoped to the requested collection when it exists; otherwise the
    // legacy whole-library path (no collection passed, or unknown id).
    const scope = request.collectionId ? this.collections.get(request.collectionId) : undefined;
    const memberIds = scope
      ? scope.puzzleIds.filter((id) => this.puzzles.has(id))
      : this.puzzleOrder;
    const newIntroductionsAllowed =
      this.countIntroducedToday(programId, now, scope?.id) < this.settings.newIntroductionLimitPerDay;

    for (const puzzleId of memberIds) {
      if (excluded.has(puzzleId)) continue;
      const entry = scope
        ? this.scopedScheduleFor(programId, scope.id, puzzleId)
        : this.legacyScheduleFor(programId, puzzleId);
      const key = entry.key;
      const state = entry.schedule ?? this.scheduler.createState().schedule;
      if (state.state === 'new' && !newIntroductionsAllowed) {
        continue;
      }
      seen.add(key);
      seenPuzzles.add(puzzleId);
      candidates.push({ progressKey: key, state, orderKey: puzzleId });
      if (state.state === 'new') newOrder.push(key);
    }

    for (const [key, state] of this.schedules) {
      const parsed = parseScheduleKey(key);
      if (!parsed || parsed.programId !== programId) continue;
      // Exclusions apply here too: an excluded puzzle was skipped in the loop
      // above, so its key never reached `seen` — without this check the second
      // loop silently re-adds the puzzle that was just finished (and the
      // fallback below then picks it, which is the reported "it repeats").
      if (excluded.has(parsed.puzzleId)) continue;
      if (scope && parsed.collectionId !== scope.id) continue;
      if (!scope && seenPuzzles.has(parsed.puzzleId)) continue;
      if (seen.has(key)) continue;
      candidates.push({ progressKey: key, state: state.schedule, orderKey: key });
    }

    if (candidates.length === 0) {
      // Nothing selectable. When that is because the caller excluded the only
      // eligible puzzle (e.g. the one just finished), report when work returns
      // instead of claiming the library is empty.
      if (memberIds.length > 0 && memberIds.every((puzzleId) => excluded.has(puzzleId))) {
        let nextDueAt: number | undefined;
        for (const puzzleId of memberIds) {
          const entry = scope
            ? this.scopedScheduleFor(programId, scope.id, puzzleId)
            : this.legacyScheduleFor(programId, puzzleId);
          const dueAt = entry.schedule?.dueAt;
          if (dueAt !== undefined && (nextDueAt === undefined || dueAt < nextDueAt)) nextDueAt = dueAt;
        }
        return {
          puzzleId: null,
          reason: 'no-due-work',
          ...(nextDueAt !== undefined ? { nextDueAt } : {}),
        };
      }
      return { puzzleId: null, reason: 'queue-empty' };
    }

    const chosen = selectNextDue(candidates, { now, reservedKeys: reserved, newOrder });
    if (!chosen) {
      // Continue ordinary Next navigation with the earliest scheduled review
      // when nothing is normally eligible. New puzzles suppressed by the
      // introduction cap are deliberately not fallback candidates.
      const futureScheduled = candidates
        .filter((candidate) =>
          candidate.state.state !== 'new' &&
          candidate.state.dueAt !== undefined &&
          candidate.state.dueAt > now &&
          !reserved.has(candidate.progressKey),
        )
        .sort((a, b) =>
          a.state.dueAt! - b.state.dueAt! ||
          (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0),
        );
      if (futureScheduled[0]) {
        return { puzzleId: parseScheduleKey(futureScheduled[0].progressKey)?.puzzleId ?? futureScheduled[0].progressKey };
      }
      let nextDueAt: number | undefined;
      for (const candidate of candidates) {
        const dueAt = candidate.state.dueAt;
        if (dueAt === undefined || dueAt <= now || reserved.has(candidate.progressKey)) continue;
        if (nextDueAt === undefined || dueAt < nextDueAt) nextDueAt = dueAt;
      }
      return {
        puzzleId: null,
        reason: 'no-due-work',
        nextDueAt,
      };
    }

    return { puzzleId: parseScheduleKey(chosen)?.puzzleId ?? chosen };
  }

  /**
   * Abandon the session's current attempt without scoring it (skip). The
   * schedule is untouched; an `abandon` event is appended to the attempt's
   * history so the skipped attempt is never lost. The attempt reservation is
   * released so selection can proceed.
   *
   * `activeSeconds` records the solving time spent before abandoning, so
   * unscored practice (reveal, skip, unscored review) still shows up in the
   * STAT-001 totals. It never affects scoring or schedules.
   */
  async abandonAttempt(sessionId: string, activeSeconds?: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    const id = session?.activeAttemptId?.value;
    const attempt = id ? this.attempts.get(id) : undefined;
    if (attempt && attempt.outcome === undefined) {
      if (activeSeconds !== undefined && Number.isFinite(activeSeconds)) {
        attempt.timing = { ...attempt.timing, activeSolvingSeconds: Math.max(0, activeSeconds) };
      }
      attempt.events.push({
        eventId: this.idFactory(),
        type: 'abandon',
        occurredAt: this.clock.now(),
      });
      this.attempts.set(attempt.attemptId.value, attempt);
      await this.store.saveAttempt(attempt);
      this.notifyLocalChange('attempt', attempt.attemptId.value);
    }
    await this.clearActiveAttempt(sessionId);
  }

  /**
   * Queue counts. Without a collection id this covers the whole library
   * (legacy path: History screen, existing tests). With a known collection
   * id it covers that collection's membership only (Train picker); an
   * unknown id falls back to the whole library rather than stranding the UI.
   */
  queueSummary(programId: string, collectionId?: string): QueueSummary {
    const now = this.clock.now();
    const summary: QueueSummary = { total: 0, learned: 0, newCount: 0, due: 0 };
    const scope = collectionId ? this.collections.get(collectionId) : undefined;
    const memberIds = scope
      ? scope.puzzleIds.filter((id) => this.puzzles.has(id))
      : this.puzzleOrder;
    for (const puzzleId of memberIds) {
      summary.total += 1;
      const state = scope
        ? this.schedules.get(`${programId}:${scope.id}:${puzzleId}`)?.schedule
        : this.legacyScheduleFor(programId, puzzleId).schedule;
      const kind = state?.state;
      if (!kind || kind === 'new') {
        summary.newCount += 1;
        summary.due += 1;
        continue;
      }
      summary.learned += 1;
      if (state!.dueAt !== undefined && state!.dueAt <= now) summary.due += 1;
    }
    return summary;
  }

  async getSession(request: GetSessionRequest): Promise<SessionState> {
    const session = this.sessions.get(request.sessionId);
    if (!session) throw new Error(`Session not found: ${request.sessionId}`);
    return { ...session };
  }

  async getAttempt(request: GetAttemptRequest): Promise<AttemptRecord> {
    const attempt = this.attempts.get(request.attemptId.value);
    if (!attempt) throw new Error(`Attempt not found: ${request.attemptId.value}`);
    return structuredClone(attempt);
  }

  /**
   * Read-only list of raw attempt records, newest-first (by `startedAt`).
   *
   * No mutations, no grading, no scheduler writes. Returns defensive copies
   * (`structuredClone`); callers cannot affect service state by mutating the
   * result. The default limit (100) keeps the History screen cheap; pass an
   * explicit `limit` to page.
   */
  listAttempts(filter: { programId?: string; puzzleId?: string; limit?: number } = {}): AttemptRecord[] {
    const limit = filter.limit ?? 100;
    const matches: AttemptRecord[] = [];
    for (const attempt of this.attempts.values()) {
      if (filter.programId !== undefined && attempt.progressKey.programId !== filter.programId) {
        continue;
      }
      if (filter.puzzleId !== undefined && attempt.progressKey.puzzleId !== filter.puzzleId) {
        continue;
      }
      matches.push(attempt);
    }
    matches.sort((a, b) => b.startedAt - a.startedAt);
    return matches.slice(0, Math.max(0, limit)).map((attempt) => structuredClone(attempt));
  }

  // --- internals ----------------------------------------------------------

  /** Count puzzles introduced today (local day), optionally within one collection. */
  private countIntroducedToday(programId: string, now: number, collectionId?: string): number {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const dayStart = start.getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    let count = 0;
    for (const [key, state] of this.schedules) {
      const parsed = parseScheduleKey(key);
      if (!parsed || parsed.programId !== programId) continue;
      if (collectionId && parsed.collectionId !== collectionId) continue;
      const introducedAt = state.schedule.introducedAt;
      if (introducedAt !== undefined && introducedAt >= dayStart && introducedAt < dayEnd) {
        count += 1;
      }
    }
    return count;
  }

  private async clearActiveAttempt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeAttemptId = undefined;
    session.lastActivityAt = this.clock.now();
    this.sessions.set(sessionId, session);
    await this.store.saveSession(session);
  }

  private async persistActiveSessions(): Promise<void> {
    const record: Record<string, string> = {};
    for (const [programId, sessionId] of this.activeSessionByProgram) {
      record[programId] = sessionId;
    }
    await this.store.saveMeta(META_ACTIVE_SESSIONS, record);
  }
}
