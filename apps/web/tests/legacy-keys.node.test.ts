/**
 * REN-001b — the renamed `localStorage` keys must not cost existing installs
 * their preferences. (The IndexedDB database name is intentionally untouched.)
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  RENAMED_STORAGE_KEYS,
  migrateLegacyStorageKeys,
  type StorageLike,
} from '../src/legacy-keys.ts';

function storageWith(entries: Record<string, string>): StorageLike & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

test('a legacy preference is carried over and the old key removed', () => {
  const storage = storageWith({ 'chessreps.locale': 'de', 'chessreps.boardTheme': 'brown' });
  migrateLegacyStorageKeys(storage);
  assert.deepEqual(storage.dump(), { 'chessengram.locale': 'de', 'chessengram.boardTheme': 'brown' });
});

test('an existing new-format value wins over the legacy one', () => {
  const storage = storageWith({ 'chessreps.locale': 'de', 'chessengram.locale': 'fr' });
  migrateLegacyStorageKeys(storage);
  assert.equal(storage.dump()['chessengram.locale'], 'fr');
});

test('nothing to migrate is a no-op, and missing storage never throws', () => {
  const empty = storageWith({});
  migrateLegacyStorageKeys(empty);
  assert.deepEqual(empty.dump(), {});
  migrateLegacyStorageKeys(undefined);
  migrateLegacyStorageKeys({
    getItem: () => {
      throw new Error('private mode');
    },
    setItem: () => {},
    removeItem: () => {},
  });
});

test('the map only contains renamed keys (a guard against accidental renames)', () => {
  for (const [oldKey, newKey] of Object.entries(RENAMED_STORAGE_KEYS)) {
    assert.notEqual(oldKey, newKey);
    assert.match(newKey, /^chessengram\./);
  }
});
