/**
 * ONL-002 — per-device P-256 ECDSA signing (WebCrypto only).
 *
 * Each device owns an ECDSA keypair used to sign the canonical envelope bytes
 * (`canonicalEnvelopeBytes` in `types.ts`), so a stolen session alone cannot
 * forge or mutate another device's records (design decision #7). Signatures are
 * the raw WebCrypto ECDSA-P256/SHA-256 output (r‖s).
 */

import type { SyncRecordEnvelope } from './types.ts';
import { canonicalEnvelopeBytes } from './types.ts';

/** Generated per-device keypair. */
export interface DeviceKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;

function subtle(): SubtleCrypto {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || !cryptoObj.subtle) {
    throw new Error('crypto.subtle is unavailable');
  }
  return cryptoObj.subtle;
}

/** Uint8Array → base64 (browser- and Node-safe, no Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** base64 → Uint8Array. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Canonical envelope bytes as UTF-8 (what actually gets signed). The return
 * type is narrowed to `Uint8Array<ArrayBuffer>` so it is a valid `BufferSource`
 * for WebCrypto under TS 6's stricter DOM typings.
 */
export function canonicalBytesToPayload(bytes: Uint8Array | string): Uint8Array<ArrayBuffer> {
  const encoded = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return new Uint8Array(encoded);
}

/** Generate a fresh per-device P-256 ECDSA keypair (extractable public key). */
export async function generateDeviceKeys(): Promise<DeviceKeys> {
  const pair = (await subtle().generateKey(ALGORITHM, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

/** Export a public key as JWK for storage/registration. */
export async function exportDevicePublicKeyJwk(publicKey: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', publicKey);
}

/** Import a public JWK for signature verification. */
export async function importDevicePublicKeyJwk(publicKeyJwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', publicKeyJwk, ALGORITHM, true, ['verify']);
}

/**
 * Sign bytes with the device private key. Returns base64 raw ECDSA output.
 * Accepts a string for the canonical envelope bytes (encoded as UTF-8).
 */
export async function signBytes(bytes: Uint8Array | string, privateKey: CryptoKey): Promise<string> {
  const signature = await subtle().sign(SIGN_PARAMS, privateKey, canonicalBytesToPayload(bytes));
  return bytesToBase64(new Uint8Array(signature));
}

/**
 * Verify a base64 signature. `publicKey` may be an imported `CryptoKey` or a
 * public JWK (as returned by {@link exportDevicePublicKeyJwk}); a JWK is
 * imported transparently.
 */
export async function verifyBytes(
  bytes: Uint8Array | string,
  publicKey: CryptoKey | JsonWebKey,
  signature: string,
): Promise<boolean> {
  const key =
    publicKey instanceof CryptoKey ? publicKey : await importDevicePublicKeyJwk(publicKey);
  try {
    return await subtle().verify(
      SIGN_PARAMS,
      key,
      base64ToBytes(signature),
      canonicalBytesToPayload(bytes),
    );
  } catch {
    // Malformed base64 / unexpected verify failure: treat as a bad signature.
    return false;
  }
}

/** Sign the canonical bytes of an envelope (minus `sig`/`seq`). */
export async function signEnvelope(
  envelope: SyncRecordEnvelope,
  privateKey: CryptoKey,
): Promise<string> {
  return signBytes(await canonicalEnvelopeBytes(envelope), privateKey);
}

/**
 * Cross-check helper: verify `envelope.sig` against the canonical bytes of the
 * unsigned envelope. Canonicalisation is imported from `types.ts`, never
 * duplicated. Returns `false` (never throws) for a tampered/malformed envelope.
 */
export async function verifyEnvelopeSignature(
  envelope: SyncRecordEnvelope,
  publicKeyJwk: JsonWebKey,
): Promise<boolean> {
  return verifyBytes(await canonicalEnvelopeBytes(envelope), publicKeyJwk, envelope.sig);
}
