/**
 * Minimal in-memory stand-in for a Cloudflare D1 binding.
 *
 * Supports exactly the `prepare/bind/all/first/run` calls `D1SyncStore` makes,
 * so the adapter is exercised with **no network and no account**. It also
 * models the introspective calls the v2 migration uses (`PRAGMA table_info`,
 * `SELECT COUNT(*)`, `DROP TABLE`) so the legacy-schema path is testable. Not a
 * test file (does not match `*.node.test.ts`).
 */

import type { D1Like, D1ResultLike, D1StatementLike } from '../src/store.ts';

interface EnvelopeRow {
  seq: number;
  user_id: string;
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
  user_id: string;
  device_id: string;
  name: string | null;
  added_at: number;
  revoked_at: number | null;
}

/** Columns of the current (v2, plaintext) `sync_envelopes` table. */
const NEW_ENVELOPE_COLUMNS: readonly string[] = [
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
];

/** Columns of the live pre-v2 table (encrypted), including `ciphertext`. */
const LEGACY_ENVELOPE_COLUMNS: readonly string[] = [
  'seq',
  'user_id',
  'type',
  'record_id',
  'dedupe_key',
  'device_id',
  'updated_at',
  'rev',
  'key_version',
  'iv',
  'ciphertext',
  'sig',
];

/**
 * Columns of the intermediate v2 revision that a live database was found
 * carrying: `payload` already, but not yet `type`/`record_id`/`sig`. Every push
 * 500'd with `no such column: type` until the shape check learned about it.
 */
const INTERMEDIATE_ENVELOPE_COLUMNS: readonly string[] = [
  'seq',
  'user_id',
  'dedupe_key',
  'device_id',
  'updated_at',
  'rev',
  'payload',
];

