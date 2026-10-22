/**
 * Sync storage seam.
 *
 * Two implementations:
 *   - {@link InMemorySyncStore} — tests and local dev, zero dependencies.
 *   - {@link D1SyncStore} — a thin adapter over a minimal D1-like binding
 *     (`prepare/bind/all/first/run`), i.e. Cloudflare D1 in production.
 *
 * Contract highlights (see docs/research/online-sync-design.md):
 *   - each envelope's `payload` object is stored as stable-normalized JSON
 *     text (the same bytes its hash is taken over), so a signature stays
 *     verifiable from storage without re-serializing; the store never inspects
 *     the payload itself;
 *   - `putEnvelope` is idempotent by `(userId, dedupeKey)`. Immutable,
 *     append-only types (`attempt`, `woodpecker`, `woodpeckerResult`) are
 *     **first write wins** (a replay never overwrites the stored row), while
 *     mutable types (`setting`, `collection`, `userPuzzle`) are
 *     **last-write-wins by `(updatedAt, rev, deviceId)`**: a strictly newer
 *     `updatedAt` wins; on equal `updatedAt` a higher per-device `rev` wins;
 *     on equal `updatedAt` and `rev` the lexicographically larger `deviceId`
 *     wins, so two devices converge on the same row regardless of arrival
 *     order. A winning replacement is assigned a **new monotonic `seq`** so
 *     cursors older than it observe the change;
 *   - `seq` is assigned monotonically by the store;
 *   - devices are a per-user registry with add/list/revoke;
 *   - `deleteUser` wipes envelopes and devices for one user only.
 *
 * The wire `updatedAt` is exact (design #8 revised 2026-10-19) and the signed
 * per-device `rev` counter breaks same-millisecond ties, so two edits on one
 * device can no longer be dropped as a duplicate. `rev` is optional on the wire
 * (older clients) and defaults to `0`.
 */

import { stableJson } from './canonical.ts';
import { SYNC_ENVELOPE_VERSION, type SyncEntityType, type SyncRecordEnvelope } from './protocol.ts';

export interface DeviceRecord {
  userId: string;
  deviceId: string;
  name?: string;
  addedAt: number;
  revokedAt?: number;
}

export interface PutEnvelopeResult {
  status: 'accepted' | 'duplicate';
  /** Stored envelope including the assigned `seq` (existing row on duplicate). */
  envelope: SyncRecordEnvelope;
}

export interface SyncStore {
  /** This user's envelopes with `seq > since`, ordered by `seq`, at most `limit`. */
  listChanges(userId: string, since: number, limit: number): Promise<SyncRecordEnvelope[]>;
  /**
   * Idempotent by `(userId, dedupeKey)`. Immutable types (`attempt`,
   * `woodpecker`, `woodpeckerResult`) are first write wins; mutable types
   * (`setting`, `collection`, `userPuzzle`) are last-write-wins by
   * `(updatedAt, rev, deviceId)` with a deterministic tie-break.
   */
  putEnvelope(userId: string, envelope: SyncRecordEnvelope): Promise<PutEnvelopeResult>;
  /** Wipe every envelope and device belonging to this user. */
  deleteUser(userId: string): Promise<void>;
  addDevice(userId: string, deviceId: string, name?: string): Promise<void>;
  listDevices(userId: string): Promise<DeviceRecord[]>;
  revokeDevice(userId: string, deviceId: string): Promise<void>;
}

function cloneEnvelope(envelope: SyncRecordEnvelope): SyncRecordEnvelope {
  return JSON.parse(JSON.stringify(envelope)) as SyncRecordEnvelope;
}

/**
 * Mutable record types that follow **last-write-wins by `updatedAt`** rather
 * than first-write-wins. Everything else (`attempt`, `woodpecker`,
 * `woodpeckerResult`) is immutable/append-only and stays first-write-wins.
 */
const LAST_WRITE_WINS_TYPES: ReadonlySet<SyncEntityType> = new Set([
  'setting',
  'collection',
  'userPuzzle',
]);

/** True for the mutable types that resolve conflicts by last-write-wins. */
export function isLastWriteWinsType(type: SyncEntityType): boolean {
  return LAST_WRITE_WINS_TYPES.has(type);
}

