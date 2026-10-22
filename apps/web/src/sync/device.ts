/**
 * ONL-002 — device identity and the local user salt.
 *
 * Both live in the frozen `SyncState` shape (`types.ts`) and are persisted
 * through the `SyncStateStorage` seam. Nothing here touches the network or a
 * concrete store: the caller injects the seam (and, in tests, the randomness).
 */

import type { SyncState, SyncStateStorage } from './types.ts';

/** Returns `length` cryptographically-random bytes. */
export type RandomBytesSource = (length: number) => Uint8Array;

/** WebCrypto-backed source (default). Available in browsers and Node ≥ 20. */
export function cryptoRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is unavailable');
  }
  cryptoObj.getRandomValues(out);
  return out;
}

/** Lowercase hex encoding. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * `length` random bytes as lowercase hex (so the string is `2 * length` chars).
 * `randomBytes` is injectable for deterministic tests.
 */
export function randomHex(length: number, randomBytes: RandomBytesSource = cryptoRandomBytes): string {
  return bytesToHex(randomBytes(length));
}

/** New opaque device id (16 random bytes → 32 hex chars). */
export function newDeviceId(randomBytes: RandomBytesSource = cryptoRandomBytes): string {
  return randomHex(16, randomBytes);
}

export interface DeviceIdOptions {
  /** Injectable randomness; defaults to `crypto.getRandomValues`. */
  randomBytes?: RandomBytesSource;
}

/** De-duplicates concurrent `getOrCreateDeviceId` calls for the same storage. */
const inFlight = new WeakMap<SyncStateStorage, Promise<string>>();

/**
 * Read the persisted device id, creating and saving one on first use.
 *
 * Only `deviceId` is touched: every other `SyncState` field (enabled,
 * cursor, userId) is preserved verbatim. Concurrent first calls are
 * collapsed per storage instance so a single id wins.
 */
export async function getOrCreateDeviceId(
  storage: SyncStateStorage,
  options: DeviceIdOptions = {},
): Promise<string> {
  const pending = inFlight.get(storage);
  if (pending) return pending;

  const run = (async () => {
    const state = await storage.load();
    if (state?.deviceId) return state.deviceId;
    const deviceId = newDeviceId(options.randomBytes);
    const next: SyncState = { ...(state ?? {}), enabled: state?.enabled ?? false, deviceId };
    await storage.save(next);
    return deviceId;
  })();

  inFlight.set(storage, run);
  try {
    return await run;
  } finally {
    inFlight.delete(storage);
  }
}
