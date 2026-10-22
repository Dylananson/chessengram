/**
 * ONL-007 — pure merge rules for synced Woodpecker sets, cycles and results.
 *
 * Local shapes come from `@chessengram/scheduler` (`WoodpeckerSetRecord`,
 * `WoodpeckerCycle`, `WoodpeckerCycleResult`); wire shapes are the frozen
 * `SyncWoodpeckerPayload` / `SyncWoodpeckerResultPayload` (`types.ts`).
 *
 * Rules (design: `docs/research/online-sync-design.md`):
 * - **set**: create-if-absent. A set is an immutable snapshot of collection
 *   membership, so the first snapshot seen on a device wins and later payloads
 *   are ignored (`created: false`).
 * - **cycle**: append-only per `cycleId`. The first `startedAt` wins and the
 *   snapshot is never rewritten. `completedAt` is only ever moved *earlier*
 *   (or filled when missing), so it never moves later.
 * - **result**: first write wins per `(cycleId, puzzleId)`, mirroring the
 *   server's `unique(dedupeKey)`. A duplicate leaves the cycle untouched and
 *   reports `applied: false`.
 *
 * `WoodpeckerCycle` carries no `cycleId` (the store keys cycles by it) and
 * `SyncWoodpeckerPayload` carries no `cycleNumber`; callers supply the id
 * mapping and the presentation-only cycle number.
 *
 * Pure: no clock reads, no randomness, no I/O.
 */

import type {
  WoodpeckerCycle,
  WoodpeckerCycleResult,
  WoodpeckerSetRecord,
} from '@chessengram/scheduler';
import type { SyncWoodpeckerPayload, SyncWoodpeckerResultPayload } from './types.ts';
import { dedupeKey, dedupeScope } from './types.ts';

/** Outcome of {@link applyWoodpeckerSet}. */
export interface WoodpeckerSetApply {
  readonly record: WoodpeckerSetRecord;
  /** `true` when this device had no set and created it from the payload. */
  readonly created: boolean;
}

/** Outcome of {@link applyWoodpeckerCycle}. */
export interface WoodpeckerCycleApply {
  readonly cycle: WoodpeckerCycle;
  /** `true` when the cycle did not exist locally and was created. */
  readonly created: boolean;
}

