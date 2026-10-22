/**
 * ONL-011 — Cognito authorization-code + PKCE for the public sync client.
 *
 * The app is a **public** OAuth client: it has no client secret, so PKCE is
 * mandatory. This module owns only the two browser-side legs:
 *
 *   1. {@link beginAuth} builds the hosted-UI authorize URL and remembers a
 *      short-lived `{ state, verifier }` pair (sessionStorage by default).
 *      The caller assigns `location.href`, so nothing here navigates.
 *   2. {@link completeAuth} validates the returned `state`, exchanges the code
 *      at `/oauth2/token` and returns the Cognito ID token.
 *
 * Rules baked in here:
 * - **Nothing secret is logged.** Tokens, the PKCE verifier and the pending
 *   record never appear in messages or console output.
 * - **No network in tests.** `fetchImpl` and the pending storage are injectable;
 *   the module never imports a concrete store.
 * - **Fails closed.** Missing/mismatched/expired state, a non-2xx token
 *   response and a body without `id_token` all become a typed
 *   {@link SyncAuthError}, never a partial success.
 *
 * The ID token is exchanged for a server session by `bootstrap.enable()`; it is
 * never persisted by this module (`client.ts` owns the session cookie).
 */

import type { SyncPanelConfig } from './panel.ts';

/** sessionStorage key holding the in-flight authorize request. */
export const AUTH_PENDING_STORAGE_KEY = 'chessengram.sync.auth.pending';
/** How long a redirect may take before the pending verifier is useless. */
export const AUTH_PENDING_TTL_MS = 10 * 60 * 1000;
/** Cognito scopes requested by default (Google-only user pool). */
export const DEFAULT_AUTH_SCOPE = 'openid email profile';

/** The minimum sessionStorage shape we need (injectable for Node tests). */
export interface AuthPendingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Persisted authorize request. Never includes a token. */
export interface AuthPending {
  state: string;
  verifier: string;
  createdAt: number;
}

/** Machine-readable failure codes; safe to show/act on. */
export type SyncAuthErrorCode =
  | 'missing_config'
  | 'storage_unavailable'
  | 'state_missing'
  | 'state_mismatch'
  | 'state_expired'
  | 'invalid_callback'
  | 'token_exchange_failed'
  | 'invalid_token_response'
  | 'network_error';

/** Typed auth failure. Messages are deliberately generic (no secrets). */
export class SyncAuthError extends Error {
  readonly code: SyncAuthErrorCode;
  /** HTTP status of a failed token exchange, when there was one. */
  readonly status: number | undefined;

  constructor(code: SyncAuthErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SyncAuthError';
    this.code = code;
    this.status = status;
  }
}

/** Minimal response shape the token exchange needs. */
export interface AuthFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** Injectable fetch used for the token exchange (tests never hit the network). */
export type AuthFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<AuthFetchResponse>;

export interface BeginAuthInput {
  config: SyncPanelConfig;
  /** Injectable clock (defaults to `Date.now`). */
  now?: number;
  /** Injectable pending storage (defaults to `sessionStorage`). */
  storage?: AuthPendingStorage;
  /** OAuth scopes; defaults to {@link DEFAULT_AUTH_SCOPE}. */
  scope?: string;
  /** Injectable randomness so tests can assert deterministic values. */
  randomBytes?: (length: number) => Uint8Array;
}

export interface BeginAuthResult {
  /** Authorize URL the caller assigns to `location.href`. */
  url: string;
  /** The random `state` persisted with the verifier. */
  state: string;
}

export interface CompleteAuthInput {
  config: SyncPanelConfig;
  /** Full callback URL (query string is what matters). */
  callbackUrl: string;
  /** Injectable fetch (defaults to `globalThis.fetch`). */
  fetchImpl?: AuthFetch;
  /** Injectable clock (defaults to `Date.now`). */
  now?: number;
  /** Injectable pending storage (defaults to `sessionStorage`). */
  storage?: AuthPendingStorage;
}

