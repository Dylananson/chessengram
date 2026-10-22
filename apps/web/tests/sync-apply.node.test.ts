/**
 * ONL-012 — inbound apply pipeline tests (Node, real WebCrypto, no network).
 *
 * Covers: decrypt + apply for every entity type; idempotent re-apply; a corrupt
 * envelope skipped while the rest of the batch applies; cursor never advancing
 * past a skipped record; unsupported/malformed envelopes skipped; tampered payload skipped.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AttemptEvent, AttemptRecord, NormalizedPuzzle } from '@chessengram/contracts';
import type { WoodpeckerCycle, WoodpeckerSetRecord } from '@chessengram/scheduler';
import {
  applyChanges,
  type SyncApplySkipReason,
  type SyncApplyWriter,
} from '../src/sync/apply.ts';
import { bytesToBase64, base64ToBytes, sealRecord } from '../src/sync/envelope.ts';
import type { CollectionSyncState } from '../src/sync/collections.ts';
import type {
  SyncEntityType,
  SyncRecordEnvelope,
} from '../src/sync/types.ts';
import type {
  CollectionRecord,
  SettingSyncState,
  UserPuzzleSyncState,
} from '../src/storage/local-store.ts';

const DEVICE_ID = 'device-a';
const CLOCK = 1_700_000_000_000;

// --- in-memory writer -------------------------------------------------------

class MemoryWriter implements SyncApplyWriter {
  readonly attempts = new Map<string, AttemptRecord>();
  readonly collections = new Map<string, CollectionRecord>();
  readonly collectionStates = new Map<string, CollectionSyncState>();
  readonly sets = new Map<string, WoodpeckerSetRecord>();
  readonly cycles = new Map<string, { cycleId: string; cycle: WoodpeckerCycle }>();
  readonly settingStates = new Map<string, SettingSyncState>();
  readonly savedSettings = new Map<string, Record<string, unknown>>();
  readonly userPuzzleStates = new Map<string, UserPuzzleSyncState>();
  readonly puzzles = new Map<string, NormalizedPuzzle>();
  attemptWrites = 0;

  constructor(seedPuzzle?: NormalizedPuzzle) {
    if (seedPuzzle) this.puzzles.set(seedPuzzle.id, seedPuzzle);
  }

  async applyAttempts(records: readonly AttemptRecord[]): Promise<{ applied: number; duplicates: number }> {
    let applied = 0;
    let duplicates = 0;
    for (const record of records) {
      if (this.attempts.has(record.attemptId.value)) {
        duplicates += 1;
        continue;
      }
      this.attempts.set(record.attemptId.value, record);
      this.attemptWrites += 1;
      applied += 1;
    }
    return { applied, duplicates };
  }

  getCollection(collectionId: string): CollectionRecord | undefined {
    return this.collections.get(collectionId);
  }

  async loadCollectionSyncState(collectionId: string): Promise<CollectionSyncState | undefined> {
    return this.collectionStates.get(collectionId);
  }

  async saveCollectionSyncState(state: CollectionSyncState): Promise<void> {
    this.collectionStates.set(state.collectionId, state);
  }

  async saveCollection(record: CollectionRecord): Promise<void> {
    this.collections.set(record.id, record);
  }

  async deleteCollection(collectionId: string): Promise<void> {
    this.collections.delete(collectionId);
  }

  getWoodpeckerSet(setId: string): WoodpeckerSetRecord | undefined {
    return this.sets.get(setId);
  }

  async saveWoodpeckerSet(record: WoodpeckerSetRecord): Promise<void> {
    this.sets.set(record.setId, record);
  }

  getWoodpeckerCycle(cycleId: string): { cycleId: string; cycle: WoodpeckerCycle } | undefined {
    return this.cycles.get(cycleId);
  }

  async saveWoodpeckerCycle(cycleId: string, cycle: WoodpeckerCycle): Promise<void> {
    this.cycles.set(cycleId, { cycleId, cycle });
  }

  nextWoodpeckerCycleNumber(setId: string): number {
    let max = 0;
    for (const saved of this.cycles.values()) {
      if (saved.cycle.setId === setId) max = Math.max(max, saved.cycle.cycleNumber);
    }
    return max + 1;
  }

  async loadSettingSyncState(recordId: string): Promise<SettingSyncState | undefined> {
    return this.settingStates.get(recordId);
  }

  async saveSettings(
    recordId: string,
    values: Record<string, unknown>,
    state: SettingSyncState,
  ): Promise<void> {
    this.savedSettings.set(recordId, values);
    this.settingStates.set(recordId, state);
  }

  async loadUserPuzzleSyncState(puzzleId: string): Promise<UserPuzzleSyncState | undefined> {
    return this.userPuzzleStates.get(puzzleId);
  }

  async saveUserPuzzle(puzzle: NormalizedPuzzle, state: UserPuzzleSyncState): Promise<void> {
    this.puzzles.set(puzzle.id, puzzle);
    this.userPuzzleStates.set(puzzle.id, state);
  }

  async removeUserPuzzle(puzzleId: string, state: UserPuzzleSyncState): Promise<void> {
    this.puzzles.delete(puzzleId);
    this.userPuzzleStates.set(puzzleId, state);
  }

  findPuzzle(puzzleId: string): NormalizedPuzzle | undefined {
    return this.puzzles.get(puzzleId);
  }
}

// --- fixtures ---------------------------------------------------------------

function puzzle(id: string): NormalizedPuzzle {
  return {
    id,
    contentSchemaVersion: '1.0.0',
    rating: 1200,
    source: 'user',
    sourceId: id,
    themes: ['user'],
    sourceFen: 'fen',
    solverFen: 'fen',
    solverColor: 'white',
    solution: ['e2e4'],
    originalFields: {},
  };
}

function events(): AttemptEvent[] {
  return [{ eventId: 'e1', type: 'start', occurredAt: CLOCK }];
}

async function seal(
  type: SyncEntityType,
  recordId: string,
  payload: unknown,
  overrides: { seq?: number; rev?: number; deviceId?: string } = {},
): Promise<SyncRecordEnvelope> {
  const envelope = await sealRecord({
    type,
    recordId,
    payload,
    deviceId: overrides.deviceId ?? DEVICE_ID,
    now: CLOCK,
    rev: overrides.rev ?? 1,
    sign: async () => 'fake-signature',
  });
  return overrides.seq !== undefined ? { ...envelope, seq: overrides.seq } : envelope;
}

function deps(writer: SyncApplyWriter, errors: SyncApplySkipReason[] = []) {
  return {
    writer,
    clock: () => CLOCK,
    onError: (info: { reason: SyncApplySkipReason }) => errors.push(info.reason),
  };
}

async function run(
  changes: SyncRecordEnvelope[],
  writer: SyncApplyWriter,
  cursor = 0,
): Promise<{ result: Awaited<ReturnType<typeof applyChanges>>; errors: SyncApplySkipReason[] }> {
  const errors: SyncApplySkipReason[] = [];
  const result = await applyChanges({ changes, cursor, deps: deps(writer, errors) });
  return { result, errors };
}

/**
 * Tamper with the payload the way a hostile server or a broken transport would.
 * (Signature *verification* is the signing module's job; here it proves the
 * apply layer never trusts a payload it cannot read.)
 */
