/**
 * Reference in-memory implementation used ONLY as a contract test double
 * This is NOT a real scheduler (T06 owns that). Provides minimal stub behavior
 * sufficient for contract tests.
 *
 * Key behaviors:
 * - Tracks attempts and sessions in memory
 * - Enforces basic idempotency via idempotencyKey
 * - Distinguishes failure from correction (correction doesn't change outcome)
 * - New/Learning/Review/Relearning state types available
 * - Generates simple schedule state transitions for testing
 */

import type {
  AttemptEvent,
  AttemptId,
  AttemptOutcome,
  AttemptRecord,
  CommitOutcomeRequest,
  CommitOutcomeResponse,
  FailurePreset,
  FinishCorrectionRequest,
  FinishCorrectionResponse,
  GetAttemptRequest,
  GetSessionRequest,
  LoadPuzzleRequest,
  LoadPuzzleResponse,
  NormalizedPuzzle,
  OutcomeReceipt,
  RecordEventRequest,
  RecordEventResponse,
  ScheduleStateDetails,
  SelectNextRequest,
  SelectNextResponse,
  SessionState,
  StartAttemptRequest,
  StartAttemptResponse,
  StartSessionRequest,
  StartSessionResponse,
} from "./index.ts";
import type { TrainingService } from "./training-service.ts";

interface StoredAttempt extends AttemptRecord {
  committed: boolean;
  correctionFinished: boolean;
}

export class InMemoryTrainingService implements TrainingService {
  private sessions = new Map<string, SessionState>();
  private attempts = new Map<string, StoredAttempt>();
  private scheduleStates = new Map<string, ScheduleStateDetails>();
  private puzzles = new Map<string, NormalizedPuzzle>();
  private outcomeReceipts = new Map<string, OutcomeReceipt>();
  private idempotencyCache = new Map<string, CommitOutcomeResponse>();
  private eventSequence = 0;
  private receiptCounter = 0;
  private scheduleRevisionCounter = 0;
  private attemptIdCounter = 0;
  private eventIdCounter = 0;

  // Minimal stub for contract tests
  constructor(initialPuzzles?: NormalizedPuzzle[]) {
    if (initialPuzzles) {
      for (const puzzle of initialPuzzles) {
        this.puzzles.set(puzzle.id, puzzle);
        // Initialize schedule state for new puzzles
        const key = `${puzzle.id}`;
        this.scheduleStates.set(key, {
          scheduleSchemaVersion: "1.0.0",
          state: "new",
          algorithmId: "stub-v1",
          algorithmVersion: "1.0.0",
          settingsHash: "stub-hash",
          lapseCount: 0,
          currentStepFailureCount: 0,
        });
      }
    }
  }

  private nextAttemptId(): AttemptId {
    return { value: `attempt-${++this.attemptIdCounter}` };
  }

  private nextEventId(): string {
    return `event-${++this.eventIdCounter}`;
  }

  private nextReceiptId(): string {
    return `receipt-${++this.receiptCounter}`;
  }