/** Outcome of {@link applyWoodpeckerResult}. */
export interface WoodpeckerResultApply {
  readonly cycle: WoodpeckerCycle;
  /** `false` when the puzzle already had a result (first write wins). */
  readonly applied: boolean;
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

/** A set/cycle snapshot must be a non-empty list of distinct puzzle ids. */
function snapshotPuzzleIds(payload: SyncWoodpeckerPayload): string[] {
  const ids = payload.puzzleIds;
  if (ids === undefined || ids.length === 0) {
    throw new Error(`woodpecker payload for ${payload.setId} has no puzzleIds`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`woodpecker payload for ${payload.setId} has duplicate puzzle ids`);
  }
  return [...ids];
}

/**
 * Build the wire payload for a local set snapshot. `puzzleIds` order is the
 * snapshot's stable presentation order, so it is preserved.
 */
export function woodpeckerSetPayload(record: WoodpeckerSetRecord): SyncWoodpeckerPayload {
  return {
    setId: record.setId,
    sourceCollectionId: record.sourceCollectionId,
    name: record.name,
    puzzleIds: [...record.puzzleIds],
  };
}

/**
 * Create-if-absent for a set snapshot: an existing local set always wins and
 * the payload is ignored (`created: false`), even if it differs. The payload
 * has no `createdAt`, so `createdAt` (the local receipt time) is supplied by
 * the caller; it falls back to the payload's `startedAt` and then `0` only so
 * the helper stays total.
 */
export function applyWoodpeckerSet(
  local: WoodpeckerSetRecord | undefined,
  payload: SyncWoodpeckerPayload,
  createdAt?: number,
): WoodpeckerSetApply {
  assertNonEmpty(payload.setId, 'payload.setId');
  if (local !== undefined) {
    if (local.setId !== payload.setId) {
      throw new Error(`set id mismatch: local ${local.setId} vs payload ${payload.setId}`);
    }
    return { record: local, created: false };
  }

  assertNonEmpty(payload.sourceCollectionId, 'payload.sourceCollectionId');
  if (payload.name !== undefined && typeof payload.name !== 'string') {
    throw new Error('payload.name must be a string');
  }
  if (createdAt !== undefined) assertTimestamp(createdAt, 'createdAt');
  const puzzleIds = snapshotPuzzleIds(payload);

  const record: WoodpeckerSetRecord = {
    setId: payload.setId,
    sourceCollectionId: payload.sourceCollectionId,
    name: payload.name ?? '',
    puzzleIds,
    createdAt: createdAt ?? payload.startedAt ?? 0,
  };
  return { record, created: true };
}

/**
 * Append-only merge for one cycle (the caller resolves `cycleId` to `local`).
 *
 * Creating: `startedAt` and the puzzle snapshot come from the payload.
 * Existing: the local snapshot and `startedAt` are authoritative; only
 * `completedAt` can be filled, and an existing value is replaced solely by an
 * *earlier* completion, so it never moves later. Results are merged separately
 * with {@link applyWoodpeckerResult}.
 */
export function applyWoodpeckerCycle(
  local: WoodpeckerCycle | undefined,
  payload: SyncWoodpeckerPayload,
  cycleNumber = 1,
): WoodpeckerCycleApply {
  assertNonEmpty(payload.setId, 'payload.setId');
  if (payload.cycleId !== undefined) assertNonEmpty(payload.cycleId, 'payload.cycleId');
  if (payload.completedAt !== undefined) assertTimestamp(payload.completedAt, 'payload.completedAt');

  if (local === undefined) {
    assertNonEmpty(payload.cycleId ?? '', 'payload.cycleId');
    if (payload.startedAt === undefined) {
      throw new Error(`woodpecker cycle ${payload.cycleId} has no startedAt`);
    }
    assertTimestamp(payload.startedAt, 'payload.startedAt');
    if (!Number.isInteger(cycleNumber) || cycleNumber < 1) {
      throw new Error('cycleNumber must be a positive integer');
    }
    const cycle: WoodpeckerCycle = {
      setId: payload.setId,
      cycleNumber,
      puzzleIds: snapshotPuzzleIds(payload),
      startedAt: payload.startedAt,
      ...(payload.completedAt !== undefined ? { completedAt: payload.completedAt } : {}),
      results: [],
    };
    return { cycle, created: true };
  }

  if (local.setId !== payload.setId) {
    throw new Error(`set id mismatch: local ${local.setId} vs payload ${payload.setId}`);
  }

  const completedAt =
    payload.completedAt !== undefined &&
    (local.completedAt === undefined || payload.completedAt < local.completedAt)
      ? payload.completedAt
      : local.completedAt;

  const cycle: WoodpeckerCycle = {
    setId: local.setId,
    cycleNumber: local.cycleNumber,
    puzzleIds: [...local.puzzleIds],
    startedAt: local.startedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
    results: local.results.map((entry) => ({ ...entry })),
  };
  return { cycle, created: false };
}

/**
 * First-write-wins result merge for one cycle. A result already present for
 * the puzzle is never replaced (the server's `unique(dedupeKey)` decides the
 * same way), so the returned cycle is the exact same reference and `applied`
 * is `false`.
 */
export function applyWoodpeckerResult(
  cycle: WoodpeckerCycle,
  payload: SyncWoodpeckerResultPayload,
): WoodpeckerResultApply {
  assertNonEmpty(payload.cycleId, 'payload.cycleId');
  assertNonEmpty(payload.puzzleId, 'payload.puzzleId');
  if (payload.result !== 'clean' && payload.result !== 'failed') {
    throw new Error('payload.result must be clean or failed');
  }
  if (!Number.isFinite(payload.activeSeconds) || payload.activeSeconds < 0) {
    throw new Error('payload.activeSeconds must be a finite non-negative number');
  }

  if (cycle.results.some((entry) => entry.puzzleId === payload.puzzleId)) {
    return { cycle, applied: false };
  }
  if (!cycle.puzzleIds.includes(payload.puzzleId)) {
    throw new Error(`puzzle ${payload.puzzleId} is not in cycle for set ${cycle.setId}`);
  }

  const result: WoodpeckerCycleResult = {
    puzzleId: payload.puzzleId,
    result: payload.result,
    activeSeconds: payload.activeSeconds,
  };
  return {
    cycle: {
      ...cycle,
      puzzleIds: [...cycle.puzzleIds],
      results: [...cycle.results, result],
    },
    applied: true,
  };
}

/** `hex SHA-256('woodpeckerResult' ‖ cycleId ‖ puzzleId)` — first-write key. */
export function woodpeckerResultDedupeKey(cycleId: string, puzzleId: string): Promise<string> {
  return dedupeKey(dedupeScope('woodpeckerResult', [cycleId, puzzleId]));
}
