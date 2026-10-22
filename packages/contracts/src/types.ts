/**
 * ChessEngram training service contracts
 * Architecture-neutral boundary between UI and training service.
 * Both online (server) and local (browser) adapters implement this interface.
 * These are provisional designs - not user-approved decisions.
 */

/**
 * Content schema versioning
 */
export type ContentSchemaVersion = "1.0.0";
export type ScheduleSchemaVersion = "1.0.0";
export type AttemptSchemaVersion = "1.0.0";
export type SessionSchemaVersion = "1.0.0";

/**
 * Scheduling states as defined in T03
 * New | Learning | Review | Relearning
 */
export type ScheduleState = "new" | "learning" | "review" | "relearning";

/**
 * Puzzle themes from Lichess
 */
export type PuzzleTheme = string;

/**
 * Normalized puzzle content - separate from Lichess presentation envelope
 * Preserves setup move convention from T02
 */
export interface NormalizedPuzzle {
  /** Unique puzzle identifier */
  id: string;
  /** Content schema version */
  contentSchemaVersion: ContentSchemaVersion;
  /** Rating snapshot at time of content capture */
  rating: number;
  /** Rating deviation snapshot */
  ratingDeviation?: number;
  /** Source system (e.g., "lichess") */
  source: string;
  /** Original puzzle ID from source */
  sourceId: string;
  /** Puzzle themes */
  themes: PuzzleTheme[];
  /** Source FEN - position before opponent's move (if setup move exists) */
  sourceFen: string;
  /** Setup move to reach solver position (UCI format). May be undefined if no setup. */
  setupMove?: string;
  /** Solver FEN - position after setup; side to move is solver */
  solverFen: string;
  /** Color to move from solverFen (solver's color) */
  solverColor: "white" | "black";
  /** Solution moves in UCI format, excluding setup move. Alternating solver/opponent. */
  solution: string[];
  /** Original fields preserved for provenance - do not expose to scheduling logic */
  originalFields: Record<string, unknown>;
}

/**
 * Timing segments for attempt
 */
export interface TimingSegments {
  /** Active solving time in seconds (monotonic) */
  activeSolvingSeconds: number;
  /** Correction time after first failure in seconds (monotonic) */
  correctionSeconds: number;
  /** Total interruption time in seconds */
  interruptionSeconds: number;
  /** Time during which input was disabled/hidden */
  hiddenSeconds: number;
  /** Whether timing modifier is trustworthy (no unlogged interruptions) */
  timingTrustworthy: boolean;
}

/**
 * Failure/retry policy preset (provisional)
 */
export type FailurePreset = "retry-reset" | "retry-retain" | "step-back";

/**
 * Schedule state details (derived projection per T03)
 * Scheduler state is derived; raw history is separate
 */
export interface ScheduleStateDetails {
  /** Schedule schema version */
  scheduleSchemaVersion: ScheduleSchemaVersion;
  /** Current state */
  state: ScheduleState;
  /** When due (epoch milliseconds) */
  dueAt?: number;
  /** For Review state: rung index in ladder */
  rung?: number;
  /** For Relearning state: rung to return to after success */
  returnRung?: number;
  /** Algorithm ID (provisional) */
  algorithmId: string;
  /** Algorithm version */
  algorithmVersion: string;
  /** Settings snapshot (for reproducibility) */
  settingsHash: string;
  /** Lapse count */
  lapseCount: number;
  /** Failure count in current relearning step */
  currentStepFailureCount: number;
  /** Introduction metadata */
  introducedAt?: number;
  /** Algorithm-specific payload (opaque, forward-compatible) */
  algorithmPayload?: Record<string, unknown>;
}

/**
 * Progress key scope — per (program, collection, puzzle).
 *
 * USER DECISION 2026-10-15 (B4): per-collection SEPARATE progress — the same
 * puzzle in two collections trains independently. This OVERRIDES the ADR-002
 * per-program proposal (where `collectionId` was context-only, not identity).
 * Do NOT edit docs/decisions/** for this override; this comment is the code
 * record. `collectionId` stays optional in the type for backward
 * compatibility; the service layer defaults a missing value to the default
 * collection, but schedule identity always includes the collection scope.
 */
export interface ProgressKey {
  /** Training program identifier */
  programId: string;
  /** Puzzle identifier */
  puzzleId: string;
  /** Collection scope (identity, not context). Defaults to the default collection. */
  collectionId?: string;
}

/**
 * Attempt identity and metadata
 */
export interface AttemptId {
  /** Unique attempt identifier */
  value: string;
}

/**
 * Idempotency/receipt for outcomes
 */
export interface OutcomeReceipt {
  /** Receipt identifier */
  receiptId: string;
  /** Attempt this receipt is for */
  attemptId: AttemptId;
  /** When committed (epoch milliseconds) */
  committedAt: number;
  /** Schedule revision at commit time */
  scheduleRevision: number;
}

/**
 * Attempt outcome - immutable once committed
 */
export type AttemptOutcome = "success" | "failure";

/**
 * Failure reason (for evidence; may be coarse initially)
 */
export type FailureReason =
  | "wrong-move"
  | "hint-assisted"
  | "reveal-assisted"
  | "abandoned"
  | "other";

/**
 * Attempt record (raw history - separate from schedule projection)
 */
export interface AttemptRecord {
  /** Attempt schema version */
  attemptSchemaVersion: AttemptSchemaVersion;
  /** Attempt ID */
  attemptId: AttemptId;
  /** Progress key */
  progressKey: ProgressKey;
  /** Session ID */
  sessionId: string;
  /** Schedule revision before this attempt */
  scheduleRevisionBefore: number;
  /** Schedule revision after commit (if committed) */
  scheduleRevisionAfter?: number;
  /** Puzzle content revision/hash */
  contentHash: string;
  /** Starting position FEN (solverFen) */
  startingFen: string;
  /** Outcome if committed */
  outcome?: AttemptOutcome;
  /** Failure reason if failed */
  failureReason?: FailureReason;
  /** Timing segments */
  timing: TimingSegments;
  /** Events sequence (move events, assistance, etc.) */
  events: AttemptEvent[];
  /** When started (epoch milliseconds) */
  startedAt: number;
  /** When completed/scored (epoch milliseconds) */
  completedAt?: number;
  /** Outcome receipt if committed */
  outcomeReceipt?: OutcomeReceipt;
  /** Settings snapshot at attempt time */
  settingsHash: string;
}

/**
 * Attempt event types
 */
export type AttemptEventType =
  | "start"
  | "move"
  | "wrong-move"
  | "hint"
  | "reveal"
  | "pause"
  | "resume"
  | "background"
  | "foreground"
  | "correction-complete"
  | "abandon"
  | "complete";

/**
 * Attempt event
 */
export interface AttemptEvent {
  /** Event ID (stable, ordered) */
  eventId: string;
  /** Event type */
  type: AttemptEventType;
  /** When event occurred (epoch milliseconds) */
  occurredAt: number;
  /** Event-specific payload */
  payload?: Record<string, unknown>;
}

/**
 * Session state
 */
export interface SessionState {
  /** Session schema version */
  sessionSchemaVersion: SessionSchemaVersion;
  /** Session ID */
  sessionId: string;
  /** Training program ID */
  programId: string;
  /** Collection ID */
  collectionId?: string;
  /** Active attempt ID if any */
  activeAttemptId?: AttemptId;
  /** Schedule revision */
  scheduleRevision: number;
  /** When session started */
  startedAt: number;
  /** Last activity time */
  lastActivityAt: number;
}
