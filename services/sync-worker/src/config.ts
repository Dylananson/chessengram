/**
 * Environment configuration.
 *
 * Parses and validates the Workers `env` object — which is a plain string
 * bag under `wrangler dev`/Node and carries bindings (objects) in Workers.
 * Nothing here is hard-coded to an account: with the environment unset the
 * result says `configured: false` and explains why, and the HTTP layer refuses
 * every authenticated route.
 *
 * ONL-006 owns the Cognito verification logic; this file owns the parsing.
 */

import type { D1Like } from './store.ts';

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  /** Optional explicit JWKS URL; ONL-006 derives it from region/pool otherwise. */
  jwksUrl?: string;
}

interface ConfigBase {
  maxBatch: number;
  maxPushBytes: number;
  /** BFF session lifetime in seconds (cookie `Max-Age`). */
  sessionTtlSeconds: number;
  /** How long a fetched Cognito JWKS is trusted before refetching. */
  jwksCacheSeconds: number;
  /** Hard cap on an ID-token string before it is parsed. */
  maxIdTokenBytes: number;
  allowedOrigins: string[];
  allowDevAuth: boolean;
  /** Public pack CDN base; used to build pack urls the manifest omits. */
  contentBaseUrl?: string;
  /** `Cache-Control: max-age` for `/content/manifest`. */
  contentManifestMaxAge: number;
  /** Present only when a D1-like `SYNC_DB` binding was supplied. */
  db?: D1Like;
  /** Present only when the Cognito variables are complete. */
  cognito?: CognitoConfig;
}

export interface ReadyConfig extends ConfigBase {
  configured: true;
  auth: 'cognito' | 'dev';
}

export interface UnconfiguredConfig extends ConfigBase {
  configured: false;
  auth: 'unconfigured';
  reason: string;
}

export type LoadConfigResult = ReadyConfig | UnconfiguredConfig;

export type EnvLike = Record<string, unknown>;

export const DEFAULT_MAX_BATCH = 200;
export const DEFAULT_MAX_PUSH_BYTES = 1_000_000;
/** 30 days. */
export const DEFAULT_SESSION_TTL_SECONDS = 2_592_000;
/** 1 hour. */
export const DEFAULT_JWKS_CACHE_SECONDS = 3_600;
/** 8 KiB — a Cognito ID token with a few groups is far smaller. */
export const DEFAULT_MAX_ID_TOKEN_BYTES = 8_192;
/** 5 minutes — the content manifest is small and changes only on a new pack. */
export const DEFAULT_CONTENT_MANIFEST_MAX_AGE = 300;

export const UNCONFIGURED_REASON =
  'sync is not configured: set COGNITO_REGION, COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID ' +
  '(optionally COGNITO_JWKS_URL), or set SYNC_ALLOW_DEV_AUTH=true for local development';

function readString(env: EnvLike, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Truthy env switch (`1`/`true`/`yes`/`on`, case-insensitive). */
export function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.toLowerCase());
}

/** Comma-separated origin list → trimmed, non-empty entries (`*` allowed). */
export function parseOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function readDbBinding(env: EnvLike): D1Like | undefined {
  const value = env.SYNC_DB;
  if (value === null || typeof value !== 'object') return undefined;
  if (typeof (value as { prepare?: unknown }).prepare !== 'function') return undefined;
  return value as D1Like;
}

function parseLimit(raw: string | undefined, fallback: number, name: string, problems: string[]): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  problems.push(`${name} must be a positive integer (got "${raw}")`);
  return fallback;
}

