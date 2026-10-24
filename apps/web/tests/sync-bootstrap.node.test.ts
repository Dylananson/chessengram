/**
 * ONL-009b — sync runtime wiring tests (Node, no network, fake transport).
 *
 * Covers: config loading (no fetch when unconfigured; runtime-file merge),
 * `local-only` default with zero api calls, the exact `enable()` order + local
 * adoption, strict ack rules (accepted/duplicates ack, 422 does not), 401 →
 * paused with the queue intact, and disable/sign-out/delete-server-copy never
 * touching local training data. No secret is ever written to storage.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AttemptRecord, NormalizedPuzzle } from '@chessengram/contracts';
import { mutableClock } from '@chessengram/scheduler';
import type {
  SyncApiClient,
  SyncEntityType,
  SyncPushRequest,
  SyncPushResponse,
  SyncKeyStorage,
  SyncQueueEntry,
  SyncQueueStorage,
  SyncRecordEnvelope,
  SyncSecrets,
  SyncState,
  SyncStateStorage,
} from '../src/sync/types.ts';
import type { SyncApplyWriter } from '../src/sync/apply.ts';
import { base64ToBytes, bytesToBase64, sealRecord } from '../src/sync/envelope.ts';
import {
  createSyncRuntime,
  isUnauthorized,
  loadSyncConfig,
  SYNC_DEFAULT_DEBOUNCE_MS,
  SYNC_PERIODIC_MS,
  woodpeckerResultRecordId,
  type SyncFlushTarget,
  type SyncRuntime,
  type SyncRuntimeService,
} from '../src/sync/bootstrap.ts';
import {
  LocalStore,
  syncKeyStorage,
  syncStorage,
  type CollectionRecord,
} from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { LocalTrainingService, progressKeyToString } from '../src/scheduler-service.ts';
import { SettingsCtrl, view as settingsView } from '../src/settings-view.ts';
import type { TrainingAdapter } from '../src/training-adapter.ts';
import type { VNode } from 'snabbdom/build/vnode.js';
import { makePuzzle, makeService, timing } from './fixtures.ts';

const CONFIG = {
  apiBase: 'https://api.example.test',
  authAuthority: 'https://auth.example.test',
  authClientId: 'client-123',
};

// --- in-memory storage (queue + state), mirrors ONL-001's seam -------------

class MemoryStorage implements SyncQueueStorage, SyncStateStorage {
  readonly queue = new Map<string, SyncQueueEntry>();
  state: SyncState | undefined;

  private key(type: string, recordId: string): string {
    return `${type}\u0000${recordId}`;
  }

  async list(): Promise<SyncQueueEntry[]> {
    return [...this.queue.values()].map((entry) => ({ ...entry }));
  }

  async put(entry: SyncQueueEntry): Promise<void> {
    this.queue.set(this.key(entry.type, entry.recordId), { ...entry });
  }

  async delete(type: string, recordId: string): Promise<void> {
    this.queue.delete(this.key(type, recordId));
  }

  async load(): Promise<SyncState | undefined> {
    return this.state ? { ...this.state } : undefined;
  }

  async save(state: SyncState): Promise<void> {
    this.state = { ...state };
  }

  /** Serialized content for "no secret was written" assertions. */
  dump(): string {
    return JSON.stringify({ state: this.state, queue: [...this.queue.values()] });
  }
}

// --- fake training service -------------------------------------------------

function attempt(id: string, startedAt: number, completedAt?: number): AttemptRecord {
  return {
    attemptSchemaVersion: '1.0.0',
    attemptId: { value: id },
    progressKey: { programId: 'program-a', puzzleId: `puzzle-${id}`, collectionId: 'coll-1' },
    sessionId: 'session-1',
    scheduleRevisionBefore: 0,
    contentHash: `puzzle-${id}:1.0.0:fen`,
    startingFen: 'fen',
    outcome: 'success',
    timing: {
      activeSolvingSeconds: 5,
      correctionSeconds: 1,
      interruptionSeconds: 0,
      hiddenSeconds: 0,
      timingTrustworthy: true,
    },
    events: [],
    startedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
    settingsHash: 'settings-hash',
  };
}

const COLLECTION: CollectionRecord = {
  id: 'coll-1',
  name: 'Starter',
  puzzleIds: ['puzzle-a1'],
  createdAt: 1_000,
};

function makeFakeService(): SyncRuntimeService {
  const attempts = [attempt('a1', 100, 200), attempt('a2', 300)];
  const sets = [
    {
      setId: 'woodpecker-1',
      name: 'Woodpecker set',
      sourceCollectionId: 'coll-1',
      puzzleIds: ['puzzle-a1'],
      createdAt: 2_000,
    },
  ];
  const cycles = [
    {
      cycleId: 'woodpecker-cycle-1',
      cycle: {
        setId: 'woodpecker-1',
        cycleNumber: 1,
        puzzleIds: ['puzzle-a1'],
        startedAt: 3_000,
        results: [{ puzzleId: 'puzzle-a1', result: 'clean' as const, activeSeconds: 12 }],
      },
    },
  ];
  return {
    getAttemptCount: () => attempts.length,
    listAttempts: (filter = {}) => {
      const limit = filter.limit ?? 100;
      return [...attempts]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, Math.max(0, limit))
        .map((entry) => structuredClone(entry));
    },
    listCollections: () => [{ ...COLLECTION, puzzleIds: [...COLLECTION.puzzleIds] }],
    listWoodpeckerSets: () => sets.map((set) => ({ ...set, puzzleIds: [...set.puzzleIds] })),
    listWoodpeckerCycles: (setId) =>
      cycles
        .filter((saved) => saved.cycle.setId === setId)
        .map((saved) => ({ cycleId: saved.cycleId, cycle: structuredClone(saved.cycle) })),
    getWoodpeckerSet: (setId) => sets.find((set) => set.setId === setId),
    getWoodpeckerCycle: (cycleId) => {
      const found = cycles.find((saved) => saved.cycleId === cycleId);
      return found ? { cycleId: found.cycleId, cycle: structuredClone(found.cycle) } : undefined;
    },
  };
}

/** In-memory `SyncKeyStorage`, mirroring the non-exported `sync-secrets` cache. */
class MemoryKeyStorage implements SyncKeyStorage {
  secrets: SyncSecrets | undefined;

  async load(): Promise<SyncSecrets | undefined> {
    return this.secrets ? structuredClone(this.secrets) : undefined;
  }

