/**
 * AN-002 — the analysis screen: a free board with continuous engine analysis,
 * the shape people know from lichess and chess.com.
 *
 * Behaviour (decided by the owner after the research in
 * `docs/research/analysis-modes.md`):
 * - **Continuous analysis while the screen is open.** One search per position,
 *   reported as it climbs — the eval bar and lines update live, no button press.
 * - **Auto-analysis on entering the screen**, and again on every move or
 *   navigation step, with the previous search abandoned rather than queued.
 * - **Best-move arrow only from depth 14** (chess.com's own threshold), plus the
 *   eval bar, the numeric score, the lines in SAN, a depth readout and a
 *   "go deeper" action for a verdict (lichess's escape hatch).
 *
 * Everything engine-shaped is injected (`createLiveAnalysis`), so the view is
 * testable without a wasm build; the browser smoke test covers the real engine.
 */
import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { makeUci, parseUci } from 'chessops/util';
import type { SquareName } from 'chessops/types';
import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import { screenPatch as patch } from './ui/patch.ts';
import type { Screen } from './router.ts';
import { t } from './i18n.ts';
import {
  canDeepen,
  evalBarFill,
  sameFen,
  type AnalysisSnapshot,
} from './engine/analysis-live.ts';
import { formatLine, turnOfFen } from './engine/analysis.ts';

export const ANALYSIS_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** The slice of chessground this screen drives (injectable for tests). */
export interface AnalysisBoardPort {
  setFen(fen: string): void;
  setOrientation(color: 'white' | 'black'): void;
  setShapes(shapes: Array<{ orig: string; dest?: string; brush?: string }>): void;
  onMove(handler: (from: SquareName, to: SquareName) => void): void;
}
/** Live-analysis handle the view needs (see `createLiveAnalysis`). */
export interface LiveAnalysisPort {
  analyze(fen: string): void;
  deepen(): void;
  stop(): void;
  dispose(): void;
}

export interface AnalysisViewDeps {
  /** A ready board (tests), or */
  board?: AnalysisBoardPort;
  /** …a factory that builds one on the host at mount time (the app uses this:
   *  chessground must be created on an element that is actually in the DOM). */
  createBoard?: (host: HTMLElement) => AnalysisBoardPort;
  live: LiveAnalysisPort;
  /** Initial position (from `#/analysis?fen=…`), defaults to the start. */
  initialFen?: string;
  /** Optional redraw hook (tests); the real screen patches its own panel. */
  redraw?: () => void;
  /**
   * App only: split the router's mount host into the two elements this screen
   * needs. The board host must already be in the document when chessground is
   * created, and it must stay *outside* the panel's patched subtree because
   * chessground owns that DOM. Tests skip this and inject a board port.
   */
  prepareHost?: (host: HTMLElement) => { boardHost: HTMLElement; panelHost: HTMLElement };
}

/** One move in the analysis line, so navigation and the move list can share it. */
export interface AnalysisMove {
  uci: string;
  san: string;
  fen: string;
}

export interface AnalysisState {
  /** Positions from the start of this analysis to the current one. */
  history: AnalysisMove[];
  /** Index into `history` of the position being shown (-1 = initial). */
  cursor: number;
  initialFen: string;
  orientation: 'white' | 'black';
  snapshot: AnalysisSnapshot | undefined;
  enabled: boolean;
  error: string | null;
}

/**
 * Play a legal UCI move from `fen`, returning the resulting FEN and SAN.
 * Returns undefined for an illegal move or an unreadable FEN (never throws).
 */
