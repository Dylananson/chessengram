import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { VNode } from 'snabbdom/build/vnode.js';
import { PuzzlesCtrl, PuzzlesView, summarizePuzzles, view } from '../src/puzzles-view.ts';
import { setLocale, t } from '../src/i18n.ts';
import { makePuzzle, makeService, PROGRAM_ID } from './fixtures.ts';

const PROMOTION_FEN = '7k/1P6/8/8/8/8/8/K7 w - - 0 1';
const GOOD_JSONL = JSON.stringify({
  id: 'good1',
  solverFen: PROMOTION_FEN,
  solution: ['b7b8q'],
  rating: 1000,
  themes: ['endgame'],
  source: 'lichess',
  sourceId: 'good1',
});
const CSV_HEADER =
  'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags';
const GOOD_CSV_ROW =
  '01q5Z,5r1k/pp4pp/8/3B4/1P2pRQ1/P5PP/3q4/6K1 b - - 2 33,f8f4 g4c8 f4f8 c8f8,905,80,91,1855,endgame mate mateIn2 short,https://lichess.org/abc,';
const GOOD_PGN = '[Event "Test"]\n[Site "https://lichess.org/abc"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 *\n';

/** Collect every text node in a vnode tree (snabbdom sets copy as text). */
function collectText(node: VNode | string | null | undefined): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  const out: string[] = [];
  if (typeof node.text === 'string') out.push(node.text);
  for (const child of node.children ?? []) out.push(...collectText(child as VNode | string));
  return out;
}

/** Find a vnode by its `id` attribute (smoke + CSS hook ids are preserved). */
function findById(node: VNode | string | null | undefined, id: string): VNode | null {
  if (node === null || node === undefined || typeof node === 'string') return null;
  if ((node.data?.attrs as Record<string, unknown> | undefined)?.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findById(child as VNode | string, id);
    if (found) return found;
  }
  return null;
}

/** Every vnode in the tree carrying a given `data-*` attribute value. */
function findByDataAttr(
  node: VNode | string | null | undefined,
  name: string,
): Array<{ value: unknown; node: VNode }> {
  if (node === null || node === undefined || typeof node === 'string') return [];
  const out: Array<{ value: unknown; node: VNode }> = [];
  const value = (node.data?.attrs as Record<string, unknown> | undefined)?.[name];
  if (value !== undefined) out.push({ value, node });
  for (const child of node.children ?? []) out.push(...findByDataAttr(child as VNode, name));
  return out;
}

async function makeCtrl(ids: string[] = []) {
  const service = await makeService();
  await service.upsertPuzzles(ids.map((id) => makePuzzle({ id })));
  const ctrl = new PuzzlesCtrl(service);
  await ctrl.refresh();
  return { service, ctrl };
}

test('view renders the pack panel, importers, creator toggle, and library with smoke-hook ids', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl(['a']);
  const tree = view(ctrl);
  const texts = collectText(tree);

  assert.ok(texts.includes(t('puzzles.pack.title')));
  assert.ok(texts.includes(t('puzzles.import.title')));
  assert.ok(texts.includes(t('puzzles.pgn.title')));
  assert.ok(texts.includes(t('puzzles.creator.title')));
  assert.ok(texts.includes(t('puzzles.list.title')));
  for (const id of [
    'puzzles-message',
    'puzzles-import-file',
    'puzzles-import-btn',
    'puzzles-import-csv-file',
    'puzzles-import-csv-btn',
    'puzzles-pgn-file',
    'puzzles-pgn-preview-btn',
    'puzzles-new-btn',
    'puzzles-list',
  ]) {
    assert.ok(findById(tree, id) !== null, `control #${id} renders`);
  }
  // No creator form, no PGN preview yet.
  assert.equal(findById(tree, 'pc-save'), null);
  assert.equal(findById(tree, 'puzzles-pgn-confirm'), null);
});

test('pack panel reports the loaded pack id, count, and empty state', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  assert.ok(collectText(view(ctrl)).includes(t('puzzles.pack.none')));

  const { ctrl: packed } = await makeCtrl(['a', 'b']);
  const texts = collectText(view(packed));
  assert.ok(texts.join(' ').includes(t('puzzles.pack.count', { count: 2 })));
});

test('library rows render ids, ratings, colors, themes, status, and edit/remove hooks', async () => {
  setLocale('en');
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a', themes: ['endgame', 'mate'] })]);
  const ctrl = new PuzzlesCtrl(service);
  await ctrl.refresh();
  const tree = view(ctrl);
  const texts = collectText(tree);

  assert.ok(texts.includes('a'));
  assert.ok(texts.includes(t('puzzles.edit')));
  assert.ok(texts.includes(t('puzzles.remove')));
  assert.deepEqual(
    findByDataAttr(tree, 'data-edit').map((hit) => hit.value),
    ['a'],
  );
  assert.deepEqual(
    findByDataAttr(tree, 'data-remove').map((hit) => hit.value),
    ['a'],
  );
});