  async save(secrets: SyncSecrets): Promise<void> {
    this.secrets = structuredClone(secrets);
  }

  async clear(): Promise<void> {
    this.secrets = undefined;
  }
}

// --- fake transport --------------------------------------------------------

interface FakeApi extends SyncApiClient {
  calls: string[];
  pushImpl: (request: { since: number; push: SyncRecordEnvelope[] }) => Promise<{
    cursor: number;
    accepted: string[];
    duplicates: string[];
    changes: SyncRecordEnvelope[];
  }>;
}

function makeApi(): FakeApi {
  const calls: string[] = [];
  const api: FakeApi = {
    calls,
    pushImpl: async () => ({ cursor: 0, accepted: [], duplicates: [], changes: [] }),
    async getSession() {
      calls.push('getSession');
      return { userId: 'usr_1', expiresAt: Date.now() + 1000 };
    },
    async exchangeSession(idToken: string) {
      calls.push(`exchangeSession:${idToken}`);
      return { userId: 'usr_1', expiresAt: Date.now() + 1000 };
    },
    async signOut() {
      calls.push('signOut');
    },
    async registerDevice(input) {
      calls.push(`registerDevice:${input.deviceId}`);
      return { thumbprint: 'thumb' };
    },
    async listDevices() {
      calls.push('listDevices');
      return [];
    },
    async revokeDevice(deviceId: string) {
      calls.push(`revokeDevice:${deviceId}`);
    },
    async push(request) {
      calls.push('push');
      return api.pushImpl(request);
    },
    async deleteAccount() {
      calls.push('deleteAccount');
    },
  };
  return api;
}

/** Minimal inbound writer that records remote attempts for assertions. */
class RecordingWriter implements SyncApplyWriter {
  readonly attempts = new Map<string, AttemptRecord>();

  async applyAttempts(records: readonly AttemptRecord[]): Promise<{ applied: number; duplicates: number }> {
    let applied = 0;
    let duplicates = 0;
    for (const record of records) {
      if (this.attempts.has(record.attemptId.value)) {
        duplicates += 1;
        continue;
      }
      this.attempts.set(record.attemptId.value, record);
      applied += 1;
    }
    return { applied, duplicates };
  }

  getCollection(): undefined {
    return undefined;
  }
  async loadCollectionSyncState(): Promise<undefined> {
    return undefined;
  }
  async saveCollectionSyncState(): Promise<void> {}
  async saveCollection(): Promise<void> {}
  async deleteCollection(): Promise<void> {}
  getWoodpeckerSet(): undefined {
    return undefined;
  }
  async saveWoodpeckerSet(): Promise<void> {}
  getWoodpeckerCycle(): undefined {
    return undefined;
  }
  async saveWoodpeckerCycle(): Promise<void> {}
  nextWoodpeckerCycleNumber(): number {
    return 1;
  }
  async loadSettingSyncState(): Promise<undefined> {
    return undefined;
  }
  async saveSettings(): Promise<void> {}
  async loadUserPuzzleSyncState(): Promise<undefined> {
    return undefined;
  }
  async saveUserPuzzle(): Promise<void> {}
  async removeUserPuzzle(): Promise<void> {}
  findPuzzle(): undefined {
    return undefined;
  }
}

/**
 * Build one envelope as another device would (payload in the clear, signed).
 * No key material is involved any more (ONL-020), so a test can fabricate one
 * directly.
 */
async function remoteAttemptChange(
  recordId: string,
  seq: number,
  overrides: { outcome?: 'success' | 'failure'; startedAt?: number } = {},
): Promise<SyncRecordEnvelope> {
  const envelope = await sealRecord({
    type: 'attempt',
    recordId,
    payload: {
      attemptId: recordId,
      programId: 'program-a',
      collectionId: 'coll-1',
      puzzleId: 'puzzle-a1',
      outcome: overrides.outcome ?? 'success',
      startedAt: overrides.startedAt ?? 100,
      completedAt: 200,
      timing: { activeSolvingSeconds: 5, correctionSeconds: 1 },
    },
    deviceId: 'device-remote',
    now: 1_700_000_000_000,
    rev: 1,
    sign: async () => 'remote-signature',
  });
  return { ...envelope, seq };
}

/**
 * Make a record unreadable the way a hostile server or a broken transport would
 * (ONL-020: there is no ciphertext to flip any more, so the payload itself is
 * replaced). The signature no longer matches the content.
 */
function corrupt(envelope: SyncRecordEnvelope): SyncRecordEnvelope {
  return { ...envelope, payload: { tampered: true } };
}

function makeRuntime(overrides: {
  config?: typeof CONFIG | Record<string, never>;
  api?: SyncApiClient;
  storage?: MemoryStorage;
  service?: SyncRuntimeService;
  writer?: SyncApplyWriter;
} = {}) {
  const storage = overrides.storage ?? new MemoryStorage();
  const service = overrides.service ?? makeFakeService();
  const runtime = createSyncRuntime({
    config: overrides.config ?? CONFIG,
    api: overrides.api,
    service,
    storage,
    writer: overrides.writer,
  });
  return { runtime, storage, service };
}

async function enabledRuntime() {
  const api = makeApi();
  const storage = new MemoryStorage();
  const service = makeFakeService();
  const runtime = createSyncRuntime({ config: CONFIG, api, service, storage });
  const result = await runtime.enable({ idToken: 'id-token' });
  return { runtime, api, storage, service, result };
}

// --- ONL-013 auto-sync helpers ---------------------------------------------

/** Let an async capture/debounce chain settle under Node. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Poll until `predicate` holds (WebCrypto sealing is genuinely async). */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Fake training service with a controllable `onLocalChange` observer. */
function observableService(base: SyncRuntimeService = makeFakeService()) {
  const listeners = new Set<(change: { type: SyncEntityType; recordId: string }) => void>();
  const service: SyncRuntimeService = {
    ...base,
    onLocalChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    service,
    emit(type: SyncEntityType, recordId: string): void {
      for (const listener of [...listeners]) listener({ type, recordId });
    },
    listenerCount(): number {
      return listeners.size;
    },
  };
}

/** Deterministic timer pair; `advance` runs every callback that comes due. */
class FakeTimers {
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();
  now = 0;