export function playAnalysisMove(fen: string, from: SquareName, to: SquareName, promotion?: string): AnalysisMove | undefined {
  const setup = parseFen(fen);
  if (setup.isErr) return undefined;
  const position = Chess.fromSetup(setup.value);
  if (position.isErr) return undefined;
  const chess = position.value;
  // Build the move from `from`+`to` (+ a promotion role). Promotions default to
  // a queen: the analysis board is for exploring and has no scoring
  // consequences, so interrupting with a picker would only cost flow.
  const suffix = promotion ?? '';
  const move = parseUci(`${from}${to}${suffix}`) ?? parseUci(`${from}${to}q`);
  if (!move || !chess.isLegal(move)) return undefined;

  const san = makeSan(chess, move);
  const uci = makeUci(move);
  chess.play(move);
  return { uci, san, fen: makeFen(chess.toSetup()) };
}

/** The FEN for the current cursor position. */
export function fenAt(state: AnalysisState): string {
  if (state.cursor < 0) return state.initialFen;
  return state.history[state.cursor]?.fen ?? state.initialFen;
}

/** A short, copyable move list (`1. e4 e5 2. Nf3`). */
export function analysisMoveText(history: readonly AnalysisMove[]): string {
  const parts: string[] = [];
  history.forEach((move, index) => {
    if (index % 2 === 0) parts.push(`${index / 2 + 1}.`);
    parts.push(move.san);
  });
  return parts.join(' ');
}

/**
 * The screen. It owns a tiny amount of state (history, cursor, the latest
 * snapshot) and delegates every engine call to `deps.live`.
 */
export class AnalysisView implements Screen {
  readonly id = 'analysis' as const;

  private readonly deps: AnalysisViewDeps;
  private board: AnalysisBoardPort | undefined;
  private state: AnalysisState;
  private mounted = false;
  /** Where the host mounted the board (chessground owns that element). */
  private boardHost: HTMLElement | null = null;
  /** The panel subtree this screen owns and re-patches. */
  private panelHost: HTMLElement | null = null;
  private vnode: VNode | null = null;

  constructor(deps: AnalysisViewDeps) {
    this.deps = deps;
    const initialFen = deps.initialFen?.trim() || ANALYSIS_START_FEN;
    this.state = {
      history: [],
      cursor: -1,
      initialFen,
      // A puzzle deep link should see its own side at the bottom, like the
      // trainer; the empty board still opens White.
      orientation: turnOfFen(initialFen),
      snapshot: undefined,
      enabled: true,
      error: null,
    };
  }

  /** Test/teardown view of the state. */
  currentState(): AnalysisState {
    return this.state;
  }

  /**
   * Repaint the screen. With a `prepareHost` (the app) this re-patches only the
   * panel, leaving chessground's element alone; otherwise (tests) it just calls
   * the injected hook. Routing again would unmount the screen and lose history.
   */
  private repaint(): void {
    if (this.deps.prepareHost) {
      if (this.panelHost) this.vnode = patch(this.vnode ?? this.panelHost, this.view());
    }
    this.deps.redraw?.();
  }

  /** The snapshot callback the app wires into `createLiveAnalysis`. */
  onSnapshot(snapshot: AnalysisSnapshot): void {
    if (!this.mounted) return;
    // Only accept a report for the position currently on the board: a slower
    // search for a position the user already left must not move the bar back.
    if (!sameFen(snapshot.fen, fenAt(this.state))) return;
    this.state = { ...this.state, snapshot };
    this.board?.setShapes(this.shapes());
    this.repaint();
  }

  async mount(host: HTMLElement): Promise<void> {
    this.mounted = true;
    const layout = this.deps.prepareHost?.(host);
    const boardHost = layout?.boardHost ?? host;
    this.boardHost = boardHost;
    this.panelHost = layout?.panelHost ?? host;
    this.board = this.deps.board ?? this.deps.createBoard?.(boardHost);
    if (!this.board) throw new Error('analysis screen needs a board');
    this.board.onMove((from, to) => this.playMove(from, to));
    this.syncBoard();
    this.analyseCurrent();
    this.repaint();
  }

  async unmount(): Promise<void> {
    this.mounted = false;
    this.vnode = null;
    this.panelHost = null;
    // Leaving the screen stops the search and releases the worker: continuous
    // analysis must not run in the background (battery), and a wasm worker per
    // visit would otherwise pile up. Re-entry re-initialises the engine.
    this.deps.live.stop();
    this.deps.live.dispose();
  }

