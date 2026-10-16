import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySavedBoardTheme,
  BOARD_THEME_KEY,
  getSavedBoardTheme,
  parseBoardTheme,
  saveBoardTheme,
} from '../src/board-theme.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

function classTarget() {
  const names = new Set<string>();
  return {
    names,
    classList: {
      add: (name: string) => names.add(name),
      remove: (name: string) => names.delete(name),
    },
  };
}

test('board theme validation falls back for missing and unknown values', () => {
  assert.equal(parseBoardTheme('blue'), 'blue');
  assert.equal(parseBoardTheme('unknown'), 'green');
  assert.equal(parseBoardTheme(null), 'green');
});

test('saved preference is read from the namespaced display-only key', () => {
  const storage = memoryStorage({ [BOARD_THEME_KEY]: 'wood' });
  assert.equal(getSavedBoardTheme(storage), 'wood');
  assert.equal(getSavedBoardTheme(memoryStorage({ [BOARD_THEME_KEY]: 'bad' })), 'green');
});

test('boot applies validated class and removes stale theme classes', () => {
  const target = classTarget();
  target.names.add('board-theme-blue');
  const selected = applySavedBoardTheme(target, memoryStorage({ [BOARD_THEME_KEY]: 'slate' }));
  assert.equal(selected, 'slate');
  assert.deepEqual([...target.names], ['board-theme-slate']);
});

test('saving persists a valid choice and applies it without touching other classes', () => {
  const target = classTarget();
  target.names.add('unrelated');
  const storage = memoryStorage();
  assert.equal(saveBoardTheme('blue', target, storage), 'blue');
  assert.equal(storage.values.get(BOARD_THEME_KEY), 'blue');
  assert.ok(target.names.has('board-theme-blue'));
  assert.ok(target.names.has('unrelated'));
  assert.equal(saveBoardTheme('invalid', target, storage), 'green');
  assert.equal(storage.values.get(BOARD_THEME_KEY), 'green');
});

test('blocked storage does not prevent applying the selected theme', () => {
  const storage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  const target = classTarget();
  assert.equal(getSavedBoardTheme(storage), 'green');
  assert.equal(saveBoardTheme('wood', target, storage), 'wood');
  assert.ok(target.names.has('board-theme-wood'));
});