function readCognito(env: EnvLike): { config?: CognitoConfig; problems: string[] } {
  const region = readString(env, 'COGNITO_REGION');
  const userPoolId = readString(env, 'COGNITO_USER_POOL_ID');
  const clientId = readString(env, 'COGNITO_CLIENT_ID');
  const jwksUrl = readString(env, 'COGNITO_JWKS_URL');

  if (region && userPoolId && clientId) {
    const config: CognitoConfig = { region, userPoolId, clientId };
    if (jwksUrl !== undefined) config.jwksUrl = jwksUrl;
    return { config, problems: [] };
  }

  const missing: string[] = [];
  if (region === undefined) missing.push('COGNITO_REGION');
  if (userPoolId === undefined) missing.push('COGNITO_USER_POOL_ID');
  if (clientId === undefined) missing.push('COGNITO_CLIENT_ID');

  const anyPresent = region !== undefined || userPoolId !== undefined || clientId !== undefined || jwksUrl !== undefined;
  if (anyPresent) {
    return { problems: [`incomplete Cognito configuration: missing ${missing.join(', ')}`] };
  }
  return { problems: [] };
}

/**
 * Load configuration. Precedence for the active auth mode:
 *   1. `SYNC_ALLOW_DEV_AUTH` truthy → `dev` (explicit local override);
 *   2. complete Cognito vars      → `cognito`;
 *   3. otherwise                  → `{ configured: false, reason }`.
 *
 * Invalid limits (or partially-set Cognito) make the worker unconfigured
 * rather than silently guessing. There is no server-held key material any more,
 * so a configured instance needs no extra secret.
 */
export function loadConfig(env: EnvLike = {}): LoadConfigResult {
  const allowDevAuth = isTruthy(readString(env, 'SYNC_ALLOW_DEV_AUTH'));
  const allowedOrigins = parseOrigins(readString(env, 'ALLOWED_ORIGINS'));
  const db = readDbBinding(env);

  const problems: string[] = [];
  const maxBatch = parseLimit(readString(env, 'MAX_BATCH'), DEFAULT_MAX_BATCH, 'MAX_BATCH', problems);
  const maxPushBytes = parseLimit(
    readString(env, 'MAX_PUSH_BYTES'),
    DEFAULT_MAX_PUSH_BYTES,
    'MAX_PUSH_BYTES',
    problems,
  );
  const sessionTtlSeconds = parseLimit(
    readString(env, 'SESSION_TTL_SECONDS'),
    DEFAULT_SESSION_TTL_SECONDS,
    'SESSION_TTL_SECONDS',
    problems,
  );
  const jwksCacheSeconds = parseLimit(
    readString(env, 'JWKS_CACHE_SECONDS'),
    DEFAULT_JWKS_CACHE_SECONDS,
    'JWKS_CACHE_SECONDS',
    problems,
  );
  const maxIdTokenBytes = parseLimit(
    readString(env, 'MAX_ID_TOKEN_BYTES'),
    DEFAULT_MAX_ID_TOKEN_BYTES,
    'MAX_ID_TOKEN_BYTES',
    problems,
  );
  const contentBaseUrl = readString(env, 'CONTENT_BASE_URL');
  const contentManifestMaxAge = parseLimit(
    readString(env, 'CONTENT_MANIFEST_MAX_AGE'),
    DEFAULT_CONTENT_MANIFEST_MAX_AGE,
    'CONTENT_MANIFEST_MAX_AGE',
    problems,
  );

  const cognito = readCognito(env);
  problems.push(...cognito.problems);

  const base: ConfigBase = {
    maxBatch,
    maxPushBytes,
    sessionTtlSeconds,
    jwksCacheSeconds,
    maxIdTokenBytes,
    allowedOrigins,
    allowDevAuth,
    contentManifestMaxAge,
  };
  if (contentBaseUrl !== undefined) base.contentBaseUrl = contentBaseUrl;
  if (db !== undefined) base.db = db;
  if (cognito.config !== undefined) base.cognito = cognito.config;

  if (problems.length > 0) {
    return { configured: false, auth: 'unconfigured', reason: problems.join('; '), ...base };
  }

  // Which mode would be selected.
  const mode: 'dev' | 'cognito' | undefined = allowDevAuth
    ? 'dev'
    : cognito.config !== undefined
      ? 'cognito'
      : undefined;
  if (mode === undefined) {
    return { configured: false, auth: 'unconfigured', reason: UNCONFIGURED_REASON, ...base };
  }

  if (mode === 'dev') {
    return { configured: true, auth: 'dev', ...base };
  }
  return { configured: true, auth: 'cognito', ...base };
}