function tamperPayload(envelope: SyncRecordEnvelope): SyncRecordEnvelope {
  return { ...envelope, payload: { tampered: true } };
}

// --- per-type apply ---------------------------------------------------------

test('applies every entity type and maps it into local state', async () => {
  const writer = new MemoryWriter(puzzle('puzzle-1'));
  const changes = await Promise.all([
    seal('attempt', 'attempt-1', {
      attemptId: 'attempt-1',
      programId: 'program-1',
      collectionId: 'col-1',
      puzzleId: 'puzzle-1',
      outcome: 'success',
      startedAt: CLOCK,
      completedAt: CLOCK + 1_000,
      timing: { activeSolvingSeconds: 5, correctionSeconds: 1 },
      events: events(),
    }, { seq: 1 }),
    seal('collection', 'col-1', {
      collectionId: 'col-1',
      name: 'Endgames',
      puzzleIds: ['puzzle-1'],
      updatedAt: CLOCK,
      updatedBy: DEVICE_ID,
    }, { seq: 2 }),
    seal('woodpecker', 'set-1', {
      setId: 'set-1',
      sourceCollectionId: 'col-1',
      name: 'Set',
      puzzleIds: ['puzzle-1'],
    }, { seq: 3 }),
    seal('woodpecker', 'cycle-1', {
      setId: 'set-1',
      cycleId: 'cycle-1',
      sourceCollectionId: 'col-1',
      puzzleIds: ['puzzle-1'],
      startedAt: CLOCK,
    }, { seq: 4 }),
    seal('woodpeckerResult', 'cycle-1\u0000puzzle-1', {
      cycleId: 'cycle-1',
      puzzleId: 'puzzle-1',
      result: 'failed',
      activeSeconds: 9,
    }, { seq: 5 }),
    seal('setting', 'scheduler', {
      values: { failurePreset: 'step-back' },
      updatedAt: CLOCK,
      updatedBy: DEVICE_ID,
    }, { seq: 6 }),
    seal('userPuzzle', 'puzzle-1', {
      puzzleId: 'puzzle-1',
      puzzle: puzzle('puzzle-1'),
      updatedAt: CLOCK,
    }, { seq: 7 }),
  ]);

  const { result, errors } = await run(changes, writer);

  assert.deepEqual(
    { applied: result.applied, skipped: result.skipped, duplicates: result.duplicates },
    { applied: 7, skipped: 0, duplicates: 0 },
  );
  assert.equal(result.cursor, 7);
  assert.deepEqual(errors, []);
  assert.equal(writer.attempts.get('attempt-1')?.outcome, 'success');
  assert.equal(writer.collections.get('col-1')?.name, 'Endgames');
  assert.equal(writer.sets.get('set-1')?.puzzleIds.length, 1);
  assert.equal(writer.cycles.get('cycle-1')?.cycle.results[0]?.result, 'failed');
  assert.deepEqual(writer.savedSettings.get('scheduler'), { failurePreset: 'step-back' });
  assert.ok(writer.puzzles.has('puzzle-1'));
});

