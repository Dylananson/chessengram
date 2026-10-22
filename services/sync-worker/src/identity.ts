/**
 * Canonical identities + per-device public signing keys.
 *
 * A provider `sub` is only unique *within one issuer* (Cognito user pools are
 * per-region), so it must never become the application `userId`. Instead we
 * create our own random id once per `(issuer, subject)` pair and persist the
 * mapping in the `identities` table. The raw subject is stored only as an
 * internal lookup key; no HTTP response ever echoes it.
 *
 * Device public keys live next to identities (`identity_device_keys`). The
 * private key never leaves the device; the server stores only the public JWK
 * and uses it to verify each envelope's `sig`.
 *
 * Two implementations mirror `store.ts`:
 *   - {@link InMemoryIdentityStore} — tests/local dev, zero dependencies;
 *   - {@link D1IdentityStore} — Cloudflare D1, schemas created lazily.
 *
 * This file deliberately does not import Node's crypto module: randomness and
 * hashing go through WebCrypto (`globalThis.crypto`), available in Workers and
 * Node ≥ 20.
 */

import type { D1Like } from './store.ts';

/** Public half of a device key (P-256 ECDSA). Never includes `d`. */
export interface PublicDeviceJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  ext?: boolean;
  [key: string]: unknown;
}

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email?: string;
}

export interface IdentityRecord {
  /** Our canonical, random app user id (`usr_` + 32 hex chars). */
  userId: string;
  issuer: string;
  /** Internal only — never serialize this to a client. */
  subject: string;
  email?: string;
  createdAt: number;
}

/** Returns `length` cryptographically-random bytes. */
export type RandomBytesSource = (length: number) => Uint8Array;

/** WebCrypto-backed randomness (default). */
export function cryptoRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return hex;
}

/** New canonical user id: 128 random bits, never derived from the subject. */
export function newUserId(randomBytes: RandomBytesSource = cryptoRandomBytes): string {
  return `usr_${bytesToHex(randomBytes(16))}`;
}

/** Key used to make `(issuer, subject)` unique. */
function identityKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}

function deviceKey(userId: string, deviceId: string): string {
  return `${userId}\u0000${deviceId}`;
}

function cloneRecord(record: IdentityRecord): IdentityRecord {
  return { ...record };
}

function cloneJwk(jwk: PublicDeviceJwk): PublicDeviceJwk {
  return JSON.parse(JSON.stringify(jwk)) as PublicDeviceJwk;
}

export interface IdentityStore {
  /** Idempotent: the same `(issuer, subject)` always yields the same record. */
  getOrCreateIdentity(input: VerifiedIdentity): Promise<IdentityRecord>;
  getIdentity(issuer: string, subject: string): Promise<IdentityRecord | undefined>;
  getDevicePublicKey(userId: string, deviceId: string): Promise<PublicDeviceJwk | undefined>;
  setDevicePublicKey(userId: string, deviceId: string, jwk: PublicDeviceJwk): Promise<void>;
  deleteDevicePublicKey(userId: string, deviceId: string): Promise<void>;
  /** Used when the user wipes their server copy; identity mappings stay stable. */
  deleteDevicePublicKeysForUser(userId: string): Promise<void>;
}

export interface IdentityStoreOptions {
  clock?: () => number;
  randomBytes?: RandomBytesSource;
}

/**
 * Resolve the canonical app user id for a verified provider identity.
 * Creates the mapping once; later calls (even across sessions/devices) reuse it.
 */
export async function resolveCanonicalUserId(
  store: IdentityStore,
  identity: VerifiedIdentity,
): Promise<string> {
  if (typeof identity.issuer !== 'string' || identity.issuer.length === 0) {
    throw new Error('issuer must be a non-empty string');
  }
  if (typeof identity.subject !== 'string' || identity.subject.length === 0) {
    throw new Error('subject must be a non-empty string');
  }
  const record = await store.getOrCreateIdentity(identity);
  return record.userId;
}

export class InMemoryIdentityStore implements IdentityStore {
  #identities = new Map<string, IdentityRecord>();
  #deviceKeys = new Map<string, PublicDeviceJwk>();
  #clock: () => number;
  #randomBytes: RandomBytesSource;

  constructor(options: IdentityStoreOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#randomBytes = options.randomBytes ?? cryptoRandomBytes;
  }

