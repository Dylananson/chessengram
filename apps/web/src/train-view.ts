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
 *
 * Rendering (UI-001 S6 — the S2 ctrl/view/redraw pattern from history-view,
 * last and highest-risk because of the live board):
 *
 *  - Mutable state lives in {@link TrainCtrl} (game, timer, attempt flags,
 *    status, button states, review navigator, picker snapshot). {@link view}
 *    is a pure `(ctrl) => VNode` function rendering everything EXCEPT the
 *    board. `h`/`init`/modules come from DOM-free `snabbdom/build/*` deep
 *    subpaths (never the package root, which touches `window` at load), so
 *    the ctrl, the shell builder, and `view` stay importable under Node.
 *    Only `TrainView.mount` touches the DOM.
 *  - The chessground host element lives OUTSIDE the patched subtree.
 *    `mount` builds a static shell via {@link createTrainShell} (layout +
 *    board-wrap + `div#board` + an empty controls placeholder), creates the
 *    `Chessground` instance on the host once, and patches ONLY the
 *    placeholder with `view(ctrl)`. The board vnode never exists, so no
 *    patch can remount it; all board updates go through the imperative
 *    {@link TrainBoardPort} (`ground.set(...)`), and unmount destroys the
 *    ground. The global `#promotion` overlay (owned by `index.html`) likewise
 *    stays outside the tree and is synced imperatively through
 *    {@link TrainPromotionUi}.
 *  - Grading/selection logic is untouched: it lives in `puzzle-game.ts`,
 *    the adapter, and the service. This file only moved the DOM writes into
 *    vnodes + `redraw()` calls.
 *
 * Deviations from the S2 pilot (all preserve exact pre-Snabbdom hooks):
 * the info/status/solution/review shells stay raw `h()` vnodes (smoke + CSS
 * hooks depend on the legacy `div.info`/`h2`, `#status.status.*` shapes), as
 * does the practice button with its conditional `.hidden` class; every other
 * button uses the S1 `actionButton` helper (same classes/ids/strings in the
 * DOM — S7 polish). Async mount patches the placeholder immediately (loading
 * status paints synchronously, as before) then runs the resume/select flow
 * — the S4 shape.
 */

import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Key } from 'chessground/types';
import type { SquareName } from 'chessops/types';
import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import type { NormalizedPuzzle } from '@chessreps/contracts';
import { selectEarliestFutureDue, type Candidate } from '@chessreps/scheduler';
import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import {
  PuzzleGame,
  ReviewNavigator,
  buildReviewLine,
  type PromotionRole,
} from './puzzle-game.ts';
import type { Screen } from './router.ts';
import {
  DEFAULT_PROGRAM_ID,
  progressKeyToString,
  type LocalTrainingService,
} from './scheduler-service.ts';
import { AttemptTimer } from './timing.ts';
import type { TrainingAdapter } from './training-adapter.ts';
import { actionButton } from './ui/primitives.ts';
// Screen patch function: the shared `./ui/patch.ts` setup (`attributes`
// for ids/disabled, `eventListeners` for `on: { click/change }`, `props`
// for the live picker value).
import { screenPatch as patch } from './ui/patch.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** The chessground `set()` config, as accepted by the live instance. */
export type TrainBoardConfig = Parameters<Api['set']>[0];

/**
 * Imperative board seam. The ctrl renders positions into this port; the
 * mount site wires it to the real chessground instance, tests wire a
 * recording fake. The port object identity never changes within a mount, and
 * `destroy` runs only on unmount — `redraw()` never touches the board.
 */
export interface TrainBoardPort {
  set(config: TrainBoardConfig): void;
  destroy(): void;
}

/** No-op board port: the ctrl default, so Node tests never need a DOM. */
export const NoopBoard: TrainBoardPort = {
  set(): void {},
  destroy(): void {},
};

/**
 * Imperative promotion-overlay seam. The overlay element is global (owned by
 * `index.html`, outside every patched subtree); the mount site syncs it from
 * ctrl state, tests record the calls. Glyph/label resolution stays here with
 * the ctrl so the shell is a thin DOM writer.
 */
export interface TrainPromotionUi {
  show(color: 'white' | 'black'): void;
  hide(): void;
}

