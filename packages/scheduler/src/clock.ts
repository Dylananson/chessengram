/**
 * Injectable clock. The scheduler never reads the ambient Date.now() directly;
 * every time-dependent function receives a Clock or an explicit instant so that
 * identical inputs/history/settings/clock always produce identical output
 * (T03 §7; PROJECT_PLAN Q04/Q06).
 */

export interface Clock {
  /** Current epoch milliseconds. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Deterministic clock for tests and replay. */
export function fixedClock(epochMs: number): Clock {
  return { now: () => epochMs };
}

/** Advanceable clock for tests; still fully deterministic. */
export function mutableClock(startEpochMs: number): Clock & { set(epochMs: number): void; advance(ms: number): void } {
  let current = startEpochMs;
  return {
    now: () => current,
    set(epochMs: number) {
      current = epochMs;
    },
    advance(ms: number) {
      current += ms;
    },
  };
}