test('empty library renders the empty-state message', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  assert.ok(collectText(view(ctrl)).includes(t('puzzles.list.none')));
});

test('creator form renders every pc-* control with the same labels', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  await ctrl.toggleCreator();
  const tree = view(ctrl);
  const texts = collectText(tree);

  assert.ok(texts.includes(t('puzzles.creator.mode.create')));
  assert.ok(texts.includes(t('puzzles.creator.save')));
  for (const id of [
    'pc-errors',
    'pc-id',
    'pc-fen',
    'pc-setup-fen',
    'pc-setup-move',
    'pc-solution',
    'pc-rating',
    'pc-themes',
    'pc-sourceid',
    'pc-save',
  ]) {
    assert.ok(findById(tree, id) !== null, `control #${id} renders`);
  }
});

test('edit mode prefills the form, locks the id, and titles by puzzle id', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl(['a']);
  await ctrl.edit('a');
  const tree = view(ctrl);
  assert.ok(collectText(tree).includes(t('puzzles.creator.mode.edit', { id: 'a' })));
  const idInput = findById(tree, 'pc-id')!;
  assert.equal((idInput.data?.props as Record<string, unknown>)?.value, 'a');
  assert.equal((idInput.data?.attrs as Record<string, unknown>)?.readonly, true);
  const solution = findById(tree, 'pc-solution')!;
  assert.equal((solution.data?.props as Record<string, unknown>)?.value, 'e2e4');
});

test('message renders in #puzzles-message with the legacy ok/error class', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  ctrl.message = { kind: 'ok', text: 'hello' };
  let box = findById(view(ctrl), 'puzzles-message')!;
  assert.ok(collectText(box).includes('hello'));
  assert.equal(box.sel, 'div.ok');

  ctrl.message = { kind: 'error', text: 'bad' };
  box = findById(view(ctrl), 'puzzles-message')!;
  assert.equal(box.sel, 'div.error');
});

test('save with invalid input reports creator errors in #pc-errors and writes nothing', async () => {
  setLocale('en');
  const { service, ctrl } = await makeCtrl();
  let redraws = 0;
  ctrl.redraw = () => {
    redraws += 1;
  };
  const ok = await ctrl.save({ solverFen: 'nonsense', solution: [] });
  assert.equal(ok, false);
  assert.ok(ctrl.creatorErrors.length > 0);
  assert.deepEqual(service.listPuzzleIds(), []);
  assert.ok(redraws >= 1, 'failed save ends in redraw');

  await ctrl.toggleCreator();
  const box = findById(view(ctrl), 'pc-errors')!;
  assert.equal(box.sel, 'div.error');
  assert.ok(collectText(box).includes(ctrl.creatorErrors.join(' · ')));
});

test('save persists a valid puzzle and confirms added vs replaced with the same strings', async () => {
  setLocale('en');
  const { service, ctrl } = await makeCtrl();
  let redraws = 0;
  ctrl.redraw = () => {
    redraws += 1;
  };
  const input = {
    id: 'mine1',
    solverFen: PROMOTION_FEN,
    solution: ['b7b8q'],
    rating: 1234,
    themes: ['endgame', 'promotion'],
  };
  assert.equal(await ctrl.save(input), true);
  assert.deepEqual(service.listPuzzleIds(), ['mine1']);
  assert.equal(
    ctrl.message?.text,
    t('puzzles.creator.saved', { id: 'mine1', kind: t('puzzles.creator.saved.added') }),
  );
  assert.equal(ctrl.showCreator, false);

  await ctrl.edit('mine1');
  assert.equal(await ctrl.save({ ...input, rating: 1500 }), true);
  assert.equal(
    ctrl.message?.text,
    t('puzzles.creator.saved', { id: 'mine1', kind: t('puzzles.creator.saved.replaced') }),
  );
  assert.ok(redraws >= 2, 'saves end in redraw');
});

test('remove drops content and the derived schedule but keeps raw history', async () => {
  setLocale('en');
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a' }), makePuzzle({ id: 'b' })]);
  const session = await service.startSession({ programId: PROGRAM_ID, collectionId: 'c' });
  await service.startAttempt({
    sessionId: session.session.sessionId,
    progressKey: { programId: PROGRAM_ID, puzzleId: 'a' },
    expectedScheduleRevision: 0,
  });
  const attemptsBefore = service.getAttemptCount();

  const ctrl = new PuzzlesCtrl(service);
  await ctrl.remove('a');

  assert.deepEqual(service.listPuzzleIds(), ['b']);
  assert.equal(service.getScheduleState(`${PROGRAM_ID}:a`), undefined);
  assert.equal(service.getAttemptCount(), attemptsBefore, 'raw attempt history kept (D09)');
  assert.equal(ctrl.message?.text, t('puzzles.remove.done', { id: 'a' }));
  assert.ok(collectText(view(ctrl)).includes(t('puzzles.remove.done', { id: 'a' })));
});