/** No-op promotion seam: the ctrl default for Node tests. */
export const NoopPromotionUi: TrainPromotionUi = {
  show(): void {},
  hide(): void {},
};

export type TrainStatusTone = 'info' | 'correct' | 'wrong' | 'completed' | 'revealed';

export interface TrainStatus {
  key: string;
  tone: TrainStatusTone;
  params?: Record<string, string | number>;
}

export interface TrainCollectionOption {
  id: string;
  name: string;
}

/**
 * Per-screen controller: owns the game, timer, attempt flags, status, button
 * states, review navigator, and picker snapshot, plus the `board` /
 * `promotionUi` ports and the `redraw` closure the mount site installs.
 * Every mutation path ends in `redraw()` (mirroring the S2 History seam);
 * the board port carries positions imperatively and is never redrawn.
 * DOM-free: safe to drive under Node with fake ports.
 */
export class TrainCtrl {
  game: PuzzleGame | null = null;
  timer = new AttemptTimer();
  scoredCommitted = false;
  pendingPromotion: { from: Key; to: Key } | null = null;
  pendingPromotionColor: 'white' | 'black' = 'white';
  revealed = false;
  /**
   * Puzzle shown in the info panel. Set by both `beginAttempt` and resume
   * (both painted the info DOM pre-Snabbdom). Kept separate from
   * `currentPuzzle` below on purpose — see `resumeIfPossible`.
   */
  infoPuzzle: NormalizedPuzzle | null = null;
  currentPuzzle: NormalizedPuzzle | null = null;
  review: ReviewNavigator | null = null;

  status: TrainStatus = { key: 'status.loading', tone: 'info' };
  solutionHidden = true;
  revealHidesSolution = false;
  nextDisabled = true;
  skipDisabled = false;
  revealDisabled = false;
  practiceHidden = true;
  practiceLabel: string = t('practiceAhead.label');
  collections: TrainCollectionOption[] = [];
  activeCollectionId = '';
  progressText = '';
  storageText = '';
  queueText = '';

  board: TrainBoardPort;
  promotionUi: TrainPromotionUi;
  redraw: () => void = () => {};
  disposed = false;

  private readonly service: LocalTrainingService;
  private readonly adapter: TrainingAdapter;

  constructor(
    service: LocalTrainingService,
    adapter: TrainingAdapter,
    board: TrainBoardPort = NoopBoard,
    promotionUi: TrainPromotionUi = NoopPromotionUi,
    redraw: () => void = () => {},
  ) {
    this.service = service;
    this.adapter = adapter;
    this.board = board;
    this.promotionUi = promotionUi;
    this.redraw = redraw;
    this.collections = service.listCollections().map((collection) => ({
      id: collection.id,
      name: collection.name,
    }));
    this.activeCollectionId = service.getActiveCollectionId();
  }

  /** Mark torn down: late async continuations become no-ops. */
  dispose(): void {
    this.disposed = true;
    this.board = NoopBoard;
    this.promotionUi = NoopPromotionUi;
    this.redraw = () => {};
  }

  interruptTimer(): void {
    this.timer.interrupt();
  }

  resumeTimer(): void {
    this.timer.resume();
  }

  // --- board rendering -----------------------------------------------------

  private renderPosition(
    opts: { fen?: string; lastMove?: Key[]; interactive?: boolean } = {},
  ): void {
    if (!this.game || this.disposed) return;
    const interactive = opts.interactive ?? this.game.solverTurn;
    this.board.set({
      fen: opts.fen ?? this.game.fen,
      orientation: this.game.orientation,
      turnColor: this.game.turn,
      lastMove: opts.lastMove,
      movable: {
        free: false,
        color: interactive ? this.game.orientation : undefined,
        dests: interactive ? this.game.legalDests() : new Map(),
        showDests: true,
        events: { after: (o, d) => void this.onUserMove(o, d) },
      },
      draggable: { enabled: true, showGhost: true },
      selectable: { enabled: true },
    });
  }

  // --- move handling -------------------------------------------------------

