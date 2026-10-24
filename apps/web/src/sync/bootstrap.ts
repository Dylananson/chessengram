/**
 * ONL-009b — sync runtime wiring (config + four-state machine + queue drain).
 *
 * This is the seam between the pure sync pieces built by ONL-001/002/004/007 and
 * the running app: it loads configuration (`VITE_SYNC_*` merged with an optional
 * runtime `/sync-config.json`), owns the enable / sync / sign-out lifecycle and
 * drives the local pointer queue.
 *
 * Design invariants (`docs/research/online-sync-design.md`):
 * - **Local only is the default.** With no configuration this module never
 *   touches the network and reports `local-only`.
 * - **Dependency-injected.** Transport (`SyncApiClient`), persistence
 *   (`SyncQueueStorage & SyncStateStorage`), the training service, the clock and
 *   sleep are all injected, so the whole runtime runs under Node with fakes.
 *   There is no direct `window`/`fetch`/`crypto` access here beyond the seams the
 *   existing modules already expose.
 * - **Secrets stay local.** The device id lives in `SyncState`; the per-device
 *   signing keypair and the monotonic `rev` counter live in the dedicated,
 *   non-exported `sync-secrets` collection (`SyncKeyStorage` + the `rev` seam).
 *   There is no key material to protect any more (ONL-020 removed the master
 *   key): payloads are plaintext and integrity comes from the device signature.
 *   Nothing sensitive is logged.
 * - **Nothing local is ever destroyed.** Disable / sign-out / delete-server-copy
 *   drop sync state and queue pointers but keep local training data *and* the
 *   device secrets, so the device can re-enable without any user interaction.
 *
 * Reload behaviour (ONL-011): the runtime restores the signing keypair on
 * construction, so a reload while enabled reports `syncing`. If the keypair is
 * gone (cleared site data) the state is `paused` until a sync round re-registers
 * a fresh device key — nothing for the user to enter.
 */

import type { AttemptRecord, NormalizedPuzzle } from '@chessengram/contracts';
import type { WoodpeckerCycle, WoodpeckerSetRecord } from '@chessengram/scheduler';
import type {
  SyncApiClient,
  SyncEntityType,
  SyncKeyStorage,
  SyncMode,
  SyncPushResponse,
  SyncQueueEntry,
  SyncQueueStorage,
  SyncRecordEnvelope,
  SyncSecrets,
  SyncState,
  SyncStateStorage,
} from './types.ts';
import { SyncQueue, type SyncQueueAck } from './queue.ts';
import { getOrCreateDeviceId } from './device.ts';
import {
  applyChanges,
  type SyncApplyResult,
  type SyncApplyWriter,
} from './apply.ts';
import type { CollectionSyncState } from './collections.ts';
import {
  base64ToBytes,
  bytesToBase64,
  exportDevicePublicKeyJwk,
  generateDeviceKeys,
  importDevicePublicKeyJwk,
  signBytes,
  type DeviceKeys,
} from './signing.ts';
import { sealRecord } from './envelope.ts';
import { isConfigured, parseSyncConfig, type SyncPanelConfig } from './panel.ts';
import { woodpeckerSetPayload } from './woodpecker.ts';
import type {
  CollectionRecord,
  SettingSyncState,
  UserPuzzleSyncState,
} from '../storage/local-store.ts';

/** Max pointers sealed per push batch. Server caps (`MAX_BATCH`) stay server-side. */
export const SYNC_CLIENT_BATCH = 50;

/** Record id of the single scheduler-settings group (LWW). */
export const SYNC_SETTING_RECORD_ID = 'scheduler';

/**
 * Default quiet period before a captured burst is pushed (ONL-013; shortened
 * from 60 s to 10 s in ONL-016 so sync feels near-instant).
 */
export const SYNC_DEFAULT_DEBOUNCE_MS = 10_000;

/**
 * How often an open app pulls on its own.
 *
 * Auto-sync was purely *event*-driven (a local change, `online`, or a
 * visibility change), so two devices sitting open and idle never converged:
 * nothing on either side ever asked the server for the other's changes. One
 * cheap round a minute (empty push + pull) fixes that without a websocket; it
 * is only armed while sync is enabled, so the local-only build stays inert.
 */
export const SYNC_PERIODIC_MS = 60_000;
/** First retry delay after a failed auto-sync; doubles each attempt. */
export const SYNC_DEFAULT_RETRY_BASE_MS = 5_000;
/** Upper bound on the exponential retry backoff. */
export const SYNC_DEFAULT_RETRY_MAX_MS = 5 * 60_000;

/** Injectable timer pair so debounce/retry run deterministically in tests. */
export interface SyncRuntimeTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Minimal event target the flush triggers attach to. `window` in the app; a
 * fake in tests. Kept structural so no DOM type is required under Node.
 */
export interface SyncFlushTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * `visibilitychange` is fired at `document` and (in older browsers) does not
 * bubble, so a `window` listener can miss it. Prefer the target's `document`
 * when it has one; otherwise attach to the target itself (a fake in tests).
 */
function visibilityEventTarget(target: SyncFlushTarget): SyncFlushTarget {
  const candidate = (target as { document?: SyncFlushTarget }).document;
  return candidate && typeof candidate.addEventListener === 'function' ? candidate : target;
}

const defaultSyncTimers: SyncRuntimeTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

/**
 * Pick the device-local `rev` persistence seam: an explicit option wins,
 * otherwise the optional methods on the runtime storage (the real
 * `syncStorage(store)` provides them). A fake storage without them yields
 * `undefined`, so the runtime keeps a strictly increasing in-memory counter.
 */
function resolveDeviceState(
  explicit: SyncDeviceStateStorage | undefined,
  storage: SyncRuntimeStorage,
): SyncDeviceStateStorage | undefined {
  if (explicit) return explicit;
  const candidate = storage as Partial<SyncDeviceStateStorage>;
  return typeof candidate.loadRev === 'function' && typeof candidate.saveRev === 'function'
    ? (candidate as SyncDeviceStateStorage)
    : undefined;
}

/** ECDSA parameters shared by device key import/generation (`signing.ts` owns the pair). */
const DEVICE_KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** Import the private half persisted in {@link SyncSecrets}. Never exported. */
async function importDevicePrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('crypto.subtle is unavailable');
  return subtle.importKey('jwk', jwk, DEVICE_KEY_ALGORITHM, true, ['sign']);
}

/** Export the private half only for device-local persistence. */
async function exportDevicePrivateKeyJwk(privateKey: CryptoKey): Promise<JsonWebKey> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('crypto.subtle is unavailable');
  return subtle.exportKey('jwk', privateKey);
}

/** Rebuild a usable keypair from persisted JWKs. */
async function restoreDeviceKeys(secrets: SyncSecrets): Promise<DeviceKeys> {
  return {
    privateKey: await importDevicePrivateKeyJwk(secrets.devicePrivateKeyJwk),
    publicKey: await importDevicePublicKeyJwk(secrets.devicePublicKeyJwk),
  };
}

/**
 * Fallback `SyncKeyStorage` for tests and local dev only. The app always
 * injects `syncKeyStorage(store)` so secrets survive a reload; this keeps a
 * runtime constructed without a key store usable (and never persists keys).
 */
class InMemorySyncKeyStorage implements SyncKeyStorage {
  private secrets: SyncSecrets | undefined;

  async load(): Promise<SyncSecrets | undefined> {
    return this.secrets ? cloneSecrets(this.secrets) : undefined;
  }

  async save(secrets: SyncSecrets): Promise<void> {
    this.secrets = cloneSecrets(secrets);
  }

  async clear(): Promise<void> {
    this.secrets = undefined;
  }
}