test('re-applying the same batch changes nothing and reports duplicates', async () => {
  const writer = new MemoryWriter(puzzle('puzzle-1'));
  const changes = await Promise.all([
    seal('attempt', 'attempt-1', {
      attemptId: 'attempt-1',
      programId: 'program-1',
      puzzleId: 'puzzle-1',
      startedAt: CLOCK,
      timing: { activeSolvingSeconds: 1, correctionSeconds: 0 },
    }, { seq: 1 }),
    seal('collection', 'col-1', {
      collectionId: 'col-1',
      name: 'Endgames',
      puzzleIds: ['puzzle-1'],
      updatedAt: CLOCK,
      updatedBy: DEVICE_ID,
    }, { seq: 2 }),
    seal('setting', 'scheduler', {
      values: { failurePreset: 'step-back' },
      updatedAt: CLOCK,
      updatedBy: DEVICE_ID,
    }, { seq: 3 }),
    seal('userPuzzle', 'puzzle-1', {
      puzzleId: 'puzzle-1',
      puzzle: puzzle('puzzle-1'),
      updatedAt: CLOCK,
    }, { seq: 4 }),
  ]);

  const first = await run(changes, writer);
  assert.equal(first.result.applied, 4);

  const attemptsBefore = writer.attemptWrites;
  const second = await run(changes, writer, first.result.cursor);
  assert.deepEqual(
    { applied: second.result.applied, skipped: second.result.skipped, duplicates: second.result.duplicates },
    { applied: 0, skipped: 0, duplicates: 4 },
    'idempotent re-apply is all duplicates',
  );
  assert.equal(writer.attemptWrites, attemptsBefore, 'no attempt is written twice');
  assert.equal(second.result.cursor, 4, 'duplicates still advance the cursor');
});