  readonly timers = {
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = this.nextId;
      this.nextId += 1;
      this.tasks.set(id, { at: this.now + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      this.tasks.delete(handle as number);
    },
  };

  /** Delays (ms from now) of every pending timer, ascending. */
  pending(): number[] {
    return [...this.tasks.values()]
      .map((task) => task.at - this.now)
      .sort((a, b) => a - b);
  }

  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.now)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      due[1].fn();
    }
  }
}

/** Minimal event target for `attachFlushTriggers`. */
class FakeTarget implements SyncFlushTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  total(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

/** In-memory server: idempotent push by dedupeKey, cursor pull by seq. */
class FakeServer implements SyncApiClient {
  private readonly rows = new Map<string, SyncRecordEnvelope>();
  private maxSeq = 0;
  signedIn = false;

  async getSession(): Promise<{ userId: string; expiresAt: number } | undefined> {
    return this.signedIn ? { userId: 'usr_1', expiresAt: Date.now() + 10_000_000 } : undefined;
  }

  async exchangeSession(): Promise<{ userId: string; expiresAt: number }> {
    this.signedIn = true;
    return { userId: 'usr_1', expiresAt: Date.now() + 10_000_000 };
  }

  async signOut(): Promise<void> {
    this.signedIn = false;
  }

  async registerDevice(): Promise<{ thumbprint: string }> {
    return { thumbprint: 'thumb' };
  }

  async listDevices(): Promise<Array<{ deviceId: string; addedAt: number }>> {
    return [];
  }

  async revokeDevice(): Promise<void> {}

  async deleteAccount(): Promise<void> {
    this.rows.clear();
    this.maxSeq = 0;
  }

  async push(request: SyncPushRequest): Promise<SyncPushResponse> {
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const envelope of request.push) {
      if (this.rows.has(envelope.dedupeKey)) {
        duplicates.push(envelope.dedupeKey);
        continue;
      }
      this.maxSeq += 1;
      this.rows.set(envelope.dedupeKey, { ...envelope, seq: this.maxSeq });
      accepted.push(envelope.dedupeKey);
    }
    const changes = [...this.rows.values()]
      .filter((row) => (row.seq ?? 0) > request.since)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return { cursor: this.maxSeq, accepted, duplicates, changes };
  }
}

// --- config ----------------------------------------------------------------

test('loadSyncConfig never fetches when no VITE_SYNC_* value is set', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('must not be called');
  };
  const config = await loadSyncConfig(fetchImpl, {});
  assert.equal(calls, 0);
  assert.equal(config.apiBase, undefined);
  assert.equal(config.authAuthority, undefined);
  assert.equal(config.authClientId, undefined);
  assert.equal(config.authRedirectUri, undefined);
});

test('loadSyncConfig merges the runtime file over build-time values', async () => {
  const fetchImpl = async (url: string) => {
    assert.equal(url, '/sync-config.json');
    return {
      ok: true,
      json: async () => ({
        apiBase: 'https://runtime.example.test',
        authAuthority: 'https://runtime-auth.example.test',
      }),
    };
  };
  const config = await loadSyncConfig(fetchImpl, {
    VITE_SYNC_API_BASE: 'https://build.example.test',
    VITE_SYNC_AUTH_CLIENT_ID: 'build-client',
  });
  assert.equal(config.apiBase, 'https://runtime.example.test');
  assert.equal(config.authAuthority, 'https://runtime-auth.example.test');
  assert.equal(config.authClientId, 'build-client');
});

test('loadSyncConfig ignores a broken runtime file (never throws)', async () => {
  const fetchImpl = async () => {
    throw new Error('offline');
  };
  const config = await loadSyncConfig(fetchImpl, { VITE_SYNC_API_BASE: 'https://build.example.test' });
  assert.equal(config.apiBase, 'https://build.example.test');
  assert.equal(config.authAuthority, undefined);
});

// --- state machine ---------------------------------------------------------

test('unconfigured runtime reports local-only and makes no api calls', async () => {
  const api = makeApi();
  const { runtime } = makeRuntime({ config: {}, api });
  const state = await runtime.state();
  assert.equal(state.mode, 'local-only');
  assert.equal(state.pending, 0);
  assert.equal(api.calls.length, 0);
  assert.equal(runtime.isConfigured(), false);
});

test('configured runtime with no transport still reports local-only and calls nothing', async () => {
  const api = makeApi();
  const { runtime, storage } = makeRuntime({ api: undefined, storage: new MemoryStorage() });
  const state = await runtime.state();
  assert.equal(state.mode, 'local-only');
  assert.equal(runtime.isConfigured(), false);
  assert.equal(storage.queue.size, 0);
  assert.equal(api.calls.length, 0);
});

// --- enable ----------------------------------------------------------------

test('enable orders session → key fetch → device register → adoption, with nothing to show', async () => {
  const api = makeApi();
  const storage = new MemoryStorage();
  const service = makeFakeService();
  const runtime = createSyncRuntime({ config: CONFIG, api, service, storage });

  const returned = await runtime.enable({ idToken: 'id-token' });

  // Nothing is handed back to display (user decision: no visible key material).
  assert.equal(returned, undefined);

  // exact order of the network steps
  assert.deepEqual(api.calls, [
    'exchangeSession:id-token',
    `registerDevice:${storage.state?.deviceId}`,
  ]);

  // state is enabled + ready, with the device persisted
  assert.equal(storage.state?.enabled, true);
  assert.equal(storage.state?.userId, 'usr_1');
  assert.match(String(storage.state?.deviceId), /^[0-9a-f]{32}$/);
  assert.equal((await runtime.state()).mode, 'syncing');
});

test('enable adopts every existing attempt, collection and Woodpecker record', async () => {
  const api = makeApi();
  const storage = new MemoryStorage();
  const { runtime } = makeRuntime({ api, storage });
  await runtime.enable({ idToken: 'id-token' });

  const pointers = [...storage.queue.values()].map((entry) => `${entry.type}:${entry.recordId}`).sort();
  assert.deepEqual(pointers, [
    'attempt:a1',
    'attempt:a2',
    'collection:coll-1',
    `woodpecker:woodpecker-1`,
    `woodpecker:woodpecker-cycle-1`,
    `woodpeckerResult:${woodpeckerResultRecordId('woodpecker-cycle-1', 'puzzle-a1')}`,
  ].sort());
});

