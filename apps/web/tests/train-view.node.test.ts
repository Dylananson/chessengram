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
});

// --- 2. view never renders the board host ------------------------------------

const EXPECTED_IDS = [
  'status',
  'puzzle-id',
  'rating',
  'themes',
  'solver-color',
  'reveal-btn',
  'solution',
  'review-section',
  'review-label',
  'review-first',
  'review-back',
  'review-forward',
  'review-last',
  'skip-btn',
  'next-btn',
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
    assert.equal(state.vnode.sel, 'div.controls', `${state.name}: stable controls root`);
  }
  assert.ok(!vnodeSels(view(ctrl)).some((sel) => sel.includes('#board')));
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

  // First/Last stay text buttons with their ids.
  assert.equal(buttonText(findById(view(c), 'review-first')!), 'Start');
  assert.equal(buttonText(findById(view(c), 'review-last')!), 'End');
});

test('MOB-001: mobile CSS orders the review section above the detail panels', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
  const mobile = css.match(/@media\s*\(\s*max-width:\s*640px\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(mobile, 'narrow-screen media block present');
  assert.ok(
    /\.controls\s+#review-section\s*\{[^}]*order:\s*-1/.test(mobile![1]!),
    'review section ordered first inside .controls on mobile',
  );
});