test('a tampered envelope is skipped while the rest of the batch applies', async () => {
  const writer = new MemoryWriter();
  const good = await seal('attempt', 'attempt-1', {
    attemptId: 'attempt-1',
    programId: 'program-1',
    puzzleId: 'puzzle-1',
    startedAt: CLOCK,
    timing: { activeSolvingSeconds: 1, correctionSeconds: 0 },
  }, { seq: 1 });
  const corrupt = tamperPayload(await seal('attempt', 'attempt-2', {
    attemptId: 'attempt-2',
    programId: 'program-1',
    puzzleId: 'puzzle-1',
    startedAt: CLOCK,
    timing: { activeSolvingSeconds: 1, correctionSeconds: 0 },
  }, { seq: 2 }));
  const later = await seal('attempt', 'attempt-3', {
    attemptId: 'attempt-3',
    programId: 'program-1',
    puzzleId: 'puzzle-1',
    startedAt: CLOCK,
    timing: { activeSolvingSeconds: 1, correctionSeconds: 0 },
  }, { seq: 3 });

  const { result, errors } = await run([good, corrupt, later], writer);

  assert.equal(result.applied, 2, 'records before and after the corrupt one apply');
  assert.equal(result.skipped, 1);
  assert.equal(result.duplicates, 0);
  assert.equal(result.cursor, 1, 'cursor stops before the skipped record');
  assert.deepEqual(errors, ['apply_failed']);
  assert.ok(writer.attempts.has('attempt-1'));
  assert.ok(writer.attempts.has('attempt-3'));
  assert.ok(!writer.attempts.has('attempt-2'), 'nothing was partially applied');
});

test('a malformed payload is skipped and blocks the cursor', async () => {
  const writer = new MemoryWriter();
  const malformed = tamperPayload(await seal('attempt', 'attempt-1', {
    attemptId: 'attempt-1',
    programId: 'program-1',
    puzzleId: 'puzzle-1',
    startedAt: CLOCK,
    timing: { activeSolvingSeconds: 1, correctionSeconds: 0 },
  }, { seq: 1 }));

  const { result, errors } = await run([malformed], writer);

  assert.equal(result.skipped, 1);
  assert.equal(result.applied, 0);
  assert.equal(result.cursor, 0);
  // The payload parsed but could not be applied, so the record is skipped and
  // the cursor stays put (the point of the test) rather than being lost.
  assert.deepEqual(errors, ['apply_failed']);
  assert.equal(writer.attempts.size, 0);
});

test('a tampered payload is rejected without applying anything', async () => {
  const writer = new MemoryWriter();
  const tampered = tamperPayload(await seal('setting', 'scheduler', {
    values: { failurePreset: 'retry-retain' },
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
  }, { seq: 1 }));

  const { result, errors } = await run([tampered], writer);

  assert.equal(result.skipped, 1);
  assert.equal(result.applied, 0);
  assert.deepEqual(errors, ['apply_failed']);
  assert.equal(writer.savedSettings.size, 0);
});

test('an invalid payload is skipped, never partially applied', async () => {
  const writer = new MemoryWriter();
  const badShape = await seal('userPuzzle', 'puzzle-1', {
    puzzleId: 'puzzle-1',
    // missing solverFen/solution/etc.
    puzzle: { id: 'puzzle-1' },
    updatedAt: CLOCK,
  }, { seq: 1 });

  const { result, errors } = await run([badShape], writer);

  assert.equal(result.skipped, 1);
  assert.equal(result.applied, 0);
  assert.deepEqual(errors, ['apply_failed']);
  assert.equal(writer.puzzles.size, 0);
});

// --- user-puzzle tombstones (ONL-014) ---------------------------------------

