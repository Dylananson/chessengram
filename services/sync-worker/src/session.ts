/**
 * Opaque BFF sessions.
 *
 * The browser holds a random 128-bit session id in `chessengram_session`; the
 * server stores only its SHA-256 hash. Nothing is signed — the id is random,
 * unguessable and revocable — so no HMAC secret is required. The cookie is
 * `HttpOnly; Secure; SameSite=Lax; Path=/` with a bounded `Max-Age`.
 *
 * Session records may optionally carry a `deviceId`, but device registration
 * stays a separate operation: a stolen session alone can never produce a valid
 * envelope signature.
 */

import type { D1Like } from './store.ts';
import type { RandomBytesSource } from './identity.ts';
import { cryptoRandomBytes } from './identity.ts';

export const SESSION_COOKIE_NAME = 'chessengram_session';
/** 128 bits of randomness as 32 hex chars. */
const SESSION_ID_BYTES = 16;

export interface SessionRecord {
  /** SHA-256(sessionId) as lowercase hex — the storage key. */
  sessionHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  deviceId?: string;
}

export interface SessionStore {
  create(record: SessionRecord): Promise<void>;
  get(sessionHash: string): Promise<SessionRecord | undefined>;
  delete(sessionHash: string): Promise<void>;
  /** Optional hygiene: revoke every session for one user. */
  deleteUserSessions(userId: string): Promise<void>;
}

export interface CreateSessionOptions {
  userId: string;
  ttlSeconds: number;
  now?: number;
  deviceId?: string;
  randomBytes?: RandomBytesSource;
}

export interface CreatedSession {
  sessionId: string;
  sessionHash: string;
  expiresAt: number;
  /** Ready-to-send `Set-Cookie` value. */
  cookie: string;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return hex;
}

function newSessionId(randomBytes: RandomBytesSource = cryptoRandomBytes): string {
  return bytesToHex(randomBytes(SESSION_ID_BYTES));
}

/** SHA-256 of the opaque session id, lowercase hex. */
export async function hashSessionId(sessionId: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId));
  return bytesToHex(new Uint8Array(digest));
}

/** Create a session and return the raw id (cookie value) + its stored hash. */
export async function createSession(
  store: SessionStore,
  options: CreateSessionOptions,
): Promise<CreatedSession> {
  if (typeof options.userId !== 'string' || options.userId.length === 0) {
    throw new Error('userId must be a non-empty string');
  }
  if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be a positive integer');
  }
  const now = options.now ?? Date.now();
  const sessionId = newSessionId(options.randomBytes);
  const sessionHash = await hashSessionId(sessionId);
  const record: SessionRecord = {
    sessionHash,
    userId: options.userId,
    createdAt: now,
    expiresAt: now + options.ttlSeconds * 1000,
  };
  if (options.deviceId !== undefined) record.deviceId = options.deviceId;
  await store.create(record);
  return {
    sessionId,
    sessionHash,
    expiresAt: record.expiresAt,
    cookie: sessionCookie(sessionId, options.ttlSeconds),
  };
}

/** `Set-Cookie` value for a freshly created session. */
export function sessionCookie(sessionId: string, ttlSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`;
}

/** `Set-Cookie` value that clears the session cookie. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Extract the session id from a `Cookie` header (first match wins). */
export function readSessionCookie(cookieHeader: string | null): string | undefined {
  if (cookieHeader === null) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return { ...record };
}

export class InMemorySessionStore implements SessionStore {
  #sessions = new Map<string, SessionRecord>();

  async create(record: SessionRecord): Promise<void> {
    this.#sessions.set(record.sessionHash, cloneRecord(record));
  }

  async get(sessionHash: string): Promise<SessionRecord | undefined> {
    const record = this.#sessions.get(sessionHash);
    return record ? cloneRecord(record) : undefined;
  }

  async delete(sessionHash: string): Promise<void> {
    this.#sessions.delete(sessionHash);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    for (const [hash, record] of this.#sessions) {
      if (record.userId === userId) this.#sessions.delete(hash);
    }
  }
}

export const SESSION_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS auth_sessions (
     session_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     device_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS auth_sessions_user
     ON auth_sessions (user_id)`,
];

interface SessionRow {
  session_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  device_id: string | null;
}

function rowToRecord(row: SessionRow): SessionRecord {
  const record: SessionRecord = {
    sessionHash: row.session_hash,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  if (row.device_id !== null) record.deviceId = row.device_id;
  return record;
}

export class D1SessionStore implements SessionStore {
  #db: D1Like;
  #ready: Promise<void> | undefined;

  constructor(db: D1Like) {
    this.#db = db;
  }

  async #ensure(): Promise<void> {
    this.#ready ??= (async () => {
      for (const statement of SESSION_SCHEMA) {
        await this.#db.prepare(statement).run();
      }
    })();
    return this.#ready;
  }

  async create(record: SessionRecord): Promise<void> {
    await this.#ensure();
    await this.#db
      .prepare(
        'INSERT INTO auth_sessions (session_hash, user_id, created_at, expires_at, device_id) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(
        record.sessionHash,
        record.userId,
        record.createdAt,
        record.expiresAt,
        record.deviceId ?? null,
      )
      .run();
  }

  async get(sessionHash: string): Promise<SessionRecord | undefined> {
    await this.#ensure();
    const row = await this.#db
      .prepare('SELECT session_hash, user_id, created_at, expires_at, device_id FROM auth_sessions WHERE session_hash = ?')
      .bind(sessionHash)
      .first<SessionRow>();
    return row ? rowToRecord(row) : undefined;
  }

  async delete(sessionHash: string): Promise<void> {
    await this.#ensure();
    await this.#db.prepare('DELETE FROM auth_sessions WHERE session_hash = ?').bind(sessionHash).run();
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.#ensure();
    await this.#db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(userId).run();
  }
}
