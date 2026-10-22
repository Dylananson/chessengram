/**
 * ONL-009a — browser-side HTTP client for the ChessEngram sync worker.
 *
 * Implements the frozen {@link SyncApiClient} seam (`./types.ts`) on top of
 * `fetch`. The worker contract lives in `services/sync-worker/src/index.ts`.
 *
 * Design rules baked in here:
 * - **No retries.** Retry/backoff belongs to the caller (ONL-009b bootstrap),
 *   so `push` and every other call attempt the network exactly once.
 * - **No storage.** Session cookies are handled by the browser via
 *   `credentials: 'include'`; this module never reads or writes
 *   `localStorage`/IndexedDB and never persists a token.
 * - **No logging.** The base URL and request bodies are never logged (the
 *   the wire carries sync records that only this user can authorize).
 * - **Server-blind payloads.** `push` re-serializes each envelope from the
 *   exact wire fields, so a stray plaintext key (`startedAt`, `puzzleId`,
 *   `timing`, …) on an envelope object can never reach the network.
 * - Cookie-authenticated mutations must send `Content-Type: application/json`
 *   (the worker's CSRF check) — every POST/DELETE does.
 */

import type {
  SyncApiClient,
  SyncPushRequest,
  SyncPushResponse,
  SyncRecordEnvelope,
} from './types.ts';

/** Default request timeout (ms). */
export const DEFAULT_SYNC_TIMEOUT_MS = 15_000;

/** Upper bound on the raw response body kept on a {@link SyncHttpError}. */
export const MAX_ERROR_BODY_CHARS = 2048;

/** The `fetch` shape this client needs; injectable so tests hit no network. */
export type SyncFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Injectable timer pair so tests can drive the timeout deterministically. */
export interface SyncClientTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Options for {@link createSyncApiClient}. */
export interface SyncApiClientOptions {
  /** Worker base URL, e.g. `https://sync.example.com`. Trailing `/` is tolerated. */
  baseUrl: string;
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  fetchImpl?: SyncFetch;
  /** Credentials mode; defaults to `'include'` (the BFF session cookie). */
  credentials?: RequestCredentials;
  /** Abort a request after this many ms; defaults to {@link DEFAULT_SYNC_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Timer implementation; defaults to `globalThis.setTimeout`/`clearTimeout`. */
  timers?: SyncClientTimers;
}

export interface SyncHttpErrorInit {
  /** HTTP status, or `0` when there was no HTTP response (network/timeout). */
  status: number;
  /** Normalized machine code (see {@link createSyncApiClient}). */
  code: string;
  message: string;
  /** Raw response body, bounded to {@link MAX_ERROR_BODY_CHARS}. */
  body?: string;
  /** True for 429, 5xx and transport/timeout failures. */
  retryable?: boolean;
  /** The server's own `error`/`code` value, when the body carried one. */
  serverCode?: string;
  /** True when the failure was the client-side timeout firing. */
  timeout?: boolean;
}

/**
 * Typed transport failure. `code` is the stable, client-facing machine code;
 * `serverCode` keeps the raw value from the worker's JSON body when present.
 */
export class SyncHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: string;
  readonly retryable: boolean;
  readonly serverCode: string | undefined;
  readonly timeout: boolean;

  constructor(init: SyncHttpErrorInit) {
    super(init.message);
    this.name = 'SyncHttpError';
    this.status = init.status;
    this.code = init.code;
    this.body = init.body ?? '';
    this.retryable = init.retryable ?? false;
    this.serverCode = init.serverCode;
    this.timeout = init.timeout ?? false;
  }
}

/**
 * True when a failed call is worth retrying: transport failures, timeouts,
 * `429` and `5xx`. Every other `4xx` is terminal.
 */
export function isRetryable(error: unknown): boolean {
  return error instanceof SyncHttpError && error.retryable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drop trailing slashes so `base + path` never doubles up. Never logged. */
function normalizeBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== 'string') throw new TypeError('sync baseUrl must be a string');
  return baseUrl.trim().replace(/\/+$/, '');
}

function boundBody(text: string): string {
  return text.length > MAX_ERROR_BODY_CHARS ? text.slice(0, MAX_ERROR_BODY_CHARS) : text;
}

/** Pull the worker's machine code (`{ error }` or `{ code }`) out of a body. */
function parseServerCode(text: string): string | undefined {
  if (text === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed.error === 'string' && parsed.error !== '') return parsed.error;
    if (typeof parsed.code === 'string' && parsed.code !== '') return parsed.code;
    return undefined;
  } catch {
    return undefined;
  }
}

