/**
 * ONL-011 — device-local sync secrets (master key + signing keypair).
 *
 * Covers: `LocalStore` persistence + defensive copies, secrets surviving a
 * simulated reload (`syncing`), exports never containing key material,
 * `deleteSyncSecrets`, and recovery after the device-local cache is lost —
 * which needs no user input at all (design #6 revised: the master key is
 * server-held, so `syncNow()` re-fetches it and returns to `syncing`).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AttemptRecord } from '@chessengram/contracts';
import type { SyncApiClient, SyncRecordEnvelope } from '../src/sync/types.ts';
import {
  COLLECTION_SYNC_SECRETS,
  LOCAL_STORE_SCHEMA_VERSION,
  STORE_COLLECTIONS,
  LocalStore,
  SYNC_DEVICE_KEY,
  SYNC_SECRETS_KEY,
  syncDeviceStorage,
  syncKeyStorage,
  syncStorage,
} from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import type { CollectionSyncState } from '../src/sync/collections.ts';
import {
  createSyncRuntime,
  type SyncRuntime,
  type SyncRuntimeService,
} from '../src/sync/bootstrap.ts';
import { verifyEnvelopeSignature } from '../src/sync/signing.ts';

const CONFIG = {
  apiBase: 'https://api.example.test',
  authAuthority: 'https://auth.example.test',
  authClientId: 'client-123',
};

function attempt(id: string, startedAt: number): AttemptRecord {
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
    settingsHash: 'settings-hash',
  };
}

function makeService(): SyncRuntimeService {
  const attempts = [attempt('a1', 100)];
  return {
    getAttemptCount: () => attempts.length,
    listAttempts: (filter = {}) => attempts.slice(0, filter.limit ?? 100).map((a) => structuredClone(a)),
    listCollections: () => [],
    listWoodpeckerSets: () => [],
    listWoodpeckerCycles: () => [],
    getWoodpeckerSet: () => undefined,
    getWoodpeckerCycle: () => undefined,
  };
}

interface FakeApi extends SyncApiClient {
  calls: string[];
  pushed: SyncRecordEnvelope[][];
}

function makeApi(): FakeApi {
  const calls: string[] = [];
  const pushed: SyncRecordEnvelope[][] = [];
  const api: FakeApi = {
    calls,
    pushed,
    async getSession() {
      return { userId: 'usr_1', expiresAt: Date.now() + 1_000 };
    },
    async exchangeSession() {
      calls.push('exchangeSession');
      return { userId: 'usr_1', expiresAt: Date.now() + 1_000 };
    },
    async signOut() {
      calls.push('signOut');
    },
    async registerDevice(input) {
      calls.push(`registerDevice:${input.deviceId}`);
      return { thumbprint: 'thumb' };
    },
    async listDevices() {
      return [];
    },
    async revokeDevice() {},
    async push(request) {
      calls.push('push');
      pushed.push(request.push.map((envelope) => ({ ...envelope })));
      return {
        cursor: 1,
        accepted: request.push.map((envelope) => envelope.dedupeKey),
        duplicates: [],
        changes: [],
      };
    },
    async deleteAccount() {
      calls.push('deleteAccount');
    },
  };
  return api;
}

function makeRuntime(store: LocalStore, api: SyncApiClient): SyncRuntime {
  return createSyncRuntime({
    config: CONFIG,
    api,
    service: makeService(),
    storage: syncStorage(store),
    keyStorage: syncKeyStorage(store),
  });
}

/** One page load: a fresh store + runtime over the same durable backend. */
function boot(backend: InMemoryStorageBackend) {
  const store = new LocalStore(backend);
  const api = makeApi();
  return { store, api, runtime: makeRuntime(store, api) };
}

// --- local store -----------------------------------------------------------

