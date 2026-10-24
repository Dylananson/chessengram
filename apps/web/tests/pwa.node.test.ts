/**
 * APP-001 PWA helpers. Under Node there is no Cache/Storage API, so these tests
 * lock the guarded behaviour (never throw, report "not ready") plus the pure
 * formatting and the required-asset list the offline promise depends on.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  REQUIRED_OFFLINE_ASSETS,
  canInstall,
  formatBytes,
  isInstalled,
  isIos,
  pwaSnapshot,
  promptInstall,
} from '../src/pwa.ts';

test('the offline promise covers the shell, icons and all bundled packs', () => {
  assert.ok(REQUIRED_OFFLINE_ASSETS.includes('/index.html'));
  assert.ok(REQUIRED_OFFLINE_ASSETS.includes('/manifest.webmanifest'));
  assert.ok(REQUIRED_OFFLINE_ASSETS.includes('/data/puzzles/lichess-900-1099-v1/pack.jsonl'));
  assert.ok(REQUIRED_OFFLINE_ASSETS.includes('/data/puzzles/lichess-bands-v1/pack.jsonl'));
  assert.ok(REQUIRED_OFFLINE_ASSETS.includes('/data/puzzles/lichess-bands-v1/bands.json'));
  assert.ok(REQUIRED_OFFLINE_ASSETS.includes('/data/puzzles/lichess-custom-v1/pack.jsonl'));
  assert.ok(REQUIRED_OFFLINE_ASSETS.includes('/data/puzzles/lichess-custom-v1/collections.json'));
  assert.ok(REQUIRED_OFFLINE_ASSETS.some((asset) => asset.startsWith('/icons/')));
});

test('without a browser the helpers stay safe and report not ready', async () => {
  assert.equal(isInstalled(), false);
  assert.equal(isIos(), false);
  assert.equal(canInstall(), false);
  assert.equal(await promptInstall(), false);

  const snapshot = await pwaSnapshot();
  assert.equal(snapshot.installed, false);
  assert.equal(snapshot.canInstall, false);
  assert.equal(snapshot.offlineReady, false);
  assert.deepEqual(snapshot.missing, [...REQUIRED_OFFLINE_ASSETS]);
});

test('byte formatting is compact and never throws on missing data', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(820 * 1024), '820 KB');
  assert.equal(formatBytes(5_242_880), '5.0 MB');
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(Number.NaN), '—');
  assert.equal(formatBytes(-1), '—');
});
