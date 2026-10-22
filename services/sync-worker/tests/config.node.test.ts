import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEFAULT_JWKS_CACHE_SECONDS,
  DEFAULT_MAX_BATCH,
  DEFAULT_MAX_ID_TOKEN_BYTES,
  DEFAULT_MAX_PUSH_BYTES,
  DEFAULT_SESSION_TTL_SECONDS,
  UNCONFIGURED_REASON,
  loadConfig,
  parseOrigins,
} from '../src/config.ts';

test('loadConfig reports unconfigured when nothing is set', () => {
  const config = loadConfig({});
  assert.equal(config.configured, false);
  assert.equal(config.auth, 'unconfigured');
  assert.equal(config.maxBatch, DEFAULT_MAX_BATCH);
  assert.equal(config.maxPushBytes, DEFAULT_MAX_PUSH_BYTES);
  assert.deepEqual(config.allowedOrigins, []);
  if (!config.configured) assert.equal(config.reason, UNCONFIGURED_REASON);
});

test('loadConfig enables dev auth with the switch', () => {
  const config = loadConfig({ SYNC_ALLOW_DEV_AUTH: 'TRUE' });
  assert.equal(config.configured, true);
  assert.equal(config.auth, 'dev');
  assert.equal(config.allowDevAuth, true);
});

test('loadConfig parses a complete Cognito configuration', () => {
  const config = loadConfig({
    COGNITO_REGION: 'eu-west-1',
    COGNITO_USER_POOL_ID: 'eu-west-1_ABC123',
    COGNITO_CLIENT_ID: 'client-abc',
    COGNITO_JWKS_URL: 'https://example.invalid/.well-known/jwks.json',
  });
  assert.equal(config.configured, true);
  assert.equal(config.auth, 'cognito');
  assert.deepEqual(config.cognito, {
    region: 'eu-west-1',
    userPoolId: 'eu-west-1_ABC123',
    clientId: 'client-abc',
    jwksUrl: 'https://example.invalid/.well-known/jwks.json',
  });
});

test('loadConfig fails closed on partial Cognito configuration', () => {
  const config = loadConfig({ COGNITO_REGION: 'eu-west-1' });
  assert.equal(config.configured, false);
  assert.equal(config.auth, 'unconfigured');
  if (!config.configured) assert.match(config.reason, /incomplete Cognito configuration.*COGNITO_USER_POOL_ID/);
});

test('dev auth takes precedence over a complete Cognito configuration', () => {
  const config = loadConfig({
    SYNC_ALLOW_DEV_AUTH: '1',
    COGNITO_REGION: 'eu-west-1',
    COGNITO_USER_POOL_ID: 'eu-west-1_ABC123',
    COGNITO_CLIENT_ID: 'client-abc',
  });
  assert.equal(config.configured, true);
  assert.equal(config.auth, 'dev');
  assert.ok(config.cognito);
});

test('a configured instance requires no server-held key material', () => {
  const cognito = {
    COGNITO_REGION: 'eu-west-1',
    COGNITO_USER_POOL_ID: 'eu-west-1_ABC123',
    COGNITO_CLIENT_ID: 'client-abc',
  };

  // Plaintext envelopes: no KEK/secret is required to be configured.
  const configured = loadConfig({ ...cognito });
  assert.equal(configured.configured, true);
  assert.equal(configured.auth, 'cognito');
  assert.equal('keyWrapKey' in configured, false);

  // Dev-auth is likewise secret-free (only the fixed, non-secret dev token).
  const dev = loadConfig({ SYNC_ALLOW_DEV_AUTH: 'true' });
  assert.equal(dev.configured, true);
  assert.equal(dev.auth, 'dev');
});

test('loadConfig parses limits and rejects invalid values', () => {
  const ok = loadConfig({ MAX_BATCH: '5', MAX_PUSH_BYTES: '2048' });
  assert.equal(ok.maxBatch, 5);
  assert.equal(ok.maxPushBytes, 2048);

  const bad = loadConfig({ MAX_BATCH: '0' });
  assert.equal(bad.configured, false);
  if (!bad.configured) assert.match(bad.reason, /MAX_BATCH must be a positive integer/);
  assert.equal(bad.maxBatch, DEFAULT_MAX_BATCH);

  const notANumber = loadConfig({ MAX_PUSH_BYTES: 'lots' });
  assert.equal(notANumber.configured, false);
  if (!notANumber.configured) assert.match(notANumber.reason, /MAX_PUSH_BYTES must be a positive integer/);
});

test('loadConfig applies auth/session defaults and parses overrides', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.sessionTtlSeconds, DEFAULT_SESSION_TTL_SECONDS);
  assert.equal(defaults.jwksCacheSeconds, DEFAULT_JWKS_CACHE_SECONDS);
  assert.equal(defaults.maxIdTokenBytes, DEFAULT_MAX_ID_TOKEN_BYTES);

  const overridden = loadConfig({
    SESSION_TTL_SECONDS: '60',
    JWKS_CACHE_SECONDS: '120',
    MAX_ID_TOKEN_BYTES: '4096',
  });
  assert.equal(overridden.sessionTtlSeconds, 60);
  assert.equal(overridden.jwksCacheSeconds, 120);
  assert.equal(overridden.maxIdTokenBytes, 4096);

  const invalid = loadConfig({ SESSION_TTL_SECONDS: '0', JWKS_CACHE_SECONDS: 'nope', MAX_ID_TOKEN_BYTES: '-1' });
  assert.equal(invalid.configured, false);
  if (!invalid.configured) {
    assert.match(invalid.reason, /SESSION_TTL_SECONDS must be a positive integer/);
    assert.match(invalid.reason, /JWKS_CACHE_SECONDS must be a positive integer/);
    assert.match(invalid.reason, /MAX_ID_TOKEN_BYTES must be a positive integer/);
  }
});

test('loadConfig parses and trims ALLOWED_ORIGINS', () => {
  const config = loadConfig({ ALLOWED_ORIGINS: ' https://a.example , http://localhost:5173 ,, ' });
  assert.deepEqual(config.allowedOrigins, ['https://a.example', 'http://localhost:5173']);
  assert.deepEqual(parseOrigins(undefined), []);
  assert.deepEqual(parseOrigins('*'), ['*']);
});

test('loadConfig surfaces a D1-like binding and ignores malformed ones', () => {
  const binding = { prepare: () => undefined };
  const withBinding = loadConfig({ SYNC_DB: binding });
  assert.equal(withBinding.db, binding);

  const withoutBinding = loadConfig({ SYNC_DB: 'not-a-binding' });
  assert.equal(withoutBinding.db, undefined);
});
