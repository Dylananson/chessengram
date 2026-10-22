/**
 * UI-facing adapter over the local training service.
 *
 * Keeps the small amount of per-attempt UI bookkeeping (current attempt id and
 * the schedule revision to expect at commit time) out of the screen code. All
 * scheduling/scoring authority stays in `LocalTrainingService` / the scheduler.
 *
 * Idempotency keys are derived from the attempt id only (never the clock), so a
 * double-submit, retry, or reload maps to the same key and the scheduler
 * answers with the original receipt instead of double-applying.
 */

import type {
  AttemptRecord,
  CommitOutcomeRequest,
  FailureReason,
  NormalizedPuzzle,
  ProgressKey,
  TimingSegments,
} from '@chessengram/contracts';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_PROGRAM_ID,
  LocalTrainingService,
  progressKeyToString,
  type LocalTrainingServiceOptions,
} from './scheduler-service.ts';
import { LocalStore } from './storage/local-store.ts';
import { InMemoryStorageBackend } from './storage/memory-backend.ts';

/**
 * Commit an outcome, tolerating a schedule revision that moved under us.
 *
 * `startAttempt` captures the puzzle's schedule revision, and between starting
 * and finishing it that revision can legitimately change: a **sync apply**
 * replays schedules when it pulls changes, and a restart reads a fresh revision.
 * The reducer then rejects the commit as **stale** — which the adapter used to
 * swallow entirely, losing the attempt and leaving the puzzle due, so the queue
 * served the very same puzzle again ("I had to repeat it").
 *
 * On a stale rejection the reducer reports the *live* revision, so retry once
 * with it. A duplicate delivery is harmless: the idempotency key makes the
 * reducer answer `duplicate`, which counts as recorded.
 */
export async function commitOutcomeTolerant(
  service: Pick<LocalTrainingService, 'commitOutcome'>,
  build: (expectedScheduleRevision: number) => CommitOutcomeRequest,
  expectedScheduleRevision: number,
): Promise<{ recorded: boolean; scheduleRevision: number }> {
  let response = await service.commitOutcome(build(expectedScheduleRevision));
  if (!response.committed && response.reason === 'stale-schedule-revision') {
    response = await service.commitOutcome(build(response.scheduleRevision));
  }
  return { recorded: response.committed, scheduleRevision: response.scheduleRevision };
}

export interface StartAttemptResult {
  attemptId: string;
  startingFen: string;
  scheduleRevision: number;
}

export class TrainingAdapter {
  private readonly service: LocalTrainingService;
  private currentSessionId?: string;
  private currentProgramId = DEFAULT_PROGRAM_ID;
  private currentCollectionId: string | undefined = DEFAULT_COLLECTION_ID;
  private currentAttemptId?: string;
  private currentProgressKey?: ProgressKey;
  private currentExpectedRevision = 0;
  private skipList = new Set<string>();

  constructor(service: LocalTrainingService) {
    this.service = service;
  }

  /** Convenience constructor for tests: an in-memory, isolated service. */
  static withInMemoryStore(
    options: Omit<LocalTrainingServiceOptions, 'store'> = {},
  ): TrainingAdapter {
    return new TrainingAdapter(
      new LocalTrainingService({ store: new LocalStore(new InMemoryStorageBackend()), ...options }),
    );
  }

  getService(): LocalTrainingService {
    return this.service;
  }

  getSessionId(): string | undefined {
    return this.currentSessionId;
  }

  getActiveAttemptId(): string | undefined {
    return this.currentAttemptId;
  }

  async startSession(
    programId = DEFAULT_PROGRAM_ID,
    collectionId: string | undefined = DEFAULT_COLLECTION_ID,
  ) {
    this.currentProgramId = programId;
    this.currentCollectionId = collectionId;
    this.skipList.clear();
    const result = await this.service.startSession({ programId, collectionId });
    this.currentSessionId = result.session.sessionId;
    return result;
  }