function cloneSecrets(secrets: SyncSecrets): SyncSecrets {
  return {
    devicePublicKeyJwk: { ...secrets.devicePublicKeyJwk },
    devicePrivateKeyJwk: { ...secrets.devicePrivateKeyJwk },
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimal fetch shape the config reader needs (never required at runtime). */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; method?: string; cache?: string },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** True when at least one build-time value is present (⇒ runtime override may be fetched). */
function hasAnyEnvValue(config: SyncPanelConfig): boolean {
  return (
    hasText(config.apiBase) ||
    hasText(config.authAuthority) ||
    hasText(config.authClientId) ||
    hasText(config.authRedirectUri)
  );
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const raw = record[key];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/** Per-field merge: a runtime value overrides a build-time value only when present. */
function mergeConfig(env: SyncPanelConfig, runtime: SyncPanelConfig): SyncPanelConfig {
  const merged: SyncPanelConfig = {};
  const apiBase = hasText(runtime.apiBase) ? runtime.apiBase : env.apiBase;
  const authAuthority = hasText(runtime.authAuthority) ? runtime.authAuthority : env.authAuthority;
  const authClientId = hasText(runtime.authClientId) ? runtime.authClientId : env.authClientId;
  const authRedirectUri = hasText(runtime.authRedirectUri)
    ? runtime.authRedirectUri
    : env.authRedirectUri;
  if (hasText(apiBase)) merged.apiBase = apiBase;
  if (hasText(authAuthority)) merged.authAuthority = authAuthority;
  if (hasText(authClientId)) merged.authClientId = authClientId;
  if (hasText(authRedirectUri)) merged.authRedirectUri = authRedirectUri;
  return merged;
}

/**
 * Best-effort read of the optional runtime config file. Any failure (missing
 * file, offline, malformed JSON, wrong types) yields `{}`. Values are never
 * logged and the reader never throws.
 *
 * Accepts both `camelCase` and `VITE_SYNC_*` key spellings so an operator can
 * hand-write either. Only known keys are read; everything else is ignored.
 */
async function readRuntimeConfig(fetchImpl: FetchLike | undefined): Promise<SyncPanelConfig> {
  if (!fetchImpl) return {};
  try {
    const response = await fetchImpl('/sync-config.json', {
      headers: { accept: 'application/json' },
      cache: 'no-cache',
    });
    if (!response || response.ok !== true) return {};
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
    const record = data as Record<string, unknown>;
    const out: SyncPanelConfig = {};
    const apiBase = readString(record, 'apiBase') ?? readString(record, 'VITE_SYNC_API_BASE');
    const authAuthority =
      readString(record, 'authAuthority') ?? readString(record, 'VITE_SYNC_AUTH_AUTHORITY');
    const authClientId =
      readString(record, 'authClientId') ?? readString(record, 'VITE_SYNC_AUTH_CLIENT_ID');
    const authRedirectUri =
      readString(record, 'authRedirectUri') ?? readString(record, 'VITE_SYNC_AUTH_REDIRECT_URI');
    if (hasText(apiBase)) out.apiBase = apiBase;
    if (hasText(authAuthority)) out.authAuthority = authAuthority;
    if (hasText(authClientId)) out.authClientId = authClientId;
    if (hasText(authRedirectUri)) out.authRedirectUri = authRedirectUri;
    return out;
  } catch {
    return {};
  }
}

function defaultFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== 'function') return undefined;
  return candidate as FetchLike;
}

/**
 * Merge the build-time `VITE_SYNC_*` config with the optional runtime
 * `/sync-config.json` (runtime values win per field).
 *
 * **No network when unconfigured.** The runtime file is only fetched when at
 * least one build-time value is present, so a default build stays entirely
 * offline. The reader never throws and never logs values.
 */
