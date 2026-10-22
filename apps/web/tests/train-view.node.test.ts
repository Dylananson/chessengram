/**
 * S6 no-remount proof + behavior preservation for the Train ctrl/view split.
 *
 * DOM-free by design (no jsdom): `train-view.ts` keeps its ctrl, shell
 * builder, and `view` importable under Node (snabbdom via `build/*` deep
 * subpaths, chessground root verified side-effect-free at load). The proof
 * is structural, exactly as the S6 brief allows:
 *
 *  1. `createTrainShell` creates the `div#board` host exactly once per mount
 *     (counted via a stub document), and the controls placeholder is a
 *     different element — the patch target excludes the host subtree.
 *  2. `view(ctrl)` never renders a board host vnode in any UI state
 *     (initial, mid-attempt, revealed, completed-with-review, no-due), and
 *     the controls root selector is stable — so no patch can create, move,
 *     or replace the live chessground element.
 *  3. A redraw storm (60 redraws mid-attempt plus progress/picker refreshes)
 *     produces zero board-port traffic and zero destroys; the port identity
 *     is stable and the board keeps receiving imperative sets afterwards.
 *
 * Behavior coverage drives the real adapter/service through the ctrl:
 * wrong → failure → correction → complete, Skip, Reveal toggle, promotion
 * pending/cancel, resume-after-reload, and collection-picker scoping.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { VNode } from 'snabbdom/build/vnode.js';
import {
  TrainCtrl,
  createTrainShell,
  view,
  type TrainBoardConfig,
  type TrainBoardPort,
  type TrainPromotionUi,
} from '../src/train-view.ts';
import { PuzzleGame } from '../src/puzzle-game.ts';
import { TrainingAdapter } from '../src/training-adapter.ts';
import {
  LocalTrainingService,
  WOODPECKER_CYCLE_PROGRAM_ID,
  WOODPECKER_REVIEW_PROGRAM_ID,
  woodpeckerScopeId,
} from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { makePuzzle, makeService, promotionPuzzle, setupMovePuzzle } from './fixtures.ts';

// --- stub document (counts element creation, no DOM) ------------------------

interface StubEl {
  tag: string;
  id: string;
  className: string;
  textContent: string | null;
  attrs: Record<string, string>;
  type: string;
  classList: { toggle(name: string): boolean; contains(name: string): boolean };
  children: StubEl[];
  appendChild(child: StubEl): void;
  setAttribute(key: string, value: string): void;
}

function makeStubDoc(): { doc: unknown; created: StubEl[] } {
  const created: StubEl[] = [];
  const doc = {
    createElement(tag: string): StubEl {
      const el: StubEl = {
        tag,
        id: '',
        className: '',
        textContent: null,
        attrs: {},
        type: '',
        classList: {
          toggle(name: string): boolean {
            const classes = new Set(el.className.split(/\s+/).filter(Boolean));
            if (classes.has(name)) classes.delete(name);
            else classes.add(name);
            el.className = [...classes].join(' ');
            return classes.has(name);
          },
          contains(name: string): boolean {
            return el.className.split(/\s+/).includes(name);
          },
        },
        children: [],
        appendChild(child: StubEl): void {
          el.children.push(child);
        },
        setAttribute(key: string, value: string): void {
          el.attrs[key] = value;
        },
      };
      created.push(el);
      return el;
    },
  };
  return { doc, created };
}

// --- vnode walker ------------------------------------------------------------

function walkVNode(vnode: VNode, visit: (node: VNode) => void): void {
  visit(vnode);
  for (const child of vnode.children ?? []) {
    if (typeof child === 'object' && child !== null && 'sel' in child) {
      walkVNode(child as VNode, visit);
    }
  }
}

function vnodeSels(vnode: VNode): string[] {
  const sels: string[] = [];
  walkVNode(vnode, (node) => {
    if (typeof node.sel === 'string') sels.push(node.sel);
  });
  return sels;
}

function vnodeIds(vnode: VNode): string[] {
  const ids: string[] = [];
  walkVNode(vnode, (node) => {
    const fromAttrs = (node.data as { attrs?: { id?: string } } | undefined)?.attrs?.id;
    if (typeof fromAttrs === 'string') ids.push(fromAttrs);
    const match = typeof node.sel === 'string' && /#([A-Za-z0-9_-]+)/.exec(node.sel);
    if (match) ids.push(match[1]!);
  });
  return ids;
}

function vnodeText(vnode: VNode): string {
  return [typeof vnode.text === 'string' ? vnode.text : '', ...(vnode.children ?? []).map((child) =>
    typeof child === 'object' && child !== null && 'sel' in child ? vnodeText(child as VNode) : typeof child === 'string' ? child : '',
  )].join(' ');
}

/** VNodes carrying a truthy `class` entry (snabbdom classes live on `data.class`). */
function nodesWithClass(vnode: VNode, name: string): VNode[] {
  const found: VNode[] = [];
  walkVNode(vnode, (node) => {
    const classes = (node.data as { class?: Record<string, boolean> } | undefined)?.class;
    if (classes?.[name]) found.push(node);
  });
  return found;
}

// --- fakes -------------------------------------------------------------------

function makeRecordingBoard(): {
  port: TrainBoardPort;
  sets: TrainBoardConfig[];
  moves: Array<[string, string]>;
  destroys: { count: number };
} {
  const sets: TrainBoardConfig[] = [];
  const moves: Array<[string, string]> = [];
  const destroys = { count: 0 };
  return {
    sets,
    moves,
    destroys,
    port: {
      set(config: TrainBoardConfig): void {
        sets.push(config);
      },
      move(orig, dest): void {
        moves.push([orig, dest]);
      },
      destroy(): void {
        destroys.count += 1;
      },
    },
  };
}

function makePromo(): { ui: TrainPromotionUi; shown: string[]; hidden: { count: number } } {
  const shown: string[] = [];
  const hidden = { count: 0 };
  return {
    shown,
    hidden,
    ui: {
      show(color: 'white' | 'black'): void {
        shown.push(color);
      },
      hide(): void {
        hidden.count += 1;
      },
    },
  };
}

async function makeWorld(ids: string[]): Promise<{
  service: LocalTrainingService;
  adapter: TrainingAdapter;
}> {
  const service = await makeService();
  await service.seedContent(ids.map((id) => makePuzzle({ id })));
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  return { service, adapter };
}

// --- 1. shell: host created once, outside the patched subtree ----------------

test('createTrainShell creates the board host exactly once, apart from the patch target', () => {
  const { doc, created } = makeStubDoc();
  const shell = createTrainShell(doc as unknown as Document);

  const boardHosts = created.filter((el) => el.id === 'board');
  assert.equal(boardHosts.length, 1, 'exactly one div#board per shell');
  assert.equal(shell.boardHost, boardHosts[0]);
  assert.notEqual(shell.leftPlaceholder, shell.boardHost);
  assert.notEqual(shell.rightPlaceholder, shell.boardHost);
  assert.ok(!shell.leftPlaceholder.children.includes(shell.boardHost));
  assert.ok(!shell.rightPlaceholder.children.includes(shell.boardHost));
  assert.ok(shell.boardHost.className.includes('board'));
  assert.equal(shell.boardHost.attrs['aria-label'], 'Board');
  assert.equal(shell.boardWrap.className, 'board-wrap');
  assert.equal(shell.boardWrap.children[0], shell.boardHost, 'board remains first in its static wrapper');
  assert.equal(shell.boardWrap.children[1].className, 'board-actions-slot', 'actions slot follows the board');
  assert.equal(created.some((el) => el.tag === 'h2' && el.textContent === 'Board'), false);
});