test('a user-puzzle tombstone removes the puzzle and re-applying it is a no-op', async () => {
  const writer = new MemoryWriter(puzzle('puzzle-1'));
  writer.userPuzzleStates.set('puzzle-1', { updatedAt: CLOCK - 1_000 });

  const deleted = await seal('userPuzzle', 'puzzle-1', {
    puzzleId: 'puzzle-1',
    updatedAt: CLOCK,
    deleted: true,
  }, { seq: 1 });

  const first = await run([deleted], writer);
  assert.equal(first.result.applied, 1, 'the newer delete applies');
  assert.equal(first.result.skipped, 0);
  assert.ok(!writer.puzzles.has('puzzle-1'), 'the puzzle was removed locally');
  assert.deepEqual(writer.userPuzzleStates.get('puzzle-1'), {
    updatedAt: CLOCK,
    rev: 1,
    updatedBy: DEVICE_ID,
  });

  const second = await run([deleted], writer, first.result.cursor);
  assert.equal(second.result.applied, 0);
  assert.equal(second.result.duplicates, 1, 're-delivering the delete is a no-op');
  assert.ok(!writer.puzzles.has('puzzle-1'));
});

test('an older delete does not beat a newer re-create (LWW)', async () => {
  const writer = new MemoryWriter(puzzle('puzzle-1'));
  // The puzzle was re-created at CLOCK; the incoming delete is older.
  writer.userPuzzleStates.set('puzzle-1', { updatedAt: CLOCK });

  const staleDelete = await seal('userPuzzle', 'puzzle-1', {
    puzzleId: 'puzzle-1',
    updatedAt: CLOCK - 60_000,
    deleted: true,
  }, { seq: 1 });

  const { result } = await run([staleDelete], writer);
  assert.equal(result.duplicates, 1);
  assert.equal(result.applied, 0);
  assert.ok(writer.puzzles.has('puzzle-1'), 'the newer local copy survives');
  assert.deepEqual(writer.userPuzzleStates.get('puzzle-1'), { updatedAt: CLOCK });
});

// --- ONL-017 apply-layer `rev` ordering -------------------------------------

test('ONL-017: a same-millisecond, same-device setting edit with a higher rev applies', async () => {
  const writer = new MemoryWriter();
  const first = await seal('setting', 'scheduler', {
    values: { failurePreset: 'step-back' },
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
  }, { rev: 5, seq: 1 });
  const second = await seal('setting', 'scheduler', {
    values: { failurePreset: 'retry-retain' },
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
  }, { rev: 6, seq: 2 });

  const firstRun = await run([first], writer);
  assert.equal(firstRun.result.applied, 1);
  assert.deepEqual(writer.savedSettings.get('scheduler'), { failurePreset: 'step-back' });
  assert.deepEqual(writer.settingStates.get('scheduler'), {
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
    rev: 5,
  });

  const secondRun = await run([second], writer, firstRun.result.cursor);
  assert.equal(
    secondRun.result.applied,
    1,
    'the higher-rev same-millisecond edit is not a duplicate',
  );
  assert.deepEqual(writer.savedSettings.get('scheduler'), { failurePreset: 'retry-retain' });
  assert.deepEqual(writer.settingStates.get('scheduler'), {
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
    rev: 6,
  });
});