test('sync secrets persist, round-trip and are copied defensively', async () => {
  const store = new LocalStore(new InMemoryStorageBackend());
  const secrets = {
    devicePublicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'pub-x', y: 'pub-y' },
    devicePrivateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'pub-x', y: 'pub-y', d: 'secret-d' },
  };
  await store.saveSyncSecrets(secrets);

  const loaded = await store.loadSyncSecrets();
  assert.deepEqual(loaded, secrets);

  // Mutating a returned JWK must not change what is stored.
  loaded!.devicePrivateKeyJwk.d = 'tampered';
  assert.equal((await store.loadSyncSecrets())!.devicePrivateKeyJwk.d, 'secret-d');

  // An unknown schema version is treated as absent, never misread.
  const backend = new InMemoryStorageBackend();
  const other = new LocalStore(backend);
  await other.saveSyncSecrets(secrets);
  const raw = (await backend.getAll(COLLECTION_SYNC_SECRETS))[0];
  (raw!.value as { schemaVersion: string }).schemaVersion = '9.9.9';
  await backend.set(COLLECTION_SYNC_SECRETS, SYNC_SECRETS_KEY, raw!.value);
  assert.equal(await other.loadSyncSecrets(), undefined);
});

test('local storage version constants are unchanged and secrets stay out of the export set', () => {
  assert.equal(COLLECTION_SYNC_SECRETS, 'sync-secrets');
  assert.equal(LOCAL_STORE_SCHEMA_VERSION, '1.0.0');
  assert.ok(!(STORE_COLLECTIONS as readonly string[]).includes(COLLECTION_SYNC_SECRETS));
  // The rev counter lives in the same collection under a distinct key, so the
  // two records can never overwrite each other.
  assert.notEqual(SYNC_DEVICE_KEY, SYNC_SECRETS_KEY);
});

test('the device-local rev counter round-trips and stays out of exports (ONL-016)', async () => {
  const backend = new InMemoryStorageBackend();
  const store = new LocalStore(backend);
  assert.equal(await store.loadSyncDeviceState(), undefined, 'absent before any sync');

  await store.saveSyncDeviceState({ rev: 7 });
  assert.deepEqual(await store.loadSyncDeviceState(), { rev: 7 });

  // Ordinary local persistence: it survives a reload…
  const reloaded = new LocalStore(InMemoryStorageBackend.fromDump(backend.dump()));
  assert.deepEqual(await reloaded.loadSyncDeviceState(), { rev: 7 });

  // …and the standalone adapter reads/writes the same record.
  const adapter = syncDeviceStorage(store);
  await adapter.saveRev(9);
  assert.equal(await adapter.loadRev(), 9);

  // …but it never appears in an export.
  const exported = await store.exportData();
  assert.ok(!(COLLECTION_SYNC_SECRETS in exported.collections), 'sync-secrets is not exported');
  const serialized = JSON.stringify(exported);
  assert.ok(!serialized.includes('device-state'));
  assert.ok(!serialized.includes('"rev"'));

  // A corrupt/unknown-schema record is treated as absent, never misread.
  const raw = (await backend.getAll(COLLECTION_SYNC_SECRETS)).find((record) => record.key === SYNC_DEVICE_KEY);
  assert.ok(raw);
  (raw.value as { schemaVersion: string }).schemaVersion = '9.9.9';
  await backend.set(COLLECTION_SYNC_SECRETS, SYNC_DEVICE_KEY, raw.value);
  assert.equal(await store.loadSyncDeviceState(), undefined);
});

test('the rev counter persists across a reload and keeps increasing (ONL-016)', async () => {
  const backend = new InMemoryStorageBackend();
  const first = boot(backend);
  await first.runtime.enable({ idToken: 'id-token' });
  await first.runtime.syncNow(); // seals the adopted attempt → rev 1
  assert.equal((await first.store.loadSyncDeviceState())?.rev, 1);

  const reloaded = boot(backend);
  await reloaded.runtime.enable({ idToken: 'id-token' }); // re-adopt
  await reloaded.runtime.syncNow(); // seals again → rev 2
  assert.equal(
    (await reloaded.store.loadSyncDeviceState())?.rev,
    2,
    'the counter continues after a reload instead of resetting',
  );
});

