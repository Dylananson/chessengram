/**
 * Dashboard Woodpecker ordering (user request 2026-10-16): collections are
 * listed most-recently-trained first, based on the last Woodpecker attempt
 * (cycle, failed review or unscored review) in that collection's scope, falling
 * back to the last cycle start for a cycle that was opened but not yet solved.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { VNode } from 'snabbdom/build/vnode.js';
import {
  LocalTrainingService,
  WOODPECKER_CYCLE_PROGRAM_ID,
  woodpeckerScopeId,
} from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';
import { DashboardCtrl, viewDashboard } from '../src/dashboard-view.ts';
import { makePuzzle, timing } from './fixtures.ts';

/** A service with a controllable clock so ordering is deterministic. */
async function makeClockedService(): Promise<{ service: LocalTrainingService; setNow: (ms: number) => void }> {
  let now = 1_000;
  const service = new LocalTrainingService({
    store: new LocalStore(new InMemoryStorageBackend()),
    clock: { now: () => now },
  });
  await service.init();
  return { service, setNow: (ms) => { now = ms; } };
}

/** Commit one scored Woodpecker attempt for a collection's set scope. */
async function solve(
  service: LocalTrainingService,
  setId: string,
  puzzleId: string,
  key: string,
): Promise<void> {
  const collectionId = woodpeckerScopeId(setId);
  const session = await service.startSession({ programId: WOODPECKER_CYCLE_PROGRAM_ID, collectionId });
  const started = await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: WOODPECKER_CYCLE_PROGRAM_ID, collectionId, puzzleId },
    expectedScheduleRevision: 0,
  });
  await service.commitOutcome({
    attemptId: started.attemptId,
    outcome: 'success',
    timing: timing(),
    expectedScheduleRevision: started.scheduleRevision,
    idempotencyKey: key,
  });
}

/** Order of the Woodpecker collection cards in the rendered dashboard. */
function woodpeckerOrder(root: VNode): string[] {
  const out: string[] = [];
  const walk = (node: VNode | string | null | undefined): void => {
    if (node === null || node === undefined || typeof node === 'string') return;
    const id = (node.data?.attrs as Record<string, unknown> | undefined)?.['data-dashboard-woodpecker'];
    if (typeof id === 'string') out.push(id);
    for (const child of node.children ?? []) walk(child as VNode | string);
  };
  walk(root);
  return out;
}

test('the most recently trained Woodpecker collection is listed first', async () => {
  const { service, setNow } = await makeClockedService();
  await service.seedContent([makePuzzle({ id: 'p1' })]);
  const second = await service.createCollection('Second');
  await service.addPuzzleToCollection(second.id, 'p1');

  const first = await service.getOrCreateWoodpeckerSetForCollection(service.getActiveCollectionId());
  const other = await service.getOrCreateWoodpeckerSetForCollection(second.id);

  // Train the default collection first, then 'Second' later.
  setNow(2_000);
  await solve(service, first.setId, 'p1', 'a');
  setNow(3_000);
  await solve(service, other.setId, 'p1', 'b');

  const order = woodpeckerOrder(viewDashboard(new DashboardCtrl(service)));
  assert.deepEqual(order, [second.id, service.getActiveCollectionId()], 'most recent first');
});

test('retraining an older collection moves it back to the top', async () => {
  const { service, setNow } = await makeClockedService();
  await service.seedContent([makePuzzle({ id: 'p1' })]);
  const second = await service.createCollection('Second');
  await service.addPuzzleToCollection(second.id, 'p1');
  const first = await service.getOrCreateWoodpeckerSetForCollection(service.getActiveCollectionId());
  const other = await service.getOrCreateWoodpeckerSetForCollection(second.id);

  setNow(2_000);
  await solve(service, first.setId, 'p1', 'a');
  setNow(3_000);
  await solve(service, other.setId, 'p1', 'b');
  setNow(4_000);
  await solve(service, first.setId, 'p1', 'c');

  const order = woodpeckerOrder(viewDashboard(new DashboardCtrl(service)));
  assert.deepEqual(order, [service.getActiveCollectionId(), second.id]);
});

test('an opened-but-unsolved cycle still counts as activity', async () => {
  const { service, setNow } = await makeClockedService();
  await service.seedContent([makePuzzle({ id: 'p1' })]);
  const second = await service.createCollection('Second');
  await service.addPuzzleToCollection(second.id, 'p1');

  setNow(2_000);
  const first = await service.getOrCreateWoodpeckerSetForCollection(service.getActiveCollectionId());
  await service.startWoodpeckerCycle(first.setId);
  setNow(1_500); // clock goes backwards on purpose: 'Second' solved earlier
  const other = await service.getOrCreateWoodpeckerSetForCollection(second.id);
  await solve(service, other.setId, 'p1', 'b');

  const order = woodpeckerOrder(viewDashboard(new DashboardCtrl(service)));
  assert.deepEqual(order, [service.getActiveCollectionId(), second.id], 'later cycle start wins');
});

test('last activity prefers the newest attempt over an older cycle start', async () => {
  const { service, setNow } = await makeClockedService();
  await service.seedContent([makePuzzle({ id: 'p1' })]);
  const set = await service.getOrCreateWoodpeckerSetForCollection(service.getActiveCollectionId());

  setNow(1_000);
  await service.startWoodpeckerCycle(set.setId);
  assert.equal(service.getWoodpeckerLastActivityAt(set.setId), 1_000);

  setNow(5_000);
  await solve(service, set.setId, 'p1', 'a');
  assert.equal(service.getWoodpeckerLastActivityAt(set.setId), 5_000);
});

test('a collection with no Woodpecker work has no activity time', async () => {
  const { service } = await makeClockedService();
  await service.seedContent([makePuzzle({ id: 'p1' })]);
  const set = await service.getOrCreateWoodpeckerSetForCollection(service.getActiveCollectionId());
  assert.equal(service.getWoodpeckerLastActivityAt(set.setId), undefined);
});