test('re-enabling keeps this device signing key (never mints a second one)', async () => {
  const api = makeApi();
  const storage = new MemoryStorage();
  const keys = new MemoryKeyStorage();
  const runtime = createSyncRuntime({
    config: CONFIG,
    api,
    service: makeFakeService(),
    storage,
    keyStorage: keys,
  });

  await runtime.enable({ idToken: 'id-token' });
  const first = keys.secrets?.devicePublicKeyJwk.x;

  await runtime.enable({ idToken: 'id-token' });
  assert.equal(keys.secrets?.devicePublicKeyJwk.x, first, 'the same signing key is kept');
  assert.equal(storage.dump().includes('privateKey'), false, 'no key material in sync state');
});

// --- syncNow ---------------------------------------------------------------

test('syncNow pushes sealed envelopes and acks both accepted and duplicate keys', async () => {
  const { runtime, api, storage } = await enabledRuntime();
  let pushed = 0;
  api.pushImpl = async (request) => {
    pushed += request.push.length;
    return {
      cursor: 7,
      accepted: request.push.slice(0, 2).map((envelope) => envelope.dedupeKey),
      duplicates: request.push.slice(2).map((envelope) => envelope.dedupeKey),
      changes: [],
    };
  };

  const result = await runtime.syncNow();
  assert.equal(pushed, 6);
  assert.deepEqual(result, {
    pushed: 6,
    accepted: 6,
    applied: 0,
    skipped: 0,
    duplicates: 0,
    cursor: 7,
  });
  assert.equal(storage.queue.size, 0, 'accepted + duplicates clear the queue');
  assert.equal(storage.state?.cursor, 7);
});

test('syncNow leaves pointers the server did not accept queued', async () => {
  const { runtime, api, storage } = await enabledRuntime();
  api.pushImpl = async (request) => ({
    cursor: 1,
    accepted: request.push
      .filter((envelope) => envelope.type === 'attempt' || envelope.type === 'collection')
      .map((envelope) => envelope.dedupeKey),
    duplicates: [],
    changes: [],
  });

  await runtime.syncNow();
  const remaining = [...storage.queue.values()].map((entry) => entry.type);
  assert.equal(remaining.length, 3);
  assert.ok(remaining.every((type) => type === 'woodpecker' || type === 'woodpeckerResult'));
});

test('syncNow treats a 422 as not-acknowledged and rethrows (queue preserved)', async () => {
  const { runtime, api, storage } = await enabledRuntime();
  api.pushImpl = async () => {
    throw Object.assign(new Error('invalid envelope'), { status: 422 });
  };

  await assert.rejects(() => runtime.syncNow());
  assert.equal(storage.queue.size, 6, 'a rejected batch acks nothing');
  assert.equal((await runtime.state()).mode, 'syncing');
});

test('a permanent device 422 re-registers the key once and retries the batch', async () => {
  const { runtime, api, storage } = await enabledRuntime();
  api.calls.length = 0;
  let pushes = 0;
  let acceptedOnRetry = 0;
  api.pushImpl = async (request) => {
    pushes += 1;
    if (pushes === 1) {
      throw Object.assign(new Error('bad signature'), { status: 422, code: 'invalid_signature' });
    }
    acceptedOnRetry += request.push.length;
    return {
      cursor: request.since + request.push.length,
      accepted: request.push.map((envelope) => envelope.dedupeKey),
      duplicates: [],
      changes: [],
    };
  };

  const result = await runtime.syncNow();

  assert.equal(acceptedOnRetry, 6, 'the retried batch carried every pointer');
  assert.equal(storage.queue.size, 0, 'the retried batch was acked');
  assert.equal(result.accepted, 6);
  assert.equal(
    api.calls.filter((call) => call.startsWith('registerDevice:')).length,
    1,
    'the device key was re-registered exactly once',
  );
  assert.equal((await runtime.state()).mode, 'syncing');
});

test('a permanent device 422 that keeps failing stops retrying with the queue preserved', async () => {
  const { service, emit } = observableService();
  const storage = new MemoryStorage();
  const api = makeApi();
  let pushes = 0;
  api.pushImpl = async () => {
    pushes += 1;
    throw Object.assign(new Error('device revoked'), { status: 422, code: 'device_revoked' });
  };
  const timers = new FakeTimers();
  const runtime = createSyncRuntime({
    config: CONFIG,
    api,
    service,
    storage,
    timers: timers.timers,
    debounceMs: 60_000,
  });
  await runtime.enable({ idToken: 'id-token' });
  const queued = storage.queue.size;
  assert.ok(queued > 0, 'adoption queued pointers');
  api.calls.length = 0;

  emit('attempt', 'a1');
  await flushAsync();
  assert.equal(timers.pending().length, 1, 'debounce armed');

  timers.advance(60_000);
  await waitFor(() => pushes >= 2, 'one push + one retry');
  await flushAsync();

  assert.equal(
    api.calls.filter((call) => call.startsWith('registerDevice:')).length,
    1,
    'the device key was re-registered exactly once',
  );
  assert.equal(storage.queue.size, queued, 'the batch stays queued, not acked');
  assert.deepEqual(timers.pending(), [], 'no blind backoff for a permanent device error');
  assert.equal((await runtime.state()).mode, 'syncing', 'not paused; the queue is simply pending');
  runtime.dispose?.();
});

test('a 401 pauses sync and keeps the queue intact', async () => {
  const { runtime, api, storage } = await enabledRuntime();
  api.pushImpl = async () => {
    throw Object.assign(new Error('unauthenticated'), { status: 401 });
  };

  const result = await runtime.syncNow();
  assert.deepEqual(result, {
    pushed: 0,
    accepted: 0,
    applied: 0,
    skipped: 0,
    duplicates: 0,
    cursor: 0,
    paused: true,
  });
  assert.equal((await runtime.state()).mode, 'paused');
  assert.equal(storage.queue.size, 6, 'paused keeps every pointer');
  assert.equal(storage.state?.enabled, true);
});

test('syncNow applies response.changes and persists the advanced cursor', async () => {
  const writer = new RecordingWriter();
  const api = makeApi();
  const storage = new MemoryStorage();
  const service = makeFakeService();
  const runtime = createSyncRuntime({ config: CONFIG, api, service, storage, writer });
  await runtime.enable({ idToken: 'id-token' });
  const change = await remoteAttemptChange('remote-1', 5);

  api.pushImpl = async (request) => ({
    cursor: 5,
    accepted: request.push.map((envelope) => envelope.dedupeKey),
    duplicates: [],
    changes: [change],
  });

  const result = await runtime.syncNow();
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.cursor, 5);
  assert.ok(writer.attempts.has('remote-1'), 'the inbound attempt was applied');
  assert.equal(storage.state?.cursor, 5, 'the advanced cursor was persisted');
});

