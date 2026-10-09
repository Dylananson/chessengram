import type { NormalizedPuzzle } from './types.js';
import { InMemoryTrainingService } from '../../../packages/contracts/src/reference-implementation.ts';

export class TrainingAdapter {
  private service: InMemoryTrainingService;
  private currentSessionId?: string;
  private currentAttemptId?: string;

  constructor() {
    this.service = new InMemoryTrainingService();
  }

  async startSession(programId = 'player-spike-v1') {
    const result = await this.service.startSession({ programId });
    this.currentSessionId = result.session.sessionId;
    return result;
  }

  async loadPuzzle(puzzleId: string): Promise<NormalizedPuzzle> {
    const result = await this.service.loadPuzzle({ puzzleId });
    return result.puzzle;
  }

  async startAttempt(puzzle: NormalizedPuzzle, progressKey?: any) {
    if (!this.currentSessionId) {
      await this.startSession();
    }

    const pk = progressKey || {
      programId: 'player-spike-v1',
      puzzleId: puzzle.id,
    };

    const result = await this.service.startAttempt({
      sessionId: this.currentSessionId!,
      progressKey: pk,
      expectedScheduleRevision: 0,
    });

    this.currentAttemptId = result.attemptId.value;
    return result;
  }

  async recordMove(moveUci: string) {
    if (!this.currentAttemptId) return;
    await this.service.recordEvent({
      attemptId: { value: this.currentAttemptId },
      event: {
        eventId: `move-${Date.now()}`,
        type: 'move',
        occurredAt: Date.now(),
        payload: { move: moveUci },
      },
    });
  }

  async recordWrongMove(moveUci: string) {
    if (!this.currentAttemptId) return;
    await this.service.recordEvent({
      attemptId: { value: this.currentAttemptId },
      event: {
        eventId: `wrong-${Date.now()}`,
        type: 'wrong-move',
        occurredAt: Date.now(),
        payload: { move: moveUci },
      },
    });
  }

  async commitSuccess(_puzzle: NormalizedPuzzle, activeSolvingSeconds = 0) {
    if (!this.currentAttemptId) return;
    await this.service.commitOutcome({
      attemptId: { value: this.currentAttemptId },
      outcome: 'success',
      timing: {
        activeSolvingSeconds,
        correctionSeconds: 0,
        interruptionSeconds: 0,
        hiddenSeconds: 0,
        timingTrustworthy: true,
      },
      idempotencyKey: `success-${this.currentAttemptId}-${Date.now()}`,
      expectedScheduleRevision: 0,
    });
    this.currentAttemptId = undefined;
  }

  async commitFailure(_puzzle: NormalizedPuzzle, activeSolvingSeconds = 0) {
    if (!this.currentAttemptId) return;
    await this.service.commitOutcome({
      attemptId: { value: this.currentAttemptId },
      outcome: 'failure',
      failureReason: 'wrong-move',
      timing: {
        activeSolvingSeconds,
        correctionSeconds: 0,
        interruptionSeconds: 0,
        hiddenSeconds: 0,
        timingTrustworthy: true,
      },
      idempotencyKey: `fail-${this.currentAttemptId}-${Date.now()}`,
      expectedScheduleRevision: 0,
    });
    // Don't clear attemptId - need to finish correction
  }

  async finishCorrection(activeSolvingSeconds = 0) {
    if (!this.currentAttemptId) return;
    await this.service.finishCorrection({
      attemptId: { value: this.currentAttemptId },
      timing: {
        activeSolvingSeconds,
        correctionSeconds: 0,
        interruptionSeconds: 0,
        hiddenSeconds: 0,
        timingTrustworthy: true,
      },
      idempotencyKey: `corr-${this.currentAttemptId}-${Date.now()}`,
    });
    this.currentAttemptId = undefined;
  }

  getService() {
    return this.service;
  }
}
