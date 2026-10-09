/**
 * LocalTrainingService (T09-lite + T10).
 *
 * Implements the T04 `TrainingService` boundary over the real T06 scheduler
 * (`@chessreps/scheduler`) and a persistent `LocalStore`. It is the single
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
  resolveSettings,
  selectNextDue,
  type Candidate,
  type Clock,
  type CommitResult,
  type SchedulerSettings,
  type SchedulerState,
  systemClock,
} from '@chessreps/scheduler';
import type {
  AttemptId,
  AttemptRecord,
  NormalizedPuzzle,
  OutcomeReceipt,
  ProgressKey,
  ScheduleStateDetails,
  SessionState,
  TimingSegments,
} from '@chessreps/contracts';
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
} from '@chessreps/contracts';
import { LocalStore, META_ACTIVE_SESSIONS, META_CONTENT_SET, META_PUZZLE_ORDER } from './storage/local-store.ts';
import type { ContentSetMeta } from './storage/local-store.ts';

export const DEFAULT_PROGRAM_ID = 'local-spaced-reps-v1';
export const DEFAULT_COLLECTION_ID = 'lichess-900-1099-v1';

export function progressKeyToString(key: ProgressKey): string {
  return `${key.programId}:${key.puzzleId}`;
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

export interface LocalTrainingServiceOptions {
  store: LocalStore;
  clock?: Clock;
  settings?: Partial<SchedulerSettings>;
  idFactory?: () => string;
}

export class LocalTrainingService implements TrainingService {
  private readonly scheduler: Scheduler;
  private readonly store: LocalStore;
  private readonly clock: Clock;
  private readonly idFactory: () => string;

  private readonly schedules = new Map<string, SchedulerState>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly puzzles = new Map<string, NormalizedPuzzle>();
  private readonly activeSessionByProgram = new Map<string, string>();
  private puzzleOrder: string[] = [];
  private initialized = false;

  constructor(options: LocalTrainingServiceOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? makeId;
    this.scheduler = new Scheduler({
      clock: this.clock,
      settings: resolveSettings(options.settings),
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

    this.initialized = true;
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
    this.puzzleOrder = [];
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

  getScheduleState(key: string): ScheduleStateDetails | undefined {
    return this.schedules.get(key)?.schedule;
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
      if (this.keyInProgram(key, programId)) scheduleStates[key] = { ...state.schedule };
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

    for (const puzzleId of this.puzzleOrder) {
      const key = `${programId}:${puzzleId}`;
      seen.add(key);
      const state = this.schedules.get(key)?.schedule ?? this.scheduler.createState().schedule;
      candidates.push({ progressKey: key, state, orderKey: puzzleId });
      if (state.state === 'new') newOrder.push(key);
    }

    for (const [key, state] of this.schedules) {
      if (seen.has(key) || !this.keyInProgram(key, programId)) continue;
      candidates.push({ progressKey: key, state: state.schedule, orderKey: key });
    }

    if (candidates.length === 0) {
      return { puzzleId: null, reason: 'queue-empty' };
    }

    const chosen = selectNextDue(candidates, { now, reservedKeys: reserved, newOrder });
    if (!chosen) {
      let nextDueAt: number | undefined;
      for (const candidate of candidates) {
        const due = candidate.state.dueAt;
        if (due !== undefined && due > now) {
          nextDueAt = nextDueAt === undefined ? due : Math.min(nextDueAt, due);
        }
      }
      return { puzzleId: null, reason: 'no-due-work', nextDueAt };
    }

    return { puzzleId: chosen.slice(programId.length + 1) };
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

  // --- internals ----------------------------------------------------------

  private keyInProgram(key: string, programId: string): boolean {
    return key.startsWith(`${programId}:`);
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