test('syncNow still pulls when the outbound queue is empty', async () => {
  const writer = new RecordingWriter();
  const api = makeApi();
  const store = new LocalStore(new InMemoryStorageBackend());
  const service = makeFakeService();
  const runtime = createSyncRuntime({
    config: CONFIG,
    api,
    service,
    storage: syncStorage(store),
    keyStorage: syncKeyStorage(store),
    writer,
  });
  await runtime.enable({ idToken: 'id-token' });

  // Drain the adoption queue first.
  api.pushImpl = async (request) => ({
    cursor: request.push.length,
    accepted: request.push.map((envelope) => envelope.dedupeKey),
    duplicates: [],
    changes: [],
  });
  await runtime.syncNow();
  assert.equal((await store.loadSyncQueueEntries()).length, 0, 'queue drained');

  const change = await remoteAttemptChange('remote-1', 7);
  api.pushImpl = async () => ({ cursor: 7, accepted: [], duplicates: [], changes: [change] });

  const result = await runtime.syncNow();
  assert.equal(result.pushed, 0);
  assert.equal(result.applied, 1, 'an empty queue is a pure pull, not a no-op');
  assert.ok(writer.attempts.has('remote-1'));
});

test('syncNow does not move the cursor past an unreadable record', async () => {
  const writer = new RecordingWriter();
  const api = makeApi();
  const storage = new MemoryStorage();
  const service = makeFakeService();
  const runtime = createSyncRuntime({ config: CONFIG, api, service, storage, writer });
  await runtime.enable({ idToken: 'id-token' });
  const good = await remoteAttemptChange('remote-1', 5);
  const bad = corrupt(await remoteAttemptChange('remote-2', 6));

  api.pushImpl = async () => ({
    cursor: 6,
    accepted: [],
    duplicates: [],
    changes: [good, bad],
  });

  const result = await runtime.syncNow();
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.cursor, 5, 'cursor stops before the unreadable record');
  assert.equal(storage.state?.cursor, 5, 'the blocked cursor is persisted for retry');
  assert.ok(writer.attempts.has('remote-1'));
  assert.ok(!writer.attempts.has('remote-2'));
});

test('pullOnly applies inbound changes with no push', async () => {
  const writer = new RecordingWriter();
  const api = makeApi();
  const storage = new MemoryStorage();
  const service = makeFakeService();
  const runtime = createSyncRuntime({ config: CONFIG, api, service, storage, writer });
  await runtime.enable({ idToken: 'id-token' });
  const change = await remoteAttemptChange('remote-1', 9);

  let pushed = 0;
  api.pushImpl = async (request) => {
    pushed = request.push.length;
    return { cursor: 9, accepted: [], duplicates: [], changes: [change] };
  };

  const result = await runtime.pullOnly!();
  assert.equal(pushed, 0, 'pullOnly never pushes');
  assert.equal(result.applied, 1);
  assert.equal(result.cursor, 9);
  assert.ok(writer.attempts.has('remote-1'));
});

test('enable reuses an existing server session without a fresh idToken', async () => {
  const api = makeApi();
  const store = new LocalStore(new InMemoryStorageBackend());
  const runtime = createSyncRuntime({
    config: CONFIG,
    api,
    service: makeFakeService(),
    storage: syncStorage(store),
    keyStorage: syncKeyStorage(store),
  });
  await runtime.enable({ idToken: 'id-token' });
  const keyAfterFirst = (await store.loadSyncSecrets())!.devicePublicKeyJwk.x;

  api.calls.length = 0;
  await runtime.enable();

  assert.equal(
    (await store.loadSyncSecrets())!.devicePublicKeyJwk.x,
    keyAfterFirst,
    'the same device signing key is kept',
  );
  assert.equal(api.calls[0], 'getSession');
  assert.ok(!api.calls.some((call) => call.startsWith('exchangeSession')), 'no token exchange');
  assert.equal((await runtime.state()).mode, 'syncing');
});

test('enable adopts the setting group and user puzzles as pointers', async () => {
  const userPuzzle: NormalizedPuzzle = {
    id: 'user-1',
    contentSchemaVersion: '1.0.0',
    rating: 1100,
    source: 'user',
    sourceId: 'user-1',
    themes: ['user'],
    sourceFen: 'fen',
    solverFen: 'fen',
    solverColor: 'white',
    solution: ['e2e4'],
    originalFields: {},
  };
  const service: SyncRuntimeService = {
    ...makeFakeService(),
    getCuratedSettings: () => ({ failurePreset: 'retry-reset' }),
    listPuzzles: () => [userPuzzle],
  };
  const api = makeApi();
  const { runtime, storage } = makeRuntime({ api, storage: new MemoryStorage(), service });
  await runtime.enable({ idToken: 'id-token' });

  const pointers = [...storage.queue.values()].map((entry) => `${entry.type}:${entry.recordId}`).sort();
  assert.ok(pointers.includes('setting:scheduler'));
  assert.ok(pointers.includes('userPuzzle:user-1'));

  const pushed: SyncRecordEnvelope[][] = [];
  api.pushImpl = async (request) => {
    pushed.push(request.push);
    return {
      cursor: 1,
      accepted: request.push.map((envelope) => envelope.dedupeKey),
      duplicates: [],
      changes: [],
    };
  };
  await runtime.syncNow();
  const types = pushed.flat().map((envelope) => `${envelope.type}:${envelope.recordId}`);
  assert.ok(types.includes('setting:scheduler'));
  assert.ok(types.includes('userPuzzle:user-1'));
});

test('isUnauthorized recognises the common error shapes', () => {
  assert.equal(isUnauthorized({ status: 401 }), true);
  assert.equal(isUnauthorized({ statusCode: 401 }), true);
  assert.equal(isUnauthorized({ code: 'unauthorized' }), true);
  assert.equal(isUnauthorized({ status: 500 }), false);
  assert.equal(isUnauthorized(undefined), false);
  assert.equal(isUnauthorized('401'), false);
});

// --- lifecycle -------------------------------------------------------------

test('disable clears sync state + queue but keeps local training data', async () => {
  const { runtime, api, storage, service } = await enabledRuntime();
  await runtime.disable();

  assert.equal(storage.queue.size, 0);
  assert.equal(storage.state?.enabled, false);
  assert.equal((await runtime.state()).mode, 'local-only');
  assert.equal(service.getAttemptCount(), 2, 'attempts untouched');
  assert.equal(service.listCollections().length, 1, 'collections untouched');
  assert.ok(!api.calls.includes('signOut'), 'disable does not call the server');
});