/**
 * Normalize the wire `rev` for tolerance with older clients: a missing or
 * non-finite value is treated as `0`. A negative value is clamped to `0`.
 */
export function envelopeRev(envelope: Pick<SyncRecordEnvelope, 'rev'>): number {
  return typeof envelope.rev === 'number' && Number.isFinite(envelope.rev) && envelope.rev > 0
    ? envelope.rev
    : 0;
}

/**
 * LWW winner test shared by both stores, ordered by `(updatedAt, rev,
 * deviceId)`: a strictly newer `updatedAt` wins; on equal `updatedAt` the
 * higher per-device `rev` wins; on equal `updatedAt` and `rev` the
 * lexicographically larger `deviceId` wins. Both devices therefore converge on
 * the same stored row whatever the arrival order. Mirrors the client's
 * `isNewer` in `apps/web/src/sync/apply.ts`.
 */
export function winsLastWriteWins(
  incoming: Pick<SyncRecordEnvelope, 'updatedAt' | 'deviceId' | 'rev'>,
  existing: Pick<SyncRecordEnvelope, 'updatedAt' | 'deviceId' | 'rev'>,
): boolean {
  if (incoming.updatedAt !== existing.updatedAt) {
    return incoming.updatedAt > existing.updatedAt;
  }
  const incomingRev = envelopeRev(incoming);
  const existingRev = envelopeRev(existing);
  if (incomingRev !== existingRev) return incomingRev > existingRev;
  return incoming.deviceId > existing.deviceId;
}

export interface InMemorySyncStoreOptions {
  /** Injectable clock (tests); defaults to `Date.now`. */
  clock?: () => number;
}

export class InMemorySyncStore implements SyncStore {
  #envelopes = new Map<string, Map<string, SyncRecordEnvelope>>();
  #devices = new Map<string, DeviceRecord>();
  #seq = 0;
  #clock: () => number;

