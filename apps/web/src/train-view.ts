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
import { PuzzleGame, ReviewNavigator, buildReviewLine, type PromotionRole } from './puzzle-game.ts';
import type { Screen } from './router.ts';
import { DEFAULT_PROGRAM_ID, progressKeyToString } from './scheduler-service.ts';
import { AttemptTimer } from './timing.ts';
import { selectEarliestFutureDue, type Candidate } from '@chessreps/scheduler';
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
  private currentPuzzle: NormalizedPuzzle | null = null;
  private review: ReviewNavigator | null = null;

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
    practice?: HTMLButtonElement;
    progress?: HTMLElement;
    storage?: HTMLElement;
    queue?: HTMLElement;
    picker?: HTMLSelectElement;
    board?: HTMLElement;
    reviewSection?: HTMLElement;
    reviewLabel?: HTMLElement;
    reviewFirst?: HTMLButtonElement;
    reviewBack?: HTMLButtonElement;
    reviewForward?: HTMLButtonElement;
    reviewLast?: HTMLButtonElement;
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
          this.showNoDue(selection);
        }
      }
      this.refreshPicker();
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
    this.currentPuzzle = null;
    this.review = null;
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
    this.el.practice = h.querySelector('#practice-btn') ?? undefined;
    this.el.progress = h.querySelector('#progress') ?? undefined;
    this.el.storage = h.querySelector('#storage') ?? undefined;
    this.el.queue = h.querySelector('#queue') ?? undefined;
    this.el.picker = h.querySelector('#collection-picker') ?? undefined;
    this.el.board = h.querySelector('#board') ?? undefined;
    this.el.reviewSection = h.querySelector('#review-section') ?? undefined;
    this.el.reviewLabel = h.querySelector('#review-label') ?? undefined;
    this.el.reviewFirst = h.querySelector('#review-first') ?? undefined;
    this.el.reviewBack = h.querySelector('#review-back') ?? undefined;
    this.el.reviewForward = h.querySelector('#review-forward') ?? undefined;
    this.el.reviewLast = h.querySelector('#review-last') ?? undefined;
  }

  private text(id: keyof typeof this.el): HTMLElement {
    return this.el[id] as HTMLElement;
  }

  private btn(id: 'reveal' | 'skip' | 'next' | 'practice'): HTMLButtonElement {
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
    const activeCollection = this.service.getActiveCollectionId();
    const q = this.service.queueSummary(DEFAULT_PROGRAM_ID, activeCollection);
    this.text('progress').textContent = t('progress.summary', {
      attempts: this.service.getAttemptCount(),
      total: q.total,
    });
    this.text('storage').textContent = t('progress.storage', {
      backend: t(
        this.service.getBackendKind() === 'indexeddb' ? 'storage.indexeddb' : 'storage.memory',
      ),
    });
    this.text('queue').textContent = t('queue.summary', {
      total: q.total,
      newCount: q.newCount,
      due: q.due,
      learned: q.learned,
    });
  }

  // --- active-collection picker (B4) -----------------------------------------
  //
  // Queue/progress follow the persisted active collection. Switching starts a
  // fresh session in the new scope; an in-flight attempt keeps its original
  // scope and stays committable, the next selection uses the new collection.

  /** Rebuild the picker options from the service; selection follows the service. */
  private refreshPicker(): void {
    const select = this.el.picker;
    if (!select) return;
    select.innerHTML = '';
    for (const collection of this.service.listCollections()) {
      const option = document.createElement('option');
      option.value = collection.id;
      option.textContent = collection.name;
      select.appendChild(option);
    }
    select.value = this.service.getActiveCollectionId();
  }

  private async onCollectionChange(collectionId: string): Promise<void> {
    if (!collectionId || collectionId === this.service.getActiveCollectionId()) return;
    await this.service.setActiveCollectionId(collectionId);
    await this.adapter.startSession(DEFAULT_PROGRAM_ID, collectionId);
    this.refreshPicker();
    this.updateProgress();
    if (!this.adapter.getActiveAttemptId()) {
      await this.loadNext();
    }
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
    this.enterReview();
  }

  // --- attempt review (read-only, completed puzzles only) -------------------
  //
  // B5/AN-001a: after a puzzle completes, the user can step back/forward
  // through their own attempt (solver plies + auto-played opponent replies,
  // wrong attempts included) with the board rendered at each step. Review is
  // entered only from the completed state, renders non-interactively, and
  // performs no schedule or attempt writes (read via `listAttemptsForPuzzle`).

  /** Drop review state and hide the review controls (new attempt starting). */
  private resetReview(): void {
    this.review = null;
    this.el.reviewSection?.classList.add('hidden');
  }

  /**
   * Build the review line from the recorded attempt events and show the
   * controls at the final position. No-op unless the puzzle is completed.
   */
  private enterReview(): void {
    if (!this.game?.isCompleted || !this.currentPuzzle) {
      this.resetReview();
      return;
    }
    const [latest] = this.adapter.listAttemptsForPuzzle(this.currentPuzzle.id, 1);
    const events = latest?.events ?? [];
    const line = buildReviewLine(this.currentPuzzle, events);
    if (line.length < 2) {
      this.resetReview();
      return;
    }
    this.review = new ReviewNavigator(line);
    this.el.reviewSection?.classList.remove('hidden');
    this.renderReviewStep();
  }

  /** Render the navigator's current step. Non-interactive; no state writes. */
  private renderReviewStep(): void {
    if (!this.review || !this.game?.isCompleted) return;
    const step = this.review.current();
    this.renderPosition({
      fen: step.fen,
      lastMove: step.uci ? uciToKeys(step.uci) : undefined,
      interactive: false,
    });
    this.updateReviewControls();
  }

  private updateReviewControls(): void {
    if (!this.review) return;
    if (this.el.reviewLabel) {
      this.el.reviewLabel.textContent = t('review.position', {
        index: this.review.position,
        total: this.review.count - 1,
      });
    }
    if (this.el.reviewFirst) this.el.reviewFirst.disabled = !this.review.canBack;
    if (this.el.reviewBack) this.el.reviewBack.disabled = !this.review.canBack;
    if (this.el.reviewForward) this.el.reviewForward.disabled = !this.review.canForward;
    if (this.el.reviewLast) this.el.reviewLast.disabled = !this.review.canForward;
  }

  private stepReview(direction: 'first' | 'back' | 'forward' | 'last'): void {
    if (!this.review || !this.game?.isCompleted) return;
    if (direction === 'first') this.review.first();
    else if (direction === 'back') this.review.back();
    else if (direction === 'forward') this.review.forward();
    else this.review.last();
    this.renderReviewStep();
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
    this.currentPuzzle = p;
    this.resetReview();
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
    this.btn('practice').classList.add('hidden');
    this.updatePuzzleInfo(p);
    this.setStatus('status.yourTurn', undefined, { color: t(`color.${p.solverColor}`) });
    this.renderPosition();
    this.updateProgress();
  }

  private async loadNext(): Promise<void> {
    if (this.game?.isCompleted === false && this.adapter.getActiveAttemptId()) return;
    this.nextBtn().disabled = true;
    this.btn('practice').classList.add('hidden');
    const selection = await this.adapter.selectNext();
    if (!selection.puzzleId) {
      this.showNoDue(selection);
      return;
    }
    await this.beginAttempt(await this.adapter.loadPuzzle(selection.puzzleId));
  }

  /**
   * UX-001 no-due UI: never strand the user with a non-empty library.
   * - `queue-empty` (no puzzles at all) shows the empty-library status.
   * - `daily-limit-reached` (new-per-day cap) is shown distinctly from plain
   *   `no-due-work` (everything due in the future), both with the earliest
   *   due time when known.
   * - When a practice target exists, an explicit opt-in button starts it:
   *   the earliest future-due puzzle ("practice ahead"), or — only when the
   *   cap is the blocker and nothing is due in the future — a new puzzle
   *   anyway. Practice attempts are scored normally; nothing is auto-started
   *   and no schedule state is fabricated.
   */
  private showNoDue(selection: {
    puzzleId: string | null;
    nextDueAt?: number;
    reason?: string;
  }): void {
    const when = selection.nextDueAt
      ? new Date(selection.nextDueAt).toLocaleString()
      : t('puzzle.none');
    const practiceBtn = this.btn('practice');
    if (selection.reason === 'queue-empty') {
      this.setStatus('status.queueEmpty');
      practiceBtn.classList.add('hidden');
    } else {
      if (selection.reason === 'daily-limit-reached') {
        this.setStatus('status.dailyLimit', undefined, { when });
      } else {
        this.setStatus('status.noDue', undefined, { when });
      }
      const target = this.findPracticeTarget(selection.reason);
      if (target) {
        practiceBtn.textContent = t(
          target.kind === 'ahead' ? 'practiceAhead.label' : 'practiceNew.label',
        );
        practiceBtn.classList.remove('hidden');
      } else {
        practiceBtn.classList.add('hidden');
      }
    }
    this.nextBtn().disabled = false;
  }

  /** Resolve the opt-in practice target, if any. Pure read of service state. */
  private findPracticeTarget(reason?: string): { puzzleId: string; kind: 'ahead' | 'new' } | null {
    const active = this.adapter.describeCurrentAttempt().progressKey;
    const programId = active?.programId ?? DEFAULT_PROGRAM_ID;
    // B4: schedule scope is (program, collection, puzzle). Practice reads the
    // active collection's scope via 3-part keys only — never the legacy
    // `program:puzzle` lookup, which resolves another collection's state when
    // the active scope has none.
    const collectionId = this.service.getActiveCollectionId();
    const reserved = new Set<string>();
    if (active) reserved.add(progressKeyToString(active));
    const members = this.service.getCollection(collectionId)?.puzzleIds;
    const library = new Set(this.service.listPuzzleIds());
    const ids = (members ?? [...library]).filter((id) => library.has(id));
    const candidates: Candidate[] = [];
    for (const id of ids) {
      const key = progressKeyToString({ programId, collectionId, puzzleId: id });
      const state = this.service.getScheduleState(key);
      if (!state) continue;
      candidates.push({ progressKey: key, state, orderKey: id });
    }
    const ahead = selectEarliestFutureDue(candidates, { now: Date.now(), reservedKeys: reserved });
    if (ahead) return { puzzleId: ahead.orderKey, kind: 'ahead' };
    // Cap is the only blocker and nothing is due in the future: offer one
    // new puzzle anyway (explicit opt-in; the cap still gates auto-selection).
    if (reason === 'daily-limit-reached') {
      for (const id of ids) {
        const key = progressKeyToString({ programId, collectionId, puzzleId: id });
        if (reserved.has(key)) continue;
        const state = this.service.getScheduleState(key);
        if (!state || state.state === 'new') return { puzzleId: id, kind: 'new' };
      }
    }
    return null;
  }

  /** Start the opt-in practice target resolved by `findPracticeTarget`. */
  private async onPractice(): Promise<void> {
    if (this.adapter.getActiveAttemptId()) return;
    const selection = await this.adapter.selectNext();
    if (selection.puzzleId) {
      await this.beginAttempt(await this.adapter.loadPuzzle(selection.puzzleId));
      return;
    }
    const target = this.findPracticeTarget(selection.reason);
    if (!target) {
      this.showNoDue(selection);
      return;
    }
    const attemptKey = this.adapter.describeCurrentAttempt().progressKey;
    const whenValue = this.service.getScheduleState(
      progressKeyToString({
        programId: attemptKey?.programId ?? DEFAULT_PROGRAM_ID,
        collectionId: this.service.getActiveCollectionId(),
        puzzleId: target.puzzleId,
      }),
    )?.dueAt;
    await this.beginAttempt(await this.adapter.loadPuzzle(target.puzzleId));
    if (target.kind === 'ahead') {
      this.setStatus('status.practiceAhead', undefined, {
        id: target.puzzleId,
        when: whenValue ? new Date(whenValue).toLocaleString() : t('puzzle.none'),
      });
    }
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
    this.el.picker?.addEventListener('change', (event) =>
      void this.onCollectionChange((event.target as HTMLSelectElement).value),
    );
    this.btn('practice').addEventListener('click', () => void this.onPractice());
    this.btn('skip').addEventListener('click', () => void this.onSkip());
    this.btn('reveal').addEventListener('click', () => void this.onReveal());
    this.el.reviewFirst?.addEventListener('click', () => this.stepReview('first'));
    this.el.reviewBack?.addEventListener('click', () => this.stepReview('back'));
    this.el.reviewForward?.addEventListener('click', () => this.stepReview('forward'));
    this.el.reviewLast?.addEventListener('click', () => this.stepReview('last'));

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

/** Last-move highlight squares for a review step (`e2e4` → `['e2', 'e4']`). */
function uciToKeys(uci: string): Key[] | undefined {
  const match = /^[a-h][1-8][a-h][1-8][qrbn]?$/.exec(uci);
  if (!match) return undefined;
  return [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key];
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
        <div class="info hidden" id="review-section">
          <h2 data-i18n="review.title"></h2>
          <p class="progress-note">${t('review.hint')}</p>
          <p id="review-label"></p>
          <div class="button-row">
            <button id="review-first" class="button button-secondary" type="button">${t('review.first')}</button>
            <button id="review-back" class="button button-secondary" type="button">${t('review.back')}</button>
            <button id="review-forward" class="button button-secondary" type="button">${t('review.forward')}</button>
            <button id="review-last" class="button button-secondary" type="button">${t('review.last')}</button>
          </div>
        </div>
        <div class="button-row">
          <button id="skip-btn" class="button button-secondary" type="button">${t('skip.label')}</button>
          <button id="next-btn" class="button" type="button" disabled>${t('next.label')}</button>
          <button id="practice-btn" class="button button-secondary hidden" type="button">${t('practiceAhead.label')}</button>
        </div>
        <div class="info">
          <h2>${t('collections.active.label')}</h2>
          <p class="progress-note">${t('collections.active.hint')}</p>
          <select id="collection-picker"></select>
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