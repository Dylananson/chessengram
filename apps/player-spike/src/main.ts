import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';

import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Dests, Key } from 'chessground/types';
import type { SquareName } from 'chessops/types';

import { PuzzleGame, type PromotionRole } from './puzzle-game.ts';
import { AttemptTimer } from './timing.ts';
import { applyTranslations, detectLocale, setLocale, t } from './i18n.ts';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_PROGRAM_ID,
  LocalTrainingService,
  type LocalTrainingServiceOptions,
} from './scheduler-service.ts';
import { TrainingAdapter } from './training-adapter.ts';
import { LocalStore } from './storage/local-store.ts';
import { IndexedDbStorageBackend } from './storage/indexeddb-backend.ts';
import { InMemoryStorageBackend } from './storage/memory-backend.ts';
import type { StorageBackend } from './storage/backend.ts';
import { loadPuzzlesFromPack } from './pack-loader.ts';
import type { AttemptRecord, NormalizedPuzzle } from '../../../packages/contracts/src/types.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

let ground: Api;
let service: LocalTrainingService;
let adapter: TrainingAdapter;
let game: PuzzleGame | null = null;
let timer = new AttemptTimer();
let scoredCommitted = false;
let pendingPromotion: { from: Key; to: Key } | null = null;

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// --- screen state ---------------------------------------------------------

function renderPosition(opts: { fen?: string; lastMove?: Key[]; interactive?: boolean } = {}): void {
  if (!game) return;
  const interactive = opts.interactive ?? game.solverTurn;
  ground.set({
    fen: opts.fen ?? game.fen,
    orientation: game.orientation,
    turnColor: game.turn,
    lastMove: opts.lastMove,
    movable: {
      free: false,
      color: interactive ? game.orientation : undefined,
      dests: (interactive ? game.legalDests() : new Map()) as Dests,
      showDests: true,
      events: { after: onUserMove },
    },
    draggable: { enabled: true, showGhost: true },
    selectable: { enabled: true },
  });
}

function setStatus(key: string, className?: string, params?: Record<string, string | number>): void {
  const el = $('status');
  el.textContent = t(key, params);
  el.className = 'status';
  if (className) el.classList.add(className);
  if (game?.failedState && !game.isCompleted) el.classList.add('failed-but-solving');
}

function updatePuzzleInfo(p: NormalizedPuzzle): void {
  $('puzzle-id').textContent = `${t('puzzle.id')}: ${p.id}`;
  $('rating').textContent = `${t('puzzle.rating')}: ${p.rating}`;
  $('themes').textContent = `${t('puzzle.themes')}: ${p.themes.slice(0, 4).join(', ') || t('puzzle.none')}`;
  $('solver-color').textContent = `${t('puzzle.solver')}: ${t(`color.${p.solverColor}`)}`;
  $('solution').textContent = p.solution.join(' ');
}

function updateProgressInfo(): void {
  $('progress').textContent = t('progress.summary', {
    attempts: service.getAttemptCount(),
    total: service.listPuzzleIds().length,
  });
  $('storage').textContent = t('progress.storage', {
    backend: t(service.getBackendKind() === 'indexeddb' ? 'storage.indexeddb' : 'storage.memory'),
  });
}

// --- move handling --------------------------------------------------------

async function onUserMove(orig: Key, dest: Key): Promise<void> {
  if (!game) return;
  if (game.requiresPromotion(orig as SquareName, dest as SquareName)) {
    pendingPromotion = { from: orig, to: dest };
    renderPosition();
    showPromotion(game.orientation);
    return;
  }
  await resolveUserMove(orig as SquareName, dest as SquareName);
}