test('signOut ends the server session and keeps local training data', async () => {
  const { runtime, api, storage, service } = await enabledRuntime();
  await runtime.signOut();

  assert.ok(api.calls.includes('signOut'));
  assert.equal(storage.queue.size, 0);
  assert.equal(storage.state?.enabled, false);
  assert.equal((await runtime.state()).mode, 'local-only');
  assert.equal(service.getAttemptCount(), 2);
});

test('deleteServerCopy calls the API and never deletes local training data', async () => {
  const { runtime, api, storage, service } = await enabledRuntime();
  await runtime.deleteServerCopy();

  assert.ok(api.calls.includes('deleteAccount'));
  assert.equal(service.getAttemptCount(), 2);
  assert.equal(service.listCollections().length, 1);
  assert.equal(storage.state?.enabled, false);
  assert.equal(storage.queue.size, 0);
});

test('enable on an unconfigured runtime refuses without any network call', async () => {
  const api = makeApi();
  const { runtime } = makeRuntime({ config: {}, api });
  await assert.rejects(() => runtime.enable({ idToken: 'id-token' }));
  assert.equal(api.calls.length, 0);
});

// --- ONL-013 continuous capture + auto-sync --------------------------------

test('a burst of local changes is coalesced into one push after the debounce', async () => {
  const { service, emit } = observableService();
  const storage = new MemoryStorage();
  const api = makeApi();
  const batches: number[] = [];
  api.pushImpl = async (request) => {
    batches.push(request.push.length);
    return {
      cursor: request.since + request.push.length,
      accepted: request.push.map((envelope) => envelope.dedupeKey),
      duplicates: [],
      changes: [],
    };
  };
  const timers = new FakeTimers();
  const runtime = createSyncRuntime({
    config: CONFIG,
    api,
    service,
    storage,
    timers: timers.timers,
    debounceMs: 60_000,
  });
  await runtime.enable({ idToken: 'id-token' });
  await runtime.syncNow(); // drain adoption
  batches.length = 0;

  emit('attempt', 'a1');
  emit('collection', 'coll-1');
  emit('attempt', 'a1'); // same record again → coalesced
  await flushAsync();
  assert.equal(timers.pending().length, 1, 'exactly one debounce armed');
  assert.equal(batches.length, 0, 'nothing pushed before the quiet period');

  timers.advance(60_000);
  await waitFor(() => batches.filter((size) => size > 0).length === 1, 'burst push');
  assert.equal(batches.filter((size) => size > 0).length, 1, 'the whole burst pushed once');
  assert.equal(
    batches.reduce((total, size) => total + size, 0),
    2,
    'two distinct pointers (a1 coalesced) were sealed',
  );
  runtime.dispose?.();
});

test('a failed auto-sync keeps pointers and retries with exponential backoff', async () => {
  const { service, emit } = observableService();
  const storage = new MemoryStorage();
  const api = makeApi();
  let attempts = 0;
  api.pushImpl = async () => {
    attempts += 1;
    throw Object.assign(new Error('network down'), { status: 0 });
  };
  const timers = new FakeTimers();
  const runtime = createSyncRuntime({
    config: CONFIG,
    api,
    service,
    storage,
    timers: timers.timers,
    debounceMs: 60_000,
    retryBaseMs: 5_000,
    retryMaxMs: 20_000,
  });
  await runtime.enable({ idToken: 'id-token' });
  const queued = storage.queue.size;
  assert.ok(queued > 0, 'adoption queued pointers');

  emit('attempt', 'a1');
  await flushAsync();
  assert.equal(timers.pending().length, 1, 'debounce armed');
  timers.advance(60_000);
  await waitFor(() => attempts === 1 && timers.pending()[0] === 5_000, 'first failed push');
  assert.equal(attempts, 1);
  assert.equal(storage.queue.size, queued, 'a failed push acks nothing');
  assert.deepEqual(timers.pending(), [5_000], 'first retry after 5 s');

  timers.advance(5_000);
  await waitFor(() => attempts === 2 && timers.pending()[0] === 10_000, 'second failed push');
  assert.deepEqual(timers.pending(), [10_000], 'the retry doubles');

  timers.advance(10_000);
  await waitFor(() => attempts === 3 && timers.pending()[0] === 20_000, 'third failed push');
  assert.deepEqual(timers.pending(), [20_000], 'still doubling');

  timers.advance(20_000);
  await waitFor(() => attempts === 4, 'fourth failed push');
  await waitFor(() => timers.pending()[0] === 20_000, 'capped backoff');
  assert.deepEqual(timers.pending(), [20_000], 'backoff caps at retryMaxMs');
  runtime.dispose?.();
});

test('online and visibilitychange trigger an immediate flush; dispose removes them', async () => {
  const { service } = observableService();
  const storage = new MemoryStorage();
  const api = makeApi();
  let pushes = 0;
  api.pushImpl = async (request) => {
    pushes += 1;
    return {
      cursor: request.since + request.push.length,
      accepted: request.push.map((envelope) => envelope.dedupeKey),
      duplicates: [],
      changes: [],
    };
  };
  const timers = new FakeTimers();
  const runtime = createSyncRuntime({ config: CONFIG, api, service, storage, timers: timers.timers });
  await runtime.enable({ idToken: 'id-token' });
  await runtime.syncNow();
  pushes = 0;

  const target = new FakeTarget();
  runtime.attachFlushTriggers?.(target);
  assert.equal(target.count('online'), 1);
  assert.equal(target.count('visibilitychange'), 1);

  target.dispatch('online');
  await waitFor(() => pushes === 1, 'online flush');
  assert.equal(pushes, 1, 'online flushes immediately');

  target.dispatch('visibilitychange');
  await waitFor(() => pushes === 2, 'visibilitychange flush');
  assert.equal(pushes, 2, 'visibilitychange flushes immediately');

  runtime.dispose?.();
  assert.equal(target.total(), 0, 'dispose removes every listener');
});