  /** Play a user move on the free board (any legal move, both sides). */
  playMove(from: SquareName, to: SquareName): void {
    if (!this.state.enabled) return;
    const fen = fenAt(this.state);
    const move = playAnalysisMove(fen, from, to);
    if (!move) {
      this.syncBoard(); // illegal: snap the board back
      return;
    }
    // Playing from an earlier position truncates the line, like the sites do.
    const history = this.state.history.slice(0, this.state.cursor + 1);
    history.push(move);
    this.state = { ...this.state, history, cursor: history.length - 1, snapshot: undefined };
    this.syncBoard();
    this.analyseCurrent();
    this.repaint();
  }

  /** Step the cursor through the analysed line. */
  step(delta: -1 | 1): void {
    const next = this.state.cursor + delta;
    if (next < -1 || next >= this.state.history.length) return;
    this.state = { ...this.state, cursor: next, snapshot: undefined };
    this.syncBoard();
    this.analyseCurrent();
    this.repaint();
  }

  /** Back to the starting position (keeps the line so it can be stepped again). */
  reset(): void {
    this.state = { ...this.state, cursor: -1, snapshot: undefined };
    this.syncBoard();
    this.analyseCurrent();
    this.repaint();
  }

  flip(): void {
    this.state = {
      ...this.state,
      orientation: this.state.orientation === 'white' ? 'black' : 'white',
    };
    this.board?.setOrientation(this.state.orientation);
    this.repaint();
  }

  /** Toggle continuous analysis off/on (a battery switch, like the sites'). */
  toggleEngine(): void {
    const enabled = !this.state.enabled;
    this.state = { ...this.state, enabled, snapshot: enabled ? this.state.snapshot : undefined };
    if (enabled) this.analyseCurrent();
    else this.deps.live.stop();
    this.repaint();
  }

  deepen(): void {
    if (!this.state.enabled) return;
    this.deps.live.deepen();
  }

  /** Ask the engine about whatever position the cursor is on. */
  private analyseCurrent(): void {
    if (!this.state.enabled) return;
    this.deps.live.analyze(fenAt(this.state));
  }

  private syncBoard(): void {
    const fen = fenAt(this.state);
    this.board?.setFen(fen);
    this.board?.setOrientation(this.state.orientation);
    this.board?.setShapes(this.shapes());
  }

  /** The best-move arrow, once the engine is deep enough to trust it. */
  private shapes(): Array<{ orig: string; dest: string; brush: string }> {
    const arrow = this.state.snapshot?.arrow;
    if (!arrow || !this.state.enabled) return [];
    return [{ orig: arrow.orig, dest: arrow.dest, brush: 'green' }];
  }

  view(): VNode {
    const { snapshot } = this.state;
    const fill = snapshot?.score ? evalBarFill(snapshot.score, turnOfFen(fenAt(this.state))) : 0.5;

    return h('div.analysis-panel-screen', [
      h('div.analysis-head', [
        h('h2', t('analysis.title')),
        h('div.analysis-controls', [
          this.button('analysis-flip', t('analysis.flip'), () => this.flip()),
          this.button('analysis-reset', t('analysis.reset'), () => this.reset()),
          this.button(
            'analysis-engine',
            this.state.enabled ? t('analysis.engineOff') : t('analysis.engineOn'),
            () => this.toggleEngine(),
          ),
        ]),
      ]),
      h('div.analysis-body', [
        h('div.analysis-eval', [
          h(
            'div.analysis-eval-bar',
            {
              attrs: {
                id: 'analysis-eval-bar',
                role: 'img',
                'aria-label': t('analysis.barLabel'),
                style: `--analysis-fill:${(fill * 100).toFixed(1)}%`,
              },
            },
            [
              h('div.analysis-eval-white', {
                class: { 'analysis-eval-flip': this.state.orientation === 'black' },
              }),
            ],
          ),
          h('p#analysis-score.analysis-score', snapshot?.scoreText || '—'),
          h('p#analysis-depth.progress-note', snapshot?.depth !== undefined ? `d${snapshot.depth}` : ''),
        ]),
        h('div.analysis-panel', [
          this.enginePanel(snapshot),
          h('div.analysis-nav', [
            this.button('analysis-prev', '◀', () => this.step(-1), this.state.cursor < 0, t('analysis.prev')),
            this.button('analysis-next', '▶', () => this.step(1), this.state.cursor >= this.state.history.length - 1, t('analysis.next')),
          ]),
          this.state.history.length > 0
            ? h('p#analysis-moves.analysis-moves', analysisMoveText(this.state.history))
            : h('p#analysis-moves.analysis-moves.analysis-empty', t('analysis.empty')),
        ]),
      ]),
      h('p.progress-note', t('analysis.hint')),
    ]);
  }