test('inbound merge state persists in the sync collection without polluting the queue', async () => {
  const backend = new InMemoryStorageBackend();
  const store = new LocalStore(backend);
  const collectionState: CollectionSyncState = {
    collectionId: 'col-1',
    name: 'Endgames',
    nameUpdatedAt: 2_000,
    nameUpdatedBy: 'device-a',
    puzzleIds: new Set(['p1']),
    tombstones: new Map([['p2', 1_500]]),
    addedAt: new Map([['p1', 2_000]]),
    deletedAt: undefined,
    deletedUpdatedAt: 2_000,
    deletedUpdatedBy: 'device-a',
  };
  await store.saveCollectionSyncState(collectionState);
  await store.saveSettingSyncState('scheduler', { updatedAt: 10, updatedBy: 'device-a' });
  await store.saveUserPuzzleSyncState('p1', { updatedAt: 20 });
  await store.saveSyncQueueEntry({ type: 'attempt', recordId: 'a1', changedAt: 5 });

  // Reload: merge state round-trips and queue enumeration skips it.
  const reloaded = new LocalStore(InMemoryStorageBackend.fromDump(backend.dump()));
  assert.deepEqual(await reloaded.loadSyncQueueEntries(), [
    { type: 'attempt', recordId: 'a1', changedAt: 5 },
  ]);
  const restoredCollection = await reloaded.loadCollectionSyncState('col-1');
  assert.ok(restoredCollection);
  assert.deepEqual([...restoredCollection.puzzleIds], ['p1']);
  assert.deepEqual([...restoredCollection.tombstones.entries()], [['p2', 1_500]]);
  assert.deepEqual(await reloaded.loadSettingSyncState('scheduler'), {
    updatedAt: 10,
    updatedBy: 'device-a',
  });
  assert.deepEqual(await reloaded.loadUserPuzzleSyncState('p1'), { updatedAt: 20 });

  // A full export/import round-trip keeps the merge state and the queue clean.
  const exported = await store.exportData();
  const imported = new LocalStore(new InMemoryStorageBackend());
  await imported.applyExport(exported);
  assert.deepEqual(await imported.loadSyncQueueEntries(), [
    { type: 'attempt', recordId: 'a1', changedAt: 5 },
  ]);
  assert.ok(await imported.loadCollectionSyncState('col-1'));

  // A corrupt record is treated as absent, never misread.
  await backend.set('sync', `merge\u0001collection\u0001col-1`, {
    schemaVersion: '9.9.9',
    savedAt: 0,
    data: {},
  });
  const corruptStore = new LocalStore(backend);
  assert.equal(await corruptStore.loadCollectionSyncState('col-1'), undefined);
});

// --- reload ----------------------------------------------------------------

test('a reload restores the persisted device key and reports syncing', async () => {
  const backend = new InMemoryStorageBackend();
  const first = boot(backend);
  await first.runtime.enable({ idToken: 'id-token' });
  const publicKey = (await first.store.loadSyncSecrets())!.devicePublicKeyJwk;
  assert.equal((await first.runtime.state()).mode, 'syncing');

  const reloaded = boot(backend);
  assert.equal((await reloaded.runtime.state()).mode, 'syncing', 'no user input needed');

  const stored = await reloaded.store.loadSyncSecrets();
  assert.ok(stored, 'the device key was persisted');
  assert.deepEqual(stored!.devicePublicKeyJwk, publicKey, 'the same device key is restored');
});

test('syncNow after a reload signs envelopes with the persisted keypair', async () => {
  const backend = new InMemoryStorageBackend();
  const first = boot(backend);
  await first.runtime.enable({ idToken: 'id-token' });

  const reloaded = boot(backend);
  const result = await reloaded.runtime.syncNow();
  assert.equal(result.pushed, 1, 'the adopted attempt is pushed');

  const secrets = await reloaded.store.loadSyncSecrets();
  assert.ok(secrets);
  const envelope = reloaded.api.pushed[0]![0]!;
  assert.equal(envelope.deviceId, (await reloaded.store.loadSyncState())?.deviceId);
  assert.equal(
    await verifyEnvelopeSignature(envelope, secrets!.devicePublicKeyJwk),
    true,
    'the envelope verifies against the persisted signing key',
  );
});

// --- export safety ---------------------------------------------------------

test('exportData never contains the secrets collection or any key material', async () => {
  const backend = new InMemoryStorageBackend();
  const { store, runtime } = boot(backend);
  await runtime.enable({ idToken: 'id-token' });
  await runtime.syncNow(); // seal the adopted attempt so the rev counter is written
  const secrets = await store.loadSyncSecrets();
  assert.ok(secrets);
  assert.ok(await store.loadSyncDeviceState(), 'the rev counter is persisted device-locally');

  const exported = await store.exportData();
  assert.ok(!(COLLECTION_SYNC_SECRETS in exported.collections), 'secrets collection is absent');
  const serialized = JSON.stringify(exported);
  assert.ok(!serialized.includes('sync-secrets'));
  assert.ok(!serialized.includes('device-state'), 'rev state is absent');
  assert.ok(!serialized.includes('"rev"'), 'rev state is absent');
  assert.ok(!serialized.includes(secrets!.devicePrivateKeyJwk.d as string), 'private key absent');
});