test('an attached app pulls on its own every minute (auto-sync while idle)', async () => {
  // Without this, two devices sitting open and idle never converge: every
  // existing trigger needs an *event* (a local change, `online`, visibility).
  const { service } = observableService();
  const api = makeApi();
  let rounds = 0;
  api.pushImpl = async () => {
    rounds += 1;
    return { cursor: 0, accepted: [], duplicates: [], changes: [] };
  };
  const timers = new FakeTimers();
  const runtime = createSyncRuntime({
    config: CONFIG,
    api,
    service,
    storage: new MemoryStorage(),
    timers: timers.timers,
  });
  await runtime.enable({ idToken: 'id-token' });
  await runtime.syncNow(); // drain adoption
  const before = rounds;

  const target = new FakeTarget();
  runtime.attachFlushTriggers?.(target);
  await waitFor(() => timers.pending().includes(SYNC_PERIODIC_MS), 'the periodic loop is armed');

  timers.advance(SYNC_PERIODIC_MS);
  await waitFor(() => rounds === before + 1, 'an idle round ran');

  await waitFor(() => timers.pending().includes(SYNC_PERIODIC_MS), 'and re-armed itself');
  timers.advance(SYNC_PERIODIC_MS);
  await waitFor(() => rounds === before + 2, 'so a second idle round runs');

  runtime.dispose?.();
  timers.advance(SYNC_PERIODIC_MS * 3);
  assert.equal(rounds, before + 2, 'dispose stops the loop');
});

test('attachFlushTriggers wires no listeners for an unconfigured runtime', () => {
  const { service } = observableService();
  const runtime = createSyncRuntime({
    config: {},
    api: makeApi(),
    service,
    storage: new MemoryStorage(),
  });
  const target = new FakeTarget();
  runtime.attachFlushTriggers?.(target);
  runtime.attachFlushTriggers?.(undefined);
  assert.equal(target.total(), 0);
  assert.equal(runtime.isConfigured(), false);
  runtime.dispose?.();
});

test('visibilitychange attaches to the document when the target exposes one', () => {
  const { service } = observableService();
  const runtime = createSyncRuntime({
    config: CONFIG,
    api: makeApi(),
    service,
    storage: new MemoryStorage(),
  });
  const windowLike = new FakeTarget() as FakeTarget & { document?: FakeTarget };
  const documentLike = new FakeTarget();
  windowLike.document = documentLike;

  runtime.attachFlushTriggers?.(windowLike);
  assert.equal(windowLike.count('online'), 1, 'online stays on the window');
  assert.equal(windowLike.count('visibilitychange'), 0);
  assert.equal(documentLike.count('visibilitychange'), 1, 'visibilitychange uses the document');

  runtime.dispose?.();
  assert.equal(windowLike.total(), 0);
  assert.equal(documentLike.total(), 0);
});

test('a manual syncNow resets the pending debounce', async () => {
  const { service, emit } = observableService();
  const storage = new MemoryStorage();
  const api = makeApi();
  const batches: number[] = [];
  api.pushImpl = async (request) => {
    batches.push(request.push.length);
    return {
      cursor: request.since + request.push.length,
      accepted: request.push.map((envelope) => envelope.dedupeKey),
      duplicates: [],
      changes: [],
    };
  };
  const timers = new FakeTimers();
  const runtime = createSyncRuntime({
    config: CONFIG,
    api,
    service,
    storage,
    timers: timers.timers,
    debounceMs: 60_000,
  });
  await runtime.enable({ idToken: 'id-token' });
  await runtime.syncNow();
  batches.length = 0;

  emit('attempt', 'a1');
  await waitFor(() => timers.pending().length === 1, 'debounce armed');
  assert.equal(batches.filter((size) => size > 0).length, 0, 'nothing pushed yet');

  await runtime.syncNow();
  assert.equal(batches.filter((size) => size > 0).length, 1, 'the manual sync pushed');
  assert.equal(timers.pending().length, 0, 'the manual sync cleared the debounce');

  timers.advance(60_000);
  await flushAsync();
  assert.equal(batches.filter((size) => size > 0).length, 1, 'no extra automatic push');
  runtime.dispose?.();
});

test('the default sync debounce is 10 seconds (ONL-016)', async () => {
  assert.equal(SYNC_DEFAULT_DEBOUNCE_MS, 10_000);

  // A runtime with no explicit `debounceMs` arms the 10 s default.
  const { service, emit } = observableService();
  const timers = new FakeTimers();
  const runtime = createSyncRuntime({
    config: CONFIG,
    api: makeApi(),
    service,
    storage: new MemoryStorage(),
    timers: timers.timers,
  });
  await runtime.enable({ idToken: 'id-token' });
  await runtime.syncNow(); // drain adoption
  emit('attempt', 'a1');
  await waitFor(() => timers.pending().length === 1, 'debounce armed');
  assert.deepEqual(timers.pending(), [10_000], 'the quiet period is 10 s');
  runtime.dispose?.();
});

test('sealed envelopes carry a strictly increasing per-device rev (ONL-016)', async () => {
  const { runtime, api } = await enabledRuntime();
  const revs: number[] = [];
  api.pushImpl = async (request) => {
    for (const envelope of request.push) revs.push(envelope.rev);
    return {
      cursor: request.since + request.push.length,
      accepted: request.push.map((envelope) => envelope.dedupeKey),
      duplicates: [],
      changes: [],
    };
  };

  await runtime.syncNow(); // adoption batch: several records sealed in a row
  const firstBatch = revs.length;
  assert.ok(firstBatch > 1, 'the adoption batch sealed several records');

  // Re-adopt (a fresh enable) so a second batch is sealed on the same runtime.
  await runtime.enable({ idToken: 'id-token' });
  await runtime.syncNow();
  assert.ok(revs.length > firstBatch, 'a second batch was sealed');

  for (let index = 1; index < revs.length; index += 1) {
    assert.ok(
      revs[index]! > revs[index - 1]!,
      `rev must strictly increase (${revs[index - 1]} → ${revs[index]})`,
    );
  }
  runtime.dispose?.();
});