function normalize(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

export class FakeD1 implements D1Like {
  envelopes: EnvelopeRow[] = [];
  devices: DeviceRow[] = [];
  #seq = 0;
  #envelopeTableExists = false;
  #envelopeColumns: readonly string[] = NEW_ENVELOPE_COLUMNS;
  #legacyRows = 0;

  nextSeq(): number {
    this.#seq += 1;
    return this.#seq;
  }

  /**
   * Simulate the live pre-v2 `sync_envelopes` table (the encrypted shape).
   * `rowCount` models how many (undecodable) rows it holds.
   */
  seedLegacyEnvelopeTable(rowCount = 0): void {
    this.#envelopeTableExists = true;
    this.#envelopeColumns = LEGACY_ENVELOPE_COLUMNS;
    this.#legacyRows = rowCount;
    this.envelopes = [];
  }

  /** Simulate the intermediate v2 shape (payload, but no type/record_id/sig). */
  seedIntermediateEnvelopeTable(rowCount = 0): void {
    this.#envelopeTableExists = true;
    this.#envelopeColumns = INTERMEDIATE_ENVELOPE_COLUMNS;
    this.#legacyRows = rowCount;
    this.envelopes = [];
  }

  prepare(query: string): D1StatementLike {
    return new FakeStatement(this, normalize(query));
  }

  /** Test seam: current columns of the modelled `sync_envelopes` table. */
  envelopeColumns(): readonly string[] {
    return this.#envelopeTableExists ? this.#envelopeColumns : [];
  }

  countEnvelopeRows(): number {
    return this.envelopes.length;
  }

  /** Internal — the `DROP TABLE` handler. */
  dropEnvelopeTable(): void {
    this.#envelopeTableExists = false;
    this.#envelopeColumns = NEW_ENVELOPE_COLUMNS;
    this.#legacyRows = 0;
    this.envelopes = [];
  }

  /** Internal — the `CREATE TABLE` handler. */
  createEnvelopeTable(): void {
    this.#envelopeTableExists = true;
    this.#envelopeColumns = NEW_ENVELOPE_COLUMNS;
    this.#legacyRows = 0;
  }

  /** Internal — `SELECT COUNT(*)`. Any seeded-but-unmodelled shape reports its rows. */
  envelopeRowCount(): number {
    if (!this.#envelopeTableExists) return 0;
    const modelled = this.#envelopeColumns === NEW_ENVELOPE_COLUMNS;
    return modelled ? this.envelopes.length : this.#legacyRows;
  }
}

class FakeStatement implements D1StatementLike {
  #db: FakeD1;
  #sql: string;
  #params: unknown[] = [];

  constructor(db: FakeD1, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }

  bind(...values: unknown[]): D1StatementLike {
    this.#params = values;
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    const sql = this.#sql;
    if (sql.startsWith('pragma table_info(sync_envelopes)')) {
      const results = this.#db.envelopeColumns().map((name) => ({ name }));
      return { success: true, results: results as T[] };
    }
    if (sql.startsWith('insert or replace into sync_envelopes')) {
      // Mirrors D1_UPSERT_ENVELOPE in src/store.ts: bind order is
      // [user, type, recordId, key, device, updatedAt, rev, payload, sig,
      //  user, key, lww, updatedAt, updatedAt, rev, rev, device], and
      // `RETURNING seq` yields one row iff a write happened (empty result means
      // the conflict guard blocked it).
      const p = this.#params;
      const user_id = p[0] as string;
      const type = p[1] as string;
      const record_id = p[2] as string;
      const dedupe_key = p[3] as string;
      const device_id = p[4] as string;
      const updated_at = p[5] as number;
      const rev = p[6] as number;
      const payload = p[7] as string;
      const sig = p[8] as string;
      const lww = p[11] as number;
      const existing = this.#db.envelopes.find(
        (r) => r.user_id === user_id && r.dedupe_key === dedupe_key,
      );
      const shouldWrite =
        existing === undefined ||
        (lww === 1 &&
          (updated_at > existing.updated_at ||
            (updated_at === existing.updated_at &&
              (rev > existing.rev ||
                (rev === existing.rev && device_id > existing.device_id)))));
      if (!shouldWrite) return { success: true, results: [] };
      // INSERT OR REPLACE deletes the conflicting row and inserts a new one, so
      // a replacement gets a fresh monotonic `seq` just like real SQLite.
      if (existing) {
        this.#db.envelopes = this.#db.envelopes.filter((r) => r !== existing);
      }
      const seq = this.#db.nextSeq();
      this.#db.envelopes.push({
        seq,
        user_id,
        type,
        record_id,
        dedupe_key,
        device_id,
        updated_at,
        rev,
        payload,
        sig,
      });
      return { success: true, results: [{ seq }] as T[] };
    }
    if (sql.startsWith('select seq, type, record_id, dedupe_key, device_id, updated_at, rev, payload, sig from sync_envelopes')) {
      const [userId, since, limit] = this.#params as [string, number, number];
      const results = this.#db.envelopes
        .filter((row) => row.user_id === userId && row.seq > since)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map((row) => ({ ...row }));
      return { success: true, results: results as T[] };
    }
    if (sql.startsWith('select device_id, name, added_at, revoked_at from sync_devices')) {
      const [userId] = this.#params as [string];
      const results = this.#db.devices
        .filter((row) => row.user_id === userId)
        .sort((a, b) => a.added_at - b.added_at)
        .map((row) => ({
          device_id: row.device_id,
          name: row.name,
          added_at: row.added_at,
          revoked_at: row.revoked_at,
        }));
      return { success: true, results: results as T[] };
    }
    throw new Error(`FakeD1.all: unsupported query: ${sql}`);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const sql = this.#sql;
    if (sql.startsWith('select count(*) as count from sync_envelopes')) {
      return { count: this.#db.envelopeRowCount() } as T;
    }
    if (sql.startsWith('select seq, type, record_id, dedupe_key, device_id, updated_at, rev, payload, sig from sync_envelopes')) {
      const [userId, dedupeKey] = this.#params as [string, string];
      const row = this.#db.envelopes.find((r) => r.user_id === userId && r.dedupe_key === dedupeKey);
      return row ? ({ ...row } as T) : null;
    }
    if (sql.startsWith('select device_id from sync_devices where user_id = ? and device_id = ?')) {
      const [userId, deviceId] = this.#params as [string, string];
      const row = this.#db.devices.find((r) => r.user_id === userId && r.device_id === deviceId);
      return row ? ({ device_id: row.device_id } as T) : null;
    }
    throw new Error(`FakeD1.first: unsupported query: ${sql}`);
  }

  async run(): Promise<D1ResultLike<unknown>> {
    const sql = this.#sql;
    if (sql.startsWith('create table if not exists sync_envelopes')) {
      this.#db.createEnvelopeTable();
      return { success: true };
    }
    if (sql.startsWith('create table') || sql.startsWith('create unique index') || sql.startsWith('create index')) {
      return { success: true };
    }
    if (sql.startsWith('drop table sync_envelopes') || sql.startsWith('drop table if exists sync_envelopes')) {
      this.#db.dropEnvelopeTable();
      return { success: true };
    }
    if (sql.startsWith('insert into sync_devices')) {
      const [user_id, device_id, name, added_at] = this.#params as [string, string, string | null, number];
      this.#db.devices.push({ user_id, device_id, name, added_at, revoked_at: null });
      return { success: true };
    }
    if (sql.startsWith('update sync_devices set name')) {
      const [name, added_at, user_id, device_id] = this.#params as [string | null, number, string, string];
      const row = this.#db.devices.find((r) => r.user_id === user_id && r.device_id === device_id);
      if (row) {
        row.name = name;
        row.added_at = added_at;
        row.revoked_at = null;
      }
      return { success: true };
    }
    if (sql.startsWith('update sync_devices set revoked_at')) {
      const [revoked_at, user_id, device_id] = this.#params as [number, string, string];
      const row = this.#db.devices.find((r) => r.user_id === user_id && r.device_id === device_id);
      if (row) row.revoked_at = revoked_at;
      return { success: true };
    }
    if (sql.startsWith('delete from sync_envelopes where user_id = ?')) {
      const [userId] = this.#params as [string];
      this.#db.envelopes = this.#db.envelopes.filter((r) => r.user_id !== userId);
      return { success: true };
    }
    if (sql.startsWith('delete from sync_devices where user_id = ?')) {
      const [userId] = this.#params as [string];
      this.#db.devices = this.#db.devices.filter((r) => r.user_id !== userId);
      return { success: true };
    }
    throw new Error(`FakeD1.run: unsupported query: ${sql}`);
  }
}