  async onUserMove(orig: Key, dest: Key): Promise<void> {
    if (!this.game || this.disposed) return;
    if (this.game.requiresPromotion(orig as SquareName, dest as SquareName)) {
      this.pendingPromotion = { from: orig, to: dest };
      this.pendingPromotionColor = this.game.orientation;
      this.renderPosition();
      this.promotionUi.show(this.game.orientation);
      this.redraw();
      return;
    }
    await this.resolveUserMove(orig as SquareName, dest as SquareName);
  }

  async resolveUserMove(
    from: SquareName,
    to: SquareName,
    promotion?: PromotionRole,
  ): Promise<void> {
    if (!this.game || this.disposed) return;
    const result = this.game.playUserMove(from, to, promotion);

    if (result.kind === 'illegal' || result.kind === 'ignored' || result.kind === 'needs-promotion') {
      this.renderPosition();
      this.redraw();
      return;
    }

    if (result.kind === 'wrong') {
      await this.adapter.recordWrongMove(result.uci);
      if (this.disposed) return;
      if (!this.scoredCommitted) {
        this.scoredCommitted = true;
        this.timer.markFailure();
        await this.adapter.commitFailure(this.timer.snapshot());
        if (this.disposed) return;
      }
      this.status = { key: 'status.wrong', tone: 'wrong' };
      this.renderPosition();
      this.redraw();
      return;
    }

    await this.adapter.recordMove(result.uci, true);
    if (this.disposed) return;
    this.renderPosition({
      fen: result.fenAfterSolver,
      lastMove: [from as Key, to as Key],
      interactive: false,
    });

    const settle = async (): Promise<void> => {
      if (this.disposed) return;
      if (result.completed) {
        await this.completePuzzle();
      } else {
        this.status = { key: 'status.correct', tone: 'correct' };
        this.renderPosition();
        this.redraw();
      }
    };

    if (result.fenAfterOpponent) {
      // Global setTimeout (identical to window.setTimeout in the browser,
      // but Node-safe so the ctrl stays testable without a DOM).
      setTimeout(() => void settle(), 260);
    } else {
      await settle();
    }
  }

  private async completePuzzle(): Promise<void> {
    if (!this.game || this.disposed) return;
    if (this.game.failedState) {
      await this.adapter.finishCorrection(this.timer.snapshot());
      if (this.disposed) return;
      this.status = { key: 'status.correctionComplete', tone: 'completed' };
    } else {
      if (!this.scoredCommitted) {
        this.scoredCommitted = true;
        await this.adapter.commitSuccess(this.timer.snapshot());
        if (this.disposed) return;
      }
      this.status = { key: 'status.completed', tone: 'completed' };
    }
    this.renderPosition({ interactive: false });
    this.nextDisabled = false;
    this.skipDisabled = true;
    this.updateProgress();
    this.enterReview();
    this.redraw();
  }

  // --- attempt review (read-only, completed puzzles only) -------------------
  //
  // B5/AN-001a: after a puzzle completes, the user can step back/forward
  // through their own attempt (solver plies + auto-played opponent replies,
  // wrong attempts included) with the board rendered at each step. Review is
  // entered only from the completed state, renders non-interactively, and
  // performs no schedule or attempt writes (read via `listAttemptsForPuzzle`).

  /** Drop review state (new attempt starting); the view hides the section. */
  resetReview(): void {
    this.review = null;
  }

  /**
   * Build the review line from the recorded attempt events. No-op unless the
   * puzzle is completed.
   */
  enterReview(): void {
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
    this.renderReviewStep();
  }

  /** Render the navigator's current step. Non-interactive; no state writes. */
  renderReviewStep(): void {
    if (!this.review || !this.game?.isCompleted || this.disposed) return;
    const step = this.review.current();
    this.renderPosition({
      fen: step.fen,
      lastMove: step.uci ? uciToKeys(step.uci) : undefined,
      interactive: false,
    });
  }

  stepReview(direction: 'first' | 'back' | 'forward' | 'last'): void {
    if (!this.review || !this.game?.isCompleted) return;
    if (direction === 'first') this.review.first();
    else if (direction === 'back') this.review.back();
    else if (direction === 'forward') this.review.forward();
    else this.review.last();
    this.renderReviewStep();
    this.redraw();
  }

  // --- promotion picker -----------------------------------------------------