  async loadPuzzle(puzzleId: string): Promise<NormalizedPuzzle> {
    const result = await this.service.loadPuzzle({ puzzleId });
    return result.puzzle;
  }

  /**
   * Drop the in-memory attempt reservation and start a fresh session. Used after
   * the underlying store is replaced (data import/restore) so no stale attempt
   * or progress key survives (PB5).
   */
  async reloadAfterDataChange(
    programId = DEFAULT_PROGRAM_ID,
    collectionId: string | undefined = DEFAULT_COLLECTION_ID,
  ): Promise<void> {
    this.currentAttemptId = undefined;
    this.currentProgressKey = undefined;
    this.currentExpectedRevision = 0;
    await this.startSession(programId, collectionId);
  }

  /**
   * Pick the next puzzle.
   *
   * `excludePuzzleIds` is how the view keeps a puzzle it has *just finished*
   * out of the selection: when nothing else is due, the scheduler deliberately
   * falls back to the earliest **future**-scheduled puzzle (UX-005), and right
   * after a success or failure that is the puzzle you just did — which reads as
   * "I have to repeat it again".
   */
  async selectNext(
    options: { excludePuzzleIds?: readonly string[] } = {},
  ): Promise<{ puzzleId: string | null; nextDueAt?: number; reason?: string }> {
    if (!this.currentSessionId) await this.startSession();
    const excluded = new Set(this.skipList);
    for (const puzzleId of options.excludePuzzleIds ?? []) excluded.add(puzzleId);
    const result = await this.service.selectNext({
      sessionId: this.currentSessionId!,
      programId: this.currentProgramId,
      collectionId: this.currentCollectionId,
      excludedKeys: excluded.size > 0 ? [...excluded] : undefined,
    });
    return result;
  }

  async startAttempt(puzzle: NormalizedPuzzle, progressKey?: ProgressKey): Promise<StartAttemptResult> {
    if (!this.currentSessionId) await this.startSession();
    const pk: ProgressKey = progressKey ?? {
      programId: this.currentProgramId,
      puzzleId: puzzle.id,
      collectionId: this.currentCollectionId,
    };

    const result = await this.service.startAttempt({
      sessionId: this.currentSessionId!,
      progressKey: pk,
      expectedScheduleRevision: 0,
    });

    this.currentAttemptId = result.attemptId.value;
    this.currentProgressKey = pk;
    this.currentExpectedRevision = result.scheduleRevision;
    return {
      attemptId: result.attemptId.value,
      startingFen: result.startingFen,
      scheduleRevision: result.scheduleRevision,
    };
  }

  /** Adopt an attempt loaded from persistence (reload resume). */
  resumeAttempt(attempt: AttemptRecord): void {
    this.currentAttemptId = attempt.attemptId.value;
    this.currentProgressKey = attempt.progressKey;
    this.currentExpectedRevision = attempt.scheduleRevisionBefore;
  }

  async recordMove(moveUci: string, correct: boolean): Promise<void> {
    if (!this.currentAttemptId) return;
    await this.service.recordEvent({
      attemptId: { value: this.currentAttemptId },
      event: {
        eventId: `${this.currentAttemptId}-move-${moveUci}-${correct ? 'ok' : 'bad'}`,
        type: 'move',
        occurredAt: Date.now(),
        payload: { move: moveUci, uci: moveUci, correct },
      },
    });
  }

  async recordWrongMove(moveUci: string): Promise<void> {
    if (!this.currentAttemptId) return;
    await this.service.recordEvent({
      attemptId: { value: this.currentAttemptId },
      event: {
        eventId: `${this.currentAttemptId}-wrong-${moveUci}`,
        type: 'wrong-move',
        occurredAt: Date.now(),
        payload: { move: moveUci, uci: moveUci },
      },
    });
  }