/** 401/403 are normalized; everything else keeps the server's code. */
function httpErrorCode(status: number, serverCode: string | undefined): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'csrf_or_forbidden';
  return serverCode ?? `http_${status}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function httpFailure(status: number, text: string): SyncHttpError {
  const serverCode = parseServerCode(text);
  const code = httpErrorCode(status, serverCode);
  return new SyncHttpError({
    status,
    code,
    serverCode,
    body: boundBody(text),
    retryable: isRetryableStatus(status),
    message: `sync request failed: HTTP ${status}${serverCode === undefined ? '' : ` (${serverCode})`}`,
  });
}

function transportFailure(timedOut: boolean, cause?: unknown): SyncHttpError {
  const detail = cause instanceof Error && cause.message !== '' ? `: ${cause.message}` : '';
  return new SyncHttpError({
    status: 0,
    code: 'network',
    message: timedOut ? 'sync request timed out' : `sync request failed (network)${detail}`,
    retryable: true,
    timeout: timedOut,
  });
}

function invalidResponse(text: string, reason: string): SyncHttpError {
  return new SyncHttpError({
    status: 0,
    code: 'invalid_response',
    message: `sync response was not usable: ${reason}`,
    body: boundBody(text),
    retryable: false,
  });
}

/**
 * Exact wire fields of a pushed envelope (`seq` is server-assigned and must not
 * be sent). Rebuilding from this list keeps the wire shape tight: anything a
 * caller attaches by mistake is dropped rather than forwarded.
 */
const WIRE_ENVELOPE_FIELDS = [
  'v',
  'type',
  'recordId',
  'dedupeKey',
  'deviceId',
  'payload',
  'sig',
  'updatedAt',
  'rev',
] as const;

/** Copy only the wire fields, dropping anything a caller added by mistake. */
function toWireEnvelope(envelope: SyncRecordEnvelope): Record<string, unknown> {
  const source = envelope as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of WIRE_ENVELOPE_FIELDS) out[field] = source[field];
  return out;
}

const defaultTimers: SyncClientTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

function defaultFetch(): SyncFetch {
  return (input, init) => {
    const impl = globalThis.fetch;
    if (typeof impl !== 'function') throw new TypeError('global fetch is unavailable');
    return impl(input, init);
  };
}

/** Reject as soon as `signal` aborts, even if the underlying fetch ignores it. */
function raceAbort(promise: Promise<Response>, signal: AbortSignal): Promise<Response> {
  // The fetch may settle after the abort race won; swallow the orphan rejection.
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<Response>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Build a {@link SyncApiClient} for one worker base URL.
 *
 * Error mapping:
 * - `401` → `unauthorized` (`getSession` returns `undefined` instead)
 * - `403` → `csrf_or_forbidden`
 * - `422` → the worker's own code (`invalid_signature`, `unregistered_device`, …)
 * - `429`/`5xx` → the worker's code or `http_<status>`, `retryable: true`
 * - transport failure / abort / timeout → code `network`, `status: 0`
 */
export function createSyncApiClient(options: SyncApiClientOptions): SyncApiClient {
  const base = normalizeBaseUrl(options.baseUrl);
  const credentials = options.credentials ?? 'include';
  const timeoutMs = options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const timers = options.timers ?? defaultTimers;
  const fetchImpl = options.fetchImpl ?? defaultFetch();

  interface RawResult {
    status: number;
    text: string;
  }

  /** One attempt, no retry. `body === undefined` sends no request body. */
  async function send(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<RawResult> {
    const headers: Record<string, string> = { ...extraHeaders };
    // CSRF: the worker requires JSON content type on cookie-authenticated
    // mutations (POST and DELETE, including bodyless ones).
    if (method !== 'GET') headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const useTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    let timedOut = false;
    const handle = useTimeout
      ? timers.setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

    const init: RequestInit = {
      method,
      headers,
      credentials,
      signal: controller.signal,
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await raceAbort(fetchImpl(`${base}${path}`, init), controller.signal);
    } catch (error) {
      throw transportFailure(timedOut, error);
    } finally {
      if (handle !== undefined) timers.clearTimeout(handle);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw transportFailure(false, error);
    }

    if (!response.ok) throw httpFailure(response.status, text);
    return { status: response.status, text };
  }

  function parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw invalidResponse(text, 'body is not valid JSON');
    }
  }

  function parseSession(text: string): { userId: string; expiresAt: number } {
    const parsed = parseJson(text);
    if (!isRecord(parsed) || typeof parsed.userId !== 'string' || typeof parsed.expiresAt !== 'number') {
      throw invalidResponse(text, 'missing userId/expiresAt');
    }
    return { userId: parsed.userId, expiresAt: parsed.expiresAt };
  }

  return {
    async exchangeSession(idToken: string): Promise<{ userId: string; expiresAt: number }> {
      const result = await send('POST', '/auth/session', undefined, {
        Authorization: `Bearer ${idToken}`,
      });
      return parseSession(result.text);
    },

    async getSession(): Promise<{ userId: string; expiresAt: number } | undefined> {
      try {
        const result = await send('GET', '/auth/session');
        return parseSession(result.text);
      } catch (error) {
        // No session is an expected state, not a failure.
        if (error instanceof SyncHttpError && error.status === 401) return undefined;
        throw error;
      }
    },

    async signOut(): Promise<void> {
      await send('POST', '/auth/signout');
    },


    async registerDevice(input: {
      deviceId: string;
      publicKeyJwk: JsonWebKey;
    }): Promise<{ thumbprint: string }> {
      const result = await send('POST', '/devices', {
        deviceId: input.deviceId,
        publicKeyJwk: input.publicKeyJwk,
      });
      const parsed = parseJson(result.text);
      if (!isRecord(parsed) || typeof parsed.thumbprint !== 'string') {
        throw invalidResponse(result.text, 'missing thumbprint');
      }
      return { thumbprint: parsed.thumbprint };
    },

    async listDevices(): Promise<
      Array<{ deviceId: string; addedAt: number; revokedAt?: number; thumbprint?: string }>
    > {
      const result = await send('GET', '/devices');
      const parsed = parseJson(result.text);
      if (!isRecord(parsed) || !Array.isArray(parsed.devices)) {
        throw invalidResponse(result.text, 'missing devices array');
      }
      return parsed.devices as Array<{
        deviceId: string;
        addedAt: number;
        revokedAt?: number;
        thumbprint?: string;
      }>;
    },

    async revokeDevice(deviceId: string): Promise<void> {
      await send('DELETE', `/devices/${encodeURIComponent(deviceId)}`);
    },

    async push(request: SyncPushRequest): Promise<SyncPushResponse> {
      const body = {
        since: request.since,
        push: request.push.map(toWireEnvelope),
      };
      const result = await send('POST', '/sync', body);
      return parseJson(result.text) as SyncPushResponse;
    },

    async deleteAccount(): Promise<void> {
      await send('DELETE', '/sync/account');
    },
  };
}
