/**
 * Minimal D1 stand-in for the auth stores (identities, device keys, sessions).
 * Not a test file. Kept separate from `d1-fake.ts` so ONL-005's sync fake stays
 * unchanged.
 */

import type { D1Like, D1ResultLike, D1StatementLike } from '../src/store.ts';

interface IdentityRow {
  user_id: string;
  issuer: string;
  subject: string;
  email: string | null;
  created_at: number;
}

interface DeviceKeyRow {
  user_id: string;
  device_id: string;
  public_key_jwk: string;
  added_at: number;
}

interface SessionRow {
  session_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  device_id: string | null;
}

function normalize(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

export class FakeAuthD1 implements D1Like {
  identities: IdentityRow[] = [];
  deviceKeys: DeviceKeyRow[] = [];
  sessions: SessionRow[] = [];

  prepare(query: string): D1StatementLike {
    return new FakeStatement(this, normalize(query));
  }
}

class FakeStatement implements D1StatementLike {
  #db: FakeAuthD1;
  #sql: string;
  #params: unknown[] = [];

  constructor(db: FakeAuthD1, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }

  bind(...values: unknown[]): D1StatementLike {
    this.#params = values;
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    throw new Error(`FakeAuthD1.all: unsupported query: ${this.#sql}`);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const sql = this.#sql;
    if (sql.startsWith('select user_id, issuer, subject, email, created_at from identities')) {
      const [issuer, subject] = this.#params as [string, string];
      const row = this.#db.identities.find((r) => r.issuer === issuer && r.subject === subject);
      return row ? ({ ...row } as T) : null;
    }
    if (sql.startsWith('select public_key_jwk from identity_device_keys')) {
      const [userId, deviceId] = this.#params as [string, string];
      const row = this.#db.deviceKeys.find((r) => r.user_id === userId && r.device_id === deviceId);
      return row ? ({ public_key_jwk: row.public_key_jwk } as T) : null;
    }
    if (sql.startsWith('select session_hash, user_id, created_at, expires_at, device_id from auth_sessions')) {
      const [sessionHash] = this.#params as [string];
      const row = this.#db.sessions.find((r) => r.session_hash === sessionHash);
      return row ? ({ ...row } as T) : null;
    }
    throw new Error(`FakeAuthD1.first: unsupported query: ${sql}`);
  }

  async run(): Promise<D1ResultLike<unknown>> {
    const sql = this.#sql;
    if (sql.startsWith('create table') || sql.startsWith('create unique index') || sql.startsWith('create index')) {
      return { success: true };
    }
    if (sql.startsWith('insert into identities')) {
      const [user_id, issuer, subject, email, created_at] = this.#params as [
        string,
        string,
        string,
        string | null,
        number,
      ];
      if (this.#db.identities.some((r) => r.issuer === issuer && r.subject === subject)) {
        throw new Error('UNIQUE constraint failed: identities.issuer, identities.subject');
      }
      this.#db.identities.push({ user_id, issuer, subject, email, created_at });
      return { success: true };
    }
    if (sql.startsWith('insert into identity_device_keys')) {
      const [user_id, device_id, public_key_jwk, added_at] = this.#params as [string, string, string, number];
      if (this.#db.deviceKeys.some((r) => r.user_id === user_id && r.device_id === device_id)) {
        throw new Error('UNIQUE constraint failed: identity_device_keys');
      }
      this.#db.deviceKeys.push({ user_id, device_id, public_key_jwk, added_at });
      return { success: true };
    }
    if (sql.startsWith('update identity_device_keys set public_key_jwk')) {
      const [public_key_jwk, added_at, user_id, device_id] = this.#params as [string, number, string, string];
      const row = this.#db.deviceKeys.find((r) => r.user_id === user_id && r.device_id === device_id);
      if (row) {
        row.public_key_jwk = public_key_jwk;
        row.added_at = added_at;
      }
      return { success: true };
    }
    if (sql.startsWith('delete from identity_device_keys where user_id = ? and device_id = ?')) {
      const [user_id, device_id] = this.#params as [string, string];
      this.#db.deviceKeys = this.#db.deviceKeys.filter(
        (r) => !(r.user_id === user_id && r.device_id === device_id),
      );
      return { success: true };
    }
    if (sql.startsWith('delete from identity_device_keys where user_id = ?')) {
      const [user_id] = this.#params as [string];
      this.#db.deviceKeys = this.#db.deviceKeys.filter((r) => r.user_id !== user_id);
      return { success: true };
    }
    if (sql.startsWith('insert into auth_sessions')) {
      const [session_hash, user_id, created_at, expires_at, device_id] = this.#params as [
        string,
        string,
        number,
        number,
        string | null,
      ];
      this.#db.sessions.push({ session_hash, user_id, created_at, expires_at, device_id });
      return { success: true };
    }
    if (sql.startsWith('delete from auth_sessions where session_hash = ?')) {
      const [session_hash] = this.#params as [string];
      this.#db.sessions = this.#db.sessions.filter((r) => r.session_hash !== session_hash);
      return { success: true };
    }
    if (sql.startsWith('delete from auth_sessions where user_id = ?')) {
      const [user_id] = this.#params as [string];
      this.#db.sessions = this.#db.sessions.filter((r) => r.user_id !== user_id);
      return { success: true };
    }
    throw new Error(`FakeAuthD1.run: unsupported query: ${sql}`);
  }
}
