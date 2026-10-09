/**
 * Scheduler settings, defaults and deterministic settings hashing.
 *
 * Implements T03 §4 "Proposed candidate defaults and exact arithmetic".
 * Every numeric value here is a PROPOSAL, not a user-approved product decision.
 * See docs/decisions/ADR-003-scheduler-defaults.md.
 */

import type { FailurePreset } from "../../contracts/src/types.ts";

export const SCHEDULE_SCHEMA_VERSION = "1.0.0" as const;

/**
 * Bounded, replaceable timing policy (T03 §4 "Small timing influence").
 * The scheduler treats this as an isolated plugin: disabling it yields f = 1.
 */
export interface TimingPolicySettings {
  /** Master switch. When false every interval uses the exact ladder base. */
  enabled: boolean;
  /** Maximum proportional adjustment (T03: 0.10 => f in [0.90, 1.10]). */
  coefficient: number;
  /** Target floor in seconds (T03: T = max(30, 15*n)). */
  minTargetSeconds: number;
  /** Seconds of target per required solver move (T03: 15). */
  secondsPerMove: number;
  /** Upper clamp for f. */
  maxFactor: number;
  /** Lower clamp for f. */
  minFactor: number;
}

/**
 * Complete scheduler configuration. Frozen (snapshotted) per scored attempt so
 * that mid-attempt settings changes cannot retroactively rewrite an outcome.
 */
export interface SchedulerSettings {
  algorithmId: string;
  algorithmVersion: string;
  /** Review interval ladder in elapsed days, indexed by rung. */
  ladderDays: readonly number[];
  /** Absolute cap applied to any computed interval. */
  maxIntervalDays: number;
  /** New -> Learning confirmation delay in minutes. */
  learningConfirmationMinutes: number;
  /** Learning/Relearning short retry delay in minutes. */
  learningRetryMinutes: number;
  /** Relearning step delay in minutes. */
  relearningMinutes: number;
  /** Configurable failure preset (T03 §5). */
  failurePreset: FailurePreset;
  /** `b` used by the step-back preset (b >= 1 recommended). */
  stepBackAmount: number;
  /** `b` used by the retry-retain preset (b >= 0; 0 retains the prior rung). */
  retryRetainAmount: number;
  timing: TimingPolicySettings;
  /** New introductions per study day, per program scope, no carryover. */
  newIntroductionLimitPerDay: number;
}

export const DEFAULT_TIMING_POLICY: TimingPolicySettings = {
  enabled: true,
  coefficient: 0.1,
  minTargetSeconds: 30,
  secondsPerMove: 15,
  maxFactor: 1.1,
  minFactor: 0.9,
};

/** T03 §4 proposed ladder: [1, 3, 7, 14, 30, 60, 120, 240] elapsed days. */
export const DEFAULT_LADDER_DAYS: readonly number[] = [1, 3, 7, 14, 30, 60, 120, 240];

export const DEFAULT_SETTINGS: SchedulerSettings = {
  algorithmId: "ladder-v1",
  algorithmVersion: "1.0.0",
  ladderDays: DEFAULT_LADDER_DAYS,
  maxIntervalDays: 240,
  learningConfirmationMinutes: 10,
  learningRetryMinutes: 1,
  relearningMinutes: 10,
  failurePreset: "retry-reset",
  stepBackAmount: 1,
  retryRetainAmount: 0,
  timing: DEFAULT_TIMING_POLICY,
  newIntroductionLimitPerDay: 10,
};

/**
 * Build a complete settings object, filling any omitted field from defaults.
 * The returned object is a fresh, deeply-cloned value so callers can freeze it.
 */
export function resolveSettings(partial?: Partial<SchedulerSettings>): SchedulerSettings {
  const timing: TimingPolicySettings = partial?.timing
    ? { ...DEFAULT_TIMING_POLICY, ...partial.timing }
    : { ...DEFAULT_TIMING_POLICY };
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    ladderDays: partial?.ladderDays ? [...partial.ladderDays] : [...DEFAULT_LADDER_DAYS],
    timing,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  return value;
}

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;
const encoder = new TextEncoder();

/**
 * Non-cryptographic deterministic 64-bit FNV-1a hash of a UTF-8 string.
 * Used only for stable settings identity/migration detection, not security.
 */
export function fnv1a64Hex(input: string): string {
  let hash = FNV_OFFSET_64;
  const bytes = encoder.encode(input);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Stable settings hash independent of object key insertion order.
 * Format: `fnv1a64:<hex>`.
 */
export function settingsHash(settings: SchedulerSettings): string {
  const json = JSON.stringify(canonicalize(settings));
  return `fnv1a64:${fnv1a64Hex(json)}`;
}