// --- losing the device-local key cache -------------------------------------

test('a device whose keypair was cleared recovers by syncing again — no user input', async () => {
  const backend = new InMemoryStorageBackend();
  const first = boot(backend);
  await first.runtime.enable({ idToken: 'id-token' });

  // Simulate cleared/absent device-local state (fresh browser profile, or an
  // explicit delete) on a device that is still enabled + signed in.
  await first.store.deleteSyncSecrets();
  assert.equal(await first.store.loadSyncSecrets(), undefined);

  const reloaded = boot(backend);
  assert.equal((await reloaded.runtime.state()).mode, 'paused', 'no device key yet');

  await reloaded.runtime.syncNow();

  assert.equal((await reloaded.runtime.state()).mode, 'syncing');
  assert.ok(
    reloaded.api.calls.some((call) => call.startsWith('registerDevice:')),
    'a fresh device key is registered',
  );
  const restored = await reloaded.store.loadSyncSecrets();
  assert.ok(restored, 'the new keypair is persisted for the next reload');
  assert.equal(restored!.devicePrivateKeyJwk.d !== undefined, true, 'it has a private half');

  // And the next reload is back to normal.
  const after = boot(backend);
  assert.equal((await after.runtime.state()).mode, 'syncing');
});

test('an enabled device with no key does not sync or throw when the server is unreachable', async () => {
  const backend = new InMemoryStorageBackend();
  const first = boot(backend);
  await first.runtime.enable({ idToken: 'id-token' });
  await first.store.deleteSyncSecrets();

  const offline = boot(backend);
  offline.api.registerDevice = async () => {
    throw new Error('offline');
  };
  const result = await offline.runtime.syncNow();
  assert.deepEqual(result, { pushed: 0, accepted: 0, applied: 0, skipped: 0, duplicates: 0 });
  assert.equal(await offline.store.loadSyncSecrets(), undefined, 'nothing is persisted');
  assert.equal((await offline.runtime.state()).mode, 'paused', 'stays paused, local training unaffected');
});

// --- lifecycle: secrets survive disable / sign-out -------------------------

test('disable and sign-out keep device secrets so re-enabling needs no user input', async () => {
  const backend = new InMemoryStorageBackend();
  const { store, runtime } = boot(backend);
  await runtime.enable({ idToken: 'id-token' });
  const keyBefore = (await store.loadSyncSecrets())!.devicePublicKeyJwk;

  await runtime.disable();
  assert.equal((await runtime.state()).mode, 'local-only');
  const afterDisable = await store.loadSyncSecrets();
  assert.ok(afterDisable, 'disable keeps secrets');
  assert.deepEqual(afterDisable!.devicePublicKeyJwk, keyBefore, 'disable keeps the signing key');

  // Re-enabling re-adopts the server-issued key (never a fresh local one) and
  // needs nothing from the user; the signing keypair survives sign-out too.
  await runtime.enable({ idToken: 'id-token' });
  await runtime.signOut();
  const afterSignOut = await store.loadSyncSecrets();
  assert.ok(afterSignOut, 'sign-out keeps secrets');
  assert.deepEqual(afterSignOut!.devicePublicKeyJwk, keyBefore, 'sign-out keeps the signing key');
});

test('re-enabling with a fresh runtime reuses the persisted signing keypair', async () => {
  const backend = new InMemoryStorageBackend();
  const first = boot(backend);
  await first.runtime.enable({ idToken: 'id-token' });
  const keyBefore = (await first.store.loadSyncSecrets())!.devicePublicKeyJwk;

  const reloaded = boot(backend);
  await reloaded.runtime.enable({ idToken: 'id-token' });
  const keyAfter = (await reloaded.store.loadSyncSecrets())!.devicePublicKeyJwk;
  assert.deepEqual(keyAfter, keyBefore, 'the device key is not churned on re-enable');
});
