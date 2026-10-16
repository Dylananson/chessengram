import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { VNode } from 'snabbdom/build/vnode.js';
import { DEFAULT_COLLECTION_ID, DEFAULT_PROGRAM_ID } from '../src/scheduler-service.ts';
import { SpacedCtrl, summarizeSpaced, viewSpacedHub } from '../src/spaced-view.ts';
import { makePuzzle, makeService, timing } from './fixtures.ts';

const a = makePuzzle({ id: 'a' });
const b = makePuzzle({ id: 'b' });

/** Collect every text node in a vnode tree (snabbdom sets copy as text). */
function collectText(node: VNode | string | null | undefined): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  const out: string[] = [];
  if (typeof node.text === 'string') out.push(node.text);
  for (const child of node.children ?? []) out.push(...collectText(child as VNode | string));
  return out;
}

test('summarizeSpaced reports per-collection counts, flags and empty history', async () => {
  const service = await makeService();
  await service.seedContent([a, b]);
  const second = await service.createCollection('Second');
  await service.addPuzzleToCollection(second.id, 'a');

  const snapshot = summarizeSpaced(service);
  assert.equal(snapshot.activeCollectionId, DEFAULT_COLLECTION_ID);
  assert.equal(snapshot.collections.length, 2);

  const fallback = snapshot.collections.find((row) => row.id === DEFAULT_COLLECTION_ID)!;
  assert.equal(fallback.total, 2);
  assert.equal(fallback.isDefault, true);
  assert.equal(fallback.isActive, true);
  assert.equal(fallback.inProgressPuzzleId, undefined);

  const scoped = snapshot.collections.find((row) => row.id === second.id)!;
  assert.equal(scoped.total, 1);
  assert.equal(scoped.isDefault, false);
  assert.equal(scoped.isActive, false);

  assert.equal(snapshot.attemptCount, 0);
  assert.deepEqual(snapshot.recent, { total: 0, success: 0, failure: 0, unscored: 0, abandoned: 0 });
});

test('summarizeSpaced surfaces the in-progress puzzle and recent outcomes', async () => {
  const service = await makeService();
  await service.seedContent([a, b]);
  const session = await service.startSession({
    programId: DEFAULT_PROGRAM_ID,
    collectionId: DEFAULT_COLLECTION_ID,
  });
  const sessionId = session.session.sessionId;

  const finished = await service.startAttempt({
    sessionId,
    progressKey: { programId: DEFAULT_PROGRAM_ID, puzzleId: 'a' },
    expectedScheduleRevision: 0,
  });
  await service.commitOutcome({
    attemptId: finished.attemptId,
    outcome: 'success',
    timing: timing(),
    expectedScheduleRevision: finished.scheduleRevision,
    idempotencyKey: 'spaced-1',
  });

  // Leave a second attempt open so the collection is resumable.
  await service.startAttempt({
    sessionId,
    progressKey: { programId: DEFAULT_PROGRAM_ID, puzzleId: 'b' },
    expectedScheduleRevision: 0,
  });

  const snapshot = summarizeSpaced(service);
  assert.equal(snapshot.collections[0]!.inProgressPuzzleId, 'b');
  assert.equal(snapshot.attemptCount, 2);
  assert.equal(snapshot.recent.total, 2);
  assert.equal(snapshot.recent.success, 1);
  assert.equal(snapshot.recent.unscored, 1);
});

test('viewSpacedHub renders the summary, stats and one card per collection', async () => {
  const service = await makeService();
  await service.seedContent([a, b]);
  const second = await service.createCollection('Second');
  await service.addPuzzleToCollection(second.id, 'a');

  const ctrl = new SpacedCtrl(service);
  const texts = collectText(viewSpacedHub(ctrl));
  const joined = texts.join('\n');

  assert.ok(texts.includes('Spaced Repetition'));
  assert.ok(texts.includes('Your collections'));
  assert.ok(texts.includes('Progress'));
  assert.ok(texts.includes('Default'));
  assert.ok(texts.includes('Second'));
  assert.ok(joined.includes('2 puzzles · 2 due now · 2 new · 0 learned'));
  assert.ok(joined.includes('1 puzzles · 1 due now · 1 new · 0 learned'));
  assert.ok(joined.includes('0 attempts recorded'));
  assert.ok(texts.includes('Start Spaced Repetition'));
  assert.ok(texts.includes('Manage collections'));
});
