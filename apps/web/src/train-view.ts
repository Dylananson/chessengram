/**
 * Train screen: the board, move handling, attempt lifecycle and reload-resume,
 * extracted from the original single-file bootstrap. Owns the chessground
 * instance for its lifetime and tears everything down on unmount.
 *
 * Phase 2 additions over the spike:
 *  - solution is hidden behind a Reveal button (no spoiler),
 *  - Skip abandons the current unscored attempt and moves to the next due
 *    puzzle (session-scoped skip list in the adapter),
 *  - the queue summary (new/learned/due) is shown on screen.
 */

import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Dests, Key } from 'chessground/types';
import type { SquareName } from 'chessops/types';

import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import { PuzzleGame, type PromotionRole } from './puzzle-game.ts';
import type { Screen } from './router.ts';
import { DEFAULT_PROGRAM_ID } from './scheduler-service.ts';
import { AttemptTimer } from './timing.ts';
import type { NormalizedPuzzle } from '@chessreps/contracts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export class TrainView implements Screen {
  readonly id = 'train' as const;

  private readonly ctx: AppContext;
  private host: HTMLElement | null = null;

  private ground: Api | null = null;
  private game: PuzzleGame | null = null;
  private timer = new AttemptTimer();
  private scoredCommitted = false;
  private pendingPromotion: { from: Key; to: Key } | null = null;
  private revealed = false;

  private el: {
    status?: HTMLElement;
    puzzleId?: HTMLElement;
    rating?: HTMLElement;
    themes?: HTMLElement;
    solverColor?: HTMLElement;
    solution?: HTMLElement;
    reveal?: HTMLButtonElement;
    skip?: HTMLButtonElement;
    next?: HTMLButtonElement;
    progress?: HTMLElement;
    storage?: HTMLElement;
    queue?: HTMLElement;
    board?: HTMLElement;
  } = {};

  private readonly onVisibility = (): void => {
    if (document.hidden) this.timer.interrupt();
    else this.timer.resume();
  };

  private readonly onBeforeUnload = (): void => this.timer.interrupt();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  private get service() {
    return this.ctx.service;
  }

  private get adapter() {
    return this.ctx.adapter;
  }

  mount(host: HTMLElement): Promise<void> {
    return (async () => {
      this.host = host;
      host.innerHTML = template();
      this.queryRefs();
      this.bindEvents();

      const boardEl = this.el.board!;
      this.ground = Chessground(boardEl, {
        fen: START_FEN,
        orientation: 'white',
        coordinates: true,
        animation: { enabled: true, duration: 180 },
        movable: { free: false, showDests: true, events: { after: (o, d) => void this.onUserMove(o, d) } },
      });

      document.addEventListener('visibilitychange', this.onVisibility);
      window.addEventListener('beforeunload', this.onBeforeUnload);

      const resumed = await this.resumeIfPossible();
      if (!resumed) {
        const selection = await this.adapter.selectNext();
        if (selection.puzzleId) {
          await this.beginAttempt(await this.adapter.loadPuzzle(selection.puzzleId));
        } else {
          this.setStatus('status.noDue', undefined, {
            when: selection.nextDueAt
              ? new Date(selection.nextDueAt).toLocaleString()
              : t('puzzle.none'),
          });
          this.nextBtn().disabled = false;
        }
      }
      this.updateProgress();
    })();
  }

  unmount(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.hidePromotion();
    this.cleanupPromotion?.();
    this.cleanupPromotion = null;
    this.ground?.destroy();
    this.ground = null;
    this.game = null;
    this.host = null;
  }

  // --- DOM helpers ---------------------------------------------------------

  private queryRefs(): void {
    const h = this.host!;
    this.el.status = h.querySelector('#status') ?? undefined;
    this.el.puzzleId = h.querySelector('#puzzle-id') ?? undefined;
    this.el.rating = h.querySelector('#rating') ?? undefined;
    this.el.themes = h.querySelector('#themes') ?? undefined;
    this.el.solverColor = h.querySelector('#solver-color') ?? undefined;
    this.el.solution = h.querySelector('#solution') ?? undefined;
    this.el.reveal = h.querySelector('#reveal-btn') ?? undefined;
    this.el.skip = h.querySelector('#skip-btn') ?? undefined;
    this.el.next = h.querySelector('#next-btn') ?? undefined;
    this.el.progress = h.querySelector('#progress') ?? undefined;
    this.el.storage = h.querySelector('#storage') ?? undefined;
    this.el.queue = h.querySelector('#queue') ?? undefined;
    this.el.board = h.querySelector('#board') ?? undefined;
  }

  private text(id: keyof typeof this.el): HTMLElement {
    return this.el[id] as HTMLElement;
  }

  private btn(id: 'reveal' | 'skip' | 'next'): HTMLButtonElement {
    return this.el[id] as HTMLButtonElement;
  }

  private nextBtn(): HTMLButtonElement {
    return this.btn('next');
  }

  private setStatus(
    key: string,
    className?: string,
    params?: Record<string, string | number>,
  ): void {
    const el = this.text('status');
    el.textContent = t(key, params);
    el.className = 'status';
    if (className) el.classList.add(className);
    if (this.game?.failedState && !this.game.isCompleted) el.classList.add('failed-but-solving');
  }

  private updatePuzzleInfo(p: NormalizedPuzzle): void {
    this.text('puzzleId').textContent = `${t('puzzle.id')}: ${p.id}`;
    this.text('rating').textContent = `${t('puzzle.rating')}: ${p.rating}`;
    this.text('themes').textContent = `${t('puzzle.themes')}: ${p.themes.slice(0, 4).join(', ') || t('puzzle.none')}`;
    this.text('solverColor').textContent = `${t('puzzle.solver')}: ${t(`color.${p.solverColor}`)}`;
    this.el.solution!.textContent = p.solution.join(' ');
    this.el.solution!.classList.add('hidden');
    this.revealed = false;
    this.btn('reveal').textContent = t('reveal.show');
  }

  private updateProgress(): void {
    this.text('progress').textContent = t('progress.summary', {
      attempts: this.service.getAttemptCount(),
      total: this.service.listPuzzleIds().length,
    });
    this.text('storage').textContent = t('progress.storage', {
      backend: t(
        this.service.getBackendKind() === 'indexeddb' ? 'storage.indexeddb' : 'storage.memory',
      ),
    });
    const q = this.service.queueSummary(DEFAULT_PROGRAM_ID);
    this.text('queue').textContent = t('queue.summary', {
      total: q.total,
      newCount: q.newCount,
      due: q.due,
      learned: q.learned,
    });
  }

  // --- board rendering -----------------------------------------------------

  private renderPosition(opts: { fen?: string; lastMove?: Key[]; interactive?: boolean } = {}): void {
    if (!this.game || !this.ground) return;
    const interactive = opts.interactive ?? this.game.solverTurn;
    this.ground.set({
      fen: opts.fen ?? this.game.fen,
      orientation: this.game.orientation,
      turnColor: this.game.turn,
      lastMove: opts.lastMove,
      movable: {
        free: false,
        color: interactive ? this.game.orientation : undefined,
        dests: (interactive ? this.game.legalDests() : new Map()) as Dests,
        showDests: true,
        events: { after: (o, d) => void this.onUserMove(o, d) },
      },
      draggable: { enabled: true, showGhost: true },
      selectable: { enabled: true },
    });
  }

  // --- move handling -------------------------------------------------------

  private async onUserMove(orig: Key, dest: Key): Promise<void> {
    if (!this.game) return;
    if (this.game.requiresPromotion(orig as SquareName, dest as SquareName)) {
      this.pendingPromotion = { from: orig, to: dest };
      this.renderPosition();
      this.showPromotion(this.game.orientation);
      return;
    }
    await this.resolveUserMove(orig as SquareName, dest as SquareName);
  }

  private async resolveUserMove(
    from: SquareName,
    to: SquareName,
    promotion?: PromotionRole,
  ): Promise<void> {
    if (!this.game) return;
    const result = this.game.playUserMove(from, to, promotion);

    if (result.kind === 'illegal' || result.kind === 'ignored' || result.kind === 'needs-promotion') {
      this.renderPosition();
      return;
    }

    if (result.kind === 'wrong') {
      await this.adapter.recordWrongMove(result.uci);
      if (!this.scoredCommitted) {
        this.scoredCommitted = true;
        this.timer.markFailure();
        await this.adapter.commitFailure(this.timer.snapshot());
      }
      this.setStatus('status.wrong', 'wrong');
      this.renderPosition();
      return;
    }

    await this.adapter.recordMove(result.uci, true);
    this.renderPosition({
      fen: result.fenAfterSolver,
      lastMove: [from as Key, to as Key],
      interactive: false,
    });

    const settle = async (): Promise<void> => {
      if (result.completed) {
        await this.completePuzzle();
      } else {
        this.setStatus('status.correct', 'correct');
        this.renderPosition();
      }
    };

    if (result.fenAfterOpponent) {
      window.setTimeout(() => void settle(), 260);
    } else {
      await settle();
    }
  }

  private async completePuzzle(): Promise<void> {
    if (!this.game) return;
    if (this.game.failedState) {
      await this.adapter.finishCorrection(this.timer.snapshot());
      this.setStatus('status.correctionComplete', 'completed');
    } else {
      if (!this.scoredCommitted) {
        this.scoredCommitted = true;
        await this.adapter.commitSuccess(this.timer.snapshot());
      }
      this.setStatus('status.completed', 'completed');
    }
    this.renderPosition({ interactive: false });
    this.nextBtn().disabled = false;
    this.btn('skip').disabled = true;
    this.updateProgress();
  }

  // --- promo overlay -------------------------------------------------------

  private readonly PROMOTION_GLYPHS: Record<'white' | 'black', Record<PromotionRole, string>> = {
    white: { q: '♕', r: '♖', b: '♗', n: '♘' },
    black: { q: '♛', r: '♜', b: '♝', n: '♞' },
  };

  private showPromotion(color: 'white' | 'black'): void {
    const overlay = document.getElementById('promotion')!;
    overlay.querySelectorAll<HTMLButtonElement>('[data-promotion]').forEach((b) => {
      const role = b.getAttribute('data-promotion') as PromotionRole;
      b.textContent = this.PROMOTION_GLYPHS[color][role];
      b.setAttribute('aria-label', t(`promotion.${roleName(role)}`));
    });
    overlay.classList.remove('hidden');
  }

  private hidePromotion(): void {
    document.getElementById('promotion')?.classList.add('hidden');
  }

  private onPromotionChoice(role: PromotionRole): void {
    const pending = this.pendingPromotion;
    this.pendingPromotion = null;
    this.hidePromotion();
    if (!pending) {
      this.renderPosition();
      return;
    }
    void this.resolveUserMove(pending.from as SquareName, pending.to as SquareName, role);
  }

  // --- attempt lifecycle ---------------------------------------------------

  private async beginAttempt(p: NormalizedPuzzle): Promise<void> {
    this.game = new PuzzleGame(p);
    this.timer = new AttemptTimer();
    this.scoredCommitted = false;
    this.pendingPromotion = null;
    this.revealed = false;
    this.hidePromotion();

    await this.adapter.startAttempt(p);
    this.timer.start();

    this.nextBtn().disabled = true;
    this.btn('skip').disabled = false;
    this.btn('reveal').disabled = false;
    this.updatePuzzleInfo(p);
    this.setStatus('status.yourTurn', undefined, { color: t(`color.${p.solverColor}`) });
    this.renderPosition();
    this.updateProgress();
  }

  private async loadNext(): Promise<void> {
    if (this.game?.isCompleted === false && this.adapter.getActiveAttemptId()) return;
    this.nextBtn().disabled = true;
    const selection = await this.adapter.selectNext();
    if (!selection.puzzleId) {
      const when = selection.nextDueAt
        ? new Date(selection.nextDueAt).toLocaleString()
        : t('puzzle.none');
      this.setStatus('status.noDue', undefined, { when });
      this.nextBtn().disabled = false;
      return;
    }
    await this.beginAttempt(await this.adapter.loadPuzzle(selection.puzzleId));
  }

  /** Rebuild the current attempt after a reload, if one is still open. */
  private async resumeIfPossible(): Promise<boolean> {
    const sessionId = this.adapter.getSessionId();
    if (!sessionId) return false;
    const attempt = this.service.getActiveAttempt(sessionId);
    if (!attempt) return false;

    try {
      const p = await this.adapter.loadPuzzle(attempt.progressKey.puzzleId);
      this.game = new PuzzleGame(p);

      const correctUcis = attempt.events
        .filter((event) => event.type === 'move' && event.payload?.correct === true)
        .map((event) => String(event.payload?.uci ?? event.payload?.move ?? ''))
        .filter((uci) => uci.length > 0);
      this.game.replaySolverMoves(correctUcis);

      const failed = attempt.outcome === 'failure';
      if (failed) {
        this.game.markFailed();
        this.scoredCommitted = true;
        this.timer.markFailure();
      }
      this.adapter.resumeAttempt(attempt);
      this.timer.start();
      this.hidePromotion();
      this.updatePuzzleInfo(p);

      this.btn('skip').disabled = false;
      this.btn('reveal').disabled = false;

      if (this.game.isCompleted) {
        this.nextBtn().disabled = false;
        await this.completePuzzle();
      } else if (failed) {
        this.nextBtn().disabled = true;
        this.setStatus('status.failedButSolving', 'wrong');
      } else {
        this.nextBtn().disabled = true;
        this.setStatus('status.yourTurn', undefined, { color: t(`color.${p.solverColor}`) });
      }
      this.renderPosition();
      this.updateProgress();
      return true;
    } catch (err) {
      console.warn('Resume failed; starting a fresh selection', err);
      await this.adapter.abandonCurrentAttempt({ skip: false });
      return false;
    }
  }

  // --- actions -------------------------------------------------------------

  private async onSkip(): Promise<void> {
    if (!this.adapter.getActiveAttemptId()) return;
    this.timer.interrupt();
    await this.adapter.abandonCurrentAttempt({ skip: true });
    await this.loadNext();
  }

  private async onReveal(): Promise<void> {
    if (this.revealed) {
      if (this.el.solution) this.el.solution.classList.toggle('hidden');
      return;
    }
    this.revealed = true;
    if (this.game && !this.game.isCompleted && this.adapter.getActiveAttemptId()) {
      this.timer.interrupt();
      await this.adapter.recordAssistance('reveal');
      await this.adapter.abandonCurrentAttempt({ skip: false });
      this.renderPosition({ interactive: false });
      this.nextBtn().disabled = false;
      this.btn('skip').disabled = true;
      this.setStatus('status.revealed', 'revealed');
    }
    this.el.solution?.classList.remove('hidden');
    this.btn('reveal').textContent = t('reveal.hide');
  }

  // --- wiring --------------------------------------------------------------

  private bindEvents(): void {
    this.btn('next').addEventListener('click', () => void this.loadNext());
    this.btn('skip').addEventListener('click', () => void this.onSkip());
    this.btn('reveal').addEventListener('click', () => void this.onReveal());

    const overlay = document.getElementById('promotion')!;
    const onChoice = (e: Event): void => {
      const role = (e.currentTarget as HTMLElement).getAttribute('data-promotion') as PromotionRole;
      this.onPromotionChoice(role);
    };
    const onOverlayClick = (e: Event): void => {
      if (e.target === overlay) {
        this.pendingPromotion = null;
        this.hidePromotion();
        this.renderPosition();
      }
    };
    overlay.querySelectorAll<HTMLButtonElement>('[data-promotion]').forEach((b) => {
      b.addEventListener('click', onChoice);
    });
    overlay.addEventListener('click', onOverlayClick);
    this.cleanupPromotion = () => {
      overlay.querySelectorAll<HTMLButtonElement>('[data-promotion]').forEach((b) => {
        b.removeEventListener('click', onChoice);
      });
      overlay.removeEventListener('click', onOverlayClick);
    };
  }

  private cleanupPromotion: (() => void) | null = null;
}

