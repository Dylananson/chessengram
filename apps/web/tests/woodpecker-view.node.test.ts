import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { VNode } from 'snabbdom/build/vnode.js';
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

/** Every vnode in the tree matching the predicate, depth-first. */
function findVNodes(node: VNode | string | null | undefined, match: (n: VNode) => boolean): VNode[] {
  if (node === null || node === undefined || typeof node === 'string') return [];
  const out: VNode[] = match(node) ? [node] : [];
  for (const child of node.children ?? []) out.push(...findVNodes(child as VNode, match));
  return out;
}

test('Woodpecker page lists collections and has no set form', async () => {
  const service = await makeService();
  await service.seedContent([makePuzzle({ id: 'p1' }), makePuzzle({ id: 'p2' })]);
  const ctrl = new WoodpeckerCtrl(service);
  const root = viewWoodpecker(ctrl);
  const texts = collectText(root);
  const joined = texts.join('\n');

  assert.ok(texts.includes('Woodpecker training'));
  assert.ok(texts.includes('Your collections'));
  assert.ok(texts.includes('Default'));
  assert.ok(texts.includes('Start Woodpecker'));
  assert.ok(!joined.includes('Your sets'), 'no user-facing set list');

  const inputs = findVNodes(root, (node) => node.sel === 'input');
  assert.equal(inputs.length, 0, 'no set-name input');
});

test('Woodpecker page shows progress and resume for a started collection', async () => {
  const service = await makeService();
  await service.seedContent([makePuzzle({ id: 'p1' })]);
  const collectionId = service.getActiveCollectionId();
  const set = await service.getOrCreateWoodpeckerSetForCollection(collectionId);
  await service.startWoodpeckerCycle(set.setId);

  const ctrl = new WoodpeckerCtrl(service);
  const texts = collectText(viewWoodpecker(ctrl));
  assert.ok(texts.includes('Progress'));
  assert.ok(texts.includes('Resume cycle 1'));
  assert.ok(texts.some((line) => /fixed snapshot/.test(line)));
});

test('Woodpecker allows starting a collection larger than 500 puzzles', async () => {
  const service = await makeService();
  await service.seedContent(Array.from({ length: 501 }, (_, index) => makePuzzle({ id: `large-${index}` })));
  const root = viewWoodpecker(new WoodpeckerCtrl(service));
  const start = findVNodes(root, (node) => node.sel?.startsWith('button.button') === true)
    .find((node) => node.text === 'Start Woodpecker');

  assert.ok(start, 'start action is present');
  assert.equal((start.data?.attrs as Record<string, unknown> | undefined)?.disabled, undefined);
  assert.ok(!collectText(root).some((text) => text.includes('at most 500')));
});