export interface CompleteAuthResult {
  /** Cognito ID token, ready for `bootstrap.enable({ idToken })`. */
  idToken: string;
}

interface ResolvedAuthConfig {
  authority: string;
  clientId: string;
  /**
   * Optional: a public Cognito client may rely on its single registered
   * callback. When present it is sent on both legs so they always match.
   */
  redirectUri: string | undefined;
}

function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function trimTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** Validate the pieces every leg needs; no value is ever logged. */
function resolveConfig(config: SyncPanelConfig | undefined): ResolvedAuthConfig {
  if (!config || !hasText(config.authAuthority) || !hasText(config.authClientId)) {
    throw new SyncAuthError(
      'missing_config',
      'Sync auth is not configured (authority and client id are required).',
    );
  }
  return {
    authority: trimTrailingSlashes(config.authAuthority),
    clientId: config.authClientId.trim(),
    redirectUri: hasText(config.authRedirectUri) ? config.authRedirectUri.trim() : undefined,
  };
}

function defaultPendingStorage(): AuthPendingStorage | undefined {
  try {
    const storage = (globalThis as { sessionStorage?: AuthPendingStorage }).sessionStorage;
    if (storage && typeof storage.getItem === 'function') return storage;
  } catch {
    // Access can throw (private mode / disabled storage): treated as absent.
  }
  return undefined;
}

function requireStorage(injected: AuthPendingStorage | undefined): AuthPendingStorage {
  const storage = injected ?? defaultPendingStorage();
  if (!storage) {
    throw new SyncAuthError(
      'storage_unavailable',
      'Browser session storage is unavailable, so sign-in cannot be completed.',
    );
  }
  return storage;
}

function randomBytesSource(injected: ((length: number) => Uint8Array) | undefined) {
  if (injected) return injected;
  return (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    const cryptoObj = globalThis.crypto;
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
      throw new SyncAuthError('network_error', 'Secure randomness is unavailable.');
    }
    cryptoObj.getRandomValues(out);
    return out;
  };
}

/** base64url without padding (RFC 4648 §5). */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** S256 PKCE challenge: base64url(SHA-256(verifier)). */
async function pkceChallenge(verifier: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new SyncAuthError('network_error', 'WebCrypto is unavailable.');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

/** 32 random bytes → 43-character base64url verifier (inside the RFC 7636 range). */
function randomBase64Url(random: (length: number) => Uint8Array, length: number): string {
  return bytesToBase64Url(random(length));
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    try {
      // Relative callback (e.g. tests): only the query/state matters here.
      return new URL(url, 'http://localhost/');
    } catch {
      return undefined;
    }
  }
}

/** Parsed callback query. `error` is surfaced only as a typed failure. */
export interface AuthCallbackParams {
  code?: string;
  state?: string;
  error?: string;
}

/** Extract `code`/`state`/`error` from a callback URL; `undefined` when unparseable. */
export function parseAuthCallback(url: string): AuthCallbackParams | undefined {
  const parsed = parseUrl(url);
  if (!parsed) return undefined;
  const code = parsed.searchParams.get('code') ?? undefined;
  const state = parsed.searchParams.get('state') ?? undefined;
  const error = parsed.searchParams.get('error') ?? undefined;
  return {
    ...(code !== undefined && code !== '' ? { code } : {}),
    ...(state !== undefined && state !== '' ? { state } : {}),
    ...(error !== undefined && error !== '' ? { error } : {}),
  };
}

/** True when the URL looks like an OAuth authorization-code callback. */
export function isAuthCallback(url: string): boolean {
  const params = parseAuthCallback(url);
  return params !== undefined && params.code !== undefined && params.state !== undefined;
}

function readPending(storage: AuthPendingStorage): AuthPending | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(AUTH_PENDING_STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.state !== 'string' || record.state === '') return undefined;
    if (typeof record.verifier !== 'string' || record.verifier === '') return undefined;
    if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return undefined;
    return { state: record.state, verifier: record.verifier, createdAt: record.createdAt };
  } catch {
    return undefined;
  }
}