function roleName(role: PromotionRole): string {
  return role === 'q' ? 'queen' : role === 'r' ? 'rook' : role === 'b' ? 'bishop' : 'knight';
}

function template(): string {
  return `
    <div class="layout">
      <div class="board-wrap">
        <div class="info">
          <h2 data-i18n="board.title"></h2>
          <div id="board" class="board" aria-label="${t('board.title')}"></div>
        </div>
      </div>
      <div class="controls">
        <div class="info">
          <h2 data-i18n="puzzle.info"></h2>
          <p id="puzzle-id">-</p>
          <p id="rating">-</p>
          <p id="themes">-</p>
          <p id="solver-color">-</p>
        </div>
        <div class="info">
          <h2 data-i18n="status.title"></h2>
          <div id="status" class="status">${t('status.loading')}</div>
        </div>
        <div class="info">
          <h2 data-i18n="solution.title"></h2>
          <div class="button-row">
            <button id="reveal-btn" class="button button-secondary" type="button">${t('reveal.show')}</button>
          </div>
          <div id="solution" class="solution-preview hidden">-</div>
        </div>
        <div class="button-row">
          <button id="skip-btn" class="button button-secondary" type="button">${t('skip.label')}</button>
          <button id="next-btn" class="button" type="button" disabled>${t('next.label')}</button>
        </div>
        <div class="info">
          <h2 data-i18n="queue.title"></h2>
          <p id="queue" class="progress-note"></p>
        </div>
        <div>
          <p id="progress" class="progress-note"></p>
          <p id="storage" class="progress-note"></p>
        </div>
      </div>
    </div>
  `;
}