  choosePromotion(role: PromotionRole): void {
    const pending = this.pendingPromotion;
    this.pendingPromotion = null;
    this.promotionUi.hide();
    if (!pending) {
      this.renderPosition();
      this.redraw();
      return;
    }
    void this.resolveUserMove(pending.from as SquareName, pending.to as SquareName, role);
  }

  cancelPromotion(): void {
    this.pendingPromotion = null;
    this.promotionUi.hide();
    this.renderPosition();
    this.redraw();
  }

  // --- attempt lifecycle ---------------------------------------------------

  async beginAttempt(p: NormalizedPuzzle): Promise<void> {
    this.game = new PuzzleGame(p);
    this.infoPuzzle = p;
    this.currentPuzzle = p;
    this.resetReview();
    this.timer = new AttemptTimer();
    this.scoredCommitted = false;
    this.pendingPromotion = null;
    this.revealed = false;
    this.promotionUi.hide();

    await this.adapter.startAttempt(p);
    if (this.disposed) return;
    this.timer.start();

    this.nextDisabled = true;
    this.skipDisabled = false;
    this.revealDisabled = false;
    this.practiceHidden = true;
    this.solutionHidden = true;
    this.revealHidesSolution = false;
    this.status = {
      key: 'status.yourTurn',
      tone: 'info',
      params: { color: t(`color.${p.solverColor}`) },
    };
    this.renderPosition();
    this.updateProgress();
    this.redraw();
  }

