import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import worker from '../src/index.ts';
import {
  DEFAULT_CONTENT_MANIFEST_MAX_AGE,
  loadConfig,
} from '../src/config.ts';
import { InMemoryContentSource } from '../src/content.ts';
import { makeHarness, request } from './harness.ts';

const BASE = 'https://cdn.example.invalid/chessengram/packs';
const VERSION = '0123456789abcdef';

interface PackEntry {
  packId: string;
  version: string;
  sha256: string;
  bytes: number;
  puzzleCount: number;
  license: string;
  url?: string;
}

interface Manifest {
  schema_version: number;
  packs: PackEntry[];
}

const PACK: PackEntry = {
  packId: 'pack-a',
  version: VERSION,
  sha256: 'a'.repeat(64),
  bytes: 1234,
  puzzleCount: 2,
  license: 'CC0-1.0',
};

const MANIFEST: Manifest = { schema_version: 1, packs: [PACK] };

test('content manifest is served without authentication', async () => {
  // No verifier and no session: a signed-out client must still get the manifest.
  const { handler } = makeHarness({ verifier: undefined, content: new InMemoryContentSource(MANIFEST) });
  const response = await handler(request('GET', '/content/manifest'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), MANIFEST);
});

test('content manifest is publicly cacheable and configurable', async () => {
  const { handler } = makeHarness({ content: new InMemoryContentSource(MANIFEST) });
  const response = await handler(request('GET', '/content/manifest'));
  assert.equal(response.headers.get('Cache-Control'), `public, max-age=${DEFAULT_CONTENT_MANIFEST_MAX_AGE}`);

  const custom = makeHarness({
    content: new InMemoryContentSource(MANIFEST),
    contentManifestMaxAge: 60,
  });
  const customResponse = await custom.handler(request('GET', '/content/manifest'));
  assert.equal(customResponse.headers.get('Cache-Control'), 'public, max-age=60');
});

test('content manifest follows the shared CORS policy', async () => {
  const { handler } = makeHarness({ content: new InMemoryContentSource(MANIFEST) });

  const allowed = await handler(
    request('GET', '/content/manifest', { headers: { Origin: 'https://app.example' } }),
  );
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://app.example');

  const denied = await handler(
    request('GET', '/content/manifest', { headers: { Origin: 'https://evil.example' } }),
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
});

test('content manifest fails closed when no content is configured', async () => {
  const { handler } = makeHarness();
  const response = await handler(request('GET', '/content/manifest'));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'content_not_configured',
    message: 'content distribution is not configured: no content source is available',
  });
});

test('CONTENT_BASE_URL fills pack urls the manifest omits', async () => {
  const derived = makeHarness({
    content: new InMemoryContentSource(MANIFEST),
    contentBaseUrl: `${BASE}/`, // trailing slash is normalized away
  });
  const derivedResponse = await derived.handler(request('GET', '/content/manifest'));
  const derivedBody = (await derivedResponse.json()) as Manifest;
  assert.equal(derivedBody.packs[0]?.url, `${BASE}/${PACK.packId}/${VERSION}/pack.jsonl`);

  // An embedded absolute url wins over the configured base.
  const embedded: Manifest = { schema_version: 1, packs: [{ ...PACK, url: 'https://mirror.example/pack.jsonl' }] };
  const withEmbedded = makeHarness({
    content: new InMemoryContentSource(embedded),
    contentBaseUrl: BASE,
  });
  const embeddedBody = (await (await withEmbedded.handler(request('GET', '/content/manifest'))).json()) as Manifest;
  assert.equal(embeddedBody.packs[0]?.url, 'https://mirror.example/pack.jsonl');
});

test('pack bytes are never streamed through the worker', async () => {
  const { handler } = makeHarness({ content: new InMemoryContentSource(MANIFEST) });

  for (const path of [
    '/content/pack-a/pack.jsonl',
    `/content/${PACK.packId}/${VERSION}/pack.jsonl`,
    '/content/lichess-bands-v1/pack.jsonl',
  ]) {
    const response = await handler(request('GET', path));
    assert.equal(response.status, 404);
  }

  const manifestResponse = await handler(request('GET', '/content/manifest'));
  assert.match(manifestResponse.headers.get('Content-Type') ?? '', /application\/json/);
  // The response is the small manifest, not a pack payload.
  assert.ok((await manifestResponse.text()).length < 4096);
});

test('content manifest only answers GET', async () => {
  const { handler } = makeHarness({ content: new InMemoryContentSource(MANIFEST) });
  const response = await handler(request('POST', '/content/manifest'));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET');
});

test('health advertises the content capability', async () => {
  const unconfigured = await makeHarness().handler(request('GET', '/health'));
  assert.equal(((await unconfigured.json()) as { content: string }).content, 'unconfigured');

  const configured = await makeHarness({
    content: new InMemoryContentSource(MANIFEST),
  }).handler(request('GET', '/health'));
  assert.equal(((await configured.json()) as { content: string }).content, 'configured');
});

test('default worker export wires content from CONTENT_MANIFEST and CONTENT_BASE_URL', async () => {
  const env = { CONTENT_MANIFEST: JSON.stringify(MANIFEST), CONTENT_BASE_URL: BASE };

  const health = await worker.fetch(request('GET', '/health'), env);
  assert.equal(((await health.json()) as { content: string }).content, 'configured');

  const response = await worker.fetch(request('GET', '/content/manifest'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), `public, max-age=${DEFAULT_CONTENT_MANIFEST_MAX_AGE}`);
  const body = (await response.json()) as Manifest;
  assert.equal(body.packs[0]?.url, `${BASE}/${PACK.packId}/${VERSION}/pack.jsonl`);

  // A malformed build-time manifest stays unconfigured (fail closed).
  const malformed = await worker.fetch(request('GET', '/content/manifest'), { CONTENT_MANIFEST: 'not json' });
  assert.equal(malformed.status, 503);
});

test('loadConfig parses content settings and rejects an invalid max age', () => {
  const config = loadConfig({
    CONTENT_BASE_URL: '  https://cdn.example.invalid/chessengram/packs  ',
    CONTENT_MANIFEST_MAX_AGE: '600',
  });
  assert.equal(config.contentBaseUrl, 'https://cdn.example.invalid/chessengram/packs');
  assert.equal(config.contentManifestMaxAge, 600);

  const defaults = loadConfig({});
  assert.equal(defaults.contentBaseUrl, undefined);
  assert.equal(defaults.contentManifestMaxAge, DEFAULT_CONTENT_MANIFEST_MAX_AGE);

  const invalid = loadConfig({ CONTENT_MANIFEST_MAX_AGE: 'nope' });
  assert.equal(invalid.configured, false);
  assert.equal(invalid.contentManifestMaxAge, DEFAULT_CONTENT_MANIFEST_MAX_AGE);
  if (!invalid.configured) assert.match(invalid.reason, /CONTENT_MANIFEST_MAX_AGE must be a positive integer/);
});
