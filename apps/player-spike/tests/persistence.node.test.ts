import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { makePuzzle, makeService, PROGRAM_ID } from './fixtures.ts';

const p1 = makePuzzle({ id: 'p1' });
const p2 = makePuzzle({ id: 'p2' });

test('local store round-trips content and meta through a dumped backend', async () => {
  const backend = new InMemoryStorageBackend();
  const store = new LocalStore(backend);
  await store.savePuzzles([p1, p2]);
  await store.saveMeta('flag', { ok: true });

  const reloaded = new LocalStore(InMemoryStorageBackend.fromDump(backend.dump()));
  assert.deepEqual(await reloaded.loadPuzzles(), [p1, p2]);
  assert.deepEqual(await reloaded.loadMeta('flag'), { ok: true });
  assert.equal(await reloaded.loadMeta('missing'), undefined);
});

test('a reloaded service restores content, order, schedule and the active attempt', async () => {
  const backend = new InMemoryStorageBackend();
  const service = await makeService(backend);
  await service.seedContent([p1, p2], { packId: 'pack-x' });
  const session = await service.startSession({ programId: PROGRAM_ID, collectionId: 'c1' });
  const started = await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: PROGRAM_ID, puzzleId: p1.id, collectionId: 'c1' },
    expectedScheduleRevision: 0,
  });
  await service.recordEvent({
    attemptId: started.attemptId,
    event: { eventId: 'm1', type: 'move', occurredAt: 1, payload: { uci: 'e2e4', correct: true } },
  });

  const reloaded = await makeService(InMemoryStorageBackend.fromDump(backend.dump()));

  assert.equal(reloaded.hasContent(), true);
  assert.deepEqual(reloaded.listPuzzleIds(), ['p1', 'p2']);
  assert.equal((await reloaded.loadContentMeta())?.packId, 'pack-x');

  const schedule = reloaded.getScheduleState(`${PROGRAM_ID}:p1`);
  assert.ok(schedule);
  assert.ok(schedule.introducedAt !== undefined, 'introduction must survive reload');

  const active = reloaded.getActiveAttempt(session.session.sessionId);
  assert.ok(active, 'active attempt must be resumable after reload');
  assert.equal(active.progressKey.puzzleId, 'p1');
  const moves = active.events.filter((event) => event.type === 'move');
  assert.equal(moves.length, 1);
  assert.equal(moves[0]?.payload?.correct, true);
});

test('reset clears persisted content and derived state', async () => {
  const backend = new InMemoryStorageBackend();
  const service = await makeService(backend);
  await service.seedContent([p1]);
  await service.startSession({ programId: PROGRAM_ID });

  await service.reset();
  await service.init();

  assert.equal(service.hasContent(), false);
  assert.equal(service.listPuzzleIds().length, 0);
  assert.equal(service.getAttemptCount(), 0);
});
