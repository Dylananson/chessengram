/**
 * F01 acceptance gap: the Failed-review queue had no end-to-end coverage - the
 * Woodpecker page entry point, the isolated failed-review program scope, and the
 * route the trainer is given were all untested. These tests drive the real
 * service (a cycle with a recorded failure) rather than faking the queue.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { VNode } from 'snabbdom/build/vnode.js';
import {
  WOODPECKER_CYCLE_PROGRAM_ID,
  WOODPECKER_FAILED_PROGRAM_ID,
  woodpeckerScopeId,
} from '../src/scheduler-service.ts';
import { TrainingAdapter } from '../src/training-adapter.ts';
import { TrainCtrl, view as viewTrain } from '../src/train-view.ts';
import { WoodpeckerCtrl, viewWoodpecker } from '../src/woodpecker-view.ts';
import { makePuzzle, makeService } from './fixtures.ts';

/** Collect every text node in a vnode tree (snabbdom sets copy as text). */
function collectText(node: VNode | string | null | undefined): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  const out: string[] = [];
  if (typeof node.text === 'string') out.push(node.text);
  for (const child of node.children ?? []) out.push(...collectText(child as VNode | string));
  return out;
}

/** Minimal `window` so navigation actions can be observed under Node. */
function stubWindow(): { hash: string } {
  const location = { hash: '' };
  (globalThis as unknown as { window: unknown }).window = {
    location,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return location;
}

function restoreWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

/** A collection whose current cycle already has one recorded failure (p1). */
async function makeFailedCollection() {
  const service = await makeService();
  await service.seedContent([makePuzzle({ id: 'p1' }), makePuzzle({ id: 'p2' })]);
  const collectionId = service.getActiveCollectionId();
  const set = await service.getOrCreateWoodpeckerSetForCollection(collectionId);
  const { cycleId } = await service.startWoodpeckerCycle(set.setId);
  await service.recordWoodpeckerCycleResult(cycleId, 'p1', 'failed', 12);
  await service.recordWoodpeckerCycleResult(cycleId, 'p2', 'clean', 7);
  return { service, collectionId, set, cycleId };
}

test('the Woodpecker page offers the Failed review entry once a cycle has failures', async () => {
  const { service, collectionId, set } = await makeFailedCollection();
  const ctrl = new WoodpeckerCtrl(service);

  const texts = collectText(viewWoodpecker(ctrl));
  assert.ok(texts.includes('Failed review (1)'), `entry rendered, got ${JSON.stringify(texts)}`);
  assert.equal(service.getWoodpeckerFailedPuzzleIds(set.setId).length, 1);

  const location = stubWindow();
  try {
    ctrl.reviewFailures(collectionId);
    assert.equal(
      location.hash,
      `/train/woodpecker?mode=failed&setId=${encodeURIComponent(set.setId)}`,
      'opens the isolated failed-review queue for that collection',
    );
  } finally {
    restoreWindow();
  }
});

test('a failed-review run selects the failed puzzle in its own program scope', async () => {
  const { service, set } = await makeFailedCollection();
  stubWindow();
  try {
    const adapter = new TrainingAdapter(service);
    await adapter.startSession(WOODPECKER_FAILED_PROGRAM_ID, woodpeckerScopeId(set.setId));
    const ctrl = new TrainCtrl(service, adapter);
    ctrl.configureWoodpecker({ kind: 'failed', setId: set.setId });

    await ctrl.loadNext();

    assert.equal(ctrl.currentPuzzle?.id, 'p1', 'only puzzles missed in the cycle are offered');
    assert.ok(
      collectText(viewTrain(ctrl)).includes('Woodpecker · Failed review'),
      'the trainer identifies failed-review mode',
    );
    const attempts = service.listAttempts({ programId: WOODPECKER_FAILED_PROGRAM_ID });
    assert.equal(attempts.length, 1, 'the review attempt lands in the failed-review scope');
    assert.equal(service.listAttempts({ programId: WOODPECKER_CYCLE_PROGRAM_ID }).length, 0, 'cycle scope untouched');
    ctrl.dispose();
  } finally {
    restoreWindow();
  }
});

test('an empty failed queue reports queue-empty without crashing', async () => {
  const service = await makeService();
  await service.seedContent([makePuzzle({ id: 'p1' })]);
  const set = await service.getOrCreateWoodpeckerSetForCollection(service.getActiveCollectionId());
  await service.startWoodpeckerCycle(set.setId);
  stubWindow();
  try {
    const adapter = new TrainingAdapter(service);
    await adapter.startSession(WOODPECKER_FAILED_PROGRAM_ID, woodpeckerScopeId(set.setId));
    const ctrl = new TrainCtrl(service, adapter);
    ctrl.configureWoodpecker({ kind: 'failed', setId: set.setId });

    await ctrl.loadNext();

    assert.equal(ctrl.currentPuzzle, null, 'nothing to review yet');
    assert.equal(ctrl.status.key, 'status.queueEmpty');
    assert.ok(
      collectText(viewTrain(ctrl)).includes('Woodpecker · Failed review'),
      'still renders the failed-review context',
    );
    ctrl.dispose();
  } finally {
    restoreWindow();
  }
});