  constructor(options: InMemorySyncStoreOptions = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  async listChanges(userId: string, since: number, limit: number): Promise<SyncRecordEnvelope[]> {
    const byKey = this.#envelopes.get(userId);
    if (!byKey || limit <= 0) return [];
    return [...byKey.values()]
      .filter((envelope) => (envelope.seq ?? 0) > since)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .slice(0, limit)
      .map(cloneEnvelope);
  }

  async putEnvelope(userId: string, envelope: SyncRecordEnvelope): Promise<PutEnvelopeResult> {
    let byKey = this.#envelopes.get(userId);
    if (!byKey) {
      byKey = new Map<string, SyncRecordEnvelope>();
      this.#envelopes.set(userId, byKey);
    }
    // Normalize the wire `rev` (older clients omit it) so the stored row and
    // every later comparison see a concrete number.
    const normalized: SyncRecordEnvelope = { ...envelope, rev: envelopeRev(envelope) };
    const existing = byKey.get(envelope.dedupeKey);
    if (existing && (!isLastWriteWinsType(envelope.type) || !winsLastWriteWins(normalized, existing))) {
      // First-write-wins, or a stale/equal-losing LWW envelope: the stored row
      // (and its `seq`) is returned untouched.
      return { status: 'duplicate', envelope: cloneEnvelope(existing) };
    }
    // New record, or a winning LWW replacement: assign a fresh monotonic `seq`
    // so cursors older than it see the change in `listChanges`.
    this.#seq += 1;
    const stored: SyncRecordEnvelope = { ...normalized, seq: this.#seq };
    byKey.set(envelope.dedupeKey, stored);
    return { status: 'accepted', envelope: cloneEnvelope(stored) };
  }

  async deleteUser(userId: string): Promise<void> {
    this.#envelopes.delete(userId);
    for (const key of [...this.#devices.keys()]) {
      if (key.startsWith(`${userId}\u0000`)) this.#devices.delete(key);
    }
  }

  async addDevice(userId: string, deviceId: string, name?: string): Promise<void> {
    const record: DeviceRecord = { userId, deviceId, addedAt: this.#clock() };
    if (name !== undefined) record.name = name;
    this.#devices.set(deviceKey(userId, deviceId), record);
  }

  async listDevices(userId: string): Promise<DeviceRecord[]> {
    return [...this.#devices.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((record) => ({ ...record }));
  }

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    const record = this.#devices.get(deviceKey(userId, deviceId));
    if (record) record.revokedAt = this.#clock();
  }
}

function deviceKey(userId: string, deviceId: string): string {
  return `${userId}\u0000${deviceId}`;
}

/** The minimal shape of a Cloudflare D1 binding this adapter relies on. */
export interface D1ResultLike<T> {
  results?: T[];
  success?: boolean;
  meta?: { last_row_id?: number };
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1ResultLike<unknown>>;
}

export interface D1Like {
  prepare(query: string): D1StatementLike;
}

/**
 * Schema, applied lazily with `CREATE … IF NOT EXISTS` so no separate
 * migration step is required. `seq INTEGER PRIMARY KEY AUTOINCREMENT` gives a
 * monotonic, race-safe sequence from the database itself.
 *
 * The `payload` column holds the envelope payload **object** as
 * stable-normalized JSON text — the exact bytes {@link payloadHashHex} hashes —
 * so a signature stays verifiable from storage without re-serializing. The v2
 * schema drops the old `ciphertext`, `iv` and `key_version` columns (see
 * {@link migrateLegacyEnvelopeTable}).
 */
export const SYNC_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sync_envelopes (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     type TEXT NOT NULL,
     record_id TEXT NOT NULL,
     dedupe_key TEXT NOT NULL,
     device_id TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     rev INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL,
     sig TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sync_envelopes_user_dedupe
     ON sync_envelopes (user_id, dedupe_key)`,
  `CREATE INDEX IF NOT EXISTS sync_envelopes_user_seq
     ON sync_envelopes (user_id, seq)`,
  `CREATE TABLE IF NOT EXISTS sync_devices (
     user_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     name TEXT,
     added_at INTEGER NOT NULL,
     revoked_at INTEGER,
     PRIMARY KEY (user_id, device_id)
   )`,
];

/**
 * Every column the v2 `sync_envelopes` table must have (the reader's
 * {@link ENVELOPE_COLUMNS} plus `user_id`).
 */
const REQUIRED_ENVELOPE_COLUMNS = [
  'seq',
  'user_id',
  'type',
  'record_id',
  'dedupe_key',
  'device_id',
  'updated_at',
  'rev',
  'payload',
  'sig',
] as const;

/**
 * Bring an existing `sync_envelopes` table to the v2 shape.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot reshape a table, so a pre-existing table
 * whose columns differ from {@link REQUIRED_ENVELOPE_COLUMNS} is examined: when
 * it is **empty** it is dropped and recreated by {@link ensureSchema}; when it
 * has any rows this fails closed with a clear error rather than discarding data.
 *
 * This is deliberately a **shape** check, not a test for the one legacy
 * `ciphertext` column. A live deployment was found carrying an *intermediate*
 * v2 revision (payload but no `type`/`record_id`/`sig`), which a
 * single-column test skipped as "already v2" — and every push then failed with
 * `no such column: type` (a 500, seen from the app as a plain server error).
 * Any unexpected shape now self-heals while the table is empty, and a
 * non-empty table stops with an actionable message.
 */
async function migrateLegacyEnvelopeTable(db: D1Like): Promise<void> {
  const columns = await db.prepare('PRAGMA table_info(sync_envelopes)').all<{ name: string }>();
  const names = (columns.results ?? []).map((column) => column.name);
  if (names.length === 0) return; // no table yet — the CREATE below makes it
  const missing = REQUIRED_ENVELOPE_COLUMNS.filter((column) => !names.includes(column));
  if (missing.length === 0) return; // already the v2 shape

  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM sync_envelopes')
    .first<{ count: number }>();
  const count = row?.count ?? 0;
  if (count > 0) {
    throw new Error(
      `sync_envelopes has ${count} row(s) but is missing ${missing.join(', ')}; refusing to drop ` +
        'data. Migrate or clear the table before switching to plaintext envelopes.',
    );
  }
  // Empty but not the v2 shape: dropping also drops its indexes, which the
  // CREATE INDEX statements below then recreate.
  await db.prepare('DROP TABLE sync_envelopes').run();
}

export async function ensureSchema(db: D1Like): Promise<void> {
  await migrateLegacyEnvelopeTable(db);
  for (const statement of SYNC_SCHEMA) {
    await db.prepare(statement).run();
  }
}

/**
 * Single-statement, race-safe upsert for both conflict rules.
 *
 * `?` bind order: userId, type, recordId, dedupeKey, deviceId, updatedAt, rev,
 * payload, sig (the row to insert), then userId, dedupeKey, `lww` flag,
 * updatedAt, updatedAt, rev, rev, deviceId (the existence/winner test). `lww`
 * is `1` for mutable types and `0` for immutable ones:
 *
 *   - no existing row → the `NOT EXISTS` guard passes and the row is inserted;
 *   - immutable (`lww = 0`) with an existing row → guarded out, so the write is
 *     a no-op and the stored row keeps its `seq` (first write wins);
 *   - mutable (`lww = 1`) → written only when the incoming `(updatedAt, rev,
 *     deviceId)` is strictly greater: a newer `updatedAt`, or equal with a
 *     higher `rev`, or equal with a lexicographically larger `deviceId`
 *     (deterministic tie-break); `INSERT OR REPLACE` deletes the old row and
 *     inserts a new one, which is what gives the replacement a fresh monotonic
 *     `seq`.
 *
 * `RETURNING seq` reports exactly whether a write happened: an empty result
 * means the guard blocked it, so the caller can read back the stored row and
 * answer `duplicate`. D1 executes this atomically.
 */
const D1_UPSERT_ENVELOPE = `INSERT OR REPLACE INTO sync_envelopes (user_id, type, record_id, dedupe_key, device_id, updated_at, rev, payload, sig)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE NOT EXISTS (
  SELECT 1 FROM sync_envelopes
  WHERE user_id = ? AND dedupe_key = ?
    AND (? = 0 OR updated_at > ? OR (updated_at = ? AND (rev > ? OR (rev = ? AND device_id >= ?))))
)
RETURNING seq`;

/** Every stored envelope column the adapter reads back (payload is JSON text). */
const ENVELOPE_COLUMNS = 'seq, type, record_id, dedupe_key, device_id, updated_at, rev, payload, sig';

interface EnvelopeRow {
  seq: number;
  type: string;
  record_id: string;
  dedupe_key: string;
  device_id: string;
  updated_at: number;
  rev: number;
  payload: string;
  sig: string;
}

interface DeviceRow {
  device_id: string;
  name: string | null;
  added_at: number;
  revoked_at: number | null;
}

function rowToEnvelope(row: EnvelopeRow): SyncRecordEnvelope {
  return {
    v: SYNC_ENVELOPE_VERSION,
    type: row.type as SyncEntityType,
    recordId: row.record_id,
    dedupeKey: row.dedupe_key,
    deviceId: row.device_id,
    payload: JSON.parse(row.payload) as unknown,
    sig: row.sig,
    updatedAt: row.updated_at,
    rev: row.rev,
    seq: row.seq,
  };
}

export interface D1SyncStoreOptions {
  clock?: () => number;
}

/** Thin D1 adapter. Stateless apart from the one-time schema bootstrap. */
export class D1SyncStore implements SyncStore {
  #db: D1Like;
  #clock: () => number;
  #ready: Promise<void> | undefined;

  constructor(db: D1Like, options: D1SyncStoreOptions = {}) {
    this.#db = db;
    this.#clock = options.clock ?? Date.now;
  }

  async #ensure(): Promise<void> {
    this.#ready ??= ensureSchema(this.#db);
    return this.#ready;
  }

  async listChanges(userId: string, since: number, limit: number): Promise<SyncRecordEnvelope[]> {
    await this.#ensure();
    const result = await this.#db
      .prepare(
        `SELECT ${ENVELOPE_COLUMNS} FROM sync_envelopes WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .bind(userId, since, limit)
      .all<EnvelopeRow>();
    return (result.results ?? []).map(rowToEnvelope);
  }

  async putEnvelope(userId: string, envelope: SyncRecordEnvelope): Promise<PutEnvelopeResult> {
    await this.#ensure();
    const lww = isLastWriteWinsType(envelope.type) ? 1 : 0;
    // Normalize the wire `rev` (older clients omit it) before storing/ordering.
    const rev = envelopeRev(envelope);
    const normalized: SyncRecordEnvelope = { ...envelope, rev };
    // Store the payload as the stable-normalized JSON text the signature hashes,
    // so the row can be re-verified without re-serializing.
    const payload = stableJson(envelope.payload);
    // One atomic statement decides and applies the conflict rule, then reports
    // a real write via `RETURNING seq` (empty result = the guard blocked it).
    const result = await this.#db
      .prepare(D1_UPSERT_ENVELOPE)
      .bind(
        userId,
        envelope.type,
        envelope.recordId,
        envelope.dedupeKey,
        envelope.deviceId,
        envelope.updatedAt,
        rev,
        payload,
        envelope.sig,
        userId,
        envelope.dedupeKey,
        lww,
        envelope.updatedAt,
        envelope.updatedAt,
        rev,
        rev,
        envelope.deviceId,
      )
      .all<{ seq: number }>();
    const written = result.results?.[0];
    if (written && typeof written.seq === 'number') {
      return { status: 'accepted', envelope: { ...normalized, seq: written.seq } };
    }
    // No write: an existing row blocked it (first-write-wins, or a stale/equal
    // LWW loser). Return the stored row so the client keeps its pointer.
    const existing = await this.#findByDedupeKey(userId, envelope.dedupeKey);
    if (existing) return { status: 'duplicate', envelope: existing };
    throw new Error('D1SyncStore: upsert neither wrote nor found an existing row');
  }

  async #findByDedupeKey(userId: string, dedupeKey: string): Promise<SyncRecordEnvelope | undefined> {
    const row = await this.#db
      .prepare(`SELECT ${ENVELOPE_COLUMNS} FROM sync_envelopes WHERE user_id = ? AND dedupe_key = ?`)
      .bind(userId, dedupeKey)
      .first<EnvelopeRow>();
    return row ? rowToEnvelope(row) : undefined;
  }

  async deleteUser(userId: string): Promise<void> {
    await this.#ensure();
    await this.#db.prepare('DELETE FROM sync_envelopes WHERE user_id = ?').bind(userId).run();
    await this.#db.prepare('DELETE FROM sync_devices WHERE user_id = ?').bind(userId).run();
  }

  async addDevice(userId: string, deviceId: string, name?: string): Promise<void> {
    await this.#ensure();
    const existing = await this.#db
      .prepare('SELECT device_id FROM sync_devices WHERE user_id = ? AND device_id = ?')
      .bind(userId, deviceId)
      .first<{ device_id: string }>();
    const now = this.#clock();
    if (existing) {
      // Re-adding a revoked device makes it active again.
      await this.#db
        .prepare('UPDATE sync_devices SET name = ?, added_at = ?, revoked_at = NULL WHERE user_id = ? AND device_id = ?')
        .bind(name ?? null, now, userId, deviceId)
        .run();
      return;
    }
    await this.#db
      .prepare('INSERT INTO sync_devices (user_id, device_id, name, added_at, revoked_at) VALUES (?, ?, ?, ?, NULL)')
      .bind(userId, deviceId, name ?? null, now)
      .run();
  }

  async listDevices(userId: string): Promise<DeviceRecord[]> {
    await this.#ensure();
    const result = await this.#db
      .prepare('SELECT device_id, name, added_at, revoked_at FROM sync_devices WHERE user_id = ? ORDER BY added_at ASC')
      .bind(userId)
      .all<DeviceRow>();
    return (result.results ?? []).map((row) => {
      const record: DeviceRecord = { userId, deviceId: row.device_id, addedAt: row.added_at };
      if (row.name !== null) record.name = row.name;
      if (row.revoked_at !== null) record.revokedAt = row.revoked_at;
      return record;
    });
  }

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    await this.#ensure();
    await this.#db
      .prepare('UPDATE sync_devices SET revoked_at = ? WHERE user_id = ? AND device_id = ?')
      .bind(this.#clock(), userId, deviceId)
      .run();
  }
}