export async function loadSyncConfig(
  fetchImpl: FetchLike | undefined = defaultFetch(),
  envLike: Record<string, unknown> | undefined = import.meta.env,
): Promise<SyncPanelConfig> {
  const env = parseSyncConfig(envLike);
  if (!hasAnyEnvValue(env)) return env;
  return mergeConfig(env, await readRuntimeConfig(fetchImpl));
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * The slice of the training service adoption/sealing needs.
 *
 * The inbound members (all optional) are the ONL-012 writer surface. They are
 * optional so existing fakes/embedded runtimes keep working; a real
 * `LocalTrainingService` implements every one of them.
 */
export interface SyncRuntimeService {
  getAttemptCount(): number;
  listAttempts(filter?: { programId?: string; puzzleId?: string; limit?: number }): AttemptRecord[];
  listCollections(): CollectionRecord[];
  listWoodpeckerSets(): WoodpeckerSetRecord[];
  listWoodpeckerCycles(setId: string): Array<{ cycleId: string; cycle: WoodpeckerCycle }>;
  getWoodpeckerSet(setId: string): WoodpeckerSetRecord | undefined;
  getWoodpeckerCycle(cycleId: string): { cycleId: string; cycle: WoodpeckerCycle } | undefined;

  // --- outbound payload sources (optional; absent ⇒ the type is unsupported) ---
  listPuzzles?(): NormalizedPuzzle[];
  getCuratedSettings?(): unknown;

  // --- inbound writer (ONL-012) ---
  getCollection?(collectionId: string): CollectionRecord | undefined;
  getPuzzle?(puzzleId: string): NormalizedPuzzle | undefined;
  applyRemoteAttempts?(
    records: readonly AttemptRecord[],
  ): Promise<{ applied: number; duplicates: number }>;
  applyRemoteCollection?(
    collectionId: string,
    record: CollectionRecord | undefined,
  ): Promise<void>;
  applyRemoteWoodpeckerSet?(record: WoodpeckerSetRecord): Promise<void>;
  applyRemoteWoodpeckerCycle?(cycleId: string, cycle: WoodpeckerCycle): Promise<void>;
  applyRemotePuzzle?(puzzle: NormalizedPuzzle): Promise<void>;
  /**
   * Inbound tombstone (ONL-014): remove a user puzzle deleted on another device.
   * Same semantics as local removal (`removePuzzle`): content + derived
   * schedules only; history and other records are untouched.
   */
  applyRemotePuzzleRemoval?(puzzleId: string): Promise<void>;
  applyRemoteSettings?(recordId: string, values: Record<string, unknown>): Promise<void>;
  nextWoodpeckerCycleNumber?(setId: string): number;

  // --- local change observation (ONL-013) ---
  /**
   * Observe source-record mutations sync should capture. Optional so existing
   * fakes/embedded runtimes keep working; a real `LocalTrainingService`
   * implements it. The returned function unsubscribes.
   */
  onLocalChange?(
    listener: (change: { type: SyncEntityType; recordId: string }) => void,
  ): () => void;
}

/** Optional merge-state persistence implemented by the real `syncStorage`. */
export interface SyncMergeStateStorage {
  loadCollectionSyncState(collectionId: string): Promise<CollectionSyncState | undefined>;
  saveCollectionSyncState(state: CollectionSyncState): Promise<void>;
  loadSettingSyncState(recordId: string): Promise<SettingSyncState | undefined>;
  saveSettingSyncState(recordId: string, state: SettingSyncState): Promise<void>;
  loadUserPuzzleSyncState(puzzleId: string): Promise<UserPuzzleSyncState | undefined>;
  saveUserPuzzleSyncState(puzzleId: string, state: UserPuzzleSyncState): Promise<void>;
}

/**
 * Device-local monotonic `rev` persistence (ONL-016). Deliberately separate
 * from `SyncState` (which is exported) and from the key material, so two
 * devices never share a counter and an export never carries one.
 */
export interface SyncDeviceStateStorage {
  loadRev(): Promise<number | undefined>;
  saveRev(rev: number): Promise<void>;
}

/**
 * Persistence seam the runtime persists through (ONL-001's `syncStorage`).
 * The optional `SyncDeviceStateStorage` methods are implemented by the real
 * `syncStorage`; a fake without them falls back to an in-memory counter.
 */
export type SyncRuntimeStorage = SyncQueueStorage &
  SyncStateStorage &
  Partial<SyncMergeStateStorage> &
  Partial<SyncDeviceStateStorage>;

export interface SyncRuntimeOptions {
  /** Merged build-time + runtime config. */
  config?: SyncPanelConfig;
  /** Transport; `undefined` when sync is not configured (or no client exists yet). */
  api?: SyncApiClient;
  service: SyncRuntimeService;
  storage: SyncRuntimeStorage;
  /**
   * Device-local secret persistence (master key + signing keypair). Omit only
   * in tests: the runtime then keeps secrets in memory for its lifetime.
   */
  keyStorage?: SyncKeyStorage;
  /** Injectable clock (defaults to `Date.now`). */
  clock?: () => number;
  /** Injectable sleep between batches (defaults to a resolved promise). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional logger. Only generic messages are ever passed; never values. */
  logger?: SyncRuntimeLogger;
  /**
   * Inbound writer (ONL-012). Defaults to an adapter over `service` + `storage`,
   * so a real `LocalTrainingService` needs no extra wiring. Tests inject a fake.
   */
  writer?: SyncApplyWriter;
  /**
   * Device-local `rev` persistence (ONL-016). Defaults to the optional methods
   * on `storage` (the app's `syncStorage(store)`); tests may inject a fake.
   */
  deviceState?: SyncDeviceStateStorage;
  /** Quiet period before a captured change burst is pushed (default 10 s). */
  debounceMs?: number;
  /** Injectable timers for debounce/retry (defaults to `setTimeout`). */
  timers?: SyncRuntimeTimers;
  /** First retry delay after a failed auto-sync (default 5 s). */
  retryBaseMs?: number;
  /** Upper bound on the exponential retry backoff (default 5 min). */
  retryMaxMs?: number;
}

export interface SyncRuntimeLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

/** What the Settings panel renders, derived from the persisted state + queue. */
export interface SyncRuntimeState {
  mode: SyncMode;
  pending: number;
  lastSyncedAt?: number;
}

/** Result of one `syncNow()` round (inbound counters are additive). */
export interface SyncRunResult {
  pushed: number;
  accepted: number;
  applied?: number;
  skipped?: number;
  /** True when this round was short-circuited by an unauthenticated/paused session. */
  paused?: boolean;
  duplicates?: number;
  cursor?: number;
}

export interface SyncRuntime {
  readonly config: SyncPanelConfig;
  /** Configured *and* a transport is available: the only case that can sync. */
  isConfigured(): boolean;
  state(): Promise<SyncRuntimeState>;
  /**
   * Opt in / re-link. `idToken` is required for the first link; when omitted an
   * existing cookie session from `api.getSession()` is reused instead.
   *
   * Design #6 revised: the master key comes from the server
   * (the payload is plaintext; the device signature is the only integrity
   * mechanism), so nothing is displayed or entered. Resolves once the device is
   * enabled and able to sync.
   */
  enable(input?: { idToken?: string }): Promise<void>;
  /** Push local changes, then pull + apply remote changes. */
  syncNow(): Promise<SyncRunResult>;
  /** Pure inbound sync (no push), applying `response.changes` over a fake/real API. */
  pullOnly?(): Promise<SyncApplyResult>;
  disable(): Promise<void>;
  signOut(): Promise<void>;
  deleteServerCopy(): Promise<void>;
  /**
   * ONL-013: wire `online`/`visibilitychange` flush triggers on an injected
   * target (`window` in the app, a fake in tests). No listeners are attached
   * when sync is unconfigured, so the local-only build stays inert.
   */
  attachFlushTriggers?(target?: SyncFlushTarget): void;
  /**
   * ONL-013: stop debounce/retry timers and unsubscribe the local-change
   * observer + flush triggers. Idempotent.
   */
  dispose?(): void;
}

/** `true` when the error looks like a 401 from the transport, however it is shaped. */
export function isUnauthorized(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return (
    record.status === 401 ||
    record.statusCode === 401 ||
    record.code === 401 ||
    record.code === 'unauthorized'
  );
}

/**
 * Permanent device rejections the server returns as `422`. They never clear on
 * their own, so retrying with backoff is pointless: the device must be
 * re-registered before the same batch can succeed.
 */
const PERMANENT_DEVICE_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_signature',
  'unregistered_device',
  'device_revoked',
]);

/**
 * `true` when a `422` carries one of the permanent device codes. Detected
 * structurally (not via `client.ts`) so the runtime works with any transport
 * that shapes its errors the same way.
 */
export function isPermanentDeviceError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { status?: unknown; statusCode?: unknown; code?: unknown; serverCode?: unknown };
  const status = record.status ?? record.statusCode;
  if (status !== 422) return false;
  const codes = [record.code, record.serverCode];
  return codes.some((code) => typeof code === 'string' && PERMANENT_DEVICE_ERROR_CODES.has(code));
}

/** Composite pointer id for one Woodpecker cycle result (unique per `(cycleId, puzzleId)`). */
export function woodpeckerResultRecordId(cycleId: string, puzzleId: string): string {
  return `${cycleId}\u0000${puzzleId}`;
}

interface SyncLookups {
  attempts: Map<string, AttemptRecord>;
  collections: Map<string, CollectionRecord>;
  sets: Map<string, WoodpeckerSetRecord>;
  cycles: Map<string, { cycleId: string; cycle: WoodpeckerCycle; setId: string }>;
  /** Curated scheduler settings group, when the service exposes it. */
  settings: unknown;
  userPuzzles: Map<string, NormalizedPuzzle>;
}

interface SealPlan {
  envelopes: SyncRecordEnvelope[];
  /** Pointer → pushed `changedAt`, keyed by the envelope's dedupe key. */
  byDedupeKey: Map<string, SyncQueueEntry>;
  /** Pointers whose local record is gone: drop them instead of retrying forever. */
  dropped: SyncQueueEntry[];
}

function defaultClock(): number {
  return Date.now();
}

/**
 * The local sync runtime. Construct with injection. Constructing never makes a
 * network call; it only kicks off a local read of this device's persisted
 * secrets (awaited by `state()`/`enable()`/`unlock()`/`syncNow()`).
 */
export class LocalSyncRuntime implements SyncRuntime {
  readonly config: SyncPanelConfig;

  private readonly api: SyncApiClient | undefined;
  private readonly service: SyncRuntimeService;
  private readonly storage: SyncRuntimeStorage;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: SyncRuntimeLogger;
  private readonly queue: SyncQueue;
  private readonly keyStorage: SyncKeyStorage;
  /** ONL-016 device-local `rev` persistence (absent ⇒ in-memory counter). */
  private readonly deviceState: SyncDeviceStateStorage | undefined;
  private readonly writer: SyncApplyWriter;
  private readonly debounceMs: number;
  private readonly timers: SyncRuntimeTimers;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  /** Restored on construction; retained across disable/sign-out in `keyStorage`. */
  private deviceKeys: DeviceKeys | undefined;
  private paused = false;
  /** ONL-016 monotonic per-device counter; incremented once per sealed record. */
  private rev = 0;
  /** Resolves once the persisted state (secrets + `rev`) has been read (never rejects). */
  private readonly secretsReady: Promise<void>;

