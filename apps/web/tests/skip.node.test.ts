import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LocalTrainingService } from '../src/scheduler-service.ts';
import { TrainingAdapter } from '../src/training-adapter.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { makePuzzle } from './fixtures.ts';

async function makeReadyAdapter(n = 3): Promise<TrainingAdapter> {
  const service = new LocalTrainingService({ store: new LocalStore(new InMemoryStorageBackend()) });
  await service.init();
  const puzzles = Array.from({ length: n }, (_, i) => makePuzzle({ id: `p${i}` }));
  await service.seedContent(puzzles);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  const first = await adapter.selectNext();
  assert.ok(first.puzzleId);
  await adapter.startAttempt(await adapter.loadPuzzle(first.puzzleId!));
  assert.ok(adapter.getActiveAttemptId());
  return adapter;
}

test('skip abandons the current attempt without scoring and excludes it for the next selection', async () => {
  const adapter = await makeReadyAdapter(3);
  const firstId = adapter.describeCurrentAttempt().progressKey!.puzzleId;

  await adapter.abandonCurrentAttempt({ skip: true });

  assert.equal(adapter.getActiveAttemptId(), undefined, 'attempt released');
  const sessionId = adapter.getSessionId()!;
  assert.equal(
    adapter.getService().getActiveAttempt(sessionId),
    undefined,
    'reservation cleared in the service',
  );

  const next = await adapter.selectNext();
  assert.ok(next.puzzleId);
  assert.notEqual(next.puzzleId, firstId, 'skipped puzzle is excluded');
});

test('skip without skip-list still releases the reservation (reveal/abandon path)', async () => {
  const adapter = await makeReadyAdapter(2);
  await adapter.abandonCurrentAttempt({ skip: false });
  assert.equal(adapter.getActiveAttemptId(), undefined);
  const next = await adapter.selectNext();
  assert.equal(next.puzzleId, 'p0', 'non-skip abandon keeps the puzzle selectable');
});

test('queueSummary counts new, learned and due', async () => {
  const service = new LocalTrainingService({ store: new LocalStore(new InMemoryStorageBackend()) });
  await service.init();
  await service.seedContent([makePuzzle({ id: 'a' }), makePuzzle({ id: 'b' }), makePuzzle({ id: 'c' })]);

  const summary = service.queueSummary('test-program');
  assert.deepEqual(summary, { total: 3, learned: 0, newCount: 3, due: 3 });

  // Solve one puzzle so it leaves the "new" bucket.
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');
  await adapter.startAttempt(await adapter.loadPuzzle('a'));
  await adapter.commitSuccess({
    activeSolvingSeconds: 4,
    correctionSeconds: 0,
    interruptionSeconds: 0,
    hiddenSeconds: 0,
    timingTrustworthy: true,
  });

  const after = service.queueSummary('test-program');
  assert.equal(after.total, 3);
  assert.equal(after.newCount, 2);
  assert.equal(after.learned, 1);
  assert.equal(after.due, 2, 'the two remaining new puzzles are due');
});

test('contracts: SelectNextRequest accepts excludedKeys', async () => {
  const service = new LocalTrainingService({ store: new LocalStore(new InMemoryStorageBackend()) });
  await service.init();
  await service.seedContent([makePuzzle({ id: 'x' }), makePuzzle({ id: 'y' })]);
  const adapter = new TrainingAdapter(service);
  await adapter.startSession('test-program', 'test-collection');

  const service2 = adapter.getService();
  const result = await service2.selectNext({
    sessionId: adapter.getSessionId()!,
    programId: 'test-program',
    collectionId: 'test-collection',
    excludedKeys: ['x'],
  });
  assert.equal(result.puzzleId, 'y');
});