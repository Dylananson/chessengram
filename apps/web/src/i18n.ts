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
  'app.title': 'ChessReps',
  'app.subtitle': 'Spaced-repetition puzzle training',
  'app.update.available': 'Update available',
  'app.update.reload': 'Reload',
  'nav.train': 'Train',
  'nav.puzzles': 'Puzzles',
  'nav.collections': 'Collections',
  'nav.settings': 'Settings',
  'nav.history': 'History',
  'screen.puzzles.title': 'Puzzles',
  'screen.puzzles.body': 'Manage puzzle packs and individual puzzles. Importing and editing arrive in the next build step.',
  'screen.collections.title': 'Collections',
  'screen.collections.body': 'Organize puzzles into collections and programs.',
  'collections.title': 'Collections',
  'collections.subtitle': 'Static sets; one puzzle may live in many collections. Each collection trains the same puzzle independently.',
  'collections.summary': '{members} puzzles · {due} due now · {learned} learned',
  'collections.badge.default': 'default',
  'collections.badge.active': 'active',
  'collections.create': 'Create collection',
  'collections.create.placeholder': 'New collection name',
  'collections.created': 'Created {name}.',
  'collections.rename.start': 'Rename',
  'collections.rename.save': 'Save name',
  'collections.renamed': 'Renamed.',
  'collections.delete': 'Delete',
  'collections.deleted': 'Deleted.',
  'collections.list.empty': 'No collections yet.',
  'collections.members.empty': 'No puzzles in this collection yet.',
  'collections.member.add': 'Add puzzle',
  'collections.member.add.placeholder': 'Puzzle id',
  'collections.member.added': 'Added {id}.',
  'collections.member.remove': 'Remove',
  'collections.member.removed': 'Removed {id}.',
  'collections.active.label': 'Active collection',
  'collections.active.hint': 'Training queue and progress follow the active collection.',
  'screen.settings.title': 'Settings',
  'screen.settings.body': 'Scheduler defaults and training preferences arrive in the next build step.',
  'screen.history.title': 'History',
  'screen.history.body': 'Raw attempt history, stored separately from derived schedule state.',
  'history.title': 'Progress & history',
  'history.subtitle': 'Derived schedule state per puzzle plus the raw attempt count. Read-only.',
  'history.queue': '{total} puzzles · {newCount} new · {due} due now · {learned} learned',
  'history.attempts': '{count} attempts recorded',
  'history.list.title': 'Per-puzzle status',
  'history.list.due': 'Due',
  'history.list.empty': 'No puzzles in the library yet.',
  'history.state.new': 'new',
  'history.state.learning': 'learning',
  'history.state.review': 'review',
  'history.state.relearning': 'relearning',
  'history.due.now': 'now',
  'history.due.never': '—',
  'history.note':
    'Raw attempt history is shown newest-first (latest 100). Timing is in seconds of active solving / correction.',
  'history.attempts.title': 'Recent attempts',
  'history.attempts.puzzle': 'Puzzle',
  'history.attempts.outcome': 'Outcome',
  'history.attempts.active': 'Active (s)',
  'history.attempts.correction': 'Correction (s)',
  'history.attempts.events': 'Events',
  'history.attempts.started': 'Started',
  'history.attempts.finished': 'Finished',
  'history.attempts.empty': 'No attempts recorded yet.',
  'history.attempts.unfinished': '—',
  'history.outcome.success': 'success',
  'history.outcome.failure': 'failure',
  'history.outcome.unscored': 'unscored',
  'history.outcome.abandoned': 'abandoned',
  'settings.prefs.title': 'Scheduler preferences',
  'settings.prefs.body':
    'Defaults for new attempts. A change takes effect on the next attempt; in-progress attempts keep the settings they started with.',
  'settings.prefs.failurePreset': 'On a failed review',
  'settings.prefs.stepBack': 'Step-back amount (used by “step-back”)',
  'settings.prefs.retryRetain': 'Retain amount (used by “retry-retain”)',
  'settings.prefs.newPerDay': 'New puzzles per day',
  'settings.prefs.relearning': 'Relearning delay (minutes)',
  'settings.prefs.timing': 'Adjust review intervals by solving time',
  'settings.prefs.save': 'Save preferences',
  'settings.prefs.saved': 'Preferences saved.',
  'settings.data.title': 'Data safety',
  'settings.data.body':
    'Everything lives on this device. Export it as one JSON file for safekeeping or to move to another device. Imports replace all data, but your current data is snapshotted first and can be restored.',
  'settings.data.current': 'On this device: {total} records ({content} puzzles · {schedules} schedules · {attempts} attempts).',
  'settings.data.export': 'Export all data',
  'settings.data.exported': 'Exported {total} records.',
  'settings.data.import': 'Import data file',
  'settings.data.previewButton': 'Preview import',
  'settings.data.importSummary':
    'Export from {date} · {total} records ({content} puzzles · {schedules} schedules · {attempts} attempts).',
  'settings.data.confirm': 'Replace all data with this file',
  'settings.data.cancel': 'Cancel',
  'settings.data.imported': 'Imported {total} records. Previous data backed up as {label}.',
  'settings.data.importError': 'Import failed: {error}',
  'settings.data.invalid': 'That file is not a valid ChessReps export.',
  'settings.data.backups': 'Recovery snapshots',
  'settings.data.noBackups': 'No recovery snapshots yet.',
  'settings.data.restore': 'Restore',
  'settings.data.restored': 'Restored snapshot {label}.',
  'settings.data.restoreMissing': 'Snapshot not found.',
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
  'status.dailyLimit': 'Daily new-puzzle limit reached. Next review due: {when}',
  'status.practiceAhead': 'Practicing ahead of schedule: {id} (due {when})',
  'practiceAhead.label': 'Practice earliest due',
  'practiceNew.label': 'Practice a new puzzle anyway',
  'status.queueEmpty': 'No puzzles available in this collection.',
  'status.loadError': 'Could not load puzzle content.',
  'status.revealed': 'Solution revealed — no score recorded for this attempt.',
  'skip.label': 'Skip',
  'skip.tip': 'Abandon this puzzle without scoring it and go to the next due one',
  'reveal.show': 'Show solution',
  'reveal.hide': 'Hide solution',
  'review.title': 'Review your attempt',
  'review.hint': 'Step through the moves you played (read-only).',
  'review.first': 'Start',
  'review.back': 'Back',
  'review.forward': 'Forward',
  'review.last': 'End',
  'review.position': 'Move {index} of {total}',
  'queue.title': 'Queue',
  'queue.summary': '{total} puzzles · {newCount} new · {due} due now · {learned} learned',
  'color.white': 'white',
  'color.black': 'black',
  'solution.title': 'Solution',
  'board.title': 'Board',
  'next.label': 'Next puzzle',
  'next.none': 'No puzzle due',
  'restart.label': 'Try again',
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
  'puzzles.pack.title': 'Pack',
  'puzzles.pack.id': 'Pack id',
  'puzzles.pack.count': '{count} puzzles in the library',
  'puzzles.pack.loaded': 'Loaded {when}',
  'puzzles.pack.none': 'No pack loaded yet.',
  'puzzles.import.title': 'Import puzzles',
  'puzzles.import.jsonl.hint': 'JSONL file with one normalized puzzle per line (the same format as the bundled pack).',
  'puzzles.import.button': 'Import file',
  'puzzles.import.csv.hint': 'Official Lichess puzzle CSV export (PuzzleId,FEN,Moves,Rating,…). The first move is the opponent setup move.',
  'puzzles.import.csv.button': 'Import Lichess CSV',
  'puzzles.pgn.title': 'Import PGN',
  'puzzles.pgn.hint': 'Each game becomes a puzzle: its starting position is the solver position and its mainline is the solution. Variations are reported but not imported as solutions.',
  'puzzles.pgn.previewButton': 'Preview PGN',
  'puzzles.pgn.preview.title': 'PGN preview',
  'puzzles.pgn.preview.row': 'Game {index}: {plies} plies · solver {color} · {variations} variation(s)',
  'puzzles.pgn.preview.error': 'Game {index}: {error}',
  'puzzles.pgn.confirm': 'Import {count} puzzle(s)',
  'puzzles.pgn.cancel': 'Cancel preview',
  'puzzles.pgn.imported': 'Imported {added} from PGN ({replaced} replaced).',
  'puzzles.pgn.none': 'No games found in the PGN.',
  'puzzles.import.none': 'No file selected.',
  'puzzles.import.result': '{added} added · {replaced} replaced',
  'puzzles.import.errors': '{n} line(s) rejected: {sample}',
  'puzzles.creator.title': 'Create / edit puzzle',
  'puzzles.creator.open': 'New puzzle',
  'puzzles.creator.cancel': 'Cancel',
  'puzzles.creator.save': 'Save puzzle',
  'puzzles.creator.mode.create': 'Create a new puzzle',
  'puzzles.creator.mode.edit': 'Edit puzzle {id}',
  'puzzles.creator.id.optional': 'optional',
  'puzzles.creator.fen': 'Solver position (FEN)',
  'puzzles.creator.fen.placeholder': '7k/1P6/8/8/8/8/8/K7 w - - 0 1',
  'puzzles.creator.setup': 'Source position (FEN, only needed with a setup move)',
  'puzzles.creator.setupMove': 'Setup move (UCI, optional)',
  'puzzles.creator.solution': 'Solution moves (UCI, space-separated; include opponent replies)',
  'puzzles.creator.solution.placeholder': 'b7b8q',
  'puzzles.creator.rating': 'Rating',
  'puzzles.creator.themes': 'Themes (space-separated, optional)',
  'puzzles.creator.sourceId': 'Source id (optional)',
  'puzzles.creator.saved': 'Saved {id} ({kind}).',
  'puzzles.creator.saved.added': 'new',
  'puzzles.creator.saved.replaced': 'updated',
  'puzzles.list.title': 'Library',
  'puzzles.list.none': 'The library is empty.',
  'puzzles.puzzle.status': '{state} · due {when}',
  'puzzles.puzzle.dueNow': 'now',
  'puzzles.puzzle.dueNever': '—',
  'puzzles.state.new': 'new',
  'puzzles.state.learning': 'learning',
  'puzzles.state.review': 'review',
  'puzzles.state.relearning': 'relearning',
  'puzzles.edit': 'Edit',
  'puzzles.remove': 'Remove',
  'puzzles.remove.confirm': 'Remove puzzle {id}? Its schedule is deleted; attempt history is kept.',
  'puzzles.remove.done': 'Removed {id}.',
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
