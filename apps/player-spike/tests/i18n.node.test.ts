import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { getLocale, registerLocale, setLocale, t } from '../src/i18n.ts';

test('english is the default locale with interpolation', () => {
  setLocale('en');
  assert.equal(getLocale(), 'en');
  assert.equal(t('app.title'), 'ChessReps Player');
  assert.equal(t('status.yourTurn', { color: t('color.white') }), 'Your turn (white) — solve the puzzle');
});

test('unknown keys fall back to the key itself', () => {
  assert.equal(t('does.not.exist'), 'does.not.exist');
});

test('registering a partial locale keeps english fallbacks', () => {
  registerLocale('xx', { 'app.title': 'Titel' });
  setLocale('xx');
  assert.equal(t('app.title'), 'Titel');
  assert.equal(t('next.label'), 'Next puzzle');
  setLocale('en');
});

test('setLocale ignores unknown locales', () => {
  setLocale('en');
  assert.equal(setLocale('zz'), 'en');
});