  // --- ONL-013 continuous capture + auto-sync -----------------------------
  /** Unsubscribe for the local-change observer (absent when the service lacks it). */
  private unsubscribeLocalChange: (() => void) | undefined;
  private debounceHandle: unknown | undefined;
  private periodicHandle: unknown | undefined;
  private retryHandle: unknown | undefined;
  private retryAttempt = 0;
  private disposed = false;
  private flushRegistrations: Array<{ target: SyncFlushTarget; type: string }> = [];
  private flushHandler: (() => void) | undefined;

  constructor(options: SyncRuntimeOptions) {
    this.config = options.config ?? {};
    this.api = options.api;
    this.service = options.service;
    this.storage = options.storage;
    this.clock = options.clock ?? defaultClock;
    this.sleep = options.sleep ?? (() => Promise.resolve());
    this.logger = options.logger ?? {};
    this.queue = new SyncQueue(options.storage);
    this.keyStorage = options.keyStorage ?? new InMemorySyncKeyStorage();
    this.deviceState = resolveDeviceState(options.deviceState, options.storage);
    this.writer = options.writer ?? createDefaultApplyWriter(this.service, this.storage);
    this.debounceMs = options.debounceMs ?? SYNC_DEFAULT_DEBOUNCE_MS;
    this.timers = options.timers ?? defaultSyncTimers;
    this.retryBaseMs = options.retryBaseMs ?? SYNC_DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? SYNC_DEFAULT_RETRY_MAX_MS;
    // Local-only I/O (no network): a reload must come back unlocked.
    this.secretsReady = this.restorePersistedState();
    // ONL-013: observe source-record changes. The handler is a no-op until sync
    // is enabled, so a local-only device captures nothing and writes no queue.
    if (typeof this.service.onLocalChange === 'function') {
      this.unsubscribeLocalChange = this.service.onLocalChange((change) =>
        this.handleLocalChange(change),
      );
    }
  }

  isConfigured(): boolean {
    return isConfigured(this.config) && this.api !== undefined;
  }

  async state(): Promise<SyncRuntimeState> {
    await this.secretsReady;
    const saved = await this.storage.load();
    const pending = await this.queue.size();
    const enabled = saved?.enabled === true;
    const result: SyncRuntimeState = {
      mode: this.modeFor(enabled),
      pending: enabled ? pending : 0,
      ...(saved?.lastSyncedAt !== undefined ? { lastSyncedAt: saved.lastSyncedAt } : {}),
    };
    return result;
  }

  /**
   * `paused` covers "enabled but this device has no signing key yet" (e.g. site
   * data cleared): the next sync round registers a fresh one. There is no locked
   * state to recover from by hand.
   */
  private modeFor(enabled: boolean): SyncMode {
    if (!this.isConfigured() || !enabled) return 'local-only';
    if (this.paused) return 'paused';
    return this.deviceKeys !== undefined ? 'syncing' : 'paused';
  }

  /**
   * Read the persisted device state started in the constructor: the `rev`
   * counter and the master key + signing keypair. A corrupt/absent record
   * simply leaves the runtime locked (or `rev` at 0); it never throws.
   */
  private async restorePersistedState(): Promise<void> {
    await this.restoreDeviceRev();
    let secrets: SyncSecrets | undefined;
    try {
      secrets = await this.keyStorage.load();
    } catch (error) {
      this.logKeyStorageFailure(error);
      return;
    }
    if (!secrets) return;
    try {
      this.deviceKeys = await restoreDeviceKeys(secrets);
    } catch (error) {
      this.logKeyStorageFailure(error);
    }
  }