async function resolveUserMove(
  from: SquareName,
  to: SquareName,
  promotion?: PromotionRole,
): Promise<void> {
  if (!game) return;
  const result = game.playUserMove(from, to, promotion);

  if (result.kind === 'illegal' || result.kind === 'ignored' || result.kind === 'needs-promotion') {
    renderPosition();
    return;
  }

  if (result.kind === 'wrong') {
    await adapter.recordWrongMove(result.uci);
    if (!scoredCommitted) {
      scoredCommitted = true;
      timer.markFailure();
      await adapter.commitFailure(timer.snapshot());
    }
    setStatus('status.wrong', 'wrong');
    renderPosition();
    return;
  }

  await adapter.recordMove(result.uci, true);
  renderPosition({ fen: result.fenAfterSolver, lastMove: [from as Key, to as Key], interactive: false });

  const settle = async (): Promise<void> => {
    if (result.completed) {
      await completePuzzle();
    } else {
      setStatus('status.correct', 'correct');
      renderPosition();
    }
  };

  if (result.fenAfterOpponent) {
    window.setTimeout(() => {
      void settle();
    }, 260);
  } else {
    await settle();
  }
}

async function completePuzzle(): Promise<void> {
  if (!game) return;
  if (game.failedState) {
    await adapter.finishCorrection(timer.snapshot());
    setStatus('status.correctionComplete', 'completed');
  } else {
    if (!scoredCommitted) {
      scoredCommitted = true;
      await adapter.commitSuccess(timer.snapshot());
    }
    setStatus('status.completed', 'completed');
  }
  renderPosition({ interactive: false });
  $<HTMLButtonElement>('next-btn').disabled = false;
  updateProgressInfo();
}

// --- promotion overlay ----------------------------------------------------

const PROMOTION_GLYPHS: Record<'white' | 'black', Record<PromotionRole, string>> = {
  white: { q: '♕', r: '♖', b: '♗', n: '♘' },
  black: { q: '♛', r: '♜', b: '♝', n: '♞' },
};

function showPromotion(color: 'white' | 'black'): void {
  const overlay = $('promotion');
  overlay.querySelectorAll<HTMLButtonElement>('[data-promotion]').forEach((btn) => {
    const role = btn.getAttribute('data-promotion') as PromotionRole;
    btn.textContent = PROMOTION_GLYPHS[color][role];
    btn.setAttribute('aria-label', t(`promotion.${roleName(role)}`));
  });
  overlay.classList.remove('hidden');
}

function roleName(role: PromotionRole): string {
  return role === 'q' ? 'queen' : role === 'r' ? 'rook' : role === 'b' ? 'bishop' : 'knight';
}

function hidePromotion(): void {
  $('promotion').classList.add('hidden');
}

function onPromotionChoice(role: PromotionRole): void {
  const pending = pendingPromotion;
  pendingPromotion = null;
  hidePromotion();
  if (!pending) {
    renderPosition();
    return;
  }
  void resolveUserMove(pending.from as SquareName, pending.to as SquareName, role);
}

// --- attempt lifecycle ----------------------------------------------------

async function beginAttempt(p: NormalizedPuzzle): Promise<void> {
  game = new PuzzleGame(p);
  timer = new AttemptTimer();
  scoredCommitted = false;
  pendingPromotion = null;
  hidePromotion();

  await adapter.startAttempt(p);
  timer.start();

  $<HTMLButtonElement>('next-btn').disabled = true;
  updatePuzzleInfo(p);
  setStatus('status.yourTurn', undefined, { color: t(`color.${p.solverColor}`) });
  renderPosition();
  updateProgressInfo();
}

async function loadNext(): Promise<void> {
  if (!game?.isCompleted) return;
  $<HTMLButtonElement>('next-btn').disabled = true;
  const selection = await adapter.selectNext();
  if (!selection.puzzleId) {
    const when = selection.nextDueAt
      ? new Date(selection.nextDueAt).toLocaleString()
      : t('puzzle.none');
    setStatus('status.noDue', undefined, { when });
    $<HTMLButtonElement>('next-btn').disabled = false;
    return;
  }
  await beginAttempt(await adapter.loadPuzzle(selection.puzzleId));
}