test('JSONL import merges under the filename pack id and reports counts', async () => {
  setLocale('en');
  const { service, ctrl } = await makeCtrl();
  await ctrl.importText('jsonl', `${GOOD_JSONL}\n`, 'pack.jsonl');
  assert.deepEqual(service.listPuzzleIds(), ['good1']);
  assert.equal((await service.loadContentMeta())?.packId, 'pack.jsonl');
  assert.equal(ctrl.message?.text, t('puzzles.import.result', { added: 1, replaced: 0 }));
});

test('JSONL import with no file or no valid lines reports the same error strings', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  await ctrl.importText('jsonl', null, '');
  assert.equal(ctrl.message?.text, t('puzzles.import.none'));

  await ctrl.importText('jsonl', 'not json\n', 'bad.jsonl');
  assert.equal(ctrl.message?.kind, 'error');
  assert.ok(collectText(view(ctrl)).includes(ctrl.message!.text));
});

test('CSV import derives puzzles from the setup move with the same result string', async () => {
  setLocale('en');
  const { service, ctrl } = await makeCtrl();
  await ctrl.importText('csv', `${CSV_HEADER}\n${GOOD_CSV_ROW}\n`, 'lichess.csv');
  assert.deepEqual(service.listPuzzleIds(), ['01q5Z']);
  assert.equal(ctrl.message?.text, t('puzzles.import.result', { added: 1, replaced: 0 }));
});

test('PGN preview-confirm flow keeps ambiguity reporting and cancel semantics', async () => {
  setLocale('en');
  const { service, ctrl } = await makeCtrl();
  await ctrl.previewPgnText(null);
  assert.equal(ctrl.message?.text, t('puzzles.import.none'));

  await ctrl.previewPgnText('1. e4 e5 (1... c5 2. Nf3) 2. Nf3 Nc6 *\n');
  assert.ok(ctrl.pgnPreview !== null);
  assert.equal(ctrl.pgnPreview!.candidates[0]!.variations, 1, 'variations reported, not imported');

  let tree = view(ctrl);
  assert.ok(findById(tree, 'puzzles-pgn-confirm') !== null);
  assert.ok(findById(tree, 'puzzles-pgn-cancel') !== null);
  assert.ok(collectText(tree).includes(t('puzzles.pgn.preview.title')));

  await ctrl.cancelPgn();
  assert.equal(ctrl.pgnPreview, null);
  assert.equal(findById(view(ctrl), 'puzzles-pgn-confirm'), null);

  await ctrl.previewPgnText(GOOD_PGN);
  await ctrl.confirmPgn();
  assert.equal(ctrl.pgnPreview, null);
  assert.equal(service.listPuzzleIds().length, 1);
  assert.equal(
    ctrl.message?.text,
    t('puzzles.pgn.imported', { added: 1, replaced: 0 }),
  );
});

test('PGN preview with no games or no valid games reports the same strings', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  await ctrl.previewPgnText('');
  assert.equal(ctrl.message?.text, t('puzzles.pgn.none'));

  await ctrl.previewPgnText('[Variant "Crazyhouse"]\n\n1. e4 *\n');
  assert.ok(ctrl.pgnPreview !== null, 'unsupported-variant game still previews');
  const tree = view(ctrl);
  const confirm = findById(tree, 'puzzles-pgn-confirm')!;
  assert.equal(
    (confirm.data?.attrs as Record<string, unknown>)?.disabled,
    true,
    'confirm disabled with zero valid games',
  );
});

test('summarizePuzzles is a pure read-only projection with per-row status', async () => {
  setLocale('en');
  const service = await makeService();
  await service.upsertPuzzles([makePuzzle({ id: 'a', rating: 1500, themes: ['x', 'y'] })]);
  const snapshot = summarizePuzzles(service, undefined);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0]!.id, 'a');
  assert.equal(snapshot.rows[0]!.rating, 1500);
  assert.ok(snapshot.rows[0]!.status.includes(t('puzzles.state.new')));
});

test('every writer ends in redraw and refresh re-reads the library', async () => {
  const { ctrl } = await makeCtrl(['a']);
  let redraws = 0;
  ctrl.redraw = () => {
    redraws += 1;
  };
  const before = redraws;
  await ctrl.refresh();
  assert.ok(redraws > before);
  assert.equal(ctrl.snapshot.rows.length, 1);
});

test('unmount without mount is safe', async () => {
  const service = await makeService();
  const screen = new PuzzlesView({ service, adapter: undefined as never });
  screen.unmount();
});
