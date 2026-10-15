import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { VNode } from 'snabbdom/build/vnode.js';
import { HistoryCtrl, HistoryView, summarizeHistory, view } from '../src/history-view.ts';
import { DEFAULT_PROGRAM_ID } from '../src/scheduler-service.ts';
import { setLocale, t } from '../src/i18n.ts';
import { makePuzzle, makeService, timing } from './fixtures.ts';

/** Collect every text node in a vnode tree (snabbdom sets cell copy as text). */
function collectText(node: VNode | string | null | undefined): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  const out: string[] = [];
  if (typeof node.text === 'string') out.push(node.text);
  for (const child of node.children ?? []) out.push(...collectText(child as VNode | string));
  return out;
}

/** True when any vnode in the tree matches the selector predicate. */
function hasSelector(node: VNode | string | null | undefined, match: (sel: string) => boolean): boolean {
  if (node === null || node === undefined || typeof node === 'string') return false;
  if (typeof node.sel === 'string' && match(node.sel)) return true;
  return (node.children ?? []).some((child) => hasSelector(child as VNode | string, match));
}

test('empty library yields an empty read-only snapshot', async () => {
  const service = await makeService();
  const snapshot = summarizeHistory(service, DEFAULT_PROGRAM_ID);
  assert.deepEqual(snapshot, {
    total: 0,
    newCount: 0,
    due: 0,
    learned: 0,
    attemptCount: 0,
    rows: [],
    attempts: [],
  });
});

test('snapshot lists per-puzzle state, queue counts and the attempt total', async () => {
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a' }), makePuzzle({ id: 'b' })]);

  const session = await service.startSession({
    programId: DEFAULT_PROGRAM_ID,
    collectionId: 'c1',
  });
  const started = await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: DEFAULT_PROGRAM_ID, puzzleId: 'a', collectionId: 'c1' },
    expectedScheduleRevision: 0,
  });
  await service.recordEvent({
    attemptId: started.attemptId,
    event: { eventId: 'm1', type: 'move', occurredAt: 1, payload: { uci: 'e2e4', correct: true } },
  });
  const committed = await service.commitOutcome({
    attemptId: started.attemptId,
    outcome: 'success',
    timing: timing(),
    expectedScheduleRevision: started.scheduleRevision,
  });
  assert.equal(committed.committed, true);

  const before = { attempts: service.getAttemptCount(), ids: service.listPuzzleIds() };
  const snapshot = summarizeHistory(service, DEFAULT_PROGRAM_ID);

  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.newCount + snapshot.learned, 2);
  assert.equal(snapshot.attemptCount, before.attempts);
  assert.ok(snapshot.attemptCount >= 1, 'recorded attempt is visible');
  assert.deepEqual(
    snapshot.rows.map((row) => row.puzzleId),
    ['a', 'b'],
  );
  const rowA = snapshot.rows.find((row) => row.puzzleId === 'a')!;
  assert.notEqual(rowA.state, 'new', 'attempted puzzle leaves the new state');
  assert.equal(
    snapshot.rows.find((row) => row.puzzleId === 'b')!.state,
    'new',
    'untouched puzzle stays new',
  );

  // Read-only: the projection must not mutate derived or raw state.
  assert.equal(service.getAttemptCount(), before.attempts);
  assert.deepEqual(service.listPuzzleIds(), before.ids);
});

test('HistoryView renders read-only content without touching service state', async () => {
  setLocale('en');
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a', rating: 1234 })]);
  const ctrl = new HistoryCtrl(service);

  const attemptsBefore = service.getAttemptCount();
  const texts = collectText(view(ctrl));
  const joined = texts.join('\n');
  assert.ok(joined.includes('a'));
  assert.ok(joined.includes('1234'));
  assert.ok(texts.includes(t('history.title')));
  assert.equal(service.getAttemptCount(), attemptsBefore, 'render performs no writes');
  assert.ok(
    hasSelector(view(ctrl), (sel) => sel.startsWith('table.puzzle-table')),
    'per-puzzle status list renders',
  );
});

test('empty library renders the empty-list message', async () => {
  setLocale('en');
  const service = await makeService();
  const ctrl = new HistoryCtrl(service);
  const texts = collectText(view(ctrl));
  assert.ok(texts.includes(t('history.list.empty')));
  assert.ok(texts.includes(t('history.attempts.empty')));
});

test('ctrl.refresh re-reads service getters without writes', async () => {
  setLocale('en');
  const service = await makeService();
  let redraws = 0;
  const ctrl = new HistoryCtrl(service, DEFAULT_PROGRAM_ID, () => {
    redraws += 1;
  });
  assert.equal(ctrl.snapshot.rows.length, 0);

  await service.upsertPuzzles([makePuzzle({ id: 'a' })]);
  const before = service.getAttemptCount();
  ctrl.refresh();

  assert.equal(ctrl.snapshot.rows.length, 1);
  assert.equal(ctrl.snapshot.total, 1);
  assert.equal(redraws, 1, 'refresh ends in redraw');
  assert.equal(service.getAttemptCount(), before, 'refresh performs no writes');
});

test('unmount without mount is safe', async () => {
  const service = await makeService();
  const screen = new HistoryView({ service, adapter: undefined as never });
  screen.unmount();
});