/** Rebuild the current attempt after a reload, if one is still open. */
async function resumeIfPossible(): Promise<boolean> {
  const sessionId = adapter.getSessionId();
  if (!sessionId) return false;
  const attempt: AttemptRecord | undefined = service.getActiveAttempt(sessionId);
  if (!attempt) return false;

  try {
    const p = await adapter.loadPuzzle(attempt.progressKey.puzzleId);
    game = new PuzzleGame(p);

    const correctUcis = attempt.events
      .filter((event) => event.type === 'move' && event.payload?.correct === true)
      .map((event) => String(event.payload?.uci ?? event.payload?.move ?? ''))
      .filter((uci) => uci.length > 0);
    game.replaySolverMoves(correctUcis);

    const failed = attempt.outcome === 'failure';
    if (failed) {
      game.markFailed();
      scoredCommitted = true;
      timer.markFailure();
    }
    adapter.resumeAttempt(attempt);
    timer.start();
    hidePromotion();
    updatePuzzleInfo(p);

    if (game.isCompleted) {
      $<HTMLButtonElement>('next-btn').disabled = false;
      await completePuzzle();
    } else if (failed) {
      $<HTMLButtonElement>('next-btn').disabled = true;
      setStatus('status.failedButSolving', 'wrong');
    } else {
      $<HTMLButtonElement>('next-btn').disabled = true;
      setStatus('status.yourTurn', undefined, { color: t(`color.${p.solverColor}`) });
    }
    renderPosition();
    updateProgressInfo();
    return true;
  } catch (err) {
    console.warn('Resume failed; starting a fresh attempt', err);
    adapter.releaseAttempt();
    return false;
  }
}

// --- bootstrap ------------------------------------------------------------

async function createService(): Promise<LocalTrainingService> {
  let backend: StorageBackend;
  if (typeof indexedDB !== 'undefined') {
    try {
      backend = new IndexedDbStorageBackend();
    } catch {
      backend = new InMemoryStorageBackend();
    }
  } else {
    backend = new InMemoryStorageBackend();
  }
  const options: LocalTrainingServiceOptions = { store: new LocalStore(backend) };
  const svc = new LocalTrainingService(options);
  await svc.init();

  const params = new URLSearchParams(window.location.search);
  if (params.get('reset') === '1') {
    await svc.reset();
  }
  return svc;
}

async function init(): Promise<void> {
  const locale = detectLocale();
  setLocale(locale);
  document.documentElement.lang = locale;
  applyTranslations(document);

  $('promotion').querySelectorAll<HTMLButtonElement>('[data-promotion]').forEach((btn) => {
    btn.addEventListener('click', () => onPromotionChoice(btn.getAttribute('data-promotion') as PromotionRole));
  });
  $('promotion').addEventListener('click', (event) => {
    if (event.target === $('promotion')) {
      pendingPromotion = null;
      hidePromotion();
      renderPosition();
    }
  });

  const boardEl = $('board');
  ground = Chessground(boardEl, {
    fen: START_FEN,
    orientation: 'white',
    coordinates: true,
    animation: { enabled: true, duration: 180 },
    movable: { free: false, showDests: true, events: { after: onUserMove } },
  });

  try {
    service = await createService();
    if (!service.hasContent()) {
      const pack = await loadPuzzlesFromPack();
      await service.seedContent(pack.puzzles, { packId: pack.packId });
    }
  } catch (err) {
    console.error(err);
    setStatus('status.loadError', 'wrong');
    return;
  }

  adapter = new TrainingAdapter(service);
  await adapter.startSession(DEFAULT_PROGRAM_ID, DEFAULT_COLLECTION_ID);
  updateProgressInfo();

  $<HTMLButtonElement>('next-btn').addEventListener('click', () => void loadNext());

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) timer.interrupt();
    else timer.resume();
  });
  window.addEventListener('beforeunload', () => timer.interrupt());

  const resumed = await resumeIfPossible();
  if (!resumed) {
    const selection = await adapter.selectNext();
    if (selection.puzzleId) {
      await beginAttempt(await adapter.loadPuzzle(selection.puzzleId));
    } else {
      setStatus('status.noDue', undefined, {
        when: selection.nextDueAt ? new Date(selection.nextDueAt).toLocaleString() : t('puzzle.none'),
      });
    }
  }
}

void init();
