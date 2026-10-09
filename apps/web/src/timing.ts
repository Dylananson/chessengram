/**
 * Active/correction timing with interruption accounting (T03 §7).
 *
 * Tracks visible solver-thinking time separately from post-failure correction
 * time, excludes hidden/backgrounded time, and flags the attempt as untrustworthy
 * once any interruption occurred. The scheduler turns an untrustworthy attempt
 * into a neutral timing factor, so this is best-effort but wired end to end.
 */

import type { TimingSegments } from '@chessreps/contracts';

export interface AttemptTimerOptions {
  now?: () => number;
}

export class AttemptTimer {
  private readonly clock: () => number;
  private running = false;
  private segmentStart: number | undefined;
  private activeMs = 0;
  private correctionMs = 0;
  private hiddenMs = 0;
  private interruptionMs = 0;
  private hiddenSince: number | undefined;
  private trustworthy = true;
  private failed = false;

  constructor(options: AttemptTimerOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
  }

  get isFailed(): boolean {
    return this.failed;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isTrustworthy(): boolean {
    return this.trustworthy;
  }

  start(): void {
    if (this.running) return;
    this.segmentStart = this.clock();
    this.running = true;
  }

  private accumulate(now: number): void {
    if (!this.running || this.segmentStart === undefined) return;
    const delta = Math.max(0, now - this.segmentStart);
    if (this.failed) {
      this.correctionMs += delta;
    } else {
      this.activeMs += delta;
    }
    this.segmentStart = now;
  }

  /** Called on the first wrong solution move: later time counts as correction. */
  markFailure(): void {
    const now = this.clock();
    this.accumulate(now);
    this.failed = true;
    this.segmentStart = this.running ? now : undefined;
  }

  /** App hidden / backgrounded, device locked, or explicit pause. */
  interrupt(): void {
    if (this.hiddenSince !== undefined) return;
    const now = this.clock();
    this.accumulate(now);
    this.running = false;
    this.segmentStart = undefined;
    this.hiddenSince = now;
    this.trustworthy = false;
  }

  /** Input becomes available again; hidden time is recorded as an interruption. */
  resume(): void {
    if (this.hiddenSince === undefined) {
      this.start();
      return;
    }
    const now = this.clock();
    const away = Math.max(0, now - this.hiddenSince);
    this.hiddenMs += away;
    this.interruptionMs += away;
    this.hiddenSince = undefined;
    this.segmentStart = now;
    this.running = true;
  }

  /** Never mutates internal segment anchors, so it is safe to call repeatedly. */
  snapshot(): TimingSegments {
    const now = this.clock();
    let active = this.activeMs;
    let correction = this.correctionMs;
    if (this.running && this.segmentStart !== undefined) {
      const delta = Math.max(0, now - this.segmentStart);
      if (this.failed) {
        correction += delta;
      } else {
        active += delta;
      }
    }
    return {
      activeSolvingSeconds: Math.round(active / 1000),
      correctionSeconds: Math.round(correction / 1000),
      interruptionSeconds: Math.round(this.interruptionMs / 1000),
      hiddenSeconds: Math.round(this.hiddenMs / 1000),
      timingTrustworthy: this.trustworthy,
    };
  }
}