test('train shell has no size toggle and keeps the board host outside the patch target', async () => {
  const { doc } = makeStubDoc();
  const shell = createTrainShell(doc as unknown as Document);
  const { service, adapter } = await makeWorld(['brd-size']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  const host = shell.boardHost;
  const port = ctrl.board;
  for (let i = 0; i < 20; i += 1) {
    ctrl.redraw = () => { view(ctrl); };
    ctrl.redraw();
    assert.equal(shell.boardHost, host, 'redraws preserve the static chessground host identity');
    assert.ok(!vnodeSels(view(ctrl)).some((sel) => sel.includes('#board')));
  }

  assert.equal(shell.boardHost, host, 'board host identity unchanged');
  assert.equal(ctrl.board, port, 'board port identity unchanged');
  assert.equal(board.destroys.count, 0, 'layout changes never destroy Chessground');
  ctrl.dispose();
});

test('desktop view separates details, solve sections, and board actions in the requested order', async () => {
  const { service, adapter } = await makeWorld(['layout-a']);
  const ctrl = new TrainCtrl(service, adapter);
  await ctrl.beginAttempt(await adapter.loadPuzzle('layout-a'));
  const initial = view(ctrl);
  const initialChildren = initial.children as VNode[];
  assert.ok(initialChildren[0]!.sel?.includes('controls-left'));
  assert.ok(initialChildren[1]!.sel?.includes('controls-right'));
  const leftChildren = initialChildren[0]!.children as VNode[];
  assert.equal(leftChildren.length, 2, 'details column has exactly two sections');
  assert.ok(leftChildren[0]!.sel?.includes('training-status-section'));
  assert.ok(leftChildren[1]!.sel?.includes('puzzle-section'));
  assert.ok(!vnodeIds(initial).includes('solution'), 'standalone solution display removed');
  const rightChildren = initialChildren[1]!.children as VNode[];
  assert.ok(rightChildren[0]!.sel?.includes('move-list'));
  assert.ok(rightChildren[1]!.sel?.includes('status-panel'));
  assert.equal(rightChildren.length, 3, 'right side has only moves, feedback, and review arrows');
  assert.ok(rightChildren[2]!.sel?.includes('review-nav'));
  assert.ok(initialChildren[2]!.sel?.includes('train-actions'));
  assert.ok(vnodeIds(initial).indexOf('review-back') > vnodeIds(initial).indexOf('status'));
  assert.ok(vnodeIds(initial).indexOf('puzzle-id') < vnodeIds(initial).indexOf('status'));
  assert.equal(findById(initial, 'skip-btn'), null, 'Skip is not a visible train action');
  assert.ok(findById(initial, 'reveal-btn'));
  assert.ok(findById(initial, 'hint-btn'));

  const completed = view(await makeCompletedReview());
  assert.ok(findById(completed, 'review-back'));
  assert.ok(findById(completed, 'review-forward'));
  assert.equal(findById(completed, 'review-first'), null);
  assert.equal(findById(completed, 'review-last'), null);
});

test('move list shows the puzzle setup move as previous context, before learner moves', async () => {
  const { service, adapter } = await makeWorld([]);
  await service.seedContent([setupMovePuzzle]);
  const ctrl = new TrainCtrl(service, adapter);
  await ctrl.beginAttempt(await adapter.loadPuzzle(setupMovePuzzle.id));

  const moveList = (view(ctrl).children as VNode[])[1]!.children as VNode[];
  const entries = moveList[0]!.children as VNode[];
  const list = entries[1]!.children as VNode[];
  assert.equal(list.length, 1, 'only context is shown before the learner moves');
  assert.ok(list[0]!.sel?.includes('moves-row'));
  assert.equal(vnodeText(list[0]!.children![0] as VNode), '33', 'setup ply keeps its move number');
  const setupCells = nodesWithClass(list[0]!, 'setup');
  assert.equal(setupCells.length, 1, 'setup move is marked as context');
  assert.match(vnodeText(setupCells[0]!), /Rxf4/, 'setup move is shown in SAN');
  assert.match(vnodeText(setupCells[0]!), /♜/, 'setup move carries the moving piece glyph');

  ctrl.dispose();
});

test('move list is Lichess-style: numbered rows, white and black paired, SAN + piece glyph', async () => {
  const ctrl = await makeCompletedReview();
  const moveList = (view(ctrl).children as VNode[])[1]!.children as VNode[];
  const list = (moveList[0]!.children as VNode[])[1]!.children as VNode[];

  // The wrong d4 was reverted, so only the played e4/e5 line is shown.
  assert.equal(list.length, 1, 'reverted attempts leave no row');
  const row = list[0]!;
  assert.equal(vnodeText(row.children![0] as VNode), '1', 'white and black share one move number');
  const cells = row.children!.filter(
    (child): child is VNode => typeof child === 'object' && child !== null && 'sel' in child && (child as VNode).sel!.includes('moves-move'),
  );
  assert.equal(cells.length, 2, 'white then black on the same row');
  assert.ok(nodesWithClass(cells[0]!, 'white').length === 1);
  assert.ok(nodesWithClass(cells[1]!, 'black').length === 1);
  assert.match(vnodeText(cells[0]!), /♙.*e4/s, 'white move carries glyph and SAN');
  assert.match(vnodeText(cells[1]!), /♟.*e5/s, 'black move carries glyph and SAN');
  assert.equal(nodesWithClass(row, 'wrong').length, 0, 'no reverted moves are shown');

  ctrl.dispose();
});

test('beginAttempt plays the opponent setup move as an animation before the solver moves', async () => {
  const { service, adapter } = await makeWorld([]);
  await service.seedContent([setupMovePuzzle]);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  ctrl.setupMoveDelayMs = 5;
  await ctrl.beginAttempt(await adapter.loadPuzzle(setupMovePuzzle.id));

  // Prelude: the board snaps to the position before the setup move, with input
  // disabled and animation off so the cross-puzzle jump does not animate.
  const prelude = board.sets.at(-1)! as { fen?: string; animation?: { enabled?: boolean }; movable?: { color?: unknown } };
  assert.equal(prelude.fen, setupMovePuzzle.sourceFen, 'prelude shows the pre-move position');
  assert.equal(prelude.animation?.enabled, false, 'prelude does not animate the jump');
  assert.equal(prelude.movable?.color, undefined, 'prelude is not interactive');
  assert.equal(board.moves.length, 0, 'the setup move has not animated yet');

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(board.moves, [['f8', 'f4']], 'the setup move animates exactly once');
  const settled = board.sets.at(-1)! as { fen?: string; movable?: { color?: unknown } };
  assert.equal(settled.fen, setupMovePuzzle.solverFen, 'after the animation the solver position shows');
  assert.equal(settled.movable?.color, 'white', 'the solver may now move');
  assert.equal(ctrl.game?.fen, setupMovePuzzle.solverFen, 'grading state is unaffected by the prelude');

  ctrl.dispose();
});

test('a pending setup animation is dropped on dispose without touching the board', async () => {
  const { service, adapter } = await makeWorld([]);
  await service.seedContent([setupMovePuzzle]);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  ctrl.setupMoveDelayMs = 30;
  await ctrl.beginAttempt(await adapter.loadPuzzle(setupMovePuzzle.id));
  ctrl.dispose();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(board.moves.length, 0, 'no animation after teardown');
});

test('completed review steps back to the setup move played when the puzzle loaded', async () => {
  const { service, adapter } = await makeWorld([]);
  await service.seedContent([setupMovePuzzle]);
  const ctrl = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  ctrl.setupMoveDelayMs = 1;
  await ctrl.beginAttempt(await adapter.loadPuzzle(setupMovePuzzle.id));
  await new Promise((resolve) => setTimeout(resolve, 10));

  await ctrl.resolveUserMove('g4', 'c8');
  await new Promise((resolve) => setTimeout(resolve, 450));
  await ctrl.resolveUserMove('c8', 'f8');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(ctrl.game?.isCompleted, true);
  assert.ok(ctrl.review, 'review available after completion');

  ctrl.stepReview('first');
  assert.equal(ctrl.review!.current().mover, 'start');
  assert.equal(ctrl.review!.current().fen, setupMovePuzzle.sourceFen);
  ctrl.stepReview('forward');
  assert.equal(ctrl.review!.current().uci, 'f8f4', 'the first move played is reachable');
  assert.equal(ctrl.review!.current().fen, setupMovePuzzle.solverFen);

  ctrl.dispose();
});

test('live stepper rewinds during solving and returns to interactive play', async () => {
  const { service, adapter } = await makeWorld([]);
  await service.seedContent([setupMovePuzzle]);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  ctrl.setupMoveDelayMs = 1;
  await ctrl.beginAttempt(await adapter.loadPuzzle(setupMovePuzzle.id));
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Rewindable at load: the setup move is the last step, so nothing ahead.
  assert.ok(ctrl.review, 'live review available as soon as the puzzle loads');
  assert.equal(ctrl.review!.canForward, false, 'cursor starts on the live end');

  ctrl.stepReview('back');
  const rewound = board.sets.at(-1)! as { fen?: string; movable?: { color?: unknown } };
  assert.equal(rewound.movable?.color, undefined, 'a rewound step is read-only');
  assert.equal(rewound.fen, setupMovePuzzle.sourceFen, 'it shows the position before the setup move');

  ctrl.stepReview('forward');
  const live = board.sets.at(-1)! as { fen?: string; movable?: { color?: unknown } };
  assert.equal(live.movable?.color, 'white', 'stepping forward returns to live, interactive play');
  assert.equal(live.fen, setupMovePuzzle.solverFen);

  ctrl.dispose();
});

test('live stepper follows the played line as the solver moves', async () => {
  const { service, adapter } = await makeWorld([]);
  await service.seedContent([makePuzzle({ id: 'live-a', solution: ['e2e4', 'e7e5', 'g1f3'] })]);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  await ctrl.beginAttempt(await adapter.loadPuzzle('live-a'));
  assert.equal(ctrl.review, null, 'nothing to rewind before the first move');

  await ctrl.resolveUserMove('e2', 'e4');
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(ctrl.game?.isCompleted, false);
  assert.ok(ctrl.review, 'live review appears once moves are played');
  assert.equal(ctrl.review!.canForward, false, 'cursor follows to the new live end');

  ctrl.stepReview('back');
  const rewound = board.sets.at(-1)! as { movable?: { color?: unknown } };
  assert.equal(rewound.movable?.color, undefined, 'stepping back is read-only');
  ctrl.stepReview('forward');
  const live = board.sets.at(-1)! as { movable?: { color?: unknown } };
  assert.equal(live.movable?.color, 'white', 'returning to the end re-enables play');

  ctrl.dispose();
});

test('the move list highlights the move the stepper is on', async () => {
  const { service, adapter } = await makeWorld([]);
  await service.seedContent([setupMovePuzzle]);
  const ctrl = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  ctrl.setupMoveDelayMs = 1;
  await ctrl.beginAttempt(await adapter.loadPuzzle(setupMovePuzzle.id));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await ctrl.resolveUserMove('g4', 'c8');
  await new Promise((resolve) => setTimeout(resolve, 450));
  await ctrl.resolveUserMove('c8', 'f8');
  await new Promise((resolve) => setTimeout(resolve, 450));

  const highlighted = (): VNode[] => nodesWithClass(view(ctrl), 'current');

  ctrl.stepReview('first');
  assert.equal(highlighted().length, 0, 'the starting position highlights no move');
  ctrl.stepReview('forward');
  assert.match(vnodeText(highlighted()[0]!), /Rxf4/, 'setup move highlighted');
  ctrl.stepReview('forward');
  assert.match(vnodeText(highlighted()[0]!), /Qc8/, 'solver move highlighted');
  ctrl.stepReview('back');
  assert.match(vnodeText(highlighted()[0]!), /Rxf4/, 'stepping back moves the highlight');

  ctrl.dispose();
});

// --- 2. view never renders the board host ------------------------------------

const EXPECTED_IDS = [
  'status',
  'puzzle-id',
  'solver-color',
  'reveal-btn',
  'review-back',
  'review-forward',
  'collection-picker',
  'queue',
  'progress',
  'storage',
];

test('view keeps every control id and never renders a board host', async () => {
  const { service, adapter } = await makeWorld(['ids-a']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);

  const states: Array<{ name: string; vnode: VNode }> = [{ name: 'initial', vnode: view(ctrl) }];
  await ctrl.beginAttempt(await adapter.loadPuzzle('ids-a'));
  states.push({ name: 'mid-attempt', vnode: view(ctrl) });
  await ctrl.onReveal();
  states.push({ name: 'revealed', vnode: view(ctrl) });

  for (const state of states) {
    const ids = vnodeIds(state.vnode);
    for (const expected of EXPECTED_IDS) {
      assert.ok(ids.includes(expected), `${state.name}: #${expected} present`);
    }
    assert.ok(!ids.includes('board'), `${state.name}: no board host vnode`);
    assert.ok(!ids.includes('promotion'), `${state.name}: no promotion overlay vnode`);
    assert.ok(!ids.includes('skip-btn'), `${state.name}: no visible Skip button`);
    assert.equal(state.vnode.sel, 'div.train-panels', `${state.name}: stable combined view root`);
  }
  assert.ok(!vnodeSels(view(ctrl)).some((sel) => sel.includes('#board')));
});

test('TRN-001 hides difficulty while solving and renders accessible symbol controls', async () => {
  const { service, adapter } = await makeWorld(['trn-a']);
  const ctrl = new TrainCtrl(service, adapter);
  await ctrl.beginAttempt(await adapter.loadPuzzle('trn-a'));
  let nodes = vnodeIds(view(ctrl));
  assert.ok(!nodes.includes('rating') && !nodes.includes('themes'));
  const next = findById(view(ctrl), 'next-btn');
  assert.equal(next, null, 'Next is absent while disabled');
  ctrl.nextDisabled = false;
  const enabledNext = findById(view(ctrl), 'next-btn');
  assert.equal(buttonText(enabledNext!), '>');
  assert.equal(enabledNext?.data?.attrs?.['aria-label'], 'Next puzzle');
  const analyze = findById(view(ctrl), 'analyze-btn');
  assert.equal(buttonText(analyze!), '⌕');
  assert.ok(analyze?.sel.includes('.hidden'), 'analyze placeholder stays hidden while solving');

  // UX-009: once the puzzle is finished the same button stops being a symbol
  // and becomes an explicit, emphasised CTA (still `#next-btn`, so the
  // keyboard path and every existing hook are unchanged).
  // `PuzzleGame.isCompleted` is a getter, so simulate the finished state by
  // shadowing it on a delegate of the live game (everything else reads through).
  if (ctrl.game) {
    const game = ctrl.game;
    ctrl.game = Object.create(game, {
      isCompleted: { get: () => true, enumerable: true },
    }) as typeof game;
  }
  const finishedCta = findById(view(ctrl), 'next-btn');
  assert.ok(finishedCta !== null, 'a forward action is offered on completion');
  assert.equal(buttonText(finishedCta!), 'Next puzzle', 'the completion CTA is labelled');
  assert.ok(finishedCta!.sel.includes('next-cta'), 'and is marked for full-width emphasis');
  assert.equal(finishedCta?.data?.attrs?.['aria-label'], 'Next puzzle');
  // AN-001b: the button is a real action now that the engine is wired in.
  assert.equal(analyze?.data?.attrs?.disabled, undefined, 'Analyze is enabled once the puzzle is over');
  assert.match(String(analyze?.data?.attrs?.title), /built-in engine/);

  await ctrl.resolveUserMove('d2', 'd4');
  const failedAnalyze = findById(view(ctrl), 'analyze-btn');
  assert.ok(failedAnalyze && !failedAnalyze.sel.includes('.hidden'), 'analyze appears after failure');
});

// --- 3. redraw storm mid-attempt never touches the board ---------------------

test('N redraws mid-attempt produce zero board traffic and keep the port live', async () => {
  const { service, adapter } = await makeWorld(['storm-a']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  let redraws = 0;
  ctrl.redraw = () => {
    redraws += 1;
  };

  await ctrl.beginAttempt(await adapter.loadPuzzle('storm-a'));
  assert.equal(board.destroys.count, 0);
  const setsAfterBegin = board.sets.length;
  assert.ok(setsAfterBegin >= 1, 'beginAttempt renders the position imperatively');

  for (let i = 0; i < 60; i += 1) {
    ctrl.redraw();
    if (i % 10 === 0) {
      ctrl.updateProgress();
      ctrl.refreshPicker();
      assert.equal(view(ctrl).sel, 'div.train-panels');
      assert.ok(!vnodeIds(view(ctrl)).includes('board'));
    }
  }
  assert.equal(redraws >= 60, true, 'redraws ran');
  assert.equal(board.sets.length, setsAfterBegin, 'redraws never call board.set');
  assert.equal(board.destroys.count, 0, 'redraws never destroy the board');
  assert.equal(ctrl.board, board.port, 'port identity stable across redraws');

  // The board is still live: the next position update goes through.
  await ctrl.resolveUserMove('d2', 'd4');
  assert.ok(board.sets.length > setsAfterBegin, 'imperative board updates still flow');
  assert.equal(ctrl.status.key, 'status.wrong');
});

test('hint highlights only the next solver source and records assistance without grading', async () => {
  const { service, adapter } = await makeWorld(['hint-a']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  await ctrl.beginAttempt(await adapter.loadPuzzle('hint-a'));
  const before = board.sets.length;
  await ctrl.onHint();
  const hintConfig = board.sets.at(-1) as { drawable?: { shapes?: Array<{ orig: string; dest?: string }> } };
  assert.deepEqual(hintConfig.drawable?.shapes, [{ orig: 'e2', brush: 'green' }]);
  assert.equal(ctrl.game?.failedState, false);
  assert.equal(ctrl.nextDisabled, true);
  assert.equal(board.destroys.count, 0);
  assert.ok(board.sets.length > before, 'hint uses imperative board update without remount');
  await ctrl.resolveUserMove('e2', 'e4');
  assert.deepEqual((board.sets.at(-1) as { drawable?: { shapes?: unknown[] } }).drawable?.shapes, []);
});

// --- 4. attempt lifecycle through the ctrl -----------------------------------

test('wrong move fails, correction completes, review steps drive the board', async () => {
  const service = await makeService();
  await service.seedContent([
    makePuzzle({ id: 'life', solution: ['e2e4', 'e7e5'] }),
  ]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);

  await ctrl.beginAttempt(await adapter.loadPuzzle('life'));
  assert.equal(ctrl.status.key, 'status.yourTurn');

  await ctrl.resolveUserMove('d2', 'd4');
  assert.equal(ctrl.status.key, 'status.wrong');
  assert.equal(ctrl.game?.failedState, true);

  await ctrl.resolveUserMove('e2', 'e4');
  // Opponent reply settles after the 260ms delay, then completes.
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(ctrl.game?.isCompleted, true);
  assert.equal(ctrl.status.key, 'status.correctionComplete');
  assert.equal(ctrl.nextDisabled, false);
  assert.equal(ctrl.skipDisabled, true);
  assert.ok(ctrl.review !== null, 'review line built from the recorded attempt');

  const setsBeforeReview = board.sets.length;
  ctrl.stepReview('first');
  ctrl.stepReview('forward');
  ctrl.stepReview('last');
  assert.ok(board.sets.length > setsBeforeReview, 'review steps render imperatively');
  assert.ok(findById(view(ctrl), 'review-back'), 'review stepper available');
});

// --- 5. Skip and Reveal semantics ---------------------------------------------

test('skip abandons and advances; reveal toggles the solution without scoring', async () => {
  const { service, adapter } = await makeWorld(['sk-a', 'sk-b']);
  const ctrl = new TrainCtrl(service, adapter, makeRecordingBoard().port);

  await ctrl.beginAttempt(await adapter.loadPuzzle('sk-a'));
  await ctrl.onSkip();
  assert.equal(ctrl.infoPuzzle?.id, 'sk-b', 'skip moves to the next due puzzle');

  await ctrl.onReveal();
  assert.equal(ctrl.status.key, 'status.revealed');
  assert.equal(ctrl.solutionHidden, false);
  assert.equal(ctrl.nextDisabled, false);
  await ctrl.onReveal();
  assert.equal(ctrl.solutionHidden, true, 'second reveal toggles visibility');
});

// --- 6. promotion pending/cancel ----------------------------------------------

test('promotion choice suspends the move and cancel restores the position', async () => {
  const service = await makeService();
  await service.seedContent([promotionPuzzle]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  const board = makeRecordingBoard();
  const promo = makePromo();
  const ctrl = new TrainCtrl(service, adapter, board.port, promo.ui);

  await ctrl.beginAttempt(await adapter.loadPuzzle(promotionPuzzle.id));
  await ctrl.onUserMove('b7', 'b8');
  assert.ok(ctrl.pendingPromotion !== null, 'promotion pending');
  assert.deepEqual(promo.shown, ['white']);
  assert.ok(!vnodeIds(view(ctrl)).includes('promotion'), 'overlay stays outside the vnodes');

  ctrl.cancelPromotion();
  assert.equal(ctrl.pendingPromotion, null);
  assert.equal(promo.hidden.count >= 1, true);
  assert.equal(ctrl.game?.isCompleted, false, 'cancelled promotion plays nothing');
});

// --- 7. resume-after-reload ----------------------------------------------------

test('resume rebuilds the attempt display without claiming the current puzzle', async () => {
  const service = await makeService();
  await service.seedContent([makePuzzle({ id: 're-a', solution: ['e2e4', 'e7e5'] })]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  const first = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  await first.beginAttempt(await adapter.loadPuzzle('re-a'));

  const resumed = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  assert.equal(await resumed.resumeIfPossible(), true);
  assert.equal(resumed.infoPuzzle?.id, 're-a', 'info panel repainted from the open attempt');
  assert.equal(resumed.status.key, 'status.yourTurn');
  // Fidelity with the pre-Snabbdom flow: resume never set `currentPuzzle`,
  // so review gating still keys off a fresh beginAttempt.
  assert.equal(resumed.currentPuzzle, null);
});

test('hint works on a resumed attempt where currentPuzzle is unset', async () => {
  const service = await makeService();
  await service.seedContent([makePuzzle({ id: 're-hint', solution: ['e2e4', 'e7e5'] })]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  const first = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  await first.beginAttempt(await adapter.loadPuzzle('re-hint'));

  const board = makeRecordingBoard();
  const resumed = new TrainCtrl(service, adapter, board.port);
  assert.equal(await resumed.resumeIfPossible(), true);
  assert.equal(resumed.currentPuzzle, null, 'resume leaves currentPuzzle unset');

  await resumed.onHint();
  const hintConfig = board.sets.at(-1) as {
    drawable?: { shapes?: Array<{ orig: string; brush: string }> };
  };
  assert.deepEqual(
    hintConfig.drawable?.shapes,
    [{ orig: 'e2', brush: 'green' }],
    'hint falls back to infoPuzzle instead of silently no-oping',
  );
});

// --- 8. collection picker scoping ----------------------------------------------

test('collection change restarts the session in the new scope', async () => {
  const { service, adapter } = await makeWorld(['col-a']);
  const ctrl = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  assert.ok(ctrl.collections.length >= 1, 'picker options snapshotted at construction');

  const before = service.getActiveCollectionId();
  const created = await service.createCollection('Other collection');
  const other = created.id;
  await ctrl.onCollectionChange(other);
  assert.equal(service.getActiveCollectionId(), other);
  assert.notEqual(before, other);
  assert.equal(ctrl.activeCollectionId, other, 'picker follows the service');
});

// --- 9. MOB-001: arrow steppers + mobile order ---------------------------------

function findById(vnode: VNode, id: string): VNode | null {
  let found: VNode | null = null;
  walkVNode(vnode, (node) => {
    if (found !== null) return;
    const fromAttrs = (node.data as { attrs?: { id?: string } } | undefined)?.attrs?.id;
    const match = typeof node.sel === 'string' && /#([A-Za-z0-9_-]+)/.exec(node.sel);
    if (fromAttrs === id || match?.[1] === id) found = node;
  });
  return found;
}

function buttonText(node: VNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.children ?? [])
    .map((child) =>
      typeof child === 'object' && child !== null && 'text' in child
        ? String((child as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

async function makeCompletedReview(): Promise<TrainCtrl> {
  const service = await makeService();
  await service.seedContent([makePuzzle({ id: 'mob-a', solution: ['e2e4', 'e7e5'] })]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  const ctrl = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  await ctrl.beginAttempt(await adapter.loadPuzzle('mob-a'));
  await ctrl.resolveUserMove('d2', 'd4');
  await ctrl.resolveUserMove('e2', 'e4');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(ctrl.review !== null, 'review line built for the completed puzzle');
  return ctrl;
}

test('Next after a solve never restarts the puzzle that was just finished', async () => {
  // One-puzzle library: after the success nothing else is eligible, so the
  // scheduler's "earliest future" fallback used to hand back the same puzzle.
  const { service, adapter } = await makeWorld(['only-one']);
  const ctrl = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  await ctrl.loadNext();
  assert.equal(ctrl.game?.id, 'only-one');

  await ctrl.resolveUserMove('e2', 'e4');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(ctrl.game?.isCompleted, true, 'the puzzle completed');

  await ctrl.loadNext();
  assert.equal(ctrl.adapter.getActiveAttemptId(), undefined, 'no new attempt on the same puzzle');
  assert.equal(ctrl.game?.id, 'only-one', 'the finished board stays (no replay)');
  assert.equal(ctrl.game?.isCompleted, true);
});

test('AN-002: analysis opens the puzzle position, not the post-solution board', async () => {
  const c = await makeCompletedReview();
  const puzzleFen = c.infoPuzzle?.solverFen;
  assert.ok(puzzleFen, 'the completed puzzle is still known');

  assert.equal(c.analysisFen(), puzzleFen, 'at the line end the puzzle position is analysed');

  c.stepReview('back');
  assert.equal(
    c.analysisFen(),
    c.review?.current().fen,
    'stepping back analyses the position being reviewed',
  );
});

test('MOB-001: Back/Forward are ◀ ▶ symbols with aria-labels, ids and end-states kept', async () => {
  const c = await makeCompletedReview();

  // Entry sits at the final position: back enabled, forward disabled.
  let back = findById(view(c), 'review-back');
  let forward = findById(view(c), 'review-forward');
  assert.ok(back && forward, 'both steppers rendered');
  assert.equal(buttonText(back), '◀');
  assert.equal(buttonText(forward), '▶');
  assert.equal(
    (back.data as { attrs?: Record<string, unknown> } | undefined)?.attrs?.['aria-label'],
    'Back',
  );
  assert.equal(
    (forward.data as { attrs?: Record<string, unknown> } | undefined)?.attrs?.['aria-label'],
    'Forward',
  );
  assert.ok(back.sel.includes('button'), 'back keeps the button shape');
  assert.equal(
    (back.data as { attrs?: Record<string, unknown> } | undefined)?.attrs?.disabled,
    undefined,
    'back enabled at the line end',
  );
  assert.equal(
    (forward.data as { attrs?: Record<string, unknown> } | undefined)?.attrs?.disabled,
    true,
    'forward disabled at the line end',
  );

  // Step to the start: the disabled states flip to the other end.
  c.stepReview('first');
  back = findById(view(c), 'review-back');
  forward = findById(view(c), 'review-forward');
  assert.equal(
    (back?.data as { attrs?: Record<string, unknown> } | undefined)?.attrs?.disabled,
    true,
    'back disabled at the line start',
  );
  assert.equal(
    (forward?.data as { attrs?: Record<string, unknown> } | undefined)?.attrs?.disabled,
    undefined,
    'forward enabled at the line start',
  );

  // Start/End controls are removed; arrows remain and keyboard navigation
  // retains the first/last jump behavior.
  assert.equal(findById(view(c), 'review-first'), null);
  assert.equal(findById(view(c), 'review-last'), null);
});

test('train layout places board beside a compact panel on desktop and stacks board first on mobile', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
  const container = css.match(/\.container\s*\{([^}]*)\}/);
  assert.ok(container, 'centered content container rule present');
  assert.match(container![1]!, /width:\s*96%;/);
  assert.match(container![1]!, /max-width:\s*96%;/);
  assert.match(container![1]!, /margin:\s*0 auto/);
  const layout = css.match(/\.layout\s*\{([^}]*)\}/);
  assert.ok(layout, 'train layout rule present');
  assert.match(layout![1]!, /display:\s*grid/);
  assert.match(layout![1]!, /grid-template-columns:\s*minmax\(190px,\s*0\.85fr\)\s+minmax\(0,\s*1\.3fr\)\s+minmax\(190px,\s*0\.85fr\)/);
  assert.match(css, /\.controls-left\s*\{[^}]*grid-column:\s*1/);
  assert.match(css, /\.controls-right\s*\{[^}]*grid-column:\s*3/);
  const mobile = css.match(/@media\s*\(\s*max-width:\s*760px\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(mobile, 'tablet/mobile stacking breakpoint present');
  assert.match(mobile![1]!, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  const board = css.match(/\.board\s*\{([^}]*)\}/);
  assert.ok(board, 'board sizing rule present');
  assert.match(board![1]!, /width:\s*100%/);
  assert.doesNotMatch(board![1]!, /max-width:\s*760px/);
  assert.match(css, /\.train-actions\s*\{[^}]*flex-wrap:\s*wrap/);
});

test('solve timer is displayed inline in the right feedback section', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
  const timer = css.match(/#solve-timer\s*\{([^}]*)\}/);
  assert.ok(timer, 'existing #solve-timer has a dedicated style rule');
  assert.match(timer![1]!, /position:\s*static/);
  assert.match(timer![1]!, /display:\s*inline-block/);
  assert.doesNotMatch(timer![1]!, /safe-area-inset|position:\s*fixed/);
  assert.match(timer![1]!, /pointer-events:\s*none/);
});

test('REV-002: arrow keys step only during review and listener is removed on reset/dispose', async () => {
  const c = await makeCompletedReview();
  const listeners = new Set<(event: KeyboardEvent) => void>();
  const fakeWindow = {
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: KeyboardEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: KeyboardEvent) => void);
    },
  };
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  try {
    // Re-enter to attach against the test window; completion was created before it.
    c.resetReview();
    c.enterReview();
    assert.equal(listeners.size, 1);
    const dispatch = (key: string): boolean => {
      let prevented = false;
      const event = { key, preventDefault: () => { prevented = true; } } as KeyboardEvent;
      for (const listener of listeners) listener(event);
      return prevented;
    };
    const start = c.review!.position;
    assert.equal(dispatch('x'), false, 'unrelated key is not prevented');
    assert.equal(c.review!.position, start);
    assert.equal(dispatch('ArrowLeft'), true);
    assert.equal(c.review!.position, start - 1);
    assert.equal(dispatch('ArrowRight'), true);
    assert.equal(c.review!.position, start);
    assert.equal(dispatch('ArrowDown'), true);
    assert.equal(c.review!.position, 0);
    assert.equal(dispatch('ArrowUp'), true);
    assert.equal(c.review!.position, c.review!.count - 1);

    c.resetReview();
    assert.equal(listeners.size, 0);
    c.dispose();
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

// --- 10. BRD-001: premoves + selection persistence ------------------------------

async function makePremoveWorld(solution: string[], extra?: { solverFen?: string }): Promise<{
  service: LocalTrainingService;
  adapter: TrainingAdapter;
}> {
  const service = await makeService();
  await service.seedContent([makePuzzle({ id: 'premove-line', solution, ...extra })]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  return { service, adapter };
}

const waitReply = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 450));

test('BRD-001: legal premove queued in the reply window executes after the reply', async () => {
  const { service, adapter } = await makePremoveWorld(['e2e4', 'e7e5', 'g1f3']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);

  await ctrl.beginAttempt(await adapter.loadPuzzle('premove-line'));
  await ctrl.resolveUserMove('e2', 'e4');
  // Reply window: the window render offers native premoves, not normal moves.
  const windowSet = board.sets[board.sets.length - 1]!;
  assert.equal(windowSet.premovable?.enabled, true);
  assert.equal(windowSet.movable?.color, 'white');
  assert.equal(windowSet.movable?.dests?.size ?? 0, 0);

  await ctrl.onUserMove('g1', 'f3');
  assert.equal(ctrl.game?.failedState, false, 'queueing never fails by itself');
  assert.equal(ctrl.game?.isCompleted, false, 'queued move waits for the reply');
  assert.equal(ctrl.scoredCommitted, false);

  await waitReply();
  assert.equal(ctrl.game?.isCompleted, true, 'queued premove executed after the reply');
  assert.equal(ctrl.status.key, 'status.completed');
  assert.equal(ctrl.game?.failedState, false);
});

test('BRD-001: illegal premove is discarded without penalty', async () => {
  const { service, adapter } = await makePremoveWorld(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);

  await ctrl.beginAttempt(await adapter.loadPuzzle('premove-line'));
  await ctrl.resolveUserMove('e2', 'e4');
  await ctrl.onUserMove('a2', 'a5');
  assert.equal(ctrl.game?.failedState, false);

  await waitReply();
  assert.equal(ctrl.game?.isCompleted, false, 'nothing executed');
  assert.equal(ctrl.status.key, 'status.correct');
  assert.equal(ctrl.game?.failedState, false);
  assert.equal(ctrl.scoredCommitted, false, 'discarded premove never scores');

  // The solver is still to move: the intended move still works.
  await ctrl.resolveUserMove('g1', 'f3');
  await waitReply();
  assert.equal(ctrl.game?.isCompleted, true);
  assert.equal(ctrl.status.key, 'status.completed');
});

test('BRD-001: wrong executed premove grades as an ordinary wrong move', async () => {
  const { service, adapter } = await makePremoveWorld(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);

  await ctrl.beginAttempt(await adapter.loadPuzzle('premove-line'));
  await ctrl.resolveUserMove('e2', 'e4');
  // d2d4 is legal in the post-reply position but off-solution.
  await ctrl.onUserMove('d2', 'd4');

  await waitReply();
  assert.equal(ctrl.status.key, 'status.wrong');
  assert.equal(ctrl.game?.failedState, true);
  assert.equal(ctrl.scoredCommitted, true, 'first-failure rules unchanged');

  // Correction still completes the puzzle.
  await ctrl.resolveUserMove('g1', 'f3');
  await waitReply();
  assert.equal(ctrl.game?.isCompleted, true);
  assert.equal(ctrl.status.key, 'status.correctionComplete');
});

test('BRD-001: selection survives the opponent reply render', async () => {
  const { service, adapter } = await makePremoveWorld(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);

  await ctrl.beginAttempt(await adapter.loadPuzzle('premove-line'));
  await ctrl.resolveUserMove('e2', 'e4');
  // The user selects the knight for the next move during the reply window.
  ctrl.onBoardSelect('g1');
  await waitReply();

  const last = board.sets[board.sets.length - 1]!;
  assert.equal(last.selected, 'g1', 'selection re-asserted after the reply');
  assert.ok(last.movable?.dests?.has('g1'), 'destination highlights re-asserted');
  assert.ok(last.movable?.dests?.get('g1')?.includes('f3'));

  // A stale selection (a square with no solver dests) is dropped instead.
  await ctrl.resolveUserMove('g1', 'f3');
  ctrl.onBoardSelect('e2');
  await waitReply();
  const after = board.sets[board.sets.length - 1]!;
  assert.equal(after.selected, undefined, 'invalid selection not re-asserted');
});

// --- 11. BRD-003: restart after completion -------------------------------------

/**
 * Deterministic, strictly increasing service clock for the restart tests.
 *
 * `listAttempts` is newest-first by `startedAt` and only that key: two
 * attempts started in the same millisecond tie, and the stable sort keeps the
 * older attempt first (Map insertion order). `beginAttempt` then runs the
 * PZL-006 `refreshReview()` against the *finished* attempt and rebuilds its
 * review line, so a restarted attempt looks like it still has history.
 * Reading `startedAt` from `Date.now()` made that depend on wall-clock
 * resolution: the whole in-memory restart sequence can fit in one millisecond.
 * Ticking 1 ms per read keeps the two attempts strictly ordered without
 * depending on clock resolution.
 */
/**
 * AN-001b — the review-screen Analyze action, driven by an injected analysis
 * service (the real engine is covered by the browser smoke test).
 */
test('AN-001b: Analyze renders the engine lines for the position under review', async () => {
  const { service, adapter } = await makeWorld(['ana-a']);
  const asked: string[] = [];
  const stub = {
    isBusy: () => false,
    dispose: () => {},
    async analyze(fen: string) {
      asked.push(fen);
      return {
        fen,
        lines: [
          { scoreText: '+0.24', san: ['e4', 'e5'], depth: 12 },
          { scoreText: '−1.25', san: ['d4', 'd5'], depth: 11 },
        ],
      };
    },
  };
  const ctrl = new TrainCtrl(service, adapter, undefined, undefined, undefined, stub);
  await ctrl.beginAttempt(await adapter.loadPuzzle('ana-a'));

  assert.equal(findById(view(ctrl), 'analysis'), null, 'no panel before asking');

  await ctrl.onAnalyze();

  const tree = view(ctrl);
  assert.equal(asked.length, 1, 'the engine was asked once');
  assert.match(asked[0], /^[rnbqkpRNBQKP1-8/]+ [wb] /, 'a FEN was sent');
  assert.ok(findById(tree, 'analysis-lines') !== null, 'lines render');
  const text = vnodeText(tree);
  assert.ok(text.includes('+0.24') && text.includes('−1.25'), 'both scores render');
  assert.ok(text.includes('e4 e5'), 'the best line renders in SAN');
  assert.match(String(findById(tree, 'analysis-best')?.text), /Engine plays e4/);
});

test('AN-001b: Analyze shows a thinking state, then an error state', async () => {
  const { service, adapter } = await makeWorld(['ana-b']);
  let release: (() => void) | undefined;
  const stub = {
    isBusy: () => false,
    dispose: () => {},
    analyze: (fen: string) =>
      new Promise<never>((_, reject) => {
        release = () => reject(new Error('nope'));
      }),
  };
  const ctrl = new TrainCtrl(service, adapter, undefined, undefined, undefined, stub as never);
  await ctrl.beginAttempt(await adapter.loadPuzzle('ana-b'));

  const pending = ctrl.onAnalyze();
  assert.ok(findById(view(ctrl), 'analysis-status') !== null, 'thinking state renders while the engine runs');

  release?.();
  await pending;
  assert.match(String(findById(view(ctrl), 'analysis-error')?.text), /could not finish/);
});

function makeRestartClock(): { now(): number } {
  let now = 1_700_000_000_000;
  return { now: () => now++ };
}

async function makeRestartWorld(
  id: string,
  solution: string[],
): Promise<{ service: LocalTrainingService; adapter: TrainingAdapter }> {
  const service = new LocalTrainingService({
    store: new LocalStore(new InMemoryStorageBackend()),
    clock: makeRestartClock(),
  });
  await service.init();
  await service.seedContent([makePuzzle({ id, solution })]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  return { service, adapter };
}

test('BRD-003: restart after success starts a new scored attempt, old outcome untouched', async () => {
  const { service, adapter } = await makeRestartWorld('rs-a', ['e2e4']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);

  await ctrl.beginAttempt(await adapter.loadPuzzle('rs-a'));
  await ctrl.resolveUserMove('e2', 'e4');
  assert.equal(ctrl.game?.isCompleted, true);
  assert.equal(ctrl.status.key, 'status.completed');
  assert.ok(ctrl.review !== null, 'review entered on completion');

  const [first] = adapter.listAttemptsForPuzzle('rs-a', 5);
  assert.ok(first, 'finished attempt recorded');
  assert.equal(first.outcome, 'success');
  const firstId = first.attemptId.value;
  const firstEvents = first.events.length;
  assert.equal(adapter.getActiveAttemptId(), undefined, 'finished attempt closed');

  // Restart button visible at completion with the ↻ symbol.
  const atCompletion = findById(view(ctrl), 'restart-btn');
  assert.ok(atCompletion, 'restart button rendered');
  assert.ok(!atCompletion.sel.includes('hidden'), 'restart visible after success');
  assert.equal(buttonText(atCompletion), '↻');
  assert.equal(
    (atCompletion.data as { attrs?: Record<string, unknown> } | undefined)?.attrs?.[
      'aria-label'
    ],
    'Try again',
  );

  await ctrl.onRestart();
  assert.equal(ctrl.game?.isCompleted, false, 'fresh game at the starting position');
  assert.equal(ctrl.status.key, 'status.yourTurn');
  assert.equal(ctrl.scoredCommitted, false, 'scoring state reset');
  assert.equal(ctrl.review, null, 'review section reset');
  assert.equal(ctrl.solutionHidden, true);
  assert.equal(ctrl.nextDisabled, true);
  assert.equal(ctrl.skipDisabled, false);
  const activeId = adapter.getActiveAttemptId();
  assert.ok(activeId, 'new attempt started');
  assert.notEqual(activeId, firstId, 'new attemptId via the normal startAttempt path');
  assert.ok(!vnodeIds(view(ctrl)).includes('board'), 'no board host vnode after restart');
  const afterRestart = findById(view(ctrl), 'restart-btn');
  assert.ok(afterRestart?.sel.includes('hidden'), 'restart hidden again mid-attempt');

  // The finished attempt is immutable: same outcome and event history.
  // (`listAttempts` is newest-first, so locate the finished attempt by id.)
  const stillFirst = adapter
    .listAttemptsForPuzzle('rs-a', 5)
    .find((a) => a.attemptId.value === firstId);
  assert.equal(stillFirst?.outcome, 'success');
  assert.equal(stillFirst?.events.length, firstEvents);

  // The restarted attempt scores ordinarily: solve it and see two attempts.
  await ctrl.resolveUserMove('e2', 'e4');
  assert.equal(ctrl.status.key, 'status.completed');
  const attempts = adapter.listAttemptsForPuzzle('rs-a', 5);
  assert.equal(attempts.length, 2, 'restart recorded as a separate ordinary attempt');
  assert.ok(attempts.every((a) => a.outcome === 'success'));
  assert.notEqual(attempts[0]?.attemptId.value, attempts[1]?.attemptId.value);
});

test('BRD-003: restart after correction-complete also starts a fresh attempt', async () => {
  const { service, adapter } = await makeRestartWorld('rs-b', ['e2e4', 'e7e5']);
  const ctrl = new TrainCtrl(service, adapter, makeRecordingBoard().port);

  await ctrl.beginAttempt(await adapter.loadPuzzle('rs-b'));
  await ctrl.resolveUserMove('d2', 'd4');
  assert.equal(ctrl.status.key, 'status.wrong');
  await ctrl.resolveUserMove('e2', 'e4');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(ctrl.game?.isCompleted, true);
  assert.equal(ctrl.status.key, 'status.correctionComplete');

  const [first] = adapter.listAttemptsForPuzzle('rs-b', 5);
  assert.ok(first, 'correction attempt recorded');
  const firstOutcome = first.outcome;
  const firstEvents = first.events.length;
  const restartVisible = findById(view(ctrl), 'restart-btn');
  assert.ok(restartVisible && !restartVisible.sel.includes('hidden'), 'restart visible after correction');

  await ctrl.onRestart();
  assert.equal(ctrl.game?.isCompleted, false);
  assert.equal(ctrl.game?.failedState, false, 'fresh game is not failed');
  assert.equal(ctrl.status.key, 'status.yourTurn');
  assert.equal(ctrl.review, null);
  assert.ok(adapter.getActiveAttemptId(), 'new attempt started');

  const unchanged = adapter
    .listAttemptsForPuzzle('rs-b', 5)
    .find((a) => a.attemptId.value === first.attemptId.value);
  assert.equal(unchanged?.outcome, firstOutcome, 'finished correction outcome untouched');
  assert.equal(unchanged?.events.length, firstEvents, 'finished correction history untouched');

  // The restarted attempt is an ordinary attempt: a clean solve succeeds.
  await ctrl.resolveUserMove('e2', 'e4');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(ctrl.status.key, 'status.completed');
  assert.equal(adapter.listAttemptsForPuzzle('rs-b', 5).length, 2);
});

test('BRD-003: restart is a no-op before completion', async () => {
  const { service, adapter } = await makeRestartWorld('rs-c', ['e2e4', 'e7e5']);
  const ctrl = new TrainCtrl(service, adapter, makeRecordingBoard().port);

  await ctrl.beginAttempt(await adapter.loadPuzzle('rs-c'));
  const hidden = findById(view(ctrl), 'restart-btn');
  assert.ok(hidden?.sel.includes('hidden'), 'restart hidden mid-attempt');

  const activeBefore = adapter.getActiveAttemptId();
  await ctrl.onRestart();
  assert.equal(adapter.getActiveAttemptId(), activeBefore, 'no new attempt started');
  assert.equal(ctrl.status.key, 'status.yourTurn', 'status untouched');
  assert.equal(ctrl.game?.isCompleted, false);

  // Same guard on a fresh ctrl with no puzzle at all.
  const empty = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  await empty.onRestart();
  assert.equal(empty.game, null);
});
test('BRD-001: promotion premove goes through the picker and executes', async () => {
  const { service, adapter } = await makePremoveWorld(['e2e4', 'e7e5', 'b7b8q'], {
    solverFen: '7k/1P2p3/8/8/8/8/4P3/K7 w - - 0 1',
  });
  const board = makeRecordingBoard();
  const promo = makePromo();
  const ctrl = new TrainCtrl(service, adapter, board.port, promo.ui);

  await ctrl.beginAttempt(await adapter.loadPuzzle('premove-line'));
  await ctrl.resolveUserMove('e2', 'e4');
  await ctrl.onUserMove('b7', 'b8');
  assert.deepEqual(promo.shown, ['white'], 'promotion picker honored for premoves');
  assert.equal(ctrl.game?.isCompleted, false, 'promotion choice still pending');

  ctrl.choosePromotion('q');
  assert.equal(ctrl.game?.isCompleted, false, 'queued promotion waits for the reply');
  assert.equal(ctrl.game?.failedState, false);
  await waitReply();
  assert.equal(ctrl.game?.isCompleted, true);
  assert.equal(ctrl.status.key, 'status.completed');
  assert.equal(ctrl.game?.failedState, false);
});

// --- 12. BRD-004: reveal plays out the solution ---------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function makeRevealWorld(
  id: string,
  solution: string[],
): Promise<{ service: LocalTrainingService; adapter: TrainingAdapter }> {
  const service = await makeService();
  await service.seedContent([makePuzzle({ id, solution })]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  return { service, adapter };
}

/** Every step of a reveal playback renders with no side to move and no dests. */
function assertNonInteractive(set: TrainBoardConfig, where: string): void {
  assert.equal(set.movable?.color, undefined, `${where}: no side to move — input disabled`);
  assert.equal(set.movable?.dests?.size ?? 0, 0, `${where}: no destinations — input disabled`);
}

/** No scored outcome committed for the puzzle (abandoned attempts stay unscored). */
function assertUnscored(adapter: TrainingAdapter, puzzleId: string, where: string): void {
  for (const attempt of adapter.listAttemptsForPuzzle(puzzleId, 5)) {
    assert.equal(attempt.outcome, undefined, `${where}: no scored outcome committed`);
  }
}

test('BRD-004: reveal on-path plays the remaining plies, input disabled, unscored', async () => {
  const { service, adapter } = await makeRevealWorld('rv-a', ['e2e4', 'e7e5', 'g1f3']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  ctrl.playbackPaceMs = 15;

  const puzzle = await adapter.loadPuzzle('rv-a');
  await ctrl.beginAttempt(puzzle);
  await ctrl.resolveUserMove('e2', 'e4');
  await waitReply();
  assert.equal(ctrl.status.key, 'status.correct');

  await ctrl.onReveal();
  assert.equal(ctrl.status.key, 'status.revealed');
  assert.equal(ctrl.playingBack, true, 'playback starts after the unscored abandon');
  assert.equal(adapter.getActiveAttemptId(), undefined, 'attempt abandoned');
  const setsAtReveal = board.sets.length;

  await sleep(250);
  assert.equal(ctrl.playingBack, false, 'short remainder finishes on its own');
  assert.equal(ctrl.status.key, 'status.revealed', 'playback never changes the status');

  const last = board.sets[board.sets.length - 1]!;
  assert.deepEqual(last.lastMove, ['g1', 'f3'], 'last-move highlight on the final ply');
  assertNonInteractive(last, 'final playback step');
  const ref = new PuzzleGame(puzzle);
  ref.playUserMove('e2', 'e4');
  ref.playUserMove('g1', 'f3');
  assert.equal(last.fen, ref.fen, 'playback ends at the solution-final position');

  // Every playback render stayed non-interactive, and nothing was scored.
  for (const set of board.sets.slice(setsAtReveal)) assertNonInteractive(set, 'playback step');
  assert.equal(ctrl.scoredCommitted, false);
  assertUnscored(adapter, 'rv-a', 'reveal playback');
});

test('BRD-004: reveal off-line resets to the solver position, then plays the full line', async () => {
  const { service, adapter } = await makeRevealWorld('rv-b', ['e2e4', 'e7e5', 'g1f3']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  ctrl.playbackPaceMs = 15;

  const puzzle = await adapter.loadPuzzle('rv-b');
  await ctrl.beginAttempt(puzzle);
  await ctrl.resolveUserMove('d2', 'd4');
  assert.equal(ctrl.status.key, 'status.wrong');
  const attemptsBefore = adapter.listAttemptsForPuzzle('rv-b', 5).length;

  await ctrl.onReveal();
  assert.equal(ctrl.playingBack, true);
  const reset = board.sets[board.sets.length - 1]!;
  assert.equal(reset.fen, puzzle.solverFen, 'board resets to the solver position first');
  assertNonInteractive(reset, 'reset render');

  await sleep(350);
  assert.equal(ctrl.playingBack, false);
  const last = board.sets[board.sets.length - 1]!;
  assert.deepEqual(last.lastMove, ['g1', 'f3'], 'full line played to the final ply');
  const ref = new PuzzleGame(puzzle);
  ref.playUserMove('e2', 'e4');
  ref.playUserMove('g1', 'f3');
  assert.equal(last.fen, ref.fen, 'off-line playback ends at the solution-final position');

  // Playback itself commits nothing: same attempt count, no new outcome.
  assert.equal(adapter.listAttemptsForPuzzle('rv-b', 5).length, attemptsBefore);
  assert.equal(ctrl.status.key, 'status.revealed');
});

test('BRD-004: reveal plays promotion plies to the promoted final position', async () => {
  const service = await makeService();
  await service.seedContent([promotionPuzzle]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  ctrl.playbackPaceMs = 15;

  await ctrl.beginAttempt(await adapter.loadPuzzle(promotionPuzzle.id));
  await ctrl.onReveal();
  assert.equal(ctrl.playingBack, true);

  await sleep(200);
  assert.equal(ctrl.playingBack, false);
  const last = board.sets[board.sets.length - 1]!;
  assert.deepEqual(last.lastMove, ['b7', 'b8'], 'last-move highlight on the promotion ply');
  assert.match(last.fen!, /^1Q5k/, 'promoted queen rendered on b8');
  assertNonInteractive(last, 'promotion playback step');
  assertUnscored(adapter, promotionPuzzle.id, 'promotion playback');
});

test('BRD-004: Next cancels playback — no stale steps after navigation', async () => {
  const service = await makeService();
  await service.seedContent([
    makePuzzle({ id: 'rv-n1', solution: ['e2e4', 'e7e5', 'g1f3'] }),
    makePuzzle({ id: 'rv-n2', solution: ['e2e4', 'e7e5'] }),
  ]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  ctrl.playbackPaceMs = 5000;

  await ctrl.beginAttempt(await adapter.loadPuzzle('rv-n1'));
  await ctrl.onReveal();
  assert.equal(ctrl.playingBack, true, 'long playback pending on its timer');

  await ctrl.loadNext();
  assert.equal(ctrl.playingBack, false, 'navigation stops playback');
  const setsAfterNav = board.sets.length;
  await sleep(150);
  assert.equal(
    board.sets.length,
    setsAfterNav,
    'no stale playback callback renders after navigation',
  );
  assert.ok(ctrl.game !== null, 'a fresh attempt is live after Next');
});

test('BRD-004: stale reply settle after reveal neither scores nor re-enables input', async () => {
  const { service, adapter } = await makeRevealWorld('rv-c', ['e2e4', 'e7e5', 'g1f3']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  ctrl.playbackPaceMs = 15;

  await ctrl.beginAttempt(await adapter.loadPuzzle('rv-c'));
  await ctrl.resolveUserMove('e2', 'e4');
  // Reveal inside the opponent-reply window: the 260ms settle is still in flight.
  await ctrl.onReveal();
  assert.equal(ctrl.status.key, 'status.revealed');

  await sleep(600);
  assert.equal(ctrl.status.key, 'status.revealed', 'stale settle never overwrites the status');
  assert.equal(ctrl.playingBack, false);
  assert.equal(ctrl.scoredCommitted, false, 'revealed attempt never scores');
  assertNonInteractive(board.sets[board.sets.length - 1]!, 'post-settle board');
  assertUnscored(adapter, 'rv-c', 'stale settle');
});

test('BRD-004: dispose during playback drops the timer — no stale callbacks', async () => {
  const { service, adapter } = await makeRevealWorld('rv-d', ['e2e4', 'e7e5', 'g1f3']);
  const board = makeRecordingBoard();
  const ctrl = new TrainCtrl(service, adapter, board.port);
  ctrl.playbackPaceMs = 5000;

  await ctrl.beginAttempt(await adapter.loadPuzzle('rv-d'));
  await ctrl.onReveal();
  assert.equal(ctrl.playingBack, true);

  ctrl.dispose();
  assert.equal(ctrl.playingBack, false, 'teardown stops playback');
  await sleep(100);
  assert.equal(ctrl.playingBack, false, 'no stale callback revives playback after unmount');
});

// --- 13. Woodpecker cycle progress bar -----------------------------------------

test('woodpecker cycle panel shows progress through the set as a bar', async () => {
  const service = await makeService();
  await service.seedContent([
    makePuzzle({ id: 'wp-a' }),
    makePuzzle({ id: 'wp-b' }),
    makePuzzle({ id: 'wp-c' }),
  ]);
  const sourceCollectionId = service.getActiveCollectionId();
  const set = await service.createWoodpeckerSet({
    name: 'WP set',
    sourceCollectionId,
    puzzleIds: ['wp-a', 'wp-b', 'wp-c'],
  });
  const { cycleId } = await service.startWoodpeckerCycle(set.setId);
  await service.recordWoodpeckerCycleResult(cycleId, 'wp-a', 'clean', 5);

  const adapter = new TrainingAdapter(service);
  await adapter.startSession(WOODPECKER_CYCLE_PROGRAM_ID, woodpeckerScopeId(set.setId));
  const ctrl = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  ctrl.configureWoodpecker({ kind: 'cycle', setId: set.setId, cycleId });
  await ctrl.beginAttempt(await adapter.loadPuzzle('wp-b'));

  const context = view(ctrl);
  assert.ok(vnodeText(context).includes('Puzzle 2 of 3'), 'position text retained');
  const bar = findById(context, 'woodpecker-cycle-progress');
  assert.ok(bar, 'cycle progress bar rendered in the woodpecker context');
  assert.equal(bar.sel, 'progress.progress-bar');
  assert.equal(bar.data?.props?.value, 1, 'one puzzle already scored');
  assert.equal(bar.data?.props?.max, 3, 'bar spans the whole set');
  assert.match(String(bar.data?.attrs?.['aria-label']), /1 of 3/);
  ctrl.dispose();
});

test('completing a resumed cycle attempt records the result so Next advances', async () => {
  const service = await makeService();
  await service.seedContent([makePuzzle({ id: 'wp-res-a' }), makePuzzle({ id: 'wp-res-b' })]);
  const sourceCollectionId = service.getActiveCollectionId();
  const set = await service.createWoodpeckerSet({
    name: 'Resume WP',
    sourceCollectionId,
    puzzleIds: ['wp-res-a', 'wp-res-b'],
  });
  const { cycleId } = await service.startWoodpeckerCycle(set.setId);

  const adapter = new TrainingAdapter(service);
  await adapter.startSession(WOODPECKER_CYCLE_PROGRAM_ID, woodpeckerScopeId(set.setId));
  const opened = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  await opened.beginAttempt(await adapter.loadPuzzle('wp-res-a'));

  // The PWA was reloaded/backgrounded and reopened: a fresh controller resumes
  // the open attempt. `resumeIfPossible` deliberately leaves `currentPuzzle` null.
  const resumed = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  resumed.configureWoodpecker({ kind: 'cycle', setId: set.setId, cycleId });
  assert.equal(await resumed.resumeIfPossible(), true);
  assert.equal(resumed.currentPuzzle, null, 'resume keeps the documented contract');

  await resumed.resolveUserMove('e2', 'e4');
  await sleep(450);
  assert.equal(resumed.game?.isCompleted, true, 'the resumed puzzle completed');

  const results = service.getWoodpeckerCycle(cycleId)!.cycle.results;
  assert.deepEqual(
    results.map((result) => result.puzzleId).sort(),
    ['wp-res-a'],
    'the completion is recorded against the cycle despite the resume',
  );

  await resumed.loadNext();
  assert.equal(resumed.currentPuzzle?.id, 'wp-res-b', 'Next advances instead of replaying the puzzle');
  resumed.dispose();
  opened.dispose();
});

// --- 14. Woodpecker: revisit earlier puzzles as unscored practice --------------

test('Woodpecker Previous/Next revisits earlier puzzles as unscored practice', async () => {
  const service = await makeService();
  await service.seedContent([
    makePuzzle({ id: 'wpr-a' }),
    makePuzzle({ id: 'wpr-b' }),
    makePuzzle({ id: 'wpr-c' }),
  ]);
  const sourceCollectionId = service.getActiveCollectionId();
  const set = await service.createWoodpeckerSet({
    name: 'WP review',
    sourceCollectionId,
    puzzleIds: ['wpr-a', 'wpr-b', 'wpr-c'],
  });
  const { cycleId } = await service.startWoodpeckerCycle(set.setId);
  await service.recordWoodpeckerCycleResult(cycleId, 'wpr-a', 'clean', 5);
  await service.recordWoodpeckerCycleResult(cycleId, 'wpr-b', 'clean', 5);

  const adapter = new TrainingAdapter(service);
  await adapter.startSession(WOODPECKER_CYCLE_PROGRAM_ID, woodpeckerScopeId(set.setId));
  const ctrl = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  ctrl.configureWoodpecker({ kind: 'cycle', setId: set.setId, cycleId });

  // The cycle continues on the first uncovered puzzle, with Previous available.
  await ctrl.loadNext();
  assert.equal(ctrl.currentPuzzle?.id, 'wpr-c');
  assert.equal(ctrl.canStepWoodpeckerReview(-1), true);
  assert.equal(ctrl.canStepWoodpeckerReview(1), false, 'nothing after the last puzzle');
  assert.ok(findById(view(ctrl), 'woodpecker-prev-btn'), 'Previous control rendered');
  assert.ok(findById(view(ctrl), 'woodpecker-next-btn'), 'Next control rendered');

  // Step back to the earlier puzzle as unscored practice.
  await ctrl.stepWoodpeckerReview(-1);
  assert.equal(ctrl.currentPuzzle?.id, 'wpr-b');
  assert.equal(ctrl.woodpeckerReviewPosition, 2);
  assert.equal(ctrl.canStepWoodpeckerReview(-1), true, 'can still go further back');
  assert.equal(ctrl.canStepWoodpeckerReview(1), true, 'can return toward progress');
  assert.ok(findById(view(ctrl), 'woodpecker-current-btn'), 'Go-to-current escape hatch rendered');

  const resultsBefore = service.getWoodpeckerCycle(cycleId)!.cycle.results.length;
  await ctrl.resolveUserMove('e2', 'e4'); // the puzzle's single solution move
  assert.equal(
    service.getWoodpeckerCycle(cycleId)!.cycle.results.length,
    resultsBefore,
    'unscored review never alters cycle results',
  );
  assert.ok(
    service.listAttempts({ programId: WOODPECKER_REVIEW_PROGRAM_ID }).length >= 1,
    'the review solve lands in the isolated review scope',
  );
  assert.equal(ctrl.woodpeckerReviewPosition, 2, 'still in review after the solve');

  // Next returns to the frontier (scored play) and can never skip past progress.
  await ctrl.stepWoodpeckerReview(1);
  assert.equal(ctrl.currentPuzzle?.id, 'wpr-c');
  assert.equal(ctrl.woodpeckerReviewPosition, null, 'landing on the frontier resumes scored play');
  assert.equal(ctrl.canStepWoodpeckerReview(1), false, 'Next cannot pass the progress frontier');

  // Go to current jumps from review straight back to the frontier.
  await ctrl.stepWoodpeckerReview(-1);
  assert.equal(ctrl.woodpeckerReviewPosition, 2);
  await ctrl.goToWoodpeckerCurrent();
  assert.equal(ctrl.woodpeckerReviewPosition, null);
  assert.equal(ctrl.currentPuzzle?.id, 'wpr-c');
  ctrl.dispose();
});

// --- 15. Setup-move prelude on resume (user report 2026-10-16) ----------------
// A reload resumes the open attempt; before this fix the board jumped straight
// to the solver position with no setup move, so the puzzle looked like it had
// "lost" its first move.

test('resuming an untouched attempt replays the setup move prelude', async () => {
  const service = await makeService();
  await service.seedContent([setupMovePuzzle]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');

  const first = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  first.setupMoveDelayMs = 1;
  await first.beginAttempt(await adapter.loadPuzzle(setupMovePuzzle.id));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const board = makeRecordingBoard();
  const resumed = new TrainCtrl(service, adapter, board.port);
  resumed.setupMoveDelayMs = 5;
  assert.equal(await resumed.resumeIfPossible(), true);

  const prelude = board.sets.at(-1) as { fen?: string; movable?: { color?: unknown } };
  assert.equal(prelude.fen, setupMovePuzzle.sourceFen, 'resume first shows the pre-setup position');
  assert.equal(prelude.movable?.color, undefined, 'prelude is not interactive');
  assert.equal(board.moves.length, 0, 'the setup move has not animated yet');

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(board.moves, [['f8', 'f4']], 'the setup move animates on resume too');
  assert.equal((board.sets.at(-1) as { fen?: string }).fen, setupMovePuzzle.solverFen);
  assert.equal(resumed.currentPuzzle, null, 'resume still does not claim the current puzzle');

  resumed.dispose();
});

test('resuming after a solver move does not replay the setup prelude', async () => {
  const service = await makeService();
  await service.seedContent([setupMovePuzzle]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');

  const first = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  first.setupMoveDelayMs = 1;
  await first.beginAttempt(await adapter.loadPuzzle(setupMovePuzzle.id));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await first.resolveUserMove('g4', 'c8');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const board = makeRecordingBoard();
  const resumed = new TrainCtrl(service, adapter, board.port);
  resumed.setupMoveDelayMs = 5;
  assert.equal(await resumed.resumeIfPossible(), true);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(board.moves.length, 0, 'a partially solved puzzle is not replayed');
  assert.equal(resumed.game?.fen.includes(' '), true, 'the board renders the resumed position');

  resumed.dispose();
});

test('a resumed attempt gets a working stepper that can reach the setup move', async () => {
  const service = await makeService();
  await service.seedContent([setupMovePuzzle]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');

  const first = new TrainCtrl(service, adapter, makeRecordingBoard().port);
  first.setupMoveDelayMs = 1;
  await first.beginAttempt(await adapter.loadPuzzle(setupMovePuzzle.id));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const board = makeRecordingBoard();
  const resumed = new TrainCtrl(service, adapter, board.port);
  resumed.setupMoveDelayMs = 1;
  assert.equal(await resumed.resumeIfPossible(), true);

  // The stepper row is only rendered when a review line exists.
  assert.ok(resumed.review, 'a resumed attempt has a review line');
  assert.equal(resumed.review!.current().mover, 'setup', 'starts live on the setup move');
  assert.equal(resumed.review!.canBack, true, '◀ is enabled so the setup move is reachable');

  resumed.stepReview('back');
  assert.equal(resumed.review!.current().mover, 'start');
  assert.equal(resumed.review!.current().fen, setupMovePuzzle.sourceFen, 'steps back to the pre-setup position');
  assert.equal(resumed.review!.canForward, true, '▶ returns to the setup move');

  resumed.stepReview('forward');
  assert.equal(resumed.review!.current().mover, 'setup');

  resumed.dispose();
});
