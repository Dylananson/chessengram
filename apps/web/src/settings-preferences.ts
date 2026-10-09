/**
 * Curated scheduler preferences (PB4).
 *
 * Only a small, user-meaningful subset of `SchedulerSettings` is persisted.
 * The rest is always re-derived from `DEFAULT_SETTINGS` at load time, so
 * improving a default in a later build is picked up automatically and the
 * stored schema stays small and migration-friendly.
 *
 * Persisted values are validated and clamped on read: a corrupt or
 * out-of-range stored value can never silently bend the scheduler.
 */

import type { FailurePreset } from '@chessreps/contracts';
import {
  DEFAULT_TIMING_POLICY,
  resolveSettings,
  type SchedulerSettings,
} from '@chessreps/scheduler';

/** Storage key for the program-agnostic curated settings (per-program: later). */
export const SCHEDULER_SETTINGS_KEY = 'scheduler';

export interface CuratedSettings {
  failurePreset: FailurePreset;
  /** Applied by the `step-back` preset. */
  stepBackAmount: number;
  /** Applied by the `retry-retain` preset. */
  retryRetainAmount: number;
  newIntroductionLimitPerDay: number;
  timingEnabled: boolean;
  relearningMinutes: number;
}

export const FAILURE_PRESETS: readonly FailurePreset[] = ['retry-reset', 'retry-retain', 'step-back'];

export const CURATED_DEFAULTS: CuratedSettings = {
  failurePreset: 'retry-reset',
  stepBackAmount: 1,
  retryRetainAmount: 0,
  newIntroductionLimitPerDay: 10,
  timingEnabled: true,
  relearningMinutes: 10,
};

const FAILURE_PRESET_LABELS: Record<FailurePreset, string> = {
  'retry-reset': 'Failure restarts the ladder (retry-reset)',
  'retry-retain': 'Failure keeps the current step (retry-retain)',
  'step-back': 'Failure steps back a few rungs (step-back)',
};

export function failurePresetLabel(preset: FailurePreset): string {
  return FAILURE_PRESET_LABELS[preset];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function asPreset(value: unknown): FailurePreset {
  return typeof value === 'string' && (FAILURE_PRESETS as readonly string[]).includes(value)
    ? (value as FailurePreset)
    : CURATED_DEFAULTS.failurePreset;
}

/** Validate + clamp an arbitrary stored/parsed value into a safe CuratedSettings. */
export function parseCurated(raw: unknown): CuratedSettings {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    failurePreset: asPreset(record.failurePreset),
    stepBackAmount: clampInt(record.stepBackAmount, 1, 10, CURATED_DEFAULTS.stepBackAmount),
    retryRetainAmount: clampInt(record.retryRetainAmount, 0, 10, CURATED_DEFAULTS.retryRetainAmount),
    newIntroductionLimitPerDay: clampInt(
      record.newIntroductionLimitPerDay,
      0,
      999,
      CURATED_DEFAULTS.newIntroductionLimitPerDay,
    ),
    timingEnabled:
      typeof record.timingEnabled === 'boolean' ? record.timingEnabled : CURATED_DEFAULTS.timingEnabled,
    relearningMinutes: clampInt(record.relearningMinutes, 1, 1440, CURATED_DEFAULTS.relearningMinutes),
  };
}

/** Extract the curated subset from a fully-resolved SchedulerSettings. */
export function toCurated(settings: SchedulerSettings): CuratedSettings {
  return {
    failurePreset: settings.failurePreset,
    stepBackAmount: settings.stepBackAmount,
    retryRetainAmount: settings.retryRetainAmount,
    newIntroductionLimitPerDay: settings.newIntroductionLimitPerDay,
    timingEnabled: settings.timing.enabled,
    relearningMinutes: settings.relearningMinutes,
  };
}

/** Rebuild a full, resolved SchedulerSettings from the curated subset. */
export function fromCurated(curated: CuratedSettings): SchedulerSettings {
  const safe = parseCurated(curated);
  return resolveSettings({
    failurePreset: safe.failurePreset,
    stepBackAmount: safe.stepBackAmount,
    retryRetainAmount: safe.retryRetainAmount,
    newIntroductionLimitPerDay: safe.newIntroductionLimitPerDay,
    relearningMinutes: safe.relearningMinutes,
    timing: { ...DEFAULT_TIMING_POLICY, enabled: safe.timingEnabled },
  });
}
