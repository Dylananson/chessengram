import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { HistoryView, summarizeHistory } from '../src/history-view.ts';
import { DEFAULT_PROGRAM_ID } from '../src/scheduler-service.ts';
import { setLocale, t } from '../src/i18n.ts';
import { makePuzzle, makeService, timing } from './fixtures.ts';

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

test('HistoryView mounts read-only HTML without touching service state', async () => {
  setLocale('en');
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a', rating: 1234 })]);
  const view = new HistoryView({ service, adapter: undefined as never });
  const host = { innerHTML: '' } as unknown as HTMLElement;

  const attemptsBefore = service.getAttemptCount();
  view.mount(host);
  assert.match(host.innerHTML, /a/);
  assert.match(host.innerHTML, /1234/);
  assert.ok(host.innerHTML.includes(t('history.title')));
  assert.equal(service.getAttemptCount(), attemptsBefore, 'mount performs no writes');
  assert.match(host.innerHTML, /<table/, 'per-puzzle status list renders');

  view.unmount();
});

test('empty library renders the empty-list message', async () => {
  setLocale('en');
  const service = await makeService();
  const view = new HistoryView({ service, adapter: undefined as never });
  const host = { innerHTML: '' } as unknown as HTMLElement;
  view.mount(host);
  assert.ok(host.innerHTML.includes(t('history.list.empty')));
  view.unmount();
});