function removePending(storage: AuthPendingStorage): void {
  try {
    storage.removeItem(AUTH_PENDING_STORAGE_KEY);
  } catch {
    // Clearing is best effort: the verifier is useless once state was checked.
  }
}

function defaultFetchImpl(): AuthFetch | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== 'function') return undefined;
  return candidate as AuthFetch;
}

/**
 * Build the hosted-UI authorize URL and persist `{ state, verifier }`.
 *
 * The caller owns navigation (`location.href = result.url`), which keeps this
 * function testable under Node.
 */
export async function beginAuth(input: BeginAuthInput): Promise<BeginAuthResult> {
  const { authority, clientId, redirectUri } = resolveConfig(input.config);
  const storage = requireStorage(input.storage);
  const random = randomBytesSource(input.randomBytes);

  const state = randomBase64Url(random, 32);
  const verifier = randomBase64Url(random, 32);
  const challenge = await pkceChallenge(verifier);
  const createdAt = input.now ?? Date.now();

  const pending: AuthPending = { state, verifier, createdAt };
  try {
    storage.setItem(AUTH_PENDING_STORAGE_KEY, JSON.stringify(pending));
  } catch {
    throw new SyncAuthError(
      'storage_unavailable',
      'Browser session storage is unavailable, so sign-in cannot be completed.',
    );
  }

  const url = new URL(`${authority}/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  if (redirectUri !== undefined) url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', input.scope ?? DEFAULT_AUTH_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state };
}

/**
 * Validate the callback state and exchange the authorization code for an ID
 * token. The pending entry is consumed before the network call, so a replayed
 * callback cannot reuse the verifier.
 */
export async function completeAuth(input: CompleteAuthInput): Promise<CompleteAuthResult> {
  const { authority, clientId, redirectUri } = resolveConfig(input.config);
  const storage = requireStorage(input.storage);
  const now = input.now ?? Date.now();

  const pending = readPending(storage);
  if (!pending) {
    throw new SyncAuthError(
      'state_missing',
      'No sign-in is pending on this device. Start sign-in again.',
    );
  }
  if (now - pending.createdAt > AUTH_PENDING_TTL_MS) {
    removePending(storage);
    throw new SyncAuthError('state_expired', 'Sign-in took too long. Start it again.');
  }

  const params = parseAuthCallback(input.callbackUrl);
  if (!params || params.code === undefined || params.state === undefined) {
    throw new SyncAuthError('invalid_callback', 'The sign-in callback is incomplete.');
  }
  if (params.state !== pending.state) {
    throw new SyncAuthError('state_mismatch', 'The sign-in callback could not be verified.');
  }

  // Consume the verifier before any network I/O: a failed exchange requires a
  // fresh sign-in, and a replayed URL has nothing left to consume.
  removePending(storage);

  const fetchImpl = input.fetchImpl ?? defaultFetchImpl();
  if (!fetchImpl) {
    throw new SyncAuthError('network_error', 'Network access is unavailable.');
  }

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: params.code,
    code_verifier: pending.verifier,
  });
  if (redirectUri !== undefined) form.set('redirect_uri', redirectUri);
  const body = form.toString();

  let response: AuthFetchResponse;
  try {
    response = await fetchImpl(`${authority}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    });
  } catch {
    throw new SyncAuthError('network_error', 'Could not reach the sign-in service.');
  }

  if (!response || response.ok !== true) {
    throw new SyncAuthError(
      'token_exchange_failed',
      'The sign-in service rejected the authorization code.',
      typeof response?.status === 'number' ? response.status : undefined,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new SyncAuthError('invalid_token_response', 'The sign-in response was not usable.');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new SyncAuthError('invalid_token_response', 'The sign-in response was not usable.');
  }
  const idToken = (data as Record<string, unknown>).id_token;
  if (typeof idToken !== 'string' || idToken === '') {
    throw new SyncAuthError('invalid_token_response', 'The sign-in response had no ID token.');
  }

  return { idToken };
}