  async commitSuccess(timing: TimingSegments): Promise<boolean> {
    if (!this.currentAttemptId) return false;
    const attemptId = this.currentAttemptId;
    const result = await commitOutcomeTolerant(
      this.service,
      (expectedScheduleRevision) => ({
        attemptId: { value: attemptId },
        outcome: 'success',
        timing,
        idempotencyKey: `success-${attemptId}`,
        expectedScheduleRevision,
        finalEvents: [
          { eventId: `${attemptId}-complete`, type: 'complete', occurredAt: Date.now() },
        ],
      }),
      this.currentExpectedRevision,
    );
    this.currentExpectedRevision = result.scheduleRevision;
    this.currentAttemptId = undefined;
    return result.recorded;
  }

  async commitFailure(timing: TimingSegments, reason: FailureReason = 'wrong-move'): Promise<boolean> {
    if (!this.currentAttemptId) return false;
    const attemptId = this.currentAttemptId;
    const result = await commitOutcomeTolerant(
      this.service,
      (expectedScheduleRevision) => ({
        attemptId: { value: attemptId },
        outcome: 'failure',
        failureReason: reason,
        timing,
        idempotencyKey: `fail-${attemptId}`,
        expectedScheduleRevision,
      }),
      this.currentExpectedRevision,
    );
    this.currentExpectedRevision = result.scheduleRevision;
    // Keep the attempt reserved so correction completion can be recorded.
    return result.recorded;
  }

  async finishCorrection(timing: TimingSegments): Promise<void> {
    if (!this.currentAttemptId) return;
    const attemptId = this.currentAttemptId;
    await this.service.finishCorrection({
      attemptId: { value: attemptId },
      timing,
      idempotencyKey: `correction-${attemptId}`,
      correctionEvent: {
        eventId: `${attemptId}-correction-complete`,
        type: 'correction-complete',
        occurredAt: Date.now(),
      },
    });
    this.currentAttemptId = undefined;
  }

  /** Drop the current attempt without scoring (used when skipping). */
  releaseAttempt(): void {
    this.currentAttemptId = undefined;
    this.currentProgressKey = undefined;
  }

  /**
   * Abandon the current attempt through the service: releases the reservation,
   * appends an `abandon` event, and (optionally) skips this puzzle for the next
   * selection call so the user moves on rather than immediately re-seeing it.
   */
  async abandonCurrentAttempt(opts: { skip?: boolean; activeSeconds?: number } = {}): Promise<void> {
    if (this.currentProgressKey && opts.skip) {
      this.skipList.add(this.currentProgressKey.puzzleId);
    }
    if (this.currentSessionId && this.currentAttemptId) {
      await this.service.abandonAttempt(this.currentSessionId, opts.activeSeconds);
    }
    this.releaseAttempt();
  }

  /** Record a non-move assistance event (hint/reveal) for the current attempt. */
  async recordAssistance(kind: 'hint' | 'reveal'): Promise<void> {
    if (!this.currentAttemptId) return;
    await this.service.recordEvent({
      attemptId: { value: this.currentAttemptId },
      event: {
        eventId: `${this.currentAttemptId}-${kind}-${Math.random().toString(36).slice(2, 8)}`,
        type: kind,
        occurredAt: Date.now(),
        payload: {},
      },
    });
  }

  describeCurrentAttempt(): { attemptId?: string; progressKey?: ProgressKey } {
    return {
      attemptId: this.currentAttemptId,
      progressKey: this.currentProgressKey ? { ...this.currentProgressKey } : undefined,
    };
  }

  /**
   * Read-only: newest recorded attempts for a puzzle (for post-completion
   * review). Delegates to the service's read API; no writes, no grading, no
   * reservation changes. Returns defensive copies (the service clones).
   */
  listAttemptsForPuzzle(puzzleId: string, limit = 5): AttemptRecord[] {
    const programId = this.currentProgressKey?.programId ?? this.currentProgramId;
    return this.service.listAttempts({ programId, puzzleId, limit });
  }

  keyOf(key: ProgressKey): string {
    return progressKeyToString(key);
  }
}