  async getOrCreateIdentity(input: VerifiedIdentity): Promise<IdentityRecord> {
    const key = identityKey(input.issuer, input.subject);
    const existing = this.#identities.get(key);
    if (existing) return cloneRecord(existing);

    const record: IdentityRecord = {
      userId: newUserId(this.#randomBytes),
      issuer: input.issuer,
      subject: input.subject,
      createdAt: this.#clock(),
    };
    if (input.email !== undefined) record.email = input.email;
    this.#identities.set(key, record);
    return cloneRecord(record);
  }

  async getIdentity(issuer: string, subject: string): Promise<IdentityRecord | undefined> {
    const record = this.#identities.get(identityKey(issuer, subject));
    return record ? cloneRecord(record) : undefined;
  }

  async getDevicePublicKey(userId: string, deviceId: string): Promise<PublicDeviceJwk | undefined> {
    const jwk = this.#deviceKeys.get(deviceKey(userId, deviceId));
    return jwk ? cloneJwk(jwk) : undefined;
  }

  async setDevicePublicKey(userId: string, deviceId: string, jwk: PublicDeviceJwk): Promise<void> {
    this.#deviceKeys.set(deviceKey(userId, deviceId), cloneJwk(jwk));
  }

  async deleteDevicePublicKey(userId: string, deviceId: string): Promise<void> {
    this.#deviceKeys.delete(deviceKey(userId, deviceId));
  }

  async deleteDevicePublicKeysForUser(userId: string): Promise<void> {
    const prefix = `${userId}\u0000`;
    for (const key of [...this.#deviceKeys.keys()]) {
      if (key.startsWith(prefix)) this.#deviceKeys.delete(key);
    }
  }
}

export const IDENTITY_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS identities (
     user_id TEXT PRIMARY KEY,
     issuer TEXT NOT NULL,
     subject TEXT NOT NULL,
     email TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS identities_issuer_subject
     ON identities (issuer, subject)`,
  `CREATE TABLE IF NOT EXISTS identity_device_keys (
     user_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     public_key_jwk TEXT NOT NULL,
     added_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, device_id)
   )`,
];

interface IdentityRow {
  user_id: string;
  issuer: string;
  subject: string;
  email: string | null;
  created_at: number;
}

interface DeviceKeyRow {
  public_key_jwk: string;
}

function rowToIdentity(row: IdentityRow): IdentityRecord {
  const record: IdentityRecord = {
    userId: row.user_id,
    issuer: row.issuer,
    subject: row.subject,
    createdAt: row.created_at,
  };
  if (row.email !== null) record.email = row.email;
  return record;
}

export class D1IdentityStore implements IdentityStore {
  #db: D1Like;
  #clock: () => number;
  #randomBytes: RandomBytesSource;
  #ready: Promise<void> | undefined;

  constructor(db: D1Like, options: IdentityStoreOptions = {}) {
    this.#db = db;
    this.#clock = options.clock ?? Date.now;
    this.#randomBytes = options.randomBytes ?? cryptoRandomBytes;
  }

  async #ensure(): Promise<void> {
    this.#ready ??= (async () => {
      for (const statement of IDENTITY_SCHEMA) {
        await this.#db.prepare(statement).run();
      }
    })();
    return this.#ready;
  }

  async #find(issuer: string, subject: string): Promise<IdentityRecord | undefined> {
    const row = await this.#db
      .prepare('SELECT user_id, issuer, subject, email, created_at FROM identities WHERE issuer = ? AND subject = ?')
      .bind(issuer, subject)
      .first<IdentityRow>();
    return row ? rowToIdentity(row) : undefined;
  }

  async getOrCreateIdentity(input: VerifiedIdentity): Promise<IdentityRecord> {
    await this.#ensure();
    const existing = await this.#find(input.issuer, input.subject);
    if (existing) return existing;

    const record: IdentityRecord = {
      userId: newUserId(this.#randomBytes),
      issuer: input.issuer,
      subject: input.subject,
      createdAt: this.#clock(),
    };
    try {
      await this.#db
        .prepare('INSERT INTO identities (user_id, issuer, subject, email, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(record.userId, record.issuer, record.subject, input.email ?? null, record.createdAt)
        .run();
      return record;
    } catch (error) {
      // Lost a concurrent race on the unique (issuer, subject) index.
      const raced = await this.#find(input.issuer, input.subject);
      if (raced) return raced;
      throw error;
    }
  }

  async getIdentity(issuer: string, subject: string): Promise<IdentityRecord | undefined> {
    await this.#ensure();
    return this.#find(issuer, subject);
  }

  async getDevicePublicKey(userId: string, deviceId: string): Promise<PublicDeviceJwk | undefined> {
    await this.#ensure();
    const row = await this.#db
      .prepare('SELECT public_key_jwk FROM identity_device_keys WHERE user_id = ? AND device_id = ?')
      .bind(userId, deviceId)
      .first<DeviceKeyRow>();
    if (!row) return undefined;
    try {
      return JSON.parse(row.public_key_jwk) as PublicDeviceJwk;
    } catch {
      return undefined;
    }
  }

  async setDevicePublicKey(userId: string, deviceId: string, jwk: PublicDeviceJwk): Promise<void> {
    await this.#ensure();
    const serialized = JSON.stringify(jwk);
    const now = this.#clock();
    const existing = await this.#db
      .prepare('SELECT public_key_jwk FROM identity_device_keys WHERE user_id = ? AND device_id = ?')
      .bind(userId, deviceId)
      .first<DeviceKeyRow>();
    if (existing) {
      await this.#db
        .prepare('UPDATE identity_device_keys SET public_key_jwk = ?, added_at = ? WHERE user_id = ? AND device_id = ?')
        .bind(serialized, now, userId, deviceId)
        .run();
      return;
    }
    try {
      await this.#db
        .prepare('INSERT INTO identity_device_keys (user_id, device_id, public_key_jwk, added_at) VALUES (?, ?, ?, ?)')
        .bind(userId, deviceId, serialized, now)
        .run();
    } catch {
      // Concurrent registration: last writer wins (same device id).
      await this.#db
        .prepare('UPDATE identity_device_keys SET public_key_jwk = ?, added_at = ? WHERE user_id = ? AND device_id = ?')
        .bind(serialized, now, userId, deviceId)
        .run();
    }
  }

  async deleteDevicePublicKey(userId: string, deviceId: string): Promise<void> {
    await this.#ensure();
    await this.#db
      .prepare('DELETE FROM identity_device_keys WHERE user_id = ? AND device_id = ?')
      .bind(userId, deviceId)
      .run();
  }

  async deleteDevicePublicKeysForUser(userId: string): Promise<void> {
    await this.#ensure();
    await this.#db.prepare('DELETE FROM identity_device_keys WHERE user_id = ?').bind(userId).run();
  }
}
