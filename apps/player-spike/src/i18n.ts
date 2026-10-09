/**
 * Lightweight i18n (no framework).
 *
 * English is the default and complete locale. Add a locale by calling
 * `registerLocale('de', { 'app.title': '...' })` (typically from a new module
 * imported in main.ts). Missing keys fall back to English, then to the key
 * itself, so a partial locale is safe to ship.
 *
 * Locale selection order: explicit `setLocale` > `?lang=` URL parameter >
 * persisted `localStorage['chessreps.locale']` > browser language > English.
 */

export type LocaleMessages = Record<string, string>;

const en: LocaleMessages = {
  'app.title': 'ChessReps Player',
  'app.subtitle': 'Spaced-repetition puzzle training (local spike)',
  'puzzle.info': 'Puzzle',
  'puzzle.id': 'ID',
  'puzzle.rating': 'Rating',
  'puzzle.themes': 'Themes',
  'puzzle.solver': 'Solver',
  'puzzle.none': '—',
  'status.title': 'Status',
  'status.loading': 'Loading…',
  'status.yourTurn': 'Your turn ({color}) — solve the puzzle',
  'status.correct': 'Correct — keep going…',
  'status.wrong': 'Wrong move — keep solving the same puzzle',
  'status.failedButSolving': 'Failed, but finish the line to correct it',
  'status.completed': 'Puzzle completed!',
  'status.correctionComplete': 'Solved after a mistake (correction complete)',
  'status.resumedCorrection': 'Resumed a failed attempt — finish the correction',
  'status.noDue': 'Nothing due right now. Next due: {when}',
  'status.queueEmpty': 'No puzzles available in this collection.',
  'status.loadError': 'Could not load puzzle content.',
  'color.white': 'white',
  'color.black': 'black',
  'solution.title': 'Solution',
  'board.title': 'Board',
  'next.label': 'Next puzzle',
  'next.none': 'No puzzle due',
  'promotion.title': 'Choose a promotion piece',
  'promotion.queen': 'Promote to queen',
  'promotion.rook': 'Promote to rook',
  'promotion.bishop': 'Promote to bishop',
  'promotion.knight': 'Promote to knight',
  'promotion.cancel': 'Cancel promotion',
  'storage.memory': 'in-memory (progress will not survive reload)',
  'storage.indexeddb': 'IndexedDB (progress survives reload)',
  'progress.summary': '{attempts} attempts recorded · {total} puzzles in collection',
  'progress.storage': 'Storage: {backend}',
};

const locales: Record<string, LocaleMessages> = { en };
let current = 'en';

export function registerLocale(code: string, messages: LocaleMessages): void {
  locales[code] = { ...en, ...messages };
}

export function hasLocale(code: string): boolean {
  return code in locales;
}

export function availableLocales(): string[] {
  return Object.keys(locales);
}

export function setLocale(code: string): string {
  if (hasLocale(code)) current = code;
  return current;
}

export function getLocale(): string {
  return current;
}

export function detectLocale(): string {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('lang');
    if (fromQuery && hasLocale(fromQuery)) return fromQuery;
    try {
      const stored = window.localStorage.getItem('chessreps.locale');
      if (stored && hasLocale(stored)) return stored;
    } catch {
      // localStorage may be unavailable (private mode); fall through.
    }
    const nav = (window.navigator.language || 'en').slice(0, 2);
    if (hasLocale(nav)) return nav;
  }
  return 'en';
}

function interpolate(message: string, params: Record<string, string | number>): string {
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

export function t(key: string, params?: Record<string, string | number>): string {
  const message = locales[current]?.[key] ?? en[key] ?? key;
  return params ? interpolate(message, params) : message;
}

export function applyTranslations(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key));
  });
}