  private nextScheduleRevision(): number {
    return ++this.scheduleRevisionCounter;
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const sessionId = request.sessionId ?? `session-${Date.now()}`;
    const now = Date.now();

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionSchemaVersion: "1.0.0",
        sessionId,
        programId: request.programId,
        collectionId: request.collectionId,
        activeAttemptId: undefined,
        scheduleRevision: this.scheduleRevisionCounter,
        startedAt: now,
        lastActivityAt: now,
      };
      this.sessions.set(sessionId, session);
    } else {
      session.lastActivityAt = now;
    }

    // Return schedule states for puzzles we know about
    const scheduleStates: Record<string, ScheduleStateDetails> = {};
    for (const [key, state] of this.scheduleStates.entries()) {
      scheduleStates[key] = { ...state };
    }

    return { session: { ...session }, scheduleStates };
  }

  async loadPuzzle(request: LoadPuzzleRequest): Promise<LoadPuzzleResponse> {
    const puzzle = this.puzzles.get(request.puzzleId);
    if (!puzzle) {
      throw new Error(`Puzzle not found: ${request.puzzleId}`);
    }
    return { puzzle: { ...puzzle } };
  }

  async startAttempt(request: StartAttemptRequest): Promise<StartAttemptResponse> {
    const now = Date.now();
    const attemptId = this.nextAttemptId();
    const key = `${request.progressKey.programId}:${request.progressKey.puzzleId}`;

    const storedAttempt: StoredAttempt = {
      attemptSchemaVersion: "1.0.0",
      attemptId,
      progressKey: request.progressKey,
      sessionId: request.sessionId,
      scheduleRevisionBefore: request.expectedScheduleRevision,
      contentHash: "stub-content-hash",
      startingFen: this.getPuzzleFen(request.progressKey.puzzleId),
      timing: {
        activeSolvingSeconds: 0,
        correctionSeconds: 0,
        interruptionSeconds: 0,
        hiddenSeconds: 0,
        timingTrustworthy: true,
      },
      events: [
        {
          eventId: this.nextEventId(),
          type: "start",
          occurredAt: now,
        },
      ],
      startedAt: now,
      settingsHash: "stub-hash",
      committed: false,
      correctionFinished: false,
    };
    this.attempts.set(attemptId.value, storedAttempt);

    const session = this.sessions.get(request.sessionId);
    if (session) {
      session.activeAttemptId = attemptId;
      session.lastActivityAt = now;
    }

    return {
      attemptId,
      startingFen: storedAttempt.startingFen,
      scheduleRevision: this.scheduleRevisionCounter,
    };
  }

  private getPuzzleFen(puzzleId: string): string {
    const puzzle = this.puzzles.get(puzzleId);
    return puzzle?.solverFen ?? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  }

  async recordEvent(request: RecordEventRequest): Promise<RecordEventResponse> {
    const attempt = this.attempts.get(request.attemptId.value);
    if (!attempt) {
      return {
        accepted: false,
        reason: "attempt-not-found",
        sequenceAck: this.eventSequence++,
      };
    }
    const now = Date.now();
    const eventWithId = {
      ...request.event,
      eventId: request.event.eventId ?? this.nextEventId(),
      occurredAt: request.event.occurredAt ?? now,
    };
    attempt.events.push(eventWithId);
    return {
      accepted: true,
      sequenceAck: this.eventSequence++,
    };
  }

  async commitOutcome(request: CommitOutcomeRequest): Promise<CommitOutcomeResponse> {
    // Check idempotency
    if (this.idempotencyCache.has(request.idempotencyKey)) {
      return this.idempotencyCache.get(request.idempotencyKey)!;
    }

    const attempt = this.attempts.get(request.attemptId.value);
    if (!attempt) {
      const resp: CommitOutcomeResponse = {
        committed: false,
        reason: "attempt-not-found",
        scheduleRevision: this.scheduleRevisionCounter,
      };
      this.idempotencyCache.set(request.idempotencyKey, resp);
      return resp;
    }

    if (attempt.committed) {
      // Return prior receipt
      const receipt = attempt.outcomeReceipt;
      const resp: CommitOutcomeResponse = {
        committed: true,
        receipt,
        newScheduleState: this.getScheduleState(attempt.progressKey),
        scheduleRevision: this.scheduleRevisionCounter,
      };
      this.idempotencyCache.set(request.idempotencyKey, resp);
      return resp;
    }

    // Commit outcome
    const now = Date.now();
    const receipt = {
      receiptId: this.nextReceiptId(),
      attemptId: request.attemptId,
      committedAt: now,
      scheduleRevision: this.nextScheduleRevision(),
    };
    attempt.outcome = request.outcome;
    attempt.failureReason = request.failureReason;
    attempt.timing = request.timing;
    attempt.completedAt = now;
    attempt.outcomeReceipt = receipt;
    attempt.committed = true;
    attempt.scheduleRevisionAfter = receipt.scheduleRevision;

    // Add final events
    if (request.finalEvents) {
      for (const ev of request.finalEvents) {
        attempt.events.push({
          ...ev,
          eventId: ev.eventId ?? this.nextEventId(),
          occurredAt: ev.occurredAt ?? now,
        });
      }
    }

    // Update schedule state based on outcome (simple stub)
    const key = `${attempt.progressKey.programId}:${attempt.progressKey.puzzleId}`;
    const current = this.scheduleStates.get(key);
    if (current) {
      if (request.outcome === "success") {
        if (current.state === "new") {
          current.state = "learning";
          current.dueAt = now + 10 * 60 * 1000; // 10 min
        } else if (current.state === "learning") {
          current.state = "review";
          current.rung = 0;
          current.dueAt = now + 24 * 60 * 60 * 1000; // 1 day
        } else if (current.state === "review") {
          current.state = "review";
          current.rung = Math.min((current.rung ?? 0) + 1, 7);
          current.dueAt = now + 24 * 60 * 60 * 1000 * ((current.rung ?? 0) + 1);
        } else if (current.state === "relearning") {
          current.state = "review";
          current.rung = current.returnRung ?? 0;
          current.dueAt = now + 24 * 60 * 60 * 1000 * (current.rung + 1);
        }
      } else if (request.outcome === "failure") {
        if (current.state === "review") {
          current.state = "relearning";
          current.returnRung = 0;
          current.lapseCount = (current.lapseCount ?? 0) + 1;
          current.dueAt = now + 10 * 60 * 1000; // 10 min
        } else if (current.state === "relearning") {
          current.state = "relearning";
          current.currentStepFailureCount = (current.currentStepFailureCount ?? 0) + 1;
          current.dueAt = now + 10 * 60 * 1000;
        } else {
          current.dueAt = now + 60 * 1000; // retry soon
        }
      }
    }

    this.outcomeReceipts.set(receipt.receiptId, receipt);
    const resp: CommitOutcomeResponse = {
      committed: true,
      receipt,
      newScheduleState: this.getScheduleState(attempt.progressKey),
      scheduleRevision: this.scheduleRevisionCounter,
    };
    this.idempotencyCache.set(request.idempotencyKey, resp);
    return resp;
  }

  private getScheduleState(progressKey: any): ScheduleStateDetails | undefined {
    const key = `${progressKey.programId}:${progressKey.puzzleId}`;
    const state = this.scheduleStates.get(key);
    return state ? { ...state } : undefined;
  }

  async finishCorrection(request: FinishCorrectionRequest): Promise<FinishCorrectionResponse> {
    const attempt = this.attempts.get(request.attemptId.value);
    if (!attempt) {
      return { accepted: false, reason: "attempt-not-found" };
    }
    if (attempt.correctionFinished) {
      return { accepted: true }; // idempotent
    }
    const now = Date.now();
    attempt.correctionFinished = true;
    if (request.correctionEvent) {
      attempt.events.push({
        ...request.correctionEvent,
        eventId: request.correctionEvent.eventId ?? this.nextEventId(),
        occurredAt: request.correctionEvent.occurredAt ?? now,
      });
    }
    // Correction completion does NOT change the scored outcome - immutable failure
    return { accepted: true };
  }

  async selectNext(request: SelectNextRequest): Promise<SelectNextResponse> {
    const now = Date.now();
    // Simple stub: find a puzzle with due work, or any new puzzle
    for (const [key, state] of this.scheduleStates.entries()) {
      if (state.dueAt && state.dueAt <= now) {
        const puzzleId = key.split(":")[1] ?? key;
        return { puzzleId };
      }
    }
    // If nothing due, return first new puzzle
    for (const [key, state] of this.scheduleStates.entries()) {
      if (state.state === "new") {
        const puzzleId = key.split(":")[1] ?? key;
        return { puzzleId };
      }
    }
    return { puzzleId: null, reason: "queue-empty" };
  }

  async getSession(request: GetSessionRequest): Promise<SessionState> {
    const session = this.sessions.get(request.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${request.sessionId}`);
    }
    return { ...session };
  }

  async getAttempt(request: GetAttemptRequest): Promise<AttemptRecord> {
    const attempt = this.attempts.get(request.attemptId.value);
    if (!attempt) {
      throw new Error(`Attempt not found: ${request.attemptId.value}`);
    }
    const { committed, correctionFinished, ...record } = attempt;
    return record;
  }

  // Test helper methods
  addPuzzle(puzzle: NormalizedPuzzle): void {
    this.puzzles.set(puzzle.id, puzzle);
    const key = `${puzzle.id}`;
    this.scheduleStates.set(key, {
      scheduleSchemaVersion: "1.0.0",
      state: "new",
      algorithmId: "stub-v1",
      algorithmVersion: "1.0.0",
      settingsHash: "stub-hash",
      lapseCount: 0,
      currentStepFailureCount: 0,
    });
  }

  setScheduleState(puzzleId: string, state: Partial<ScheduleStateDetails>): void {
    const key = `${puzzleId}`;
    const current = this.scheduleStates.get(key) ?? {
      scheduleSchemaVersion: "1.0.0",
      state: "new",
      algorithmId: "stub-v1",
      algorithmVersion: "1.0.0",
      settingsHash: "stub-hash",
      lapseCount: 0,
      currentStepFailureCount: 0,
    };
    this.scheduleStates.set(key, { ...current, ...state });
  }
}
