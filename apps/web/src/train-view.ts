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
import {
  bestMoveOf,
  formatLine,
  getAnalysisService,
  type AnalysisService,
  type PositionAnalysis,
} from './engine/analysis.ts';
import { openAnalysis, rememberAnalysisFen } from './analysis-view.ts';
import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import type { NormalizedPuzzle } from '@chessengram/contracts';
import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import {
  PuzzleGame,
  ReviewNavigator,
  buildMoveList,
  buildPlaybackSteps,
  buildReviewLine,
  orderedAttemptMoves,
  type MoveListCell,
  type PlaybackStep,
  type PromotionRole,
} from './puzzle-game.ts';
import type { Screen } from './router.ts';
import {
  DEFAULT_PROGRAM_ID,
  WOODPECKER_CYCLE_PROGRAM_ID,
  WOODPECKER_FAILED_PROGRAM_ID,
  WOODPECKER_REVIEW_PROGRAM_ID,
  woodpeckerScopeId,
  progressKeyToString,
  type LocalTrainingService,
} from './scheduler-service.ts';
import { AttemptTimer } from './timing.ts';
import type { TrainingAdapter } from './training-adapter.ts';
import { actionButton, progressBar } from './ui/primitives.ts';
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
  /**
   * PZL-004: animate a programmatic move (the puzzle's setup move) without
   * going through the grading path. Optional so existing fakes keep working.
   */
  move?(orig: Key, dest: Key): void;
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
  private hintSquare: Key | null = null;
  /**
   * Puzzle shown in the info panel. Set by both `beginAttempt` and resume
   * (both painted the info DOM pre-Snabbdom). Kept separate from
   * `currentPuzzle` below on purpose — see `resumeIfPossible`.
   */
  infoPuzzle: NormalizedPuzzle | null = null;
  currentPuzzle: NormalizedPuzzle | null = null;
  review: ReviewNavigator | null = null;
  private reviewSignature = '';
  /**
   * BRD-004 reveal playback: paced, read-only replay of the solution line
   * after a reveal-abandon. Steps are precomputed FENs (never graded, never
   * written to attempt history); the board renders non-interactively and any
   * navigation stops the timer. `playbackPaceMs` is a public field so Node
   * tests can speed the clock without touching the production pace.
   */
  playingBack = false;
  playbackPaceMs = 650;
  /**
   * PZL-004 setup-move prelude: after a puzzle loads, the board shows the
   * position before the opponent's setup move, then animates that move. This
   * is the pause before the animation starts. Public so Node tests can speed
   * the clock without touching the production pace.
   */
  setupMoveDelayMs = 400;
  private playbackSteps: PlaybackStep[] = [];
  private playbackIndex = 0;
  private playbackTimer: ReturnType<typeof setTimeout> | null = null;
  private setupAnimTimer: ReturnType<typeof setTimeout> | null = null;
  private reviewKeyTarget: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = null;
  private readonly onReviewKeydown = (event: KeyboardEvent): void => {
    if (!this.review || !this.game || this.disposed) return;
    // Never hijack arrow keys inside form controls (collection picker, etc.).
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }
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
  collections: TrainCollectionOption[] = [];
  activeCollectionId = '';
  progressText = '';
  queueText = '';
  puzzleStatus: PuzzleStatusSummary | null = null;
  woodpeckerRun: { kind: 'cycle' | 'failed'; setId: string; cycleId?: string } | null = null;
  /**
   * User request 2026-10-16: 1-based index into the cycle's puzzle list when
   * the current attempt is an unscored review of an earlier puzzle, else null.
   * Public for the view's Prev/Next state.
   */
  woodpeckerReviewPosition: number | null = null;
  private woodpeckerResultRecorded = false;

  /**
   * AN-001b: on-demand engine analysis of the position being reviewed.
   * `analysisBusy` drives the thinking state, `analysis` the rendered lines.
   */
  analysisBusy = false;
  analysisError: string | null = null;
  analysis: PositionAnalysis | null = null;
  private readonly analysisSeam: AnalysisService | undefined;

  board: TrainBoardPort;
  promotionUi: TrainPromotionUi;
  redraw: () => void = () => {};
  disposed = false;

  private readonly service: LocalTrainingService;
  private readonly adapter: TrainingAdapter;

  attemptMoves(puzzleId: string) {
    const attempts = this.adapter.listAttemptsForPuzzle(puzzleId, 10);
    const currentId = this.adapter.describeCurrentAttempt().attemptId;
    return attempts.find((attempt) => attempt.attemptId.value === currentId) ?? attempts[0];
  }

  constructor(
    service: LocalTrainingService,
    adapter: TrainingAdapter,
    board: TrainBoardPort = NoopBoard,
    promotionUi: TrainPromotionUi = NoopPromotionUi,
    redraw: () => void = () => {},
    analysis?: AnalysisService,
  ) {
    this.analysisSeam = analysis;
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
    this.clearSetupAnimation();
    this.clearHint();
    this.analysis = null;
    this.analysisBusy = false;
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

  /** PZL-004: drop any pending setup-move animation (navigation, teardown). */
  private clearSetupAnimation(): void {
    if (this.setupAnimTimer === null) return;
    clearTimeout(this.setupAnimTimer);
    this.setupAnimTimer = null;
    // The prelude disables animation for its snap; restore the mount default
    // so later user/reply moves animate again even if the prelude was cut off.
    this.board.set({ animation: { enabled: true } });
  }

  /**
   * PZL-004: when a puzzle starts with an opponent setup move, show the
   * position before it and animate the move into the solver position. Purely
   * presentational — never graded and never written to attempt history; the
   * solver's own first move is handled by the normal flow once this lands.
   * Returns true when it took over the initial board render.
   *
   * `puzzle` defaults to the current puzzle; the resume path passes the resumed
   * puzzle explicitly because it deliberately leaves `currentPuzzle` unset.
   */
  private startSetupAnimation(puzzle: NormalizedPuzzle | null | undefined = this.currentPuzzle): boolean {
    const game = this.game;
    const keys = puzzle?.setupMove ? uciToKeys(puzzle.setupMove) : undefined;
    if (!puzzle || !game || !keys || this.disposed) return false;
    const [from, to] = keys as [Key, Key];
    const opponent = game.orientation === 'white' ? 'black' : 'white';
    // Snap to the pre-move position without animating the cross-puzzle jump,
    // then animate just the setup move once the player has seen it.
    this.board.set({
      fen: puzzle.sourceFen,
      orientation: game.orientation,
      turnColor: opponent,
      lastMove: undefined,
      movable: { free: false, color: undefined, dests: new Map(), showDests: false },
      premovable: { enabled: false, showDests: false },
      draggable: { enabled: false, showGhost: false },
      selectable: { enabled: false },
      drawable: { shapes: [] },
      animation: { enabled: false },
    });
    this.setupAnimTimer = setTimeout(() => {
      this.setupAnimTimer = null;
      if (this.disposed || !this.game) return;
      // If the user rewound the stepper past the setup move, don't force it
      // back onto the board — they are reviewing the earlier position.
      if (this.review && this.review.position < this.review.count - 1) return;
      this.board.set({ animation: { enabled: true } });
      this.board.move?.(from, to);
      this.renderPosition({ lastMove: [from, to] });
      this.redraw();
    }, this.setupMoveDelayMs);
    return true;
  }

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
      drawable: { shapes: this.hintSquare ? [{ orig: this.hintSquare, brush: 'green' }] : [] },
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

  private clearHint(): void {
    if (!this.hintSquare) return;
    this.hintSquare = null;
    this.board.set({ drawable: { shapes: [] } });
  }

  async onHint(): Promise<void> {
    // After a reload the in-progress attempt is resumed and `currentPuzzle`
    // is intentionally left unset (see `resumeIfPossible`); fall back to the
    // info-panel puzzle the same way reveal/restart do, or the hint silently
    // no-ops on every resumed attempt.
    const puzzle = this.currentPuzzle ?? this.infoPuzzle;
    if (!puzzle || !this.game || this.game.isCompleted || this.revealed || !this.adapter.getActiveAttemptId()) return;
    const attempt = this.attemptMoves(puzzle.id);
    const correctMoves = (attempt?.events ?? []).filter(
      (event) => event.type === 'move' && event.payload?.correct === true,
    ).length;
    const source = uciToKeys(puzzle.solution[correctMoves * 2] ?? '')?.[0];
    if (!source) return;
    this.hintSquare = source;
    this.board.set({ drawable: { shapes: [{ orig: source, brush: 'green' }] } });
    await this.adapter.recordAssistance('hint');
  }

  configureWoodpecker(run: { kind: 'cycle' | 'failed'; setId: string; cycleId?: string }): void {
    this.woodpeckerRun = run;
    this.woodpeckerResultRecorded = false;
  }

  woodpeckerCycle() {
    const run = this.woodpeckerRun;
    return run?.kind === 'cycle' && run.cycleId
      ? this.service.getWoodpeckerCycle(run.cycleId)
      : undefined;
  }

  woodpeckerSet() {
    const run = this.woodpeckerRun;
    return run ? this.service.getWoodpeckerSet(run.setId) : undefined;
  }

  woodpeckerFailedCount(): number {
    const run = this.woodpeckerRun;
    return run ? this.service.getWoodpeckerFailedPuzzleIds(run.setId).length : 0;
  }

  /** True when the live attempt belongs to the isolated unscored-review scope. */
  private isWoodpeckerReviewAttempt(): boolean {
    return this.adapter.describeCurrentAttempt().progressKey?.programId === WOODPECKER_REVIEW_PROGRAM_ID;
  }

  private async recordWoodpeckerCycleResult(result: 'clean' | 'failed', activeSeconds: number): Promise<void> {
    const run = this.woodpeckerRun;
    // A resumed attempt deliberately leaves `currentPuzzle` unset (the board is
    // rebuilt from the persisted attempt). Falling back to `infoPuzzle` is what
    // makes completion after a reload/PWA resume record the cycle result —
    // without it the puzzle stayed "unscored", and Next served it again.
    const puzzleId = (this.currentPuzzle ?? this.infoPuzzle)?.id;
    if (run?.kind !== 'cycle' || !run.cycleId || !puzzleId || this.woodpeckerResultRecorded) return;
    // Revisiting an earlier puzzle runs as unscored practice and must never
    // alter the cycle's result list (double-recording would skew progress).
    if (this.woodpeckerReviewPosition !== null || this.isWoodpeckerReviewAttempt()) return;
    await this.service.recordWoodpeckerCycleResult(run.cycleId, puzzleId, result, activeSeconds);
    this.woodpeckerResultRecorded = true;
  }

  private async reconcileResumedWoodpeckerResult(
    puzzleId: string,
    outcome: 'success' | 'failure' | undefined,
    activeSeconds: number,
  ): Promise<void> {
    const run = this.woodpeckerRun;
    if (run?.kind !== 'cycle' || !run.cycleId || !outcome) return;
    // A resumed unscored-review attempt must never be folded into cycle results.
    if (this.isWoodpeckerReviewAttempt()) return;
    const cycle = this.service.getWoodpeckerCycle(run.cycleId)?.cycle;
    if (!cycle || cycle.results.some((result) => result.puzzleId === puzzleId)) {
      this.woodpeckerResultRecorded = true;
      return;
    }
    await this.service.recordWoodpeckerCycleResult(
      run.cycleId,
      puzzleId,
      outcome === 'success' ? 'clean' : 'failed',
      activeSeconds,
    );
    this.woodpeckerResultRecorded = true;
  }

  /**
   * AN-001b: analyse the position currently under review.
   *
   * Analyses the position the *review cursor* is on (so stepping back through
   * the attempt and tapping ⌕ asks about the position you are looking at), and
   * the solver's own position when there is no review line yet. Results are
   * cached per FEN by the analysis service, so re-tapping is instant.
   */
  /**
   * The FEN the analysis screen should open on.
   *
   * At the end of the review line the board is the *post-solution* position —
   * often checkmate — so analysing that answers nothing and looks like a
   * different puzzle. Open the puzzle's own position instead. Stepping back is
   * an explicit "analyse this earlier position", so the cursor wins there.
   */
  analysisFen(): string | undefined {
    const review = this.review;
    // Still correcting a failed puzzle: the board is live and the user wants
    // the position in front of them, not the line's end.
    if (this.game && !this.game.isCompleted && review) return review.current().fen;
    // Completed: at the end the board is the post-solution position (often
    // checkmate), so analyse the puzzle's own position. A stepped-back cursor
    // is an explicit "analyse this earlier position" and wins.
    if (review && review.position < review.count - 1) return review.current().fen;
    return this.infoPuzzle?.solverFen ?? review?.current().fen;
  }

  async onAnalyze(): Promise<void> {
    if (this.disposed || this.analysisBusy) return;
    const fen = this.review?.current().fen ?? this.infoPuzzle?.solverFen;
    if (!fen) return;

    this.analysisBusy = true;
    this.analysisError = null;
    this.redraw();
    try {
      const service = this.analysisSeam ?? getAnalysisService();
      const analysis = await service.analyze(fen);
      if (this.disposed) return;
      this.analysis = analysis;
    } catch {
      if (this.disposed) return;
      this.analysisError = t('train.analyze.error');
    } finally {
      if (!this.disposed) {
        this.analysisBusy = false;
        this.redraw();
      }
    }
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
    this.clearHint();

    if (result.kind === 'wrong') {
      await this.adapter.recordWrongMove(result.uci);
      if (this.disposed) return;
      let failureRecorded = true;
      if (!this.scoredCommitted) {
        this.scoredCommitted = true;
        this.timer.markFailure();
        failureRecorded = await this.adapter.commitFailure(this.timer.snapshot());
        await this.recordWoodpeckerCycleResult('failed', this.timer.snapshot().activeSolvingSeconds);
        if (this.disposed) return;
      }
      // A rejected commit would leave the puzzle scored as never-attempted and
      // bring it straight back; say so instead of silently repeating it.
      this.status = failureRecorded
        ? { key: 'status.wrong', tone: 'wrong' }
        : { key: 'status.attemptNotSaved', tone: 'wrong' };
      this.refreshReview();
      this.renderPosition();
      this.redraw();
      return;
    }

    await this.adapter.recordMove(result.uci, true);
    if (this.disposed) return;
    this.refreshReview();
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
      let successRecorded = true;
      if (!this.scoredCommitted) {
        this.scoredCommitted = true;
        successRecorded = await this.adapter.commitSuccess(this.timer.snapshot());
        await this.recordWoodpeckerCycleResult('clean', this.timer.snapshot().activeSolvingSeconds);
        if (this.disposed) return;
      }
      this.status = successRecorded
        ? { key: 'status.completed', tone: 'completed' }
        : { key: 'status.attemptNotSaved', tone: 'wrong' };
    }
    this.renderPosition({ interactive: false });
    this.nextDisabled = false;
    this.skipDisabled = true;
    this.updateProgress();
    this.enterReview();
    this.redraw();
  }

  // --- attempt review (live replay + completed-puzzle review) ----------------
  //
  // B5/AN-001a + live replay: the board can be stepped back/forward through the
  // moves played so far (setup move, solver plies and auto-played opponent
  // replies, wrong attempts included) with the board rendered read-only at each
  // step. Before completion the line is live: while the cursor sits on the last
  // step the board is interactive (normal solving); stepping back makes it
  // read-only and stepping forward again returns to live play. After completion
  // it is a plain read-only review. Never grades and never writes schedule or
  // attempt state (read via `listAttemptsForPuzzle`).

  /** Drop review state (new attempt starting); the view hides the section. */
  resetReview(): void {
    this.stopReviewKeys();
    this.review = null;
    this.reviewSignature = '';
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

  /** Latest attempt events signature: rebuild the line only when it changes. */
  refreshReview(puzzle: NormalizedPuzzle | null | undefined = this.currentPuzzle ?? this.infoPuzzle): void {
    if (!puzzle || !this.game || this.disposed) {
      this.resetReview();
      return;
    }
    const [latest] = this.adapter.listAttemptsForPuzzle(puzzle.id, 1);
    const signature = latest ? `${latest.attemptId.value}:${latest.events.length}` : 'none';
    if (this.review && signature === this.reviewSignature) return;
    const atEnd = !this.review || this.review.position >= this.review.count - 1;
    const line = buildReviewLine(puzzle, latest?.events ?? []);
    if (line.length < 2) {
      this.resetReview();
      return;
    }
    const next = new ReviewNavigator(line);
    if (!atEnd && this.review) next.goTo(Math.min(this.review.position, next.count - 1));
    this.review = next;
    this.reviewSignature = signature;
    this.startReviewKeys();
  }

  /**
   * Build the review line from the recorded attempt events and render its
   * current step (used when a puzzle completes).
   */
  enterReview(): void {
    this.refreshReview();
    this.renderReviewStep();
  }

  /**
   * Render the navigator's current step. On the last step of an unfinished
   * puzzle the board renders live (interactive); any earlier step renders
   * read-only. No state writes.
   */
  renderReviewStep(): void {
    const review = this.review;
    const game = this.game;
    if (!review || !game || this.disposed) return;
    const step = review.current();
    const live = !game.isCompleted && !this.revealed && review.position >= review.count - 1;
    if (live) {
      this.renderPosition({
        lastMove: step.uci ? uciToKeys(step.uci) : undefined,
        replyPending: this.awaitingReply,
      });
      return;
    }
    this.renderPosition({
      fen: step.fen,
      lastMove: step.uci ? uciToKeys(step.uci) : undefined,
      interactive: false,
    });
  }

  stepReview(direction: 'first' | 'back' | 'forward' | 'last'): void {
    if (!this.game || this.disposed) return;
    this.refreshReview();
    if (!this.review) return;
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
    this.clearSetupAnimation();
    this.clearHint();
    this.game = new PuzzleGame(p);
    this.infoPuzzle = p;
    this.currentPuzzle = p;
    // AN-002: the nav destination is useful only if it knows what to analyse.
    // Remember the puzzle position as it is loaded; the completion paths keep
    // it (analysisFen deliberately returns the solver position, not mate).
    rememberAnalysisFen(p.solverFen);
    this.refreshPuzzleStatus(p.id);
    this.resetReview();
    this.timer = new AttemptTimer();
    this.scoredCommitted = false;
    this.pendingPromotion = null;
    this.clearPremoveState();
    this.revealed = false;
    this.promotionUi.hide();

    const run = this.woodpeckerRun;
    const review = this.woodpeckerReviewPosition !== null;
    const progressKey = run
      ? {
          programId: run.kind === 'cycle'
            ? (review ? WOODPECKER_REVIEW_PROGRAM_ID : WOODPECKER_CYCLE_PROGRAM_ID)
            : WOODPECKER_FAILED_PROGRAM_ID,
          collectionId: woodpeckerScopeId(run.setId),
          puzzleId: p.id,
        }
      : undefined;
    this.woodpeckerResultRecorded = false;
    await this.adapter.startAttempt(p, progressKey);
    if (this.disposed) return;
    this.timer.start();

    this.nextDisabled = true;
    this.skipDisabled = false;
    this.revealDisabled = false;
    this.solutionHidden = true;
    this.revealHidesSolution = false;
    this.status = {
      key: 'status.yourTurn',
      tone: 'info',
      params: { color: t(`color.${p.solverColor}`) },
    };
    if (!this.startSetupAnimation()) this.renderPosition();
    this.updateProgress();
    this.refreshReview();
    this.redraw();
  }

  async loadNext(): Promise<void> {
    if (this.disposed) return;
    this.stopPlayback();
    if (this.game?.isCompleted === false && this.adapter.getActiveAttemptId()) return;
    // Continuing the cycle leaves unscored review and returns to scored play.
    this.woodpeckerReviewPosition = null;
    this.nextDisabled = true;
    this.redraw();
    const run = this.woodpeckerRun;
    // The puzzle just finished must not come back as the "practise ahead"
    // fallback (it is the earliest future-due one by construction).
    const justFinished =
      this.game && (this.game.isCompleted || this.game.failedState) ? this.game.id : undefined;
    const selection = run?.kind === 'cycle' && run.cycleId
      ? this.nextWoodpeckerCyclePuzzle(run.cycleId)
      : run?.kind === 'failed'
        ? this.service.selectWoodpeckerFailed(run.setId, {
            ...(justFinished !== undefined ? { excludePuzzleIds: [justFinished] } : {}),
          })
        : await this.adapter.selectNext({
            ...(justFinished !== undefined ? { excludePuzzleIds: [justFinished] } : {}),
          });
    if (this.disposed) return;
    if (!selection.puzzleId) {
      this.showNoDue(selection);
      return;
    }
    await this.beginAttempt(await this.adapter.loadPuzzle(selection.puzzleId));
  }

  nextWoodpeckerCyclePuzzle(cycleId: string): { puzzleId: string | null; reason?: string } {
    const saved = this.service.getWoodpeckerCycle(cycleId);
    if (!saved) return { puzzleId: null, reason: 'queue-empty' };
    const completed = new Set(saved.cycle.results.map((result) => result.puzzleId));
    const puzzleId = saved.cycle.puzzleIds.find((id) => !completed.has(id)) ?? null;
    return { puzzleId, reason: puzzleId ? undefined : 'woodpecker-cycle-complete' };
  }

  /** Cycle puzzle ids in order (empty unless the run is a cycle). */
  private woodpeckerCyclePuzzleIds(): readonly string[] {
    const run = this.woodpeckerRun;
    if (run?.kind !== 'cycle' || !run.cycleId) return [];
    return this.service.getWoodpeckerCycle(run.cycleId)?.cycle.puzzleIds ?? [];
  }

  /** 0-based index the Prev/Next controls step from, or null when unavailable. */
  private woodpeckerBaseIndex(): number | null {
    const ids = this.woodpeckerCyclePuzzleIds();
    if (ids.length === 0) return null;
    if (this.woodpeckerReviewPosition !== null) return this.woodpeckerReviewPosition - 1;
    const current = this.currentPuzzle ?? this.infoPuzzle;
    if (current) {
      const index = ids.indexOf(current.id);
      return index >= 0 ? index : null;
    }
    return null;
  }

  /**
   * Index of the cycle's progress frontier: the first puzzle not yet covered by
   * a recorded result (or `ids.length` once the cycle is complete). This bounds
   * review navigation so Next can never skip ahead of real progress.
   */
  private woodpeckerFrontierIndex(): number {
    const ids = this.woodpeckerCyclePuzzleIds();
    if (ids.length === 0) return -1;
    const run = this.woodpeckerRun;
    if (run?.kind !== 'cycle' || !run.cycleId) return -1;
    const saved = this.service.getWoodpeckerCycle(run.cycleId);
    const completed = new Set(saved?.cycle.results.map((result) => result.puzzleId) ?? []);
    const index = ids.findIndex((id) => !completed.has(id));
    return index === -1 ? ids.length : index;
  }

  /** Highest index the user may navigate to: the current frontier (never past it). */
  private woodpeckerMaxIndex(): number {
    const ids = this.woodpeckerCyclePuzzleIds();
    if (ids.length === 0) return -1;
    return Math.min(this.woodpeckerFrontierIndex(), ids.length - 1);
  }

  /** Whether Previous/Next can move `delta` positions without passing progress. */
  canStepWoodpeckerReview(delta: number): boolean {
    const base = this.woodpeckerBaseIndex();
    if (base === null) return false;
    const next = base + delta;
    return next >= 0 && next <= this.woodpeckerMaxIndex();
  }

  /**
   * User request 2026-10-16: step to another puzzle in the cycle list and run it
   * as unscored practice (Show solution available; never written to the cycle
   * results). Cannot move past the progress frontier; landing on the frontier
   * returns to scored play. Releases any open attempt first so navigation cannot
   * orphan one.
   */
  async stepWoodpeckerReview(delta: number): Promise<void> {
    if (this.disposed) return;
    const ids = this.woodpeckerCyclePuzzleIds();
    const base = this.woodpeckerBaseIndex();
    if (base === null) return;
    const next = base + delta;
    if (next < 0 || next > this.woodpeckerMaxIndex()) return;
    this.stopPlayback();
    this.clearSetupAnimation();
    if (this.adapter.getActiveAttemptId()) {
      this.clearPremoveState();
      this.timer.interrupt();
      await this.adapter.abandonCurrentAttempt({ skip: false, activeSeconds: this.timer.snapshot().activeSolvingSeconds });
      if (this.disposed) return;
    }
    // Landing on the frontier is the live cycle puzzle: continue it scored.
    const onFrontier = next === this.woodpeckerFrontierIndex();
    this.woodpeckerReviewPosition = onFrontier ? null : next + 1;
    await this.beginAttempt(await this.adapter.loadPuzzle(ids[next]!));
  }

  /**
   * Jump from unscored review back to the current cycle puzzle (the progress
   * frontier) as a scored attempt. Releases any open attempt first.
   */
  async goToWoodpeckerCurrent(): Promise<void> {
    if (this.disposed) return;
    this.stopPlayback();
    this.clearSetupAnimation();
    this.woodpeckerReviewPosition = null;
    if (this.adapter.getActiveAttemptId()) {
      this.clearPremoveState();
      this.timer.interrupt();
      await this.adapter.abandonCurrentAttempt({ skip: false, activeSeconds: this.timer.snapshot().activeSolvingSeconds });
      if (this.disposed) return;
    }
    await this.loadNext();
  }

  /**
   * UX-001 no-due UI: never strand the user with a non-empty library.
   * - `queue-empty` (no puzzles at all) shows the empty-library status.
   * - `daily-limit-reached` (new-per-day cap) is shown distinctly from plain
   *   `no-due-work` (everything due in the future), both with the earliest
   *   due time when known.
   * Next remains available so it can re-run normal eligibility selection.
   */
  showNoDue(selection: {
    puzzleId: string | null;
    nextDueAt?: number;
    reason?: string;
  }): void {
    this.puzzleStatus = null;
    this.woodpeckerReviewPosition = null;
    const when = selection.nextDueAt
      ? new Date(selection.nextDueAt).toLocaleString()
      : t('puzzle.none');
    if (selection.reason === 'queue-empty') {
      this.status = { key: 'status.queueEmpty', tone: 'info' };
    } else if (selection.reason === 'woodpecker-cycle-complete') {
      this.status = { key: 'woodpecker.cycle.complete', tone: 'completed' };
    } else if (selection.reason === 'woodpecker-review-complete') {
      this.status = { key: 'woodpecker.failed.complete', tone: 'completed' };
    } else {
      if (selection.reason === 'daily-limit-reached') {
        this.status = { key: 'status.dailyLimit', tone: 'info', params: { when } };
      } else {
        this.status = { key: 'status.noDue', tone: 'info', params: { when } };
      }
    }
    this.nextDisabled = false;
    this.redraw();
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
      if (attempt.progressKey.programId === WOODPECKER_REVIEW_PROGRAM_ID) {
        const ids = this.woodpeckerCyclePuzzleIds();
        const index = ids.indexOf(p.id);
        this.woodpeckerReviewPosition = index >= 0 ? index + 1 : null;
      }
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
      await this.reconcileResumedWoodpeckerResult(
        attempt.progressKey.puzzleId,
        attempt.outcome,
        attempt.timing.activeSolvingSeconds,
      );
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
      // Resuming an untouched attempt should still show the opponent's setup
      // move (user report 2026-10-16: a reload silently dropped it). Replay the
      // presentational prelude when no solver move has been played yet;
      // otherwise render the position as before.
      // The stepper must also work on a resumed attempt (same report): build the
      // review line here too. `refreshReview` falls back to `infoPuzzle` because
      // resume deliberately leaves `currentPuzzle` unset.
      this.refreshReview(p);
      if (this.game.isCompleted || failed || correctUcis.length > 0 || !this.startSetupAnimation(p)) {
        this.renderPosition();
      }
      this.updateProgress();
      this.redraw();
      return true;
    } catch (err) {
      console.warn('Resume failed; starting a fresh selection', err);
      await this.adapter.abandonCurrentAttempt({ skip: false, activeSeconds: this.timer.snapshot().activeSolvingSeconds });
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
    this.clearSetupAnimation();
    if (!this.adapter.getActiveAttemptId()) return;
    this.clearPremoveState();
    this.timer.interrupt();
    await this.adapter.abandonCurrentAttempt({ skip: true, activeSeconds: this.timer.snapshot().activeSolvingSeconds });
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
    this.clearSetupAnimation();
    // Reveal playback owns the board; the live stepper must not re-enable it.
    this.resetReview();
    this.clearHint();
    if (this.game && !this.game.isCompleted && this.adapter.getActiveAttemptId()) {
      this.clearPremoveState();
      this.timer.interrupt();
      await this.adapter.recordAssistance('reveal');
      if (this.disposed) return;
      await this.adapter.abandonCurrentAttempt({ skip: false, activeSeconds: this.timer.snapshot().activeSolvingSeconds });
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

export function roleName(role: PromotionRole): string {
  return role === 'q' ? 'queen' : role === 'r' ? 'rook' : role === 'b' ? 'bishop' : 'knight';
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

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${remainder}s`
    : minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

/**
 * Pure view: same information, ids, classes, and strings as the pre-Snabbdom
 * template (board excluded — see {@link createTrainShell}). Board-adjacent
 * state (review position, button disabled states, solution visibility,
 * picker options) reads live ctrl fields.
 */
function viewLeft(ctrl: TrainCtrl): VNode {
  return h('div.controls.controls-left', [
    ...viewDetails(ctrl),
  ]);
}

function viewActions(ctrl: TrainCtrl): VNode {
  // UX-009: once this puzzle is finished, "go on" stops being a symbol. The
  // bare `>` reads as another control in a row of icons, so on completion the
  // same `#next-btn` becomes an explicit, labelled primary action (and goes
  // full-width on phones via `.next-cta` in app.css). Mid-session it stays the
  // compact `>` so the row does not shout while solving.
  const finished = Boolean(ctrl.game?.isCompleted || ctrl.game?.failedState);
  return h('div.button-row.train-actions', [
      ...(!ctrl.nextDisabled ? [h(`button#next-btn.button.button-primary${finished ? '.next-cta' : ''}`, {
        attrs: { type: 'button', 'aria-label': t('next.label') },
        on: { click: () => void ctrl.loadNext() },
      }, finished ? t('next.cta') : '>')] : []),
      h(`button#restart-btn.button.button-secondary${ctrl.game?.isCompleted ? '' : '.hidden'}`, {
        attrs: { type: 'button', 'aria-label': t('restart.label') },
        on: { click: () => void ctrl.onRestart() },
      }, '↻'),
      h(`button#analyze-btn.button.button-secondary${finished ? '.analyze-armed' : '.hidden'}`, {
        attrs: {
          type: 'button',
          ...(ctrl.analysisBusy ? { disabled: true } : {}),
          'aria-label': t('train.analyze.label'),
          title: t('train.analyze.title'),
        },
        // AN-002: open the full analysis board on the position under review —
        // continuous evaluation, arrows and free exploration — rather than the
        // static list this button used to render.
        on: { click: () => openAnalysis(ctrl.analysisFen()) },
        // Once the puzzle is over this is a real action, so it carries a label:
        // a lone grey icon reads as a disabled placeholder.
      }, finished ? `⌕ ${t('train.analyze.short')}` : '⌕'),
  ]);
}

function viewDetails(ctrl: TrainCtrl): VNode[] {
  const puzzle = ctrl.infoPuzzle;
  const run = ctrl.woodpeckerRun;
  const woodpeckerSet = ctrl.woodpeckerSet();
  const savedCycle = ctrl.woodpeckerCycle();
  const cycle = savedCycle?.cycle;
  const results = cycle?.results ?? [];
  const clean = results.filter((result) => result.result === 'clean').length;
  const errors = results.length - clean;
  const position = cycle && puzzle ? cycle.puzzleIds.indexOf(puzzle.id) + 1 : 0;
  return [
    run
      ? h('section.info.train-section.woodpecker-context', [
          h('h2', run.kind === 'cycle' ? 'Woodpecker cycle' : 'Woodpecker · Failed review'),
          h('p.woodpecker-set-name', woodpeckerSet?.name ?? run.setId),
          ...(run.kind === 'cycle' && cycle ? [
            h('p#woodpecker-cycle-position', `Cycle ${cycle.cycleNumber} · Puzzle ${position > 0 ? position : '—'} of ${cycle.puzzleIds.length}`),
            progressBar(results.length, cycle.puzzleIds.length, {
              id: 'woodpecker-cycle-progress',
              label: t('woodpecker.cycle.progress', { scored: results.length, total: cycle.puzzleIds.length }),
            }),
            h('p', `${clean} clean · ${errors} errors`),
            h('p', `Active solving time: ${formatDuration(results.reduce((sum, result) => sum + result.activeSeconds, 0))}`),
            h('div.button-row.woodpecker-review-nav', [
              actionButton('◀ Previous puzzle', 'tertiary', {
                id: 'woodpecker-prev-btn',
                compact: true,
                disabled: !ctrl.canStepWoodpeckerReview(-1),
                onClick: () => void ctrl.stepWoodpeckerReview(-1),
              }),
              actionButton('Next puzzle ▶', 'tertiary', {
                id: 'woodpecker-next-btn',
                compact: true,
                disabled: !ctrl.canStepWoodpeckerReview(1),
                onClick: () => void ctrl.stepWoodpeckerReview(1),
              }),
              ...(ctrl.woodpeckerReviewPosition !== null ? [
                actionButton('Go to current', 'secondary', {
                  id: 'woodpecker-current-btn',
                  compact: true,
                  onClick: () => void ctrl.goToWoodpeckerCurrent(),
                }),
                h('p.progress-note', `Reviewing puzzle ${ctrl.woodpeckerReviewPosition} of ${cycle.puzzleIds.length} — unscored practice (Show solution for the answer).`),
              ] : []),
            ]),
          ] : [
            h('p', `${ctrl.woodpeckerFailedCount()} puzzles in this set’s Failed queue`),
            h('p.progress-note', 'Reviews are spaced separately from the main cycle.'),
          ]),
        ])
      : h('section.info.train-section.training-status-section', [
          h('h2', 'Training Status'),
          ...puzzleStatusLines(ctrl.puzzleStatus),
        ]),
    h('section.info.train-section.puzzle-section', [
      h('h2', 'Puzzle'),
      h('p#puzzle-id', puzzle ? `${t('puzzle.id')}: ${puzzle.id}` : '-'),
      ...(ctrl.game?.isCompleted ? [
        h('p#rating', puzzle ? `${t('puzzle.rating')}: ${puzzle.rating}` : '-'),
        h('p#themes', puzzle ? `${t('puzzle.themes')}: ${puzzle.themes.slice(0, 4).join(', ') || t('puzzle.none')}` : '-'),
      ] : []),
      h(
        'p#solver-color',
        puzzle ? `${t('puzzle.solver')}: ${t(`color.${puzzle.solverColor}`)}` : '-',
      ),
      ...(!run ? [
        h('h2.train-subheading', { attrs: { 'data-i18n': 'collections.active.label' } }, t('collections.active.label')),
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
        h('h2.train-subheading', { attrs: { 'data-i18n': 'queue.title' } }, t('queue.title')),
        h('p#queue.progress-note', ctrl.queueText),
        h('p#progress.progress-note', ctrl.progressText),
      ] : []),
      h('p#storage.progress-note.hidden'),
    ]),
  ];
}

function viewRight(ctrl: TrainCtrl): VNode {
  const review = ctrl.review;
  const puzzle = ctrl.infoPuzzle;
  const attempt = puzzle ? ctrl.attemptMoves(puzzle.id) : undefined;
  const reviewedUci = review?.current().uci;
  const rows = puzzle
    ? buildMoveList(puzzle, orderedAttemptMoves(attempt?.events ?? []), {
        complete: Boolean(ctrl.game?.isCompleted || ctrl.revealed),
      })
    : [];
  const moveList = rows.length
    ? h(
        'ol.moves-list',
        rows.map((row, index) =>
          h('li.moves-row', { key: `row-${row.number}-${index}` }, [
            h('span.moves-index', String(row.number)),
            moveCell(row.white, reviewedUci),
            moveCell(row.black, reviewedUci),
          ]),
        ),
      )
    : h('ol.moves-list', [h('li.move-list-empty', 'No moves yet')]);
  return h('div.controls.controls-right', [
    h('section.info.move-list', [h('h2', t('moves.title')), moveList]),
    h('div.info.status-panel', [
      h('h2', { attrs: { 'data-i18n': 'status.title' } }, t('status.title')),
      ...(ctrl.woodpeckerRun ? [h('p.woodpecker-mode', ctrl.woodpeckerRun.kind === 'cycle' ? t('woodpecker.mode.cycle') : t('woodpecker.mode.failed'))] : []),
      h('p#solve-timer', formatSolveTimer(ctrl.timer.snapshot())),
      h(statusClass(ctrl), t(ctrl.status.key, ctrl.status.params)),
      h('div.button-row.feedback-actions', [
        actionButton(t(ctrl.revealHidesSolution ? 'reveal.hide' : 'reveal.show'), 'secondary', { id: 'reveal-btn', disabled: ctrl.revealDisabled, onClick: () => void ctrl.onReveal() }),
        actionButton(t('hint.label'), 'secondary', { id: 'hint-btn', disabled: !ctrl.game || ctrl.game.isCompleted || ctrl.revealed, onClick: () => void ctrl.onHint() }),
      ]),
    ]),
    h(`div.button-row.review-nav${review ? '' : '.hidden'}`, [
      h('button.button.button-secondary', { attrs: { type: 'button', id: 'review-back', 'aria-label': t('review.back'), ...(review?.canBack ? {} : { disabled: true }) }, on: { click: () => ctrl.stepReview('back') } }, '◀'),
      h('button.button.button-secondary', { attrs: { type: 'button', id: 'review-forward', 'aria-label': t('review.forward'), ...(review?.canForward ? {} : { disabled: true }) }, on: { click: () => ctrl.stepReview('forward') } }, '▶'),
    ]),
    ...viewAnalysis(ctrl),
  ]);
}

/**
 * AN-001b: the engine panel. Rendered only once the puzzle is over (or once a
 * result/error exists), so the solving screen stays uncluttered; while the wasm
 * works it shows a thinking state rather than a frozen button.
 */
function viewAnalysis(ctrl: TrainCtrl): VNode[] {
  const finished = Boolean(ctrl.game?.isCompleted || ctrl.game?.failedState);
  if (!finished && ctrl.analysis === null && ctrl.analysisError === null && !ctrl.analysisBusy) return [];

  const body: VNode[] = [];
  if (ctrl.analysisBusy) {
    body.push(h('p#analysis-status', t('train.analyze.thinking')));
  } else if (ctrl.analysisError !== null) {
    body.push(h('p#analysis-error.analysis-error', ctrl.analysisError));
  } else if (ctrl.analysis !== null && ctrl.analysis.lines.length > 0) {
    body.push(
      h(
        'ol#analysis-lines.analysis-lines',
        ctrl.analysis.lines.map((line) =>
          h('li.analysis-line', [
            h('span.analysis-score', line.scoreText),
            h('span.analysis-moves', formatLine(line.san)),
            ...(line.depth !== undefined ? [h('span.analysis-depth', `d${line.depth}`)] : []),
          ]),
        ),
      ),
    );
    const best = bestMoveOf(ctrl.analysis);
    if (best !== undefined) {
      body.push(h('p#analysis-best.progress-note', t('train.analyze.best', { move: best })));
    }
  } else {
    body.push(h('p#analysis-status', t('train.analyze.hint')));
  }

  return [h('section.info.train-section.analysis', { attrs: { id: 'analysis' } }, [h('h2', t('train.analyze.heading')), ...body])];
}

/**
 * One move cell in the Lichess-style list: piece glyph + SAN. `current` follows
 * the review cursor; `setup` marks the pre-solution context cell. The empty
 * slot keeps the white/black columns aligned when a row has only one move.
 */
function moveCell(cell: MoveListCell | null, reviewedUci: string | null | undefined): VNode {
  if (!cell) return h('span.moves-move.empty', { attrs: { 'aria-hidden': 'true' } });
  return h(
    'span.moves-move',
    {
      key: `${cell.number}-${cell.color}-${cell.uci}`,
      class: {
        white: cell.color === 'white',
        black: cell.color === 'black',
        setup: cell.setup,
        current: cell.uci === reviewedUci,
      },
      attrs: {
        title: cell.uci,
        ...(cell.setup ? { 'aria-label': t('puzzle.previousMove') } : {}),
      },
    },
    [
      h('span.moves-piece', { attrs: { 'aria-hidden': 'true' } }, cell.glyph),
      h('span.moves-san', cell.san),
    ],
  );
}

/** Combined DOM-free view retained for callers/tests; mount patches each panel independently. */
export function view(ctrl: TrainCtrl): VNode {
  return h('div.train-panels', [viewLeft(ctrl), viewRight(ctrl), viewActions(ctrl)]);
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
  actionPlaceholder: HTMLElement;
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
  const actionPlaceholder = doc.createElement('div');
  actionPlaceholder.className = 'board-actions-slot';
  boardWrap.appendChild(actionPlaceholder);
  const leftPlaceholder = doc.createElement('div');
  leftPlaceholder.className = 'controls-slot controls-left-slot';
  const rightPlaceholder = doc.createElement('div');
  rightPlaceholder.className = 'controls-slot controls-right-slot';
  layout.appendChild(leftPlaceholder);
  layout.appendChild(boardWrap);
  layout.appendChild(rightPlaceholder);
  root.appendChild(layout);
  return { root, boardHost, boardWrap, leftPlaceholder, rightPlaceholder, actionPlaceholder };
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
  private actionVnode: VNode | null = null;
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
          move: (orig, dest) => ground.move(orig, dest),
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
      this.actionVnode = patch(shell.actionPlaceholder, viewActions(ctrl));
      this.timerInterval = setInterval(() => ctrl.redraw(), 1000);
      ctrl.redraw = () => {
        if (this.ctrl === null || this.leftVnode === null || this.rightVnode === null || this.actionVnode === null) return;
        this.leftVnode = patch(this.leftVnode, viewLeft(this.ctrl));
        this.rightVnode = patch(this.rightVnode, viewRight(this.ctrl));
        this.actionVnode = patch(this.actionVnode, viewActions(this.ctrl));
      };

      const hashQuery = window.location.hash.split('?')[1] ?? '';
      const runParams = new URLSearchParams(hashQuery);
      const setId = runParams.get('setId');
      const cycleId = runParams.get('cycleId');
      const failedMode = runParams.get('mode') === 'failed';
      if (setId && (failedMode || cycleId)) {
        const kind = failedMode ? 'failed' : 'cycle';
        if (kind === 'failed' || this.service.getWoodpeckerCycle(cycleId!)) {
          ctrl.configureWoodpecker({ kind, setId, ...(cycleId ? { cycleId } : {}) });
          await this.adapter.startSession(
            kind === 'cycle' ? WOODPECKER_CYCLE_PROGRAM_ID : WOODPECKER_FAILED_PROGRAM_ID,
            woodpeckerScopeId(setId),
          );
        }
      } else {
        await this.adapter.startSession(DEFAULT_PROGRAM_ID, this.service.getActiveCollectionId());
      }

      const resumed = await ctrl.resumeIfPossible();
      if (this.ctrl === null) return;
      if (!resumed) {
        const run = ctrl.woodpeckerRun;
        const selection = run?.kind === 'cycle' && run.cycleId
          ? ctrl.nextWoodpeckerCyclePuzzle(run.cycleId)
          : run?.kind === 'failed'
            ? this.service.selectWoodpeckerFailed(run.setId)
            : await this.adapter.selectNext();
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
      // Reuse the board's own cburnett piece art: `<piece class="white queen">`.
      const piece = b.querySelector('piece');
      if (piece) piece.className = `${color} ${roleName(role)}`;
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
    const onCancel = (e: Event): void => {
      e.preventDefault();
      this.ctrl?.cancelPromotion();
    };
    const onOverlayClick = (e: Event): void => {
      if (e.target === overlay) {
        this.ctrl?.cancelPromotion();
      }
    };
    const cancelButton = overlay.querySelector<HTMLButtonElement>('[data-promotion-cancel]');
    overlay.querySelectorAll<HTMLButtonElement>('[data-promotion]').forEach((b) => {
      b.addEventListener('click', onChoice);
    });
    cancelButton?.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    this.unbindPromotion = () => {
      overlay.querySelectorAll<HTMLButtonElement>('[data-promotion]').forEach((b) => {
        b.removeEventListener('click', onChoice);
      });
      cancelButton?.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
    };
  }
}
