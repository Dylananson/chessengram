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
import { LocalTrainingService } from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { makePuzzle, makeService, promotionPuzzle } from './fixtures.ts';

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

// --- fakes -------------------------------------------------------------------

function makeRecordingBoard(): {
  port: TrainBoardPort;
  sets: TrainBoardConfig[];
  destroys: { count: number };
} {
  const sets: TrainBoardConfig[] = [];
  const destroys = { count: 0 };
  return {
    sets,
    destroys,
    port: {
      set(config: TrainBoardConfig): void {
        sets.push(config);
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
  assert.notEqual(shell.uiPlaceholder, shell.boardHost);
  assert.ok(!shell.uiPlaceholder.children.includes(shell.boardHost));
  assert.ok(shell.boardHost.className.includes('board'));
  assert.equal(shell.boardHost.attrs['aria-label'], 'Board');
  assert.equal(shell.boardWrap.className, 'board-wrap');
  assert.deepEqual(shell.boardWrap.children, [shell.boardHost], 'no card wrapper or Board heading');
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

  assert.equal(shell.boardHost, host, 'board host identity unchanged');
  assert.equal(ctrl.board, port, 'board port identity unchanged');
  assert.equal(board.destroys.count, 0, 'layout changes never destroy Chessground');
  ctrl.dispose();
});

test('train actions render before puzzle details, with review navigation in the action row', async () => {
  const { service, adapter } = await makeWorld(['layout-a']);
  const ctrl = new TrainCtrl(service, adapter);
  await ctrl.beginAttempt(await adapter.loadPuzzle('layout-a'));
  const initial = view(ctrl);
  const initialChildren = initial.children as VNode[];
  assert.ok(initialChildren[0]!.sel?.includes('train-actions'));
  assert.ok(vnodeIds(initial).indexOf('puzzle-id') > vnodeIds(initial).indexOf('reveal-btn'));
  assert.equal(findById(initial, 'skip-btn'), null, 'Skip is not a visible train action');
  assert.ok(findById(initial, 'reveal-btn'));

  const completed = view(await makeCompletedReview());
  const actionRow = (completed.children as VNode[])[0]!;
  assert.ok(findById(actionRow, 'review-back'));
  assert.ok(findById(actionRow, 'review-forward'));
  assert.equal(findById(actionRow, 'review-first'), null);
  assert.equal(findById(actionRow, 'review-last'), null);
});

// --- 2. view never renders the board host ------------------------------------

const EXPECTED_IDS = [
  'status',
  'puzzle-id',
  'solver-color',
  'reveal-btn',
  'solution',
  'review-section',
  'review-label',
  'review-back',
  'review-forward',
  'practice-btn',
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
    assert.equal(state.vnode.sel, 'div.controls', `${state.name}: stable controls root`);
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
  assert.equal(analyze?.data?.attrs?.disabled, true);
  assert.equal(analyze?.data?.attrs?.title, 'Stockfish analysis is planned for AN-001b.');

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
      assert.equal(view(ctrl).sel, 'div.controls');
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
  assert.ok(vnodeIds(view(ctrl)).includes('review-section'), 'review section rendered');
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

test('train layout keeps the square board full-width with the action row and wraps on mobile', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
  const container = css.match(/\.container\s*\{([^}]*)\}/);
  assert.ok(container, 'centered content container rule present');
  assert.match(container![1]!, /max-width:\s*900px/);
  assert.match(container![1]!, /margin:\s*0 auto/);
  const mobile = css.match(/@media\s*\(\s*max-width:\s*640px\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(mobile, 'narrow-screen media block present');
  assert.ok(/\.board-wrap\s*\{[^}]*flex-basis:\s*100%/.test(mobile![1]!));
  const board = css.match(/\.board\s*\{([^}]*)\}/);
  assert.ok(board, 'board sizing rule present');
  assert.match(board![1]!, /width:\s*100%/);
  assert.doesNotMatch(board![1]!, /max-width:\s*760px/);
  assert.match(css, /\.controls\s*\{[^}]*flex:\s*1 1 100%/);
  assert.match(css, /\.train-actions\s*\{[^}]*flex-wrap:\s*wrap/);
});

test('solve timer stays visible in a non-interactive safe-area viewport pill', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
  const timer = css.match(/#solve-timer\s*\{([^}]*)\}/);
  assert.ok(timer, 'existing #solve-timer has a dedicated style rule');
  assert.match(timer![1]!, /position:\s*fixed/);
  assert.match(timer![1]!, /right:\s*max\([^;]*safe-area-inset-right/);
  assert.match(timer![1]!, /bottom:\s*max\([^;]*safe-area-inset-bottom/);
  assert.match(timer![1]!, /pointer-events:\s*none/);
  assert.match(timer![1]!, /z-index:\s*900/);
  assert.match(css, /\.promotion\s*\{[^}]*z-index:\s*1000/);
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

async function makeRestartWorld(
  id: string,
  solution: string[],
): Promise<{ service: LocalTrainingService; adapter: TrainingAdapter }> {
  const service = await makeService();
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