  /**
   * Load this device's persisted `rev` counter. A missing/corrupt value leaves
   * it at 0 (the next seal starts at 1); a failure never throws and never logs
   * a value.
   */
  private async restoreDeviceRev(): Promise<void> {
    if (!this.deviceState) return;
    try {
      const stored = await this.deviceState.loadRev();
      if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) {
        this.rev = stored;
      }
    } catch {
      // Keep the in-memory counter; nothing sensitive is logged.
    }
  }

  /**
   * ONL-016: increment this device's monotonic `rev` once per sealed record and
   * persist it. Persistence is best-effort — a failed write still yields a
   * strictly increasing in-memory counter for this session.
   */
  private async nextRev(): Promise<number> {
    this.rev += 1;
    if (this.deviceState) {
      try {
        await this.deviceState.saveRev(this.rev);
      } catch {
        // Best effort: the in-memory counter stays strictly increasing.
      }
    }
    return this.rev;
  }

  /** Re-read the signing keypair from persistence (used after a disable). */
  private async deviceKeysFromStorage(): Promise<DeviceKeys | undefined> {
    try {
      const secrets = await this.keyStorage.load();
      return secrets ? await restoreDeviceKeys(secrets) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Generic, value-free warning: a restore failure must never log key material. */
  private logKeyStorageFailure(_error: unknown): void {
    this.logger.warn?.('sync secrets could not be restored; device stays locked');
  }

  /**
   * Opt in to sync. Exact order:
   *   1. exchange the Cognito ID token for a server session (or reuse the
   *      existing session cookie on a re-link),
   *   2. ensure a device id + P-256 signing keypair and register the public half,
   *   3. adopt existing local data by enqueuing pointers,
   *   4. record the canonical user id.
   *
   * Nothing is returned to display: there is no key material to show.
   */
  async enable(input: { idToken?: string } = {}): Promise<void> {
    if (!this.isConfigured()) throw new Error('sync is not configured');
    const api = this.api;
    if (!api) throw new Error('sync transport is unavailable');
    await this.secretsReady;

    try {
      const idToken =
        typeof input.idToken === 'string' && input.idToken.trim() !== ''
          ? input.idToken
          : undefined;
      const reuseSession = idToken === undefined;
      const existing = await this.storage.load();

      // A session-only enable is the "come back to sync" path: an enabled device
      // needs nothing beyond its cookie.
      if (reuseSession && existing?.enabled !== true) {
        throw new Error('sync needs a signed-in session; provide an idToken to link');
      }

      // 1. session. First link exchanges the Cognito ID token; a re-link / sync
      //    on an already-enabled device reuses the server session cookie.
      const session = idToken ? await api.exchangeSession(idToken) : await api.getSession();
      if (!session) throw new Error('sync session is required');

      // 2. device identity + signing key (generated if this device has none).
      const keys = await this.ensureDeviceKeys(api);

      // 3. adopt existing local data (before declaring sync enabled)
      await this.adoptLocalData();

      this.deviceKeys = keys;
      this.paused = false;

      // 4. the canonical user id is the server's, never the provider `sub`.
      const next: SyncState = {
        ...(existing ?? { enabled: true }),
        enabled: true,
        deviceId: await getOrCreateDeviceId(this.storage),
        userId: session.userId,
        cursor: existing?.cursor ?? 0,
      };
      await this.storage.save(next);
    } catch (error) {
      this.markPausedOn(error);
      throw error;
    }
  }

  /**
   * This device's signing keypair, created and registered on first use.
   *
   * A device key is per-device and needs nothing from the server, so this is
   * also the recovery path for a device whose local state was cleared: the next
   * sync round generates a fresh keypair and re-registers it. The private half
   * never leaves the device and is kept in the non-exported `sync-secrets`
   * collection, so a reload reuses it.
   */
  private async ensureDeviceKeys(api: SyncApiClient): Promise<DeviceKeys> {
    const existing = this.deviceKeys ?? (await this.deviceKeysFromStorage());
    const deviceId = await getOrCreateDeviceId(this.storage);
    if (existing) {
      const publicKeyJwk = await exportDevicePublicKeyJwk(existing.publicKey);
      await api.registerDevice({ deviceId, publicKeyJwk });
      return existing;
    }
    const keys = await generateDeviceKeys();
    const publicKeyJwk = await exportDevicePublicKeyJwk(keys.publicKey);
    const privateKeyJwk = await exportDevicePrivateKeyJwk(keys.privateKey);
    await api.registerDevice({ deviceId, publicKeyJwk });
    await this.keyStorage.save({
      devicePublicKeyJwk: publicKeyJwk,
      devicePrivateKeyJwk: privateKeyJwk,
    });
    return keys;
  }

  /**
   * One full sync round: push the pointer queue, **apply `response.changes`**,
   * then persist the cursor. Unlike the push-only era this makes progress even
   * while the outbound queue is empty, which is what lets a fresh device pull
   * the other device's history.
   *
   * Pointers are sealed from the *current* local record and acked only when the
   * server lists their dedupe key in `accepted` or `duplicates`. A rejected
   * (`422`) pointer is never acked. A transport failure rethrows (or pauses on
   * 401) so the caller decides; the cursor is saved only after the batch has
   * been applied.
   */
  async syncNow(): Promise<SyncRunResult> {
    // A manual (or auto) round supersedes any pending debounce.
    this.cancelDebounce();
    const empty: SyncRunResult = { pushed: 0, accepted: 0, applied: 0, skipped: 0, duplicates: 0 };
    if (!this.isConfigured()) return empty;
    if (this.paused) return { ...empty, paused: true };
    await this.secretsReady;
    const saved = await this.storage.load();
    if (saved?.enabled !== true) return empty;

    const api = this.api;
    if (!api) return empty;

    // A device whose local keypair is gone (cleared site data) gets a fresh one
    // here, so "Sync now" recovers instead of doing nothing.
    if (!this.deviceKeys) {
      try {
        this.deviceKeys = await this.ensureDeviceKeys(api);
      } catch (error) {
        this.markPausedOn(error);
        return { ...empty, ...(this.paused ? { paused: true } : {}) };
      }
    }

    let pushed = 0;
    let accepted = 0;
    let applied = 0;
    let skipped = 0;
    let duplicates = 0;
    let cursor = saved.cursor ?? 0;
    const lookups = this.createLookups();

    for (;;) {
      const entries = await this.queue.take(SYNC_CLIENT_BATCH);
      const plan: SealPlan =
        entries.length > 0
          ? await this.sealEntries(entries, saved, lookups)
          : { envelopes: [], byDedupeKey: new Map(), dropped: [] };
      for (const dropped of plan.dropped) {
        await this.queue.ack({ type: dropped.type, recordId: dropped.recordId });
      }

      // Always call the server: an empty `push` is a pure pull. The inbound
      // half is the point of the feature, so an empty queue must not exit early.
      let response: SyncPushResponse;
      try {
        response = await api.push({ since: cursor, push: plan.envelopes });
      } catch (error) {
        if (this.markPausedOn(error)) break;
        if (!isPermanentDeviceError(error)) throw error;
        // Permanent device error: re-register this device's public key once and
        // retry the exact same batch once. If it still fails, stop retrying this
        // batch (the pointers stay queued and `state()` surfaces them) instead
        // of backing off forever on an error that will never clear on its own.
        const recovered = await this.retryPushAfterReregister(api, plan.envelopes, cursor);
        if (recovered === undefined) break;
        response = recovered;
      }

      pushed += plan.envelopes.length;
      const ackedKeys = [...response.accepted, ...response.duplicates];
      for (const key of ackedKeys) {
        const entry = plan.byDedupeKey.get(key);
        if (!entry) continue;
        const result = await this.queue.ack(ackFor(entry));
        if (result === 'acked') accepted += 1;
      }

      const previousCursor = cursor;
      const inbound = await this.applyInbound(response.changes ?? [], saved, cursor);
      applied += inbound.applied;
      skipped += inbound.skipped;
      duplicates += inbound.duplicates;
      const responseCursor =
        typeof response.cursor === 'number' && Number.isFinite(response.cursor)
          ? response.cursor
          : inbound.cursor;
      // Never jump past a skipped record: it must be retried next sync.
      cursor =
        inbound.skipped > 0
          ? inbound.cursor
          : Math.max(cursor, responseCursor, inbound.cursor);
      saved.cursor = cursor;
      saved.lastSyncedAt = this.clock();
      await this.storage.save(saved);

      // A corrupt record blocks the cursor; retry it on the next round instead
      // of spinning on the same batch forever.
      if (inbound.skipped > 0) break;
      // Nothing to push and nothing (new) to pull: done.
      if (plan.envelopes.length === 0 && (response.changes?.length ?? 0) === 0) break;
      // A batch that acked nothing new (e.g. a partial rejection) must not spin.
      if (plan.envelopes.length > 0 && ackedKeys.length === 0) break;
      // No forward progress from either direction.
      if (cursor <= previousCursor) break;
      await this.sleep(0);
    }

    this.retryAttempt = 0;
    this.cancelRetry();
    return { pushed, accepted, applied, skipped, duplicates, cursor, ...(this.paused ? { paused: true } : {}) };
  }

  /**
   * ONL-013: attach `online`/`visibilitychange` flush triggers to an injected
   * target. No listeners are attached when sync is unconfigured (the runtime
   * only exists for a configured build anyway), so the local-only path stays
   * inert. Re-attaching replaces any previous listeners.
   */
  attachFlushTriggers(target?: SyncFlushTarget): void {
    this.detachFlushTriggers();
    if (this.disposed || !this.isConfigured()) return;
    if (!target || typeof target.addEventListener !== 'function') return;
    const handler = (): void => this.handleFlushTrigger();
    this.flushHandler = handler;
    const registrations: Array<{ target: SyncFlushTarget; type: string }> = [
      { target, type: 'online' },
      { target: visibilityEventTarget(target), type: 'visibilitychange' },
    ];
    for (const registration of registrations) {
      registration.target.addEventListener(registration.type, handler);
    }
    this.flushRegistrations = registrations;
    // Keep pulling while the app is open (see SYNC_PERIODIC_MS). Armed here
    // rather than in `enable()` because the loop's lifetime is the page's: a
    // runtime with no UI attached has nothing to refresh.
    this.schedulePeriodicSync();
  }

  /**
   * ONL-013: stop timers and unsubscribe. Idempotent; safe to call from a test
   * teardown or a page unload.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelDebounce();
    this.cancelRetry();
    this.stopPeriodicSync();
    this.unsubscribeLocalChange?.();
    this.unsubscribeLocalChange = undefined;
    this.detachFlushTriggers();
  }

  // --- ONL-013 auto-sync internals ----------------------------------------

  /** Enqueue a captured change and (re)arm the debounce. Never throws. */
  private handleLocalChange(change: { type: SyncEntityType; recordId: string }): void {
    void this.captureLocalChange(change);
  }

  private async captureLocalChange(change: {
    type: SyncEntityType;
    recordId: string;
  }): Promise<void> {
    // Paused/offline means "cannot talk to the server right now", not "do not
    // record what needs syncing": a change made while paused is queued and
    // pushed once the session recovers. Only disposed/unconfigured (and the
    // local-only `enabled` check below) suppress capture.
    if (this.disposed || !this.isConfigured()) return;
    try {
      const saved = await this.storage.load();
      // Local-only / disabled: no account, no queue (design decision #3).
      if (saved?.enabled !== true) return;
      await this.queue.enqueue({
        type: change.type,
        recordId: change.recordId,
        changedAt: this.clock(),
      });
      // Debounce coalesces a burst into one push after the quiet period.
      this.scheduleDebouncedSync();
    } catch {
      // Capture must never throw into a training mutation.
    }
  }

  private scheduleDebouncedSync(): void {
    if (this.disposed) return;
    this.cancelDebounce();
    this.debounceHandle = this.timers.setTimeout(() => {
      this.debounceHandle = undefined;
      void this.runAutoSync();
    }, this.debounceMs);
  }

  private cancelDebounce(): void {
    if (this.debounceHandle !== undefined) {
      this.timers.clearTimeout(this.debounceHandle);
      this.debounceHandle = undefined;
    }
  }

  /** Stop the periodic loop (disable, sign-out, dispose). */
  private stopPeriodicSync(): void {
    this.cancelPeriodicSync();
  }

  private cancelRetry(): void {
    if (this.retryHandle !== undefined) {
      this.timers.clearTimeout(this.retryHandle);
      this.retryHandle = undefined;
    }
  }

  /** One automatic round; failures are swallowed and retried with backoff. */
  private async runAutoSync(): Promise<void> {
    if (this.disposed || !this.isConfigured() || this.paused) return;
    try {
      await this.syncNow();
      this.retryAttempt = 0;
      this.cancelRetry();
    } catch {
      // Network/5xx: pointers stay queued (syncNow never acks on failure).
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || !this.isConfigured() || this.paused) return;
    if (this.retryHandle !== undefined) return;
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** this.retryAttempt);
    this.retryAttempt += 1;
    this.retryHandle = this.timers.setTimeout(() => {
      this.retryHandle = undefined;
      void this.runAutoSync();
    }, delay);
  }

  /** `online`/`visibilitychange`: attempt immediately, superseding a debounce. */
  private handleFlushTrigger(): void {
    if (this.disposed || !this.isConfigured() || this.paused) return;
    this.cancelDebounce();
    void this.runAutoSync();
    // A wake-up is also the moment to make sure the periodic loop is alive
    // (it may have been skipped while paused or offline).
    this.schedulePeriodicSync();
  }

  /**
   * Self-rearming periodic pull. One round runs, then the next is scheduled;
   * failures go through the normal retry/backoff path, so a periodic failure
   * cannot pile up parallel rounds.
   */
  private schedulePeriodicSync(): void {
    if (this.disposed || this.periodicHandle !== undefined) return;
    if (!this.isConfigured()) return;
    this.periodicHandle = this.timers.setTimeout(() => {
      this.periodicHandle = undefined;
      if (this.disposed || !this.isConfigured() || this.paused) return;
      void this.runAutoSync().finally(() => this.schedulePeriodicSync());
    }, SYNC_PERIODIC_MS);
  }

  private cancelPeriodicSync(): void {
    if (this.periodicHandle !== undefined) {
      this.timers.clearTimeout(this.periodicHandle);
      this.periodicHandle = undefined;
    }
  }

  private detachFlushTriggers(): void {
    const handler = this.flushHandler;
    if (handler) {
      for (const { target, type } of this.flushRegistrations) {
        target.removeEventListener(type, handler);
      }
    }
    this.flushRegistrations = [];
    this.flushHandler = undefined;
  }

  /**
   * Pure inbound sync. Uses the same `/sync` transport with an empty push, so
   * it needs no separate endpoint, and applies every `response.changes` record
   * with the same cursor/retry rules as {@link syncNow}.
   */
  async pullOnly(): Promise<SyncApplyResult> {
    const empty: SyncApplyResult = { applied: 0, skipped: 0, duplicates: 0, cursor: 0 };
    if (!this.isConfigured() || this.paused) return empty;
    await this.secretsReady;
    const saved = await this.storage.load();
    if (saved?.enabled !== true) return empty;
    if (!this.deviceKeys) return empty;

    const api = this.api;
    if (!api) return empty;

    let applied = 0;
    let skipped = 0;
    let duplicates = 0;
    let cursor = saved.cursor ?? 0;

    for (;;) {
      let response: SyncPushResponse;
      try {
        response = await api.push({ since: cursor, push: [] });
      } catch (error) {
        if (this.markPausedOn(error)) break;
        throw error;
      }

      const previousCursor = cursor;
      const inbound = await this.applyInbound(response.changes ?? [], saved, cursor);
      applied += inbound.applied;
      skipped += inbound.skipped;
      duplicates += inbound.duplicates;
      const responseCursor =
        typeof response.cursor === 'number' && Number.isFinite(response.cursor)
          ? response.cursor
          : inbound.cursor;
      cursor =
        inbound.skipped > 0
          ? inbound.cursor
          : Math.max(cursor, responseCursor, inbound.cursor);
      saved.cursor = cursor;
      saved.lastSyncedAt = this.clock();
      await this.storage.save(saved);

      if (inbound.skipped > 0) break;
      if ((response.changes?.length ?? 0) === 0) break;
      if (cursor <= previousCursor) break;
      await this.sleep(0);
    }

    return { applied, skipped, duplicates, cursor };
  }

  /**
   * Stop syncing locally and drop sync state + queue.
   *
   * Local training data **and this device's secrets** are kept: re-enabling
   * reuses the signing key and re-fetches the master key from the server. There
   * is nothing for the user to re-enter (design #6 revised).
   */
  async disable(): Promise<void> {
    await this.clearSyncState();
  }

  /** End the server session (best effort) and drop sync state + queue; secrets stay. */
  async signOut(): Promise<void> {
    if (this.api) {
      try {
        await this.api.signOut();
      } catch {
        // Local state is cleared regardless; a failed sign-out is not fatal.
      }
    }
    await this.clearSyncState();
  }

  /** Delete the ciphertext copy on the server. Local training data is never touched. */
  async deleteServerCopy(): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.deleteAccount();
    } catch (error) {
      if (this.markPausedOn(error)) return;
      throw error;
    }
    await this.clearSyncState();
  }

  // --- internals ---------------------------------------------------------

  private applyInbound(
    changes: readonly SyncRecordEnvelope[],
    _saved: SyncState,
    cursor: number,
  ): Promise<SyncApplyResult> {
    return applyChanges({
      changes,
      cursor,
      deps: {
        writer: this.writer,
        clock: this.clock,
        onError: (info) => {
          // Value-free: no key material, ciphertext or plaintext payloads.
          this.logger.warn?.(`sync skipped one ${info.type} record (${info.reason})`);
        },
      },
    });
  }

  private markPausedOn(error: unknown): boolean {
    if (!isUnauthorized(error)) return false;
    this.paused = true;
    this.logger.warn?.('sync session expired; paused with the queue preserved');
    return true;
  }

  /**
   * Recover from a permanent device `422`: re-register this device's signing
   * public key once, then retry the exact same batch once. Returns the retried
   * response, or `undefined` when re-registration or the retry failed — the
   * caller then stops retrying this batch (the pointers stay queued) rather
   * than backing off forever.
   */
  private async retryPushAfterReregister(
    api: SyncApiClient,
    envelopes: SyncRecordEnvelope[],
    since: number,
  ): Promise<SyncPushResponse | undefined> {
    if (!(await this.registerCurrentDevice(api))) return undefined;
    try {
      return await api.push({ since, push: envelopes });
    } catch (error) {
      if (this.markPausedOn(error)) return undefined;
      // Still rejected after a fresh key: surface the state (a warning; never
      // any key material) and leave the batch queued without a retry loop.
      this.logger.warn?.('sync device was rejected again; leaving the batch queued');
      return undefined;
    }
  }

  /**
   * Register this device's current public key with the server. Uses the
   * in-memory keypair (never re-reads or logs it). Returns `false` when the
   * runtime is not unlocked, has no device id, or the call fails.
   */
  private async registerCurrentDevice(api: SyncApiClient): Promise<boolean> {
    const deviceKeys = this.deviceKeys;
    if (!deviceKeys) return false;
    const saved = await this.storage.load();
    const deviceId = saved?.deviceId;
    if (!deviceId) return false;
    try {
      const publicKeyJwk = await exportDevicePublicKeyJwk(deviceKeys.publicKey);
      await api.registerDevice({ deviceId, publicKeyJwk });
      return true;
    } catch (error) {
      if (this.markPausedOn(error)) return false;
      this.logger.warn?.('sync could not re-register this device');
      return false;
    }
  }

  /**
   * Drop only sync state + queue. The call deliberately leaves
   * `this.keyStorage` untouched (device secrets survive disable/sign-out) and
   * never touches any training collection.
   */
  private async clearSyncState(): Promise<void> {
    this.paused = false;
    // Disabled/signed out: stop polling the server.
    this.stopPeriodicSync();
    this.deviceKeys = undefined;
    for (const entry of await this.queue.pending()) {
      await this.queue.ack({ type: entry.type, recordId: entry.recordId });
    }
    await this.storage.save({ enabled: false });
  }

  /** Enqueue pointers for everything already local (design decision #11). */
  private async adoptLocalData(): Promise<void> {
    const attempts = this.service.listAttempts({ limit: this.service.getAttemptCount() });
    for (const attempt of attempts) {
      await this.queue.enqueue({
        type: 'attempt',
        recordId: attempt.attemptId.value,
        changedAt: attempt.completedAt ?? attempt.startedAt,
      });
    }

    for (const collection of this.service.listCollections()) {
      await this.queue.enqueue({
        type: 'collection',
        recordId: collection.id,
        changedAt: collection.createdAt,
      });
    }

    for (const set of this.service.listWoodpeckerSets()) {
      await this.queue.enqueue({
        type: 'woodpecker',
        recordId: set.setId,
        changedAt: set.createdAt,
      });
      for (const { cycleId, cycle } of this.service.listWoodpeckerCycles(set.setId)) {
        await this.queue.enqueue({
          type: 'woodpecker',
          recordId: cycleId,
          changedAt: cycle.completedAt ?? cycle.startedAt,
        });
        for (const result of cycle.results) {
          await this.queue.enqueue({
            type: 'woodpeckerResult',
            recordId: woodpeckerResultRecordId(cycleId, result.puzzleId),
            // Same change time as its cycle, so the type tie-break (`woodpecker`
            // < `woodpeckerResult`) always pushes the cycle before its results.
            changedAt: cycle.completedAt ?? cycle.startedAt,
          });
        }
      }
    }

    // The scheduler setting group is a single LWW record (`recordId` is the
    // group key, not a per-field pointer).
    if (this.service.getCuratedSettings) {
      await this.queue.enqueue({
        type: 'setting',
        recordId: SYNC_SETTING_RECORD_ID,
        changedAt: this.clock(),
      });
    }

    // User-authored puzzles only: bundled/CC0 content is not user data.
    if (this.service.listPuzzles) {
      for (const puzzle of this.service.listPuzzles()) {
        if (puzzle.source !== 'user') continue;
        await this.queue.enqueue({
          type: 'userPuzzle',
          recordId: puzzle.id,
          changedAt: this.clock(),
        });
      }
    }
  }

  private createLookups(): SyncLookups {
    const attempts = new Map<string, AttemptRecord>();
    for (const attempt of this.service.listAttempts({ limit: this.service.getAttemptCount() })) {
      attempts.set(attempt.attemptId.value, attempt);
    }
    const collections = new Map<string, CollectionRecord>();
    for (const collection of this.service.listCollections()) collections.set(collection.id, collection);
    const sets = new Map<string, WoodpeckerSetRecord>();
    const cycles = new Map<string, { cycleId: string; cycle: WoodpeckerCycle; setId: string }>();
    for (const set of this.service.listWoodpeckerSets()) {
      sets.set(set.setId, set);
      for (const saved of this.service.listWoodpeckerCycles(set.setId)) {
        cycles.set(saved.cycleId, { cycleId: saved.cycleId, cycle: saved.cycle, setId: set.setId });
      }
    }
    const userPuzzles = new Map<string, NormalizedPuzzle>();
    if (this.service.listPuzzles) {
      for (const puzzle of this.service.listPuzzles()) {
        if (puzzle.source === 'user') userPuzzles.set(puzzle.id, puzzle);
      }
    }
    const settings = this.service.getCuratedSettings?.();
    return { attempts, collections, sets, cycles, settings, userPuzzles };
  }

  /**
   * Load the current local record for each pointer, seal it and map the resulting
   * dedupe key back to the pointer so acks can be applied precisely. A pointer
   * whose record no longer exists is dropped (there is nothing left to push).
   */
  private async sealEntries(
    entries: SyncQueueEntry[],
    saved: SyncState,
    lookups: SyncLookups,
  ): Promise<SealPlan> {
    const envelopes: SyncRecordEnvelope[] = [];
    const byDedupeKey = new Map<string, SyncQueueEntry>();
    const dropped: SyncQueueEntry[] = [];
    const deviceKeys = this.deviceKeys;
    const deviceId = saved.deviceId;
    if (!deviceKeys || !deviceId) return { envelopes, byDedupeKey, dropped };

    for (const entry of entries) {
      const payload = buildPayload(entry, lookups, deviceId, this.clock());
      if (payload === undefined) {
        dropped.push(entry);
        continue;
      }
      // ONL-016: one strictly increasing `rev` per sealed record, persisted
      // device-locally, so same-millisecond edits still total-order on the server.
      const rev = await this.nextRev();
      const envelope = await sealRecord({
        type: entry.type,
        recordId: entry.recordId,
        payload,
        deviceId,
        now: this.clock(),
        rev,
        sign: (canonicalBytes) => signBytes(canonicalBytes, deviceKeys.privateKey),
      });
      envelopes.push(envelope);
      byDedupeKey.set(envelope.dedupeKey, entry);
    }

    return { envelopes, byDedupeKey, dropped };
  }
}

