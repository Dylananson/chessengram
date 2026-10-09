/**
 * TrainingService interface - core contract between UI and training service
 * Architecture-neutral; same interface serves online and local adapters.
 * Async promises fit both local DB and HTTP transports.
 * PROVISIONAL - design subject to review
 */

import type {
  AttemptEvent,
  AttemptId,
  AttemptOutcome,
  AttemptRecord,
  FailurePreset,
  FailureReason,
  NormalizedPuzzle,
  OutcomeReceipt,
  ProgressKey,
  ScheduleStateDetails,
  SessionState,
  TimingSegments,
} from "./types.ts";

/**
 * Request to start or resume a session
 */
export interface StartSessionRequest {
  /** Training program ID */
  programId: string;
  /** Collection ID (optional) */
  collectionId?: string;
  /** Session ID if resuming existing session */
  sessionId?: string;
  /** Failure preset for this session */
  failurePreset?: FailurePreset;
}

/**
 * Response from starting/resuming session
 */
export interface StartSessionResponse {
  /** Session state */
  session: SessionState;
  /** Current schedule state for progress keys in scope */
  scheduleStates: Record<string, ScheduleStateDetails>;
}

/**
 * Request to load puzzle content
 */
export interface LoadPuzzleRequest {
  /** Puzzle ID to load */
  puzzleId: string;
}

/**
 * Response with puzzle content
 */
export interface LoadPuzzleResponse {
  /** Normalized puzzle */
  puzzle: NormalizedPuzzle;
}

/**
 * Request to start a new attempt
 */
export interface StartAttemptRequest {
  /** Session ID */
  sessionId: string;
  /** Progress key for puzzle */
  progressKey: ProgressKey;
  /** Schedule revision expected */
  expectedScheduleRevision: number;
}

/**
 * Response when starting attempt
 */
export interface StartAttemptResponse {
  /** Attempt ID */
  attemptId: AttemptId;
  /** Starting FEN (solver position) */
  startingFen: string;
  /** Schedule revision */
  scheduleRevision: number;
}

/**
 * Request to record attempt event
 */
export interface RecordEventRequest {
  /** Attempt ID */
  attemptId: AttemptId;
  /** Event to record */
  event: AttemptEvent;
}

/**
 * Response after recording event
 */
export interface RecordEventResponse {
  /** Whether event was accepted */
  accepted: boolean;
  /** If not accepted, reason */
  reason?: string;
  /** Event sequence number/ack */
  sequenceAck: number;
}

/**
 * Request to commit scored outcome
 */
export interface CommitOutcomeRequest {
  /** Attempt ID */
  attemptId: AttemptId;
  /** Outcome */
  outcome: AttemptOutcome;
  /** Failure reason if failure */
  failureReason?: FailureReason;
  /** Timing segments */
  timing: TimingSegments;
  /** Final events to include */
  finalEvents?: AttemptEvent[];
  /** Expected schedule revision */
  expectedScheduleRevision: number;
  /** Idempotency key to prevent duplicate commits */
  idempotencyKey: string;
}

/**
 * Response after committing outcome
 */
export interface CommitOutcomeResponse {
  /** Whether committed */
  committed: boolean;
  /** Outcome receipt if committed */
  receipt?: OutcomeReceipt;
  /** Updated schedule state */
  newScheduleState?: ScheduleStateDetails;
  /** If not committed, reason (conflict, duplicate, etc.) */
  reason?: string;
  /** Schedule revision */
  scheduleRevision: number;
}

/**
 * Request to finish correction (after failure)
 */
export interface FinishCorrectionRequest {
  /** Attempt ID */
  attemptId: AttemptId;
  /** Timing segments including correction time */
  timing: TimingSegments;
  /** Correction completion event */
  correctionEvent?: AttemptEvent;
  /** Idempotency key */
  idempotencyKey: string;
}

/**
 * Response after finishing correction
 */
export interface FinishCorrectionResponse {
  /** Whether accepted */
  accepted: boolean;
  /** Reason if not accepted */
  reason?: string;
}

/**
 * Request to select next puzzle
 */
export interface SelectNextRequest {
  /** Session ID */
  sessionId: string;
  /** Training program constraints */
  programId: string;
  /** Collection ID */
  collectionId?: string;
  /**
   * Puzzle IDs to exclude from this selection call (e.g. skipped just now).
   * Applies to this call only; callers may keep a session-scoped skip list.
   */
  excludedKeys?: string[];
}

/**
 * Response with next puzzle selection
 */
export interface SelectNextResponse {
  /** Selected puzzle ID, or null if nothing eligible */
  puzzleId: string | null;
  /** Reason if no selection */
  reason?: "no-due-work" | "daily-limit-reached" | "queue-empty" | "in-correction";
  /** Next due info if applicable */
  nextDueAt?: number;
}

/**
 * Request to get session state
 */
export interface GetSessionRequest {
  /** Session ID */
  sessionId: string;
}

/**
 * Request to get attempt record
 */
export interface GetAttemptRequest {
  /** Attempt ID */
  attemptId: AttemptId;
}

/**
 * Core TrainingService interface
 * All methods return promises for async operation (HTTP or local DB)
 */
export interface TrainingService {
  /**
   * Start or resume a training session
   */
  startSession(request: StartSessionRequest): Promise<StartSessionResponse>;

  /**
   * Load normalized puzzle content
   */
  loadPuzzle(request: LoadPuzzleRequest): Promise<LoadPuzzleResponse>;

  /**
   * Start a new attempt for a puzzle
   */
  startAttempt(request: StartAttemptRequest): Promise<StartAttemptResponse>;

  /**
   * Record an event during attempt (move, pause, etc.)
   */
  recordEvent(request: RecordEventRequest): Promise<RecordEventResponse>;

  /**
   * Commit scored outcome (success or failure)
   * Idempotent via idempotencyKey
   */
  commitOutcome(request: CommitOutcomeRequest): Promise<CommitOutcomeResponse>;

  /**
   * Finish correction after a failed attempt
   * Does not change the scored outcome (immutable failure)
   */
  finishCorrection(request: FinishCorrectionRequest): Promise<FinishCorrectionResponse>;

  /**
   * Select next puzzle based on scheduling
   */
  selectNext(request: SelectNextRequest): Promise<SelectNextResponse>;

  /**
   * Get current session state
   */
  getSession(request: GetSessionRequest): Promise<SessionState>;

  /**
   * Get attempt record
   */
  getAttempt(request: GetAttemptRequest): Promise<AttemptRecord>;
}
