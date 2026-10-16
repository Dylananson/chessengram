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
 *    board-wrap + `div#board` + separate left/right placeholders), creates the
 *    `Chessground` instance on the host once, and patches only the two panel
 *    placeholders. The board vnode never exists, so no
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
  buildPlaybackSteps,
  buildReviewLine,
  type PlaybackStep,
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
import { projectPuzzleStatus, type PuzzleStatusSummary } from './puzzle-status.ts';
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
  /**
   * BRD-001: clear the native premove display. Chessground keeps
   * `premovable.current` across `set()` calls, so the ctrl clears it
   * defensively when the reply window closes. Optional so existing fakes
   * keep working.
   */
  cancelPremove?(): void;
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
  /**
   * BRD-001 premove + selection state (move input only).
   * `awaitingReply` covers the ~260ms opponent-reply window after a correct
   * solver move: the displayed position is pre-reply while the game has
   * already applied the reply. One solver move may be queued in that window
   * and is executed (or silently discarded) when the reply lands.
   */
  private awaitingReply = false;
  private queuedPremove: {
    from: SquareName;
    to: SquareName;
    promotion?: PromotionRole;
  } | null = null;
  private pendingPromotionIsPremove = false;
  /** Last chessground selection, re-asserted when a reply render would drop it. */
  private selectedKey: Key | null = null;
  revealed = false;
  /**
   * Puzzle shown in the info panel. Set by both `beginAttempt` and resume
   * (both painted the info DOM pre-Snabbdom). Kept separate from
   * `currentPuzzle` below on purpose — see `resumeIfPossible`.
   */
  infoPuzzle: NormalizedPuzzle | null = null;
  currentPuzzle: NormalizedPuzzle | null = null;
  review: ReviewNavigator | null = null;
  /**
   * BRD-004 reveal playback: paced, read-only replay of the solution line
   * after a reveal-abandon. Steps are precomputed FENs (never graded, never
   * written to attempt history); the board renders non-interactively and any
   * navigation stops the timer. `playbackPaceMs` is a public field so Node
   * tests can speed the clock without touching the production pace.
   */
  playingBack = false;
  playbackPaceMs = 650;
  private playbackSteps: PlaybackStep[] = [];
  private playbackIndex = 0;
  private playbackTimer: ReturnType<typeof setTimeout> | null = null;
  private reviewKeyTarget: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = null;
  private readonly onReviewKeydown = (event: KeyboardEvent): void => {
    if (!this.review || !this.game?.isCompleted || this.disposed) return;
    const direction = ({
      ArrowLeft: 'back',
      ArrowRight: 'forward',
      ArrowUp: 'last',
      ArrowDown: 'first',
    } as const)[event.key];
    if (!direction) return;
    event.preventDefault();
    this.stepReview(direction);
  };

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
  puzzleStatus: PuzzleStatusSummary | null = null;

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
    this.stopReviewKeys();
    this.stopPlayback();
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
    opts: { fen?: string; lastMove?: Key[]; interactive?: boolean; replyPending?: boolean } = {},
  ): void {
    if (!this.game || this.disposed) return;
    const interactive = opts.interactive ?? this.game.solverTurn;
    // BRD-001: keep the last user selection across reply renders. Only
    // re-assert squares that still hold a solver piece with legal dests;
    // anything else (moved/empty/enemy squares) is dropped.
    if (this.selectedKey && !this.game.legalDests().has(this.selectedKey as SquareName)) {
      this.selectedKey = null;
    }
    this.board.set({
      fen: opts.fen ?? this.game.fen,
      orientation: this.game.orientation,
      // During the reply window the displayed position is pre-reply, so the
      // side to move shown is the opponent's. That (plus movable.color below)
      // is also what lets chessground offer premoves instead of normal moves.
      turnColor: opts.replyPending
        ? this.game.turn === 'white'
          ? 'black'
          : 'white'
        : this.game.turn,
      lastMove: opts.lastMove,
      movable: {
        free: false,
        color: opts.replyPending
          ? this.game.orientation
          : interactive
            ? this.game.orientation
            : undefined,
        dests: opts.replyPending || !interactive ? new Map() : this.game.legalDests(),
        showDests: true,
        events: { after: (o, d) => void this.onUserMove(o, d) },
      },
      // BRD-001: native premove affordance. `set`/`unset` feed the one-slot
      // app queue (promotion flow included); execution stays on the normal
      // grading path when the reply lands.
      premovable: {
        enabled: true,
        showDests: true,
        events: {
          set: (o, d) => this.queuePremove(o as SquareName, d as SquareName),
          unset: () => {
            this.queuedPremove = null;
            this.selectedKey = null;
          },
        },
      },
      events: { select: (key) => this.onBoardSelect(key) },
      ...(this.selectedKey ? { selected: this.selectedKey } : {}),
      draggable: { enabled: true, showGhost: true },
      selectable: { enabled: true },
    });
  }

  // --- move handling -------------------------------------------------------

  async onUserMove(orig: Key, dest: Key): Promise<void> {
    if (!this.game || this.disposed || this.playingBack) return;
    // BRD-001: moves during the reply window become the queued premove.
    if (this.awaitingReply) {
      this.queuePremove(orig as SquareName, dest as SquareName);
      return;
    }
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

  /**
   * BRD-001: track the user's board selection (wired to chessground
   * `events.select`) so the reply render can re-assert it. No board traffic
   * here — chessground already shows the selection natively.
   */
  onBoardSelect(key: Key): void {
    if (this.disposed || this.playingBack) return;
    this.selectedKey = key;
  }

  /**
   * BRD-001: queue one solver move during the reply window. Never grades:
   * legality is decided against the post-reply position when the reply
   * lands — illegal queues are silently discarded, legal ones run the normal
   * `resolveUserMove` grading path (a wrong executed premove is an ordinary
   * wrong move). Promotion queues go through the promotion picker first.
   */
  queuePremove(from: SquareName, to: SquareName): void {
    if (!this.game || this.disposed || !this.awaitingReply) return;
    if (this.game.requiresPromotion(from, to)) {
      this.pendingPromotion = { from: from as Key, to: to as Key };
      this.pendingPromotionColor = this.game.orientation;
      this.pendingPromotionIsPremove = true;
      this.promotionUi.show(this.game.orientation);
      this.redraw();
      return;
    }
    this.queuedPremove = { from, to };
    this.redraw();
  }

  /**
   * BRD-001: consume the queued premove if it is still legal in the
   * post-reply position. Pure gate — illegal queues vanish silently and are
   * never graded; legal ones are returned for normal `resolveUserMove`
   * grading by the caller.
   */
  private takeQueuedPremove(): {
    from: SquareName;
    to: SquareName;
    promotion?: PromotionRole;
  } | null {
    const queued = this.queuedPremove;
    this.queuedPremove = null;
    if (!queued || !this.game || this.disposed) return null;
    if (!this.game.isLegalSolverMove(queued.from, queued.to, queued.promotion)) return null;
    return queued;
  }

  /** BRD-001: drop all premove/selection state (new attempt, skip, reveal). */
  private clearPremoveState(): void {
    this.awaitingReply = false;
    this.queuedPremove = null;
    this.pendingPromotionIsPremove = false;
    this.selectedKey = null;
    this.board.cancelPremove?.();
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

    // An executed move (right or wrong) supersedes any tracked selection.
    this.selectedKey = null;

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
      replyPending: Boolean(result.fenAfterOpponent),
    });

    const attemptGame = this.game;
    const settle = async (): Promise<void> => {
      if (this.disposed) return;
      // BRD-004: a reveal-abandon during the reply window leaves a stale
      // settle behind. It must not grade, complete, or re-enable input —
      // playback owns the board now, and the attempt is already abandoned.
      if (this.revealed) {
        this.renderPosition({ interactive: false });
        this.redraw();
        return;
      }
      this.awaitingReply = false;
      this.board.cancelPremove?.();
      // BRD-001: run the queued premove only for the same attempt while it
      // is still live. Anything else (new puzzle, revealed, skipped) drops
      // the queue silently — never graded, never a failure.
      let premove: { from: SquareName; to: SquareName; promotion?: PromotionRole } | null =
        null;
      if (
        this.game === attemptGame &&
        !this.revealed &&
        this.adapter.getActiveAttemptId()
      ) {
        premove = this.takeQueuedPremove();
      } else {
        this.queuedPremove = null;
      }
      if (premove) {
        await this.resolveUserMove(premove.from, premove.to, premove.promotion);
        return;
      }
      if (result.completed) {
        await this.completePuzzle();
      } else {
        this.status = { key: 'status.correct', tone: 'correct' };
        this.renderPosition();
        this.redraw();
      }
    };

    if (result.fenAfterOpponent) {
      this.awaitingReply = true;
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
    this.stopReviewKeys();
    this.review = null;
  }

  private startReviewKeys(): void {
    if (this.reviewKeyTarget || typeof window === 'undefined') return;
    this.reviewKeyTarget = window;
    window.addEventListener('keydown', this.onReviewKeydown);
  }

  private stopReviewKeys(): void {
    this.reviewKeyTarget?.removeEventListener('keydown', this.onReviewKeydown);
    this.reviewKeyTarget = null;
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
    this.startReviewKeys();
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

  // --- reveal playback (BRD-004, read-only, unscored) --------------------------
  //
  // After a reveal-abandon (assistance `reveal` recorded, attempt abandoned
  // unscored — unchanged), the solution auto-plays on the board at a
  // watchable pace with last-move highlights. On-path (only correct moves so
  // far) the remaining plies play from the current board; off-line (a wrong
  // move went first) the board resets to the solver position, then the full
  // line plays. Steps render through the same non-interactive `renderPosition`
  // primitive as review stepping, but are driven by the solution — never by
  // attempt records, and never graded or written anywhere.

  /** Stop paced playback and drop its timer (any navigation, teardown). */
  stopPlayback(): void {
    if (this.playbackTimer !== null) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.playbackSteps = [];
    this.playbackIndex = 0;
    this.playingBack = false;
  }

  /** Start paced solution playback after a reveal-abandon. */
  startPlayback(): void {
    const game = this.game;
    if (!game || game.isCompleted || this.disposed) return;
    const line = game.solutionPlaybackLine();
    const steps = buildPlaybackSteps(line.startFen, line.plies);
    this.stopPlayback();
    if (steps.length === 0) return;
    if (line.fromStart) {
      this.renderPosition({ fen: line.startFen, interactive: false });
    }
    this.playbackSteps = steps;
    this.playbackIndex = 0;
    this.playingBack = true;
    this.schedulePlaybackStep();
    this.redraw();
  }

  private schedulePlaybackStep(): void {
    if (!this.playingBack || this.disposed) return;
    this.playbackTimer = setTimeout(() => {
      this.playbackTimer = null;
      this.advancePlayback();
    }, this.playbackPaceMs);
  }

  /** Render the next playback ply with last-move highlights. */
  advancePlayback(): void {
    if (!this.playingBack || !this.game || this.disposed) return;
    const step = this.playbackSteps[this.playbackIndex];
    if (!step) {
      this.stopPlayback();
      this.redraw();
      return;
    }
    this.playbackIndex += 1;
    this.renderPosition({
      fen: step.fen,
      lastMove: uciToKeys(step.uci),
      interactive: false,
    });
    if (this.playbackIndex >= this.playbackSteps.length) {
      this.stopPlayback();
    } else {
      this.schedulePlaybackStep();
    }
    this.redraw();
  }

  // --- promotion picker -----------------------------------------------------

  choosePromotion(role: PromotionRole): void {
    const pending = this.pendingPromotion;
    const isPremove = this.pendingPromotionIsPremove;
    this.pendingPromotion = null;
    this.pendingPromotionIsPremove = false;
    this.promotionUi.hide();
    if (!pending) {
      this.renderPosition();
      this.redraw();
      return;
    }
    // BRD-001: a promotion queued during the reply window waits for the
    // reply; a late choice (window already closed) is just a normal move.
    if (isPremove && this.awaitingReply) {
      this.queuedPremove = {
        from: pending.from as SquareName,
        to: pending.to as SquareName,
        promotion: role,
      };
      this.redraw();
      return;
    }
    void this.resolveUserMove(pending.from as SquareName, pending.to as SquareName, role);
  }

  cancelPromotion(): void {
    this.pendingPromotion = null;
    this.pendingPromotionIsPremove = false;
    this.promotionUi.hide();
    this.renderPosition();
    this.redraw();
  }

  // --- attempt lifecycle ---------------------------------------------------

  async beginAttempt(p: NormalizedPuzzle): Promise<void> {
    this.stopPlayback();
    this.game = new PuzzleGame(p);
    this.infoPuzzle = p;
    this.currentPuzzle = p;
    this.refreshPuzzleStatus(p.id);
    this.resetReview();
    this.timer = new AttemptTimer();
    this.scoredCommitted = false;
    this.pendingPromotion = null;
    this.clearPremoveState();
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
    this.stopPlayback();
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
    this.puzzleStatus = null;
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
      this.refreshPuzzleStatus(p.id);
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

  /**
   * BRD-003: restart the completed puzzle as a NEW scored attempt. Only
   * available once the game is completed (success or correction-complete);
   * reuses `beginAttempt`, so the finished attempt's immutable outcome and
   * event history are never touched — `startAttempt` mints a fresh attemptId
   * and the scheduler sees an ordinary attempt on the same puzzle.
   */
  async onRestart(): Promise<void> {
    if (this.disposed) return;
    if (!this.game?.isCompleted) return;
    const puzzle = this.currentPuzzle ?? this.infoPuzzle;
    if (!puzzle) return;
    await this.beginAttempt(puzzle);
  }

  async onSkip(): Promise<void> {
    if (this.disposed) return;
    this.stopPlayback();
    if (!this.adapter.getActiveAttemptId()) return;
    this.clearPremoveState();
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
      this.clearPremoveState();
      this.timer.interrupt();
      await this.adapter.recordAssistance('reveal');
      if (this.disposed) return;
      await this.adapter.abandonCurrentAttempt({ skip: false });
      if (this.disposed) return;
      this.renderPosition({ interactive: false });
      this.nextDisabled = false;
      this.skipDisabled = true;
      this.status = { key: 'status.revealed', tone: 'revealed' };
      this.startPlayback();
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

  /** Refresh read-only schedule/history signals for the displayed puzzle. */
  private refreshPuzzleStatus(puzzleId: string): void {
    const collectionId = this.service.getActiveCollectionId();
    const schedule = this.service.getScheduleState(
      progressKeyToString({ programId: DEFAULT_PROGRAM_ID, collectionId, puzzleId }),
    );
    const attempts = this.service
      .listAttempts({ programId: DEFAULT_PROGRAM_ID, puzzleId })
      .filter((attempt) => attempt.progressKey.collectionId === collectionId);
    this.puzzleStatus = projectPuzzleStatus(schedule, attempts);
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

function puzzleStatusLines(summary: PuzzleStatusSummary | null): VNode[] {
  if (!summary) return [h('p#puzzle-status', t('puzzle.status.new'))];
  const state = t(`puzzle.status.${summary.state}`);
  const when = summary.dueAt === undefined
    ? t('puzzle.status.dueNever')
    : summary.dueAt <= Date.now()
      ? t('puzzle.status.dueNow')
      : new Date(summary.dueAt).toLocaleString();
  const time = (value: number | undefined): string =>
    value === undefined ? t('puzzle.status.unknown') : value.toFixed(1);
  return [
    h('p#puzzle-status', state),
    h('p', t('puzzle.status.algorithm', { algorithm: summary.algorithm })),
    ...(summary.rung === undefined ? [] : [h('p', t('puzzle.status.rung', { rung: summary.rung }))]),
    h('p', t('puzzle.status.due', { when })),
    h('p.progress-note', t('puzzle.status.history', {
      successes: summary.successfulSolves,
      average: time(summary.averageActiveSeconds),
      best: time(summary.bestActiveSeconds),
      lapses: summary.lapses,
    })),
  ];
}

function formatSolveTimer(snapshot: ReturnType<AttemptTimer['snapshot']>): string {
  const seconds = snapshot.activeSolvingSeconds + snapshot.correctionSeconds;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Pure view: same information, ids, classes, and strings as the pre-Snabbdom
 * template (board excluded — see {@link createTrainShell}). Board-adjacent
 * state (review position, button disabled states, solution visibility,
 * picker options) reads live ctrl fields.
 */
function viewLeft(ctrl: TrainCtrl): VNode {
  const review = ctrl.review;
  return h('div.controls.controls-left', [
    h('div.info.status-panel', [
      h('h2', { attrs: { 'data-i18n': 'status.title' } }, t('status.title')),
      h('p#solve-timer', formatSolveTimer(ctrl.timer.snapshot())),
      h(statusClass(ctrl), t(ctrl.status.key, ctrl.status.params)),
    ]),
    h('div.button-row.train-actions', [
      ...(!ctrl.nextDisabled ? [h('button#next-btn.button.button-primary', {
        attrs: { type: 'button', 'aria-label': t('next.label') },
        on: { click: () => void ctrl.loadNext() },
      }, '>')] : []),
      actionButton(
        ctrl.revealHidesSolution ? t('reveal.hide') : t('reveal.show'),
        'secondary',
        { id: 'reveal-btn', disabled: ctrl.revealDisabled, onClick: () => void ctrl.onReveal() },
      ),
      h(`button#restart-btn.button.button-secondary${ctrl.game?.isCompleted ? '' : '.hidden'}`, {
        attrs: { type: 'button', 'aria-label': t('restart.label') },
        on: { click: () => void ctrl.onRestart() },
      }, '↻'),
      h(`button#analyze-btn.button.button-secondary${ctrl.game?.isCompleted || ctrl.game?.failedState ? '' : '.hidden'}`, {
        attrs: { type: 'button', disabled: true, 'aria-label': t('train.analyze.label'), title: t('train.analyze.title') },
      }, '⌕'),
      h(`div.button-row.review-nav${review ? '' : '.hidden'}`, [
        h('button.button.button-secondary', {
          attrs: { type: 'button', id: 'review-back', 'aria-label': t('review.back'), ...(review?.canBack ? {} : { disabled: true }) },
          on: { click: () => ctrl.stepReview('back') },
        }, '◀'),
        h('button.button.button-secondary', {
          attrs: { type: 'button', id: 'review-forward', 'aria-label': t('review.forward'), ...(review?.canForward ? {} : { disabled: true }) },
          on: { click: () => ctrl.stepReview('forward') },
        }, '▶'),
      ]),
      h(`button#practice-btn.button.button-secondary${ctrl.practiceHidden ? '.hidden' : ''}`, {
        attrs: { type: 'button' }, on: { click: () => void ctrl.onPractice() },
      }, ctrl.practiceLabel),
    ]),
    h(`div.info${review ? '' : '.hidden'}`, { attrs: { id: 'review-section' } }, [
      h('h2', { attrs: { 'data-i18n': 'review.title' } }, t('review.title')),
      h('p.progress-note', t('review.hint')),
      h('p#review-label', review ? t('review.position', { index: review.position, total: review.count - 1 }) : ''),
    ]),
  ]);
}

function viewRight(ctrl: TrainCtrl): VNode {
  const puzzle = ctrl.infoPuzzle;
  return h('div.controls.controls-right', [
    h('div.info', [
      h('h2', { attrs: { 'data-i18n': 'puzzle.info' } }, t('puzzle.info')),
      h('p#puzzle-id', puzzle ? `${t('puzzle.id')}: ${puzzle.id}` : '-'),
      ...(ctrl.game?.isCompleted ? [
        h('p#rating', puzzle ? `${t('puzzle.rating')}: ${puzzle.rating}` : '-'),
        h('p#themes', puzzle ? `${t('puzzle.themes')}: ${puzzle.themes.slice(0, 4).join(', ') || t('puzzle.none')}` : '-'),
      ] : []),
      h(
        'p#solver-color',
        puzzle ? `${t('puzzle.solver')}: ${t(`color.${puzzle.solverColor}`)}` : '-',
      ),
    ]),
    h('div.info', [
      h('h2', { attrs: { 'data-i18n': 'puzzle.status.title' } }, t('puzzle.status.title')),
      ...puzzleStatusLines(ctrl.puzzleStatus),
    ]),
    h('div.info', [
      h('h2', { attrs: { 'data-i18n': 'solution.title' } }, t('solution.title')),
      h(
        `div#solution.solution-preview${ctrl.solutionHidden ? '.hidden' : ''}`,
        puzzle ? puzzle.solution.join(' ') : '-',
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

/** Combined DOM-free view retained for callers/tests; mount patches each panel independently. */
export function view(ctrl: TrainCtrl): VNode {
  return h('div.train-panels', [viewLeft(ctrl), viewRight(ctrl)]);
}

export interface TrainShell {
  /** Static root appended to the screen host; removed on unmount. */
  root: HTMLElement;
  /** The chessground host (`div#board`). Never part of the patched subtree. */
  boardHost: HTMLElement;
  /** Static wrapper around the board. */
  boardWrap: HTMLElement;
  leftPlaceholder: HTMLElement;
  rightPlaceholder: HTMLElement;
}

/**
 * Build the static Train shell in the given document: responsive layout + board-wrap +
 * `div#board` host + separate left/right patch placeholders. Called once per
 * mount; panel views never include or touch the board, so patches can never
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
  const boardHost = doc.createElement('div');
  boardHost.id = 'board';
  boardHost.className = 'board';
  boardHost.setAttribute('aria-label', t('board.title'));
  boardWrap.appendChild(boardHost);
  const leftPlaceholder = doc.createElement('div');
  leftPlaceholder.className = 'controls-slot controls-left-slot';
  const rightPlaceholder = doc.createElement('div');
  rightPlaceholder.className = 'controls-slot controls-right-slot';
  layout.appendChild(leftPlaceholder);
  layout.appendChild(boardWrap);
  layout.appendChild(rightPlaceholder);
  root.appendChild(layout);
  return { root, boardHost, boardWrap, leftPlaceholder, rightPlaceholder };
}

export class TrainView implements Screen {
  readonly id = 'train' as const;

  private readonly ctx: AppContext;
  private host: HTMLElement | null = null;
  private shell: TrainShell | null = null;
  private ground: Api | null = null;
  private ctrl: TrainCtrl | null = null;
  private leftVnode: VNode | null = null;
  private rightVnode: VNode | null = null;
  private unbindPromotion: (() => void) | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

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
          cancelPremove: () => ground.cancelPremove(),
          destroy: () => ground.destroy(),
        },
        {
          show: (color) => this.showPromotion(color),
          hide: () => this.hidePromotion(),
        },
      );
      this.ctrl = ctrl;
      this.leftVnode = patch(shell.leftPlaceholder, viewLeft(ctrl));
      this.rightVnode = patch(shell.rightPlaceholder, viewRight(ctrl));
      this.timerInterval = setInterval(() => ctrl.redraw(), 1000);
      ctrl.redraw = () => {
        if (this.ctrl === null || this.leftVnode === null || this.rightVnode === null) return;
        this.leftVnode = patch(this.leftVnode, viewLeft(this.ctrl));
        this.rightVnode = patch(this.rightVnode, viewRight(this.ctrl));
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
    if (this.timerInterval !== null) clearInterval(this.timerInterval);
    this.timerInterval = null;
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
     this.leftVnode = null;
     this.rightVnode = null;
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