function ackFor(entry: SyncQueueEntry): SyncQueueAck {
  return { type: entry.type, recordId: entry.recordId, changedAt: entry.changedAt };
}

/**
 * Adapter from the runtime's `service` + `storage` seams to the inbound
 * writer. A real `LocalTrainingService` implements every domain write; storage
 * provides the merge bookkeeping. When a fake storage omits the merge methods,
 * an in-memory fallback keeps tests/local dev usable (never durable, but never
 * silently wrong either).
 */
function createDefaultApplyWriter(
  service: SyncRuntimeService,
  storage: SyncRuntimeStorage,
): SyncApplyWriter {
  const fallbackCollections = new Map<string, CollectionSyncState>();
  const fallbackSettings = new Map<string, SettingSyncState>();
  const fallbackUserPuzzles = new Map<string, UserPuzzleSyncState>();

  const loadCollectionState = storage.loadCollectionSyncState
    ? (collectionId: string) => storage.loadCollectionSyncState!(collectionId)
    : async (collectionId: string) => fallbackCollections.get(collectionId);
  const saveCollectionState = storage.saveCollectionSyncState
    ? (state: CollectionSyncState) => storage.saveCollectionSyncState!(state)
    : async (state: CollectionSyncState) => {
        fallbackCollections.set(state.collectionId, state);
      };
  const loadSettingState = storage.loadSettingSyncState
    ? (recordId: string) => storage.loadSettingSyncState!(recordId)
    : async (recordId: string) => fallbackSettings.get(recordId);
  const saveSettingState = storage.saveSettingSyncState
    ? (recordId: string, state: SettingSyncState) =>
        storage.saveSettingSyncState!(recordId, state)
    : async (recordId: string, state: SettingSyncState) => {
        fallbackSettings.set(recordId, state);
      };
  const loadUserPuzzleState = storage.loadUserPuzzleSyncState
    ? (puzzleId: string) => storage.loadUserPuzzleSyncState!(puzzleId)
    : async (puzzleId: string) => fallbackUserPuzzles.get(puzzleId);
  const saveUserPuzzleState = storage.saveUserPuzzleSyncState
    ? (puzzleId: string, state: UserPuzzleSyncState) =>
        storage.saveUserPuzzleSyncState!(puzzleId, state)
    : async (puzzleId: string, state: UserPuzzleSyncState) => {
        fallbackUserPuzzles.set(puzzleId, state);
      };

  return {
    async applyAttempts(records) {
      if (!service.applyRemoteAttempts) {
        throw new Error('service cannot apply remote attempts');
      }
      return service.applyRemoteAttempts(records);
    },
    getCollection: (collectionId) => service.getCollection?.(collectionId),
    loadCollectionSyncState: loadCollectionState,
    saveCollectionSyncState: saveCollectionState,
    async saveCollection(record) {
      if (!service.applyRemoteCollection) throw new Error('service cannot apply collections');
      await service.applyRemoteCollection(record.id, record);
    },
    async deleteCollection(collectionId) {
      if (!service.applyRemoteCollection) throw new Error('service cannot apply collections');
      await service.applyRemoteCollection(collectionId, undefined);
    },
    getWoodpeckerSet: (setId) => service.getWoodpeckerSet(setId),
    async saveWoodpeckerSet(record) {
      if (!service.applyRemoteWoodpeckerSet) {
        throw new Error('service cannot apply Woodpecker sets');
      }
      await service.applyRemoteWoodpeckerSet(record);
    },
    getWoodpeckerCycle: (cycleId) => service.getWoodpeckerCycle(cycleId),
    async saveWoodpeckerCycle(cycleId, cycle) {
      if (!service.applyRemoteWoodpeckerCycle) {
        throw new Error('service cannot apply Woodpecker cycles');
      }
      await service.applyRemoteWoodpeckerCycle(cycleId, cycle);
    },
    nextWoodpeckerCycleNumber: (setId) =>
      service.nextWoodpeckerCycleNumber?.(setId) ??
      service.listWoodpeckerCycles(setId).length + 1,
    loadSettingSyncState: loadSettingState,
    async saveSettings(recordId, values, state) {
      if (!service.applyRemoteSettings) throw new Error('service cannot apply settings');
      // Persist the remote values first, then the LWW stamp.
      await service.applyRemoteSettings(recordId, values);
      await saveSettingState(recordId, state);
    },
    loadUserPuzzleSyncState: loadUserPuzzleState,
    async saveUserPuzzle(puzzle, state) {
      if (!service.applyRemotePuzzle) throw new Error('service cannot apply user puzzles');
      await service.applyRemotePuzzle(puzzle);
      await saveUserPuzzleState(puzzle.id, state);
    },
    async removeUserPuzzle(puzzleId, state) {
      if (!service.applyRemotePuzzleRemoval) {
        throw new Error('service cannot remove user puzzles');
      }
      // Remove content first, then persist the LWW stamp: a crash between the
      // two leaves the puzzle gone and a retry still records the stamp.
      await service.applyRemotePuzzleRemoval(puzzleId);
      await saveUserPuzzleState(puzzleId, state);
    },
    findPuzzle: (puzzleId) =>
      service.getPuzzle?.(puzzleId) ?? service.listPuzzles?.().find((puzzle) => puzzle.id === puzzleId),
  };
}