  async loadNext(): Promise<void> {
    if (this.disposed) return;
    if (this.game?.isCompleted === false && this.adapter.getActiveAttemptId()) return;
    this.nextDisabled = true;
    this.practiceHidden = true;
    this.redraw();
    const selection = await this.adapter.selectNext();
    if (this.disposed) return;
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
  showNoDue(selection: {
    puzzleId: string | null;
    nextDueAt?: number;
    reason?: string;
  }): void {
    const when = selection.nextDueAt
      ? new Date(selection.nextDueAt).toLocaleString()
      : t('puzzle.none');
    if (selection.reason === 'queue-empty') {
      this.status = { key: 'status.queueEmpty', tone: 'info' };
      this.practiceHidden = true;
    } else {
      if (selection.reason === 'daily-limit-reached') {
        this.status = { key: 'status.dailyLimit', tone: 'info', params: { when } };
      } else {
        this.status = { key: 'status.noDue', tone: 'info', params: { when } };
      }
      const target = this.findPracticeTarget(selection.reason);
      if (target) {
        this.practiceLabel = t(
          target.kind === 'ahead' ? 'practiceAhead.label' : 'practiceNew.label',
        );
        this.practiceHidden = false;
      } else {
        this.practiceHidden = true;
      }
    }
    this.nextDisabled = false;
    this.redraw();
  }

  /** Resolve the opt-in practice target, if any. Pure read of service state. */
  findPracticeTarget(reason?: string): { puzzleId: string; kind: 'ahead' | 'new' } | null {
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
  async onPractice(): Promise<void> {
    if (this.disposed) return;
    if (this.adapter.getActiveAttemptId()) return;
    const selection = await this.adapter.selectNext();
    if (this.disposed) return;
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
    if (this.disposed) return;
    if (target.kind === 'ahead') {
      this.status = {
        key: 'status.practiceAhead',
        tone: 'info',
        params: {
          id: target.puzzleId,
          when: whenValue ? new Date(whenValue).toLocaleString() : t('puzzle.none'),
        },
      };
      this.redraw();
    }
  }

  /** Rebuild the current attempt after a reload, if one is still open. */
  async resumeIfPossible(): Promise<boolean> {
    const sessionId = this.adapter.getSessionId();
    if (!sessionId) return false;
    const attempt = this.service.getActiveAttempt(sessionId);
    if (!attempt) return false;

    try {
      const p = await this.adapter.loadPuzzle(attempt.progressKey.puzzleId);
      if (this.disposed) return false;
      this.game = new PuzzleGame(p);
      this.infoPuzzle = p;
      // NOTE: `currentPuzzle` is intentionally left untouched here, matching
      // the pre-Snabbdom flow: a directly-resumed completion enters review
      // only once a fresh `beginAttempt` has set the current puzzle.

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
      this.promotionUi.hide();
      this.solutionHidden = true;
      this.revealHidesSolution = false;
      this.revealed = false;

      this.skipDisabled = false;
      this.revealDisabled = false;

      if (this.game.isCompleted) {
        this.nextDisabled = false;
        await this.completePuzzle();
      } else if (failed) {
        this.nextDisabled = true;
        this.status = { key: 'status.failedButSolving', tone: 'wrong' };
        this.redraw();
      } else {
        this.nextDisabled = true;
        this.status = {
          key: 'status.yourTurn',
          tone: 'info',
          params: { color: t(`color.${p.solverColor}`) },
        };
        this.redraw();
      }
      this.renderPosition();
      this.updateProgress();
      this.redraw();
      return true;
    } catch (err) {
      console.warn('Resume failed; starting a fresh selection', err);
      await this.adapter.abandonCurrentAttempt({ skip: false });
      return false;
    }
  }

  // --- actions -------------------------------------------------------------

  async onSkip(): Promise<void> {
    if (this.disposed) return;
    if (!this.adapter.getActiveAttemptId()) return;
    this.timer.interrupt();
    await this.adapter.abandonCurrentAttempt({ skip: true });
    if (this.disposed) return;
    await this.loadNext();
  }

  async onReveal(): Promise<void> {
    if (this.disposed) return;
    if (this.revealed) {
      this.solutionHidden = !this.solutionHidden;
      this.redraw();
      return;
    }
    this.revealed = true;
    if (this.game && !this.game.isCompleted && this.adapter.getActiveAttemptId()) {
      this.timer.interrupt();
      await this.adapter.recordAssistance('reveal');
      if (this.disposed) return;
      await this.adapter.abandonCurrentAttempt({ skip: false });
      if (this.disposed) return;
      this.renderPosition({ interactive: false });
      this.nextDisabled = false;
      this.skipDisabled = true;
      this.status = { key: 'status.revealed', tone: 'revealed' };
    }
    this.solutionHidden = false;
    this.revealHidesSolution = true;
    this.updateProgress();
    this.redraw();
  }

  // --- active-collection picker (B4) -----------------------------------------
  //
  // Queue/progress follow the persisted active collection. Switching starts a
  // fresh session in the new scope; an in-flight attempt keeps its original
  // scope and stays committable, the next selection uses the new collection.

  /** Rebuild the picker options from the service; selection follows the service. */
  refreshPicker(): void {
    this.collections = this.service.listCollections().map((collection) => ({
      id: collection.id,
      name: collection.name,
    }));
    this.activeCollectionId = this.service.getActiveCollectionId();
    this.redraw();
  }

  async onCollectionChange(collectionId: string): Promise<void> {
    if (this.disposed) return;
    if (!collectionId || collectionId === this.service.getActiveCollectionId()) return;
    await this.service.setActiveCollectionId(collectionId);
    if (this.disposed) return;
    await this.adapter.startSession(DEFAULT_PROGRAM_ID, collectionId);
    if (this.disposed) return;
    this.refreshPicker();
    this.updateProgress();
    this.redraw();
    if (!this.adapter.getActiveAttemptId()) {
      await this.loadNext();
    }
  }

  updateProgress(): void {
    const activeCollection = this.service.getActiveCollectionId();
    const q = this.service.queueSummary(DEFAULT_PROGRAM_ID, activeCollection);
    this.progressText = t('progress.summary', {
      attempts: this.service.getAttemptCount(),
      total: q.total,
    });
    this.storageText = t('progress.storage', {
      backend: t(
        this.service.getBackendKind() === 'indexeddb' ? 'storage.indexeddb' : 'storage.memory',
      ),
    });
    this.queueText = t('queue.summary', {
      total: q.total,
      newCount: q.newCount,
      due: q.due,
      learned: q.learned,
    });
  }
}

export const PROMOTION_GLYPHS: Record<'white' | 'black', Record<PromotionRole, string>> = {
  white: { q: '♕', r: '♖', b: '♗', n: '♘' },
  black: { q: '♛', r: '♜', b: '♝', n: '♞' },
};

export function roleName(role: PromotionRole): string {
  return role === 'q' ? 'queen' : role === 'r' ? 'rook' : role === 'b' ? 'bishop' : 'knight';
}

export function promotionGlyph(color: 'white' | 'black', role: PromotionRole): string {
  return PROMOTION_GLYPHS[color][role];
}

/** Last-move highlight squares for a review step (`e2e4` → `['e2', 'e4']`). */
function uciToKeys(uci: string): Key[] | undefined {
  const match = /^[a-h][1-8][a-h][1-8][qrbn]?$/.exec(uci);
  if (!match) return undefined;
  return [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key];
}

function statusClass(ctrl: TrainCtrl): string {
  let sel = 'div#status.status';
  if (ctrl.status.tone !== 'info') sel += `.${ctrl.status.tone}`;
  if (ctrl.game?.failedState && !ctrl.game.isCompleted) sel += '.failed-but-solving';
  return sel;
}

/**
 * Pure view: same information, ids, classes, and strings as the pre-Snabbdom
 * template (board excluded — see {@link createTrainShell}). Board-adjacent
 * state (review position, button disabled states, solution visibility,
 * picker options) reads live ctrl fields.
 */
export function view(ctrl: TrainCtrl): VNode {
  const puzzle = ctrl.infoPuzzle;
  const review = ctrl.review;
  return h('div.controls', [
    h('div.info', [
      h('h2', { attrs: { 'data-i18n': 'puzzle.info' } }, t('puzzle.info')),
      h('p#puzzle-id', puzzle ? `${t('puzzle.id')}: ${puzzle.id}` : '-'),
      h('p#rating', puzzle ? `${t('puzzle.rating')}: ${puzzle.rating}` : '-'),
      h(
        'p#themes',
        puzzle
          ? `${t('puzzle.themes')}: ${puzzle.themes.slice(0, 4).join(', ') || t('puzzle.none')}`
          : '-',
      ),
      h(
        'p#solver-color',
        puzzle ? `${t('puzzle.solver')}: ${t(`color.${puzzle.solverColor}`)}` : '-',
      ),
    ]),
    h('div.info', [
      h('h2', { attrs: { 'data-i18n': 'status.title' } }, t('status.title')),
      h(statusClass(ctrl), t(ctrl.status.key, ctrl.status.params)),
    ]),
    h('div.info', [
      h('h2', { attrs: { 'data-i18n': 'solution.title' } }, t('solution.title')),
      h('div.button-row', [
        actionButton(
          ctrl.revealHidesSolution ? t('reveal.hide') : t('reveal.show'),
          'secondary',
          {
            id: 'reveal-btn',
            disabled: ctrl.revealDisabled,
            onClick: () => void ctrl.onReveal(),
          },
        ),
      ]),
      h(
        `div#solution.solution-preview${ctrl.solutionHidden ? '.hidden' : ''}`,
        puzzle ? puzzle.solution.join(' ') : '-',
      ),
    ]),
    h(`div.info${review ? '' : '.hidden'}`, { attrs: { id: 'review-section' } }, [
      h('h2', { attrs: { 'data-i18n': 'review.title' } }, t('review.title')),
      h('p.progress-note', t('review.hint')),
      h(
        'p#review-label',
        review
          ? t('review.position', { index: review.position, total: review.count - 1 })
          : '',
      ),
      h('div.button-row', [
        actionButton(t('review.first'), 'secondary', {
          id: 'review-first',
          disabled: !review?.canBack,
          onClick: () => ctrl.stepReview('first'),
        }),
        actionButton(t('review.back'), 'secondary', {
          id: 'review-back',
          disabled: !review?.canBack,
          onClick: () => ctrl.stepReview('back'),
        }),
        actionButton(t('review.forward'), 'secondary', {
          id: 'review-forward',
          disabled: !review?.canForward,
          onClick: () => ctrl.stepReview('forward'),
        }),
        actionButton(t('review.last'), 'secondary', {
          id: 'review-last',
          disabled: !review?.canForward,
          onClick: () => ctrl.stepReview('last'),
        }),
      ]),
    ]),
    h('div.button-row', [
      actionButton(t('skip.label'), 'secondary', {
        id: 'skip-btn',
        disabled: ctrl.skipDisabled,
        onClick: () => void ctrl.onSkip(),
      }),
      actionButton(t('next.label'), 'primary', {
        id: 'next-btn',
        disabled: ctrl.nextDisabled,
        onClick: () => void ctrl.loadNext(),
      }),
      // Raw vnode: the conditional `.hidden` class has no `actionButton`
      // expression (same id/classes/strings in the DOM).
      h(
        `button#practice-btn.button.button-secondary${ctrl.practiceHidden ? '.hidden' : ''}`,
        {
          attrs: { type: 'button' },
          on: { click: () => void ctrl.onPractice() },
        },
        ctrl.practiceLabel,
      ),
    ]),
    h('div.info', [
      h('h2', t('collections.active.label')),
      h('p.progress-note', t('collections.active.hint')),
      h(
        'select#collection-picker',
        {
          props: { value: ctrl.activeCollectionId },
          on: {
            change: (event: Event) =>
              void ctrl.onCollectionChange((event.target as HTMLSelectElement).value),
          },
        },
        ctrl.collections.map((collection) =>
          h('option', { attrs: { value: collection.id } }, collection.name),
        ),
      ),
    ]),
    h('div.info', [
      h('h2', { attrs: { 'data-i18n': 'queue.title' } }, t('queue.title')),
      h('p#queue.progress-note', ctrl.queueText),
    ]),
    h('div', [
      h('p#progress.progress-note', ctrl.progressText),
      h('p#storage.progress-note', ctrl.storageText),
    ]),
  ]);
}

export interface TrainShell {
  /** Static root appended to the screen host; removed on unmount. */
  root: HTMLElement;
  /** The chessground host (`div#board`). Never part of the patched subtree. */
  boardHost: HTMLElement;
  /** Empty placeholder the snabbdom patch replaces with `view(ctrl)`. */
  uiPlaceholder: HTMLElement;
}

/**
 * Build the static Train shell in the given document: layout + board-wrap +
 * `div#board` host + an empty controls placeholder. Called exactly once per
 * `mount`; `view()` renders only into the placeholder, so patches can never
 * create, move, or replace the board host. Takes the document as a parameter
 * so the one-creation-per-mount property is assertable without a browser.
 */
export function createTrainShell(doc: Document): TrainShell {
  const root = doc.createElement('div');
  root.className = 'train-screen';
  const layout = doc.createElement('div');
  layout.className = 'layout';
  const boardWrap = doc.createElement('div');
  boardWrap.className = 'board-wrap';
  const info = doc.createElement('div');
  info.className = 'info';
  const heading = doc.createElement('h2');
  heading.setAttribute('data-i18n', 'board.title');
  heading.textContent = t('board.title');
  const boardHost = doc.createElement('div');
  boardHost.id = 'board';
  boardHost.className = 'board';
  boardHost.setAttribute('aria-label', t('board.title'));
  info.appendChild(heading);
  info.appendChild(boardHost);
  boardWrap.appendChild(info);
  const uiPlaceholder = doc.createElement('div');
  layout.appendChild(boardWrap);
  layout.appendChild(uiPlaceholder);
  root.appendChild(layout);
  return { root, boardHost, uiPlaceholder };
}

export class TrainView implements Screen {
  readonly id = 'train' as const;

  private readonly ctx: AppContext;
  private host: HTMLElement | null = null;
  private shell: TrainShell | null = null;
  private ground: Api | null = null;
  private ctrl: TrainCtrl | null = null;
  private vnode: VNode | null = null;
  private unbindPromotion: (() => void) | null = null;

  private get service() {
    return this.ctx.service;
  }

  private get adapter() {
    return this.ctx.adapter;
  }

  private readonly onVisibility = (): void => {
    if (this.ctrl === null) return;
    if (document.hidden) this.ctrl.interruptTimer();
    else this.ctrl.resumeTimer();
  };

  private readonly onBeforeUnload = (): void => {
    this.ctrl?.interruptTimer();
  };

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  mount(host: HTMLElement): Promise<void> {
    return (async () => {
      this.host = host;
      // Static shell first: the board host is created exactly once here and
      // is never part of the vnode tree below.
      const shell = createTrainShell(document);
      host.appendChild(shell.root);
      this.shell = shell;

      this.ground = Chessground(shell.boardHost, {
        fen: START_FEN,
        orientation: 'white',
        coordinates: true,
        animation: { enabled: true, duration: 180 },
        movable: {
          free: false,
          showDests: true,
          events: { after: (o, d) => void this.ctrl?.onUserMove(o, d) },
        },
      });

      this.bindPromotionOverlay();
      document.addEventListener('visibilitychange', this.onVisibility);
      window.addEventListener('beforeunload', this.onBeforeUnload);

      // Patch the placeholder synchronously so the loading status paints
      // immediately (as the old template did), then run the async flow.
      const ground = this.ground;
      const ctrl = new TrainCtrl(
        this.service,
        this.adapter,
        {
          set: (config) => ground.set(config),
          destroy: () => ground.destroy(),
        },
        {
          show: (color) => this.showPromotion(color),
          hide: () => this.hidePromotion(),
        },
      );
      this.ctrl = ctrl;
      this.vnode = patch(shell.uiPlaceholder, view(ctrl));
      ctrl.redraw = () => {
        if (this.ctrl === null || this.vnode === null) return;
        this.vnode = patch(this.vnode, view(this.ctrl));
      };

      const resumed = await ctrl.resumeIfPossible();
      if (this.ctrl === null) return;
      if (!resumed) {
        const selection = await this.adapter.selectNext();
        if (this.ctrl === null) return;
        if (selection.puzzleId) {
          await this.beginAttemptSafe(await this.adapter.loadPuzzle(selection.puzzleId));
        } else {
          ctrl.showNoDue(selection);
        }
      }
      if (this.ctrl === null) return;
      ctrl.refreshPicker();
      ctrl.updateProgress();
      ctrl.redraw();
    })();
  }

  private async beginAttemptSafe(p: NormalizedPuzzle): Promise<void> {
    if (this.ctrl === null) return;
    await this.ctrl.beginAttempt(p);
  }

  unmount(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.hidePromotion();
    this.unbindPromotion?.();
    this.unbindPromotion = null;
    // Swap the ctrl onto no-op ports first so any late async continuation
    // cannot touch the destroyed ground, then destroy it exactly once.
    this.ctrl?.dispose();
    this.ctrl = null;
    try {
      this.ground?.destroy();
    } finally {
      this.ground = null;
    }
    this.shell?.root.remove();
    this.shell = null;
    this.vnode = null;
    this.host = null;
  }

  // --- promotion overlay (global `#promotion`, outside the patched tree) ---

  private showPromotion(color: 'white' | 'black'): void {
    const overlay = document.getElementById('promotion');
    if (!overlay) return;
    overlay.querySelectorAll<HTMLButtonElement>('[data-promotion]').forEach((b) => {
      const role = b.getAttribute('data-promotion') as PromotionRole;
      b.textContent = promotionGlyph(color, role);
      b.setAttribute('aria-label', t(`promotion.${roleName(role)}`));
    });
    overlay.classList.remove('hidden');
  }

  private hidePromotion(): void {
    document.getElementById('promotion')?.classList.add('hidden');
  }

  private bindPromotionOverlay(): void {
    const overlay = document.getElementById('promotion');
    if (!overlay) {
      this.unbindPromotion = null;
      return;
    }
    const onChoice = (e: Event): void => {
      const role = (e.currentTarget as HTMLElement).getAttribute('data-promotion') as PromotionRole;
      this.ctrl?.choosePromotion(role);
    };
    const onOverlayClick = (e: Event): void => {
      if (e.target === overlay) {
        this.ctrl?.cancelPromotion();
      }
    };
    overlay.querySelectorAll<HTMLButtonElement>('[data-promotion]').forEach((b) => {
      b.addEventListener('click', onChoice);
    });
    overlay.addEventListener('click', onOverlayClick);
    this.unbindPromotion = () => {
      overlay.querySelectorAll<HTMLButtonElement>('[data-promotion]').forEach((b) => {
        b.removeEventListener('click', onChoice);
      });
      overlay.removeEventListener('click', onOverlayClick);
    };
  }
}