test('full-timing round trip reproduces the same intervals on replay', async () => {
  const server = new FakeServer();
  const clock = mutableClock(1_700_000_000_000);
  const puzzles = [makePuzzle({ id: 'p1' })];
  const programId = 'local-spaced-reps-v1';

  const storeA = new LocalStore(new InMemoryStorageBackend(), clock);
  const serviceA = new LocalTrainingService({ store: storeA, clock });
  await serviceA.init();
  await serviceA.seedContent(puzzles);
  const collectionId = serviceA.getActiveCollectionId();
  const session = await serviceA.startSession({ programId, collectionId });

  // Three successes: New → Learning → Review → Review. The last one is a
  // Review→Review success, where the interruption segment changes the interval.
  const segments = [
    timing(),
    timing(),
    timing({ interruptionSeconds: 7, timingTrustworthy: true }),
  ];
  for (const [index, segment] of segments.entries()) {
    const started = await serviceA.startAttempt({
      sessionId: session.session.sessionId,
      progressKey: { programId, collectionId, puzzleId: 'p1' },
      expectedScheduleRevision: 0,
    });
    await serviceA.commitOutcome({
      attemptId: started.attemptId,
      outcome: 'success',
      timing: segment,
      expectedScheduleRevision: started.scheduleRevision,
      idempotencyKey: `a-${index}`,
    });
    clock.advance(60_000);
  }
  const key = progressKeyToString({ programId, collectionId, puzzleId: 'p1' });
  const expected = serviceA.getScheduleState(key);
  assert.ok(expected, 'A has a schedule for p1');

  const runtimeA = createSyncRuntime({
    config: CONFIG,
    api: server,
    service: serviceA,
    storage: syncStorage(storeA),
    keyStorage: syncKeyStorage(storeA),
    clock: () => clock.now(),
  });
  await runtimeA.enable({ idToken: 'token-a' });
  await runtimeA.syncNow();

  // Device B is the same account: adopt A's secrets, reuse the session.
  const aSecrets = await storeA.loadSyncSecrets();
  const aState = await storeA.loadSyncState();
  assert.ok(aSecrets && aState);
  const storeB = new LocalStore(new InMemoryStorageBackend(), clock);
  const serviceB = new LocalTrainingService({ store: storeB, clock });
  await serviceB.init();
  await serviceB.seedContent(puzzles);
  await storeB.saveSyncSecrets(aSecrets);
  await storeB.saveSyncState({ ...aState, deviceId: 'device-b', cursor: 0 });
  const runtimeB = createSyncRuntime({
    config: CONFIG,
    api: server,
    service: serviceB,
    storage: syncStorage(storeB),
    keyStorage: syncKeyStorage(storeB),
    clock: () => clock.now(),
  });
  await runtimeB.enable();
  const pulled = await runtimeB.pullOnly!();
  assert.ok(pulled.applied >= 3, 'B applied A’s attempts');

  const bAttempts = serviceB.listAttempts({ limit: 10 });
  assert.ok(
    bAttempts.some((attempt) => attempt.timing.interruptionSeconds === 7),
    'the interruption segment survived the round trip',
  );
  assert.deepEqual(
    serviceB.getScheduleState(key),
    expected,
    'replay reproduces the same schedule (and intervals)',
  );

  runtimeA.dispose?.();
  runtimeB.dispose?.();
});

// --- Settings wiring -------------------------------------------------------

function collectText(node: VNode | string | null | undefined): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  const out: string[] = [];
  if (typeof node.text === 'string') out.push(node.text);
  for (const child of node.children ?? []) out.push(...collectText(child as VNode | string));
  return out;
}

function findById(node: VNode | string | null | undefined, id: string): VNode | null {
  if (node === null || node === undefined || typeof node === 'string') return null;
  if ((node.data?.attrs as Record<string, unknown> | undefined)?.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findById(child as VNode | string, id);
    if (found) return found;
  }
  return null;
}

function stubRuntime(calls: string[]): SyncRuntime {
  return {
    config: CONFIG,
    isConfigured: () => true,
    state: async () => ({ mode: 'syncing', pending: 3, lastSyncedAt: Date.now() }),
    enable: async () => {},
    syncNow: async () => {
      calls.push('syncNow');
      return { pushed: 0, accepted: 0 };
    },
    disable: async () => {
      calls.push('disable');
    },
    signOut: async () => {
      calls.push('signOut');
    },
    deleteServerCopy: async () => {
      calls.push('deleteServerCopy');
    },
  };
}

test('Settings maps the runtime state into the panel and wires its actions', async () => {
  const service = await makeService();
  const adapter = { reloadAfterDataChange: async () => {} } as unknown as TrainingAdapter;
  const calls: string[] = [];
  const ctrl = new SettingsCtrl(service, adapter);
  await ctrl.attachSync(stubRuntime(calls));

  const tree = settingsView(ctrl);
  const mode = findById(tree, 'sync-mode')!;
  assert.equal((mode.data?.attrs as Record<string, unknown>)['data-sync-mode'], 'syncing');
  assert.ok(collectText(tree).some((text) => /3 changes waiting to sync/.test(text)));

  const syncNow = findById(tree, 'sync-now')!;
  const onClick = (syncNow.data?.on as { click?: () => void } | undefined)?.click;
  assert.equal(typeof onClick, 'function');
  onClick!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['syncNow']);
});

test('Settings does not report completion when syncNow pauses on an expired session', async () => {
  const service = await makeService();
  const adapter = { reloadAfterDataChange: async () => {} } as unknown as TrainingAdapter;
  const calls: string[] = [];
  const runtime = stubRuntime(calls);
  runtime.state = async () => ({ mode: 'paused', pending: 3 });
  runtime.syncNow = async () => {
    calls.push('syncNow');
    return { pushed: 0, accepted: 0, skipped: 0, paused: true };
  };
  let latest: VNode | undefined;
  const ctrl = new SettingsCtrl(service, adapter, () => {
    latest = settingsView(ctrl);
  });
  await ctrl.attachSync(runtime);
  const syncNow = findById(settingsView(ctrl), 'sync-now')!;
  const onClick = (syncNow.data?.on as { click?: () => void } | undefined)?.click;
  onClick!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rendered = collectText(latest);
  assert.ok(!rendered.includes('Sync complete.'));
  assert.ok(rendered.includes('Sync paused. Your sign-in may have expired; sign in again. Changes remain queued on this device.'));
});

test('Settings falls back to the inert local-only panel when no runtime is attached', async () => {
  const service = await makeService();
  const adapter = { reloadAfterDataChange: async () => {} } as unknown as TrainingAdapter;
  const ctrl = new SettingsCtrl(service, adapter);
  const tree = settingsView(ctrl);
  const mode = findById(tree, 'sync-mode')!;
  assert.equal((mode.data?.attrs as Record<string, unknown>)['data-sync-mode'], 'local-only');
  const enable = findById(tree, 'sync-enable')!;
  assert.equal((enable.data?.attrs as Record<string, unknown>).disabled, true);
});