  private enginePanel(snapshot: AnalysisSnapshot | undefined): VNode {
    if (!this.state.enabled) {
      return h('p#analysis-status.progress-note', t('analysis.engineDisabled'));
    }
    if (snapshot?.error) {
      return h('p#analysis-status.progress-note.analysis-error', t('analysis.unavailable'));
    }
    if (!snapshot || snapshot.lines.length === 0) {
      return h('p#analysis-status.progress-note', t('analysis.thinking'));
    }
    return h('div.analysis-lines-wrap', [
      h(
        'ol#analysis-lines.analysis-lines',
        snapshot.lines.map((line) =>
          h('li.analysis-line', [
            h('span.analysis-score', line.scoreText),
            h('span.analysis-moves', formatLine(line.san)),
          ]),
        ),
      ),
      canDeepen(snapshot)
        ? this.button('analysis-deepen', t('analysis.deepen'), () => this.deepen())
        : null,
    ]);
  }

  private button(
    id: string,
    label: string,
    onClick: () => void,
    disabled = false,
    ariaLabel?: string,
  ): VNode {
    return h(
      'button.button.button-secondary',
      {
        attrs: {
          type: 'button',
          id,
          ...(ariaLabel !== undefined ? { 'aria-label': ariaLabel, title: ariaLabel } : {}),
          ...(disabled ? { disabled: true } : {}),
        },
        on: { click: onClick },
      },
      label,
    );
  }
}

/** Read `?fen=…` from a `#/analysis?fen=…` hash. */
export function fenFromHash(hash: string): string | undefined {
  const query = hash.split('?')[1];
  if (!query) return undefined;
  const value = new URLSearchParams(query).get('fen');
  if (!value) return undefined;
  const setup = parseFen(value);
  if (setup.isErr) return undefined;
  // Reject a syntactically valid but illegal position (e.g. the side not to
  // move is in check): chessground would render it and the engine can choke.
  return Chess.fromSetup(setup.value).isOk ? value : undefined;
}

/** Kept exported from this module for existing callers/tests (implementation
 *  lives with the other score helpers so display and bar cannot drift apart). */
export { turnOfFen };

/**
 * The last position the trainer put on the board, so the nav "Analysis"
 * destination opens something meaningful (the puzzle you are on) instead of a
 * fresh board — the owner reported ending up on "the next puzzle" after
 * finishing.
 */
let rememberedFen: string | undefined;

export function rememberAnalysisFen(fen: string | undefined): void {
  if (typeof fen === 'string' && fen.trim() !== '') rememberedFen = fen.trim();
}

export function rememberedAnalysisFen(): string | undefined {
  return rememberedFen;
}

/** Navigate to the analysis screen for a position (defaults to the remembered one). */
export function openAnalysis(fen?: string): void {
  const target = fen ?? rememberedFen;
  const query = target ? `?fen=${encodeURIComponent(target)}` : '';
  // Guarded so importing this module under Node (tests) never touches the DOM.
  if (typeof window === 'undefined') return;
  window.location.hash = `#/analysis${query}`;
}