/**
 * Build the plaintext wire payload for one pointer from the *current* local
 * record. Returns `undefined` when the record is gone locally.
 */
function buildPayload(
  entry: SyncQueueEntry,
  lookups: SyncLookups,
  deviceId: string,
  now: number,
): unknown | undefined {
  switch (entry.type) {
    case 'attempt': {
      const attempt = lookups.attempts.get(entry.recordId);
      if (!attempt) return undefined;
      return {
        attemptId: attempt.attemptId.value,
        programId: attempt.progressKey.programId,
        ...(attempt.progressKey.collectionId !== undefined
          ? { collectionId: attempt.progressKey.collectionId }
          : {}),
        puzzleId: attempt.progressKey.puzzleId,
        ...(attempt.outcome !== undefined ? { outcome: attempt.outcome } : {}),
        startedAt: attempt.startedAt,
        ...(attempt.completedAt !== undefined ? { completedAt: attempt.completedAt } : {}),
        timing: {
          activeSolvingSeconds: attempt.timing.activeSolvingSeconds,
          correctionSeconds: attempt.timing.correctionSeconds,
          interruptionSeconds: attempt.timing.interruptionSeconds,
          hiddenSeconds: attempt.timing.hiddenSeconds,
          timingTrustworthy: attempt.timing.timingTrustworthy,
        },
        events: attempt.events,
      };
    }
    case 'collection': {
      const collection = lookups.collections.get(entry.recordId);
      if (!collection) return undefined;
      return {
        collectionId: collection.id,
        name: collection.name,
        puzzleIds: [...collection.puzzleIds],
        // The immutable creation time is not a mutation timestamp. The signed
        // envelope and payload both need the current change time for LWW.
        updatedAt: now,
        updatedBy: deviceId,
      };
    }
    case 'woodpecker': {
      const set = lookups.sets.get(entry.recordId);
      if (set) return woodpeckerSetPayload(set);
      const cycle = lookups.cycles.get(entry.recordId);
      if (!cycle) return undefined;
      const source = lookups.sets.get(cycle.setId);
      return {
        setId: cycle.cycle.setId,
        cycleId: cycle.cycleId,
        sourceCollectionId: source?.sourceCollectionId ?? '',
        puzzleIds: [...cycle.cycle.puzzleIds],
        startedAt: cycle.cycle.startedAt,
        ...(cycle.cycle.completedAt !== undefined ? { completedAt: cycle.cycle.completedAt } : {}),
      };
    }
    case 'woodpeckerResult': {
      const [cycleId, puzzleId] = entry.recordId.split('\u0000');
      if (!cycleId || !puzzleId) return undefined;
      const cycle = lookups.cycles.get(cycleId);
      if (!cycle) return undefined;
      const result = cycle.cycle.results.find((candidate) => candidate.puzzleId === puzzleId);
      if (!result) return undefined;
      return {
        cycleId,
        puzzleId,
        result: result.result,
        activeSeconds: result.activeSeconds,
      };
    }
    case 'setting': {
      if (lookups.settings === undefined) return undefined;
      return {
        values: lookups.settings as Record<string, unknown>,
        updatedAt: now,
        updatedBy: deviceId,
      };
    }
    case 'userPuzzle': {
      const puzzle = lookups.userPuzzles.get(entry.recordId);
      if (!puzzle) {
        // A `userPuzzle` pointer only ever names a user-authored puzzle; if the
        // record is gone locally it was removed, so emit a tombstone. Other
        // devices apply it under LWW against their own sync stamp.
        return {
          puzzleId: entry.recordId,
          updatedAt: now,
          deleted: true,
        };
      }
      return {
        puzzleId: puzzle.id,
        puzzle,
        updatedAt: now,
      };
    }
    default:
      return undefined;
  }
}

/** Convenience factory mirroring the injection contract. */
export function createSyncRuntime(options: SyncRuntimeOptions): SyncRuntime {
  return new LocalSyncRuntime(options);
}