test('ONL-017: a lower-rev same-millisecond setting edit is still a duplicate', async () => {
  const writer = new MemoryWriter();
  writer.settingStates.set('scheduler', { updatedAt: CLOCK, updatedBy: DEVICE_ID, rev: 9 });
  const stale = await seal('setting', 'scheduler', {
    values: { failurePreset: 'stale' },
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
  }, { rev: 8, seq: 1 });

  const { result } = await run([stale], writer);
  assert.equal(result.applied, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(writer.savedSettings.size, 0);
  assert.deepEqual(writer.settingStates.get('scheduler'), {
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
    rev: 9,
  });
});

test('ONL-017: an equal (updatedAt, rev, updatedBy) setting edit is a duplicate', async () => {
  const writer = new MemoryWriter();
  writer.settingStates.set('scheduler', { updatedAt: CLOCK, updatedBy: DEVICE_ID, rev: 3 });
  const dup = await seal('setting', 'scheduler', {
    values: { failurePreset: 'same' },
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
  }, { rev: 3, seq: 1 });

  const { result } = await run([dup], writer);
  assert.equal(result.applied, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(writer.savedSettings.size, 0);
});

test('ONL-017: a legacy setting stamp without rev reads as rev 0', async () => {
  const writer = new MemoryWriter();
  // A stamp written before ONL-017 has no `rev`.
  writer.settingStates.set('scheduler', { updatedAt: CLOCK, updatedBy: DEVICE_ID });

  // An equal (updatedAt, updatedBy) legacy incoming (rev 0) is still a duplicate.
  const equal = await seal('setting', 'scheduler', {
    values: { failurePreset: 'equal' },
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
  }, { rev: 0, seq: 1 });
  const first = await run([equal], writer);
  assert.equal(first.result.applied, 0);
  assert.equal(first.result.duplicates, 1);

  // A strictly newer edit still applies.
  const newer = await seal('setting', 'scheduler', {
    values: { failurePreset: 'newer' },
    updatedAt: CLOCK + 1,
    updatedBy: DEVICE_ID,
  }, { rev: 1, seq: 2 });
  const second = await run([newer], writer, first.result.cursor);
  assert.equal(second.result.applied, 1);
  assert.deepEqual(writer.savedSettings.get('scheduler'), { failurePreset: 'newer' });
});

test('ONL-017: a same-millisecond, same-device user-puzzle edit with a higher rev applies', async () => {
  const writer = new MemoryWriter(puzzle('puzzle-1'));
  const first = await seal('userPuzzle', 'puzzle-1', {
    puzzleId: 'puzzle-1',
    puzzle: { ...puzzle('puzzle-1'), rating: 1300 },
    updatedAt: CLOCK,
  }, { rev: 4, seq: 1 });
  const second = await seal('userPuzzle', 'puzzle-1', {
    puzzleId: 'puzzle-1',
    puzzle: { ...puzzle('puzzle-1'), rating: 1400 },
    updatedAt: CLOCK,
  }, { rev: 5, seq: 2 });

  const firstRun = await run([first], writer);
  assert.equal(firstRun.result.applied, 1);
  assert.equal(writer.puzzles.get('puzzle-1')?.rating, 1300);
  assert.deepEqual(writer.userPuzzleStates.get('puzzle-1'), {
    updatedAt: CLOCK,
    rev: 4,
    updatedBy: DEVICE_ID,
  });

  const secondRun = await run([second], writer, firstRun.result.cursor);
  assert.equal(
    secondRun.result.applied,
    1,
    'the higher-rev same-millisecond edit is not a duplicate',
  );
  assert.equal(writer.puzzles.get('puzzle-1')?.rating, 1400);
  assert.deepEqual(writer.userPuzzleStates.get('puzzle-1'), {
    updatedAt: CLOCK,
    rev: 5,
    updatedBy: DEVICE_ID,
  });
});

test('ONL-017: a lower-rev same-millisecond user-puzzle edit is still a duplicate', async () => {
  const writer = new MemoryWriter(puzzle('puzzle-1'));
  writer.puzzles.set('puzzle-1', { ...puzzle('puzzle-1'), rating: 1300 });
  writer.userPuzzleStates.set('puzzle-1', { updatedAt: CLOCK, rev: 9, updatedBy: DEVICE_ID });
  const stale = await seal('userPuzzle', 'puzzle-1', {
    puzzleId: 'puzzle-1',
    puzzle: { ...puzzle('puzzle-1'), rating: 1400 },
    updatedAt: CLOCK,
  }, { rev: 8, seq: 1 });

  const { result } = await run([stale], writer);
  assert.equal(result.applied, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(writer.puzzles.get('puzzle-1')?.rating, 1300);
});

test('ONL-017: an equal (updatedAt, rev, updatedBy) user-puzzle edit is a duplicate', async () => {
  const writer = new MemoryWriter(puzzle('puzzle-1'));
  writer.userPuzzleStates.set('puzzle-1', { updatedAt: CLOCK, rev: 3, updatedBy: DEVICE_ID });
  const dup = await seal('userPuzzle', 'puzzle-1', {
    puzzleId: 'puzzle-1',
    puzzle: { ...puzzle('puzzle-1'), rating: 1400 },
    updatedAt: CLOCK,
  }, { rev: 3, seq: 1 });

  const { result } = await run([dup], writer);
  assert.equal(result.applied, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(writer.puzzles.get('puzzle-1')?.rating, 1200);
});

test('ONL-017: a legacy user-puzzle stamp without rev reads as rev 0', async () => {
  const writer = new MemoryWriter(puzzle('puzzle-1'));
  // A pre-ONL-017 stamp: no `rev` and no stored device id.
  writer.userPuzzleStates.set('puzzle-1', { updatedAt: CLOCK });

  // An equal (updatedAt) legacy incoming (rev 0) stays a duplicate, exactly as
  // the old `updatedAt`-only rule did (a stamp with no device id cannot tie-break).
  const equal = await seal('userPuzzle', 'puzzle-1', {
    puzzleId: 'puzzle-1',
    puzzle: { ...puzzle('puzzle-1'), rating: 1400 },
    updatedAt: CLOCK,
  }, { rev: 0, seq: 1 });
  const first = await run([equal], writer);
  assert.equal(first.result.applied, 0);
  assert.equal(first.result.duplicates, 1);

  // A strictly newer edit still applies.
  const newer = await seal('userPuzzle', 'puzzle-1', {
    puzzleId: 'puzzle-1',
    puzzle: { ...puzzle('puzzle-1'), rating: 1500 },
    updatedAt: CLOCK + 1,
  }, { rev: 1, seq: 2 });
  const second = await run([newer], writer, first.result.cursor);
  assert.equal(second.result.applied, 1);
  assert.equal(writer.puzzles.get('puzzle-1')?.rating, 1500);
});

test('ONL-017: a same-millisecond, same-device collection rename with a higher rev applies', async () => {
  const writer = new MemoryWriter();
  const first = await seal('collection', 'col-1', {
    collectionId: 'col-1',
    name: 'Endgames',
    puzzleIds: ['puzzle-1'],
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
  }, { rev: 2, seq: 1 });
  const second = await seal('collection', 'col-1', {
    collectionId: 'col-1',
    name: 'Endgames v2',
    puzzleIds: ['puzzle-1'],
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
  }, { rev: 3, seq: 2 });

  const firstRun = await run([first], writer);
  assert.equal(firstRun.result.applied, 1);
  assert.equal(writer.collections.get('col-1')?.name, 'Endgames');

  const secondRun = await run([second], writer, firstRun.result.cursor);
  assert.equal(secondRun.result.applied, 1, 'the higher-rev same-ms rename is not a duplicate');
  assert.equal(writer.collections.get('col-1')?.name, 'Endgames v2');
  const state = writer.collectionStates.get('col-1') as { nameRev?: number } | undefined;
  assert.equal(state?.nameRev, 3);
  // Membership is untouched by the rev-aware name resolution (ONL-007 intact).
  assert.deepEqual(writer.collections.get('col-1')?.puzzleIds, ['puzzle-1']);
});

test('ONL-017: a lower-rev same-millisecond collection rename is still a duplicate', async () => {
  const writer = new MemoryWriter();
  const first = await seal('collection', 'col-1', {
    collectionId: 'col-1',
    name: 'Endgames',
    puzzleIds: ['puzzle-1'],
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
  }, { rev: 7, seq: 1 });
  const firstRun = await run([first], writer);
  assert.equal(firstRun.result.applied, 1);

  const stale = await seal('collection', 'col-1', {
    collectionId: 'col-1',
    name: 'Stale name',
    puzzleIds: ['puzzle-1'],
    updatedAt: CLOCK,
    updatedBy: DEVICE_ID,
  }, { rev: 6, seq: 2 });
  const secondRun = await run([stale], writer, firstRun.result.cursor);
  assert.equal(secondRun.result.applied, 0);
  assert.equal(secondRun.result.duplicates, 1);
  assert.equal(writer.collections.get('col-1')?.name, 'Endgames');
});
