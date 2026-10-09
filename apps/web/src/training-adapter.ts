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
  FailureReason,
  NormalizedPuzzle,
  ProgressKey,
  TimingSegments,
} from '@chessreps/contracts';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_PROGRAM_ID,
  LocalTrainingService,
  progressKeyToString,
  type LocalTrainingServiceOptions,
} from './scheduler-service.ts';
import { LocalStore } from './storage/local-store.ts';
import { InMemoryStorageBackend } from './storage/memory-backend.ts';

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

  async selectNext(): Promise<{ puzzleId: string | null; nextDueAt?: number; reason?: string }> {
    if (!this.currentSessionId) await this.startSession();
    return this.service.selectNext({
      sessionId: this.currentSessionId!,
      programId: this.currentProgramId,
      collectionId: this.currentCollectionId,
      excludedKeys: this.skipList.size > 0 ? [...this.skipList] : undefined,
    });
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

  async commitSuccess(timing: TimingSegments): Promise<void> {
    if (!this.currentAttemptId) return;
    const attemptId = this.currentAttemptId;
    await this.service.commitOutcome({
      attemptId: { value: attemptId },
      outcome: 'success',
      timing,
      idempotencyKey: `success-${attemptId}`,
      expectedScheduleRevision: this.currentExpectedRevision,
      finalEvents: [
        { eventId: `${attemptId}-complete`, type: 'complete', occurredAt: Date.now() },
      ],
    });
    this.currentAttemptId = undefined;
  }

  async commitFailure(timing: TimingSegments, reason: FailureReason = 'wrong-move'): Promise<void> {
    if (!this.currentAttemptId) return;
    const attemptId = this.currentAttemptId;
    await this.service.commitOutcome({
      attemptId: { value: attemptId },
      outcome: 'failure',
      failureReason: reason,
      timing,
      idempotencyKey: `fail-${attemptId}`,
      expectedScheduleRevision: this.currentExpectedRevision,
    });
    // Keep the attempt reserved so correction completion can be recorded.
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
  async abandonCurrentAttempt(opts: { skip?: boolean } = {}): Promise<void> {
    if (this.currentProgressKey && opts.skip) {
      this.skipList.add(this.currentProgressKey.puzzleId);
    }
    if (this.currentSessionId && this.currentAttemptId) {
      await this.service.abandonAttempt(this.currentSessionId);
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

  keyOf(key: ProgressKey): string {
    return progressKeyToString(key);
  }
}
