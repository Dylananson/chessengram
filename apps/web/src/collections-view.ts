/**
 * Collections screen (B4, user decision 2026-10-15): real static puzzle sets
 * with multi-membership. Lists every collection with membership and due
 * counts, and supports create/rename/delete plus adding/removing puzzle
 * references. One puzzle may live in many collections; schedule progress is
 * per-collection (the same puzzle trains independently in each collection).
 *
 * Deleting a collection removes its membership list and its scoped derived
 * schedules; puzzles, other collections' schedules and all raw attempt
 * history are kept. The default collection cannot be deleted. The
 * active-collection picker lives on the Train screen; this screen only shows
 * which collection is active. Strictly membership management: no grading, no
 * attempt writes.
 *
 * Rendering (UI-001 S3, copying the S2 History pattern): mutable state lives
 * in {@link CollectionsCtrl} (the current `summarizeCollections` snapshot
 * plus `message`/`renamingId` UI state and per-input drafts), {@link view} is
 * a pure `(ctrl) => VNode` function built from the S1 primitives, and
 * {@link CollectionsView} mounts once via snabbdom `patch` then re-patches
 * through a guarded `redraw` closure. `h`/`init`/modules come from DOM-free
 * `snabbdom/build/*` deep subpaths (never the package root, which touches
 * `window` at load), so this module — ctrl, snapshot helpers, and `view` —
 * stays importable under Node. Only `mount` touches the DOM.
 */

import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import type { Screen } from './router.ts';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_PROGRAM_ID,
  type LocalTrainingService,
} from './scheduler-service.ts';
import { actionButton, emptyState, panel } from './ui/primitives.ts';
// Shared screen patch (see `./ui/patch.ts`).
import { screenPatch as patch } from './ui/patch.ts';

export interface CollectionsRow {
  id: string;
  name: string;
  puzzleIds: string[];
  total: number;
  due: number;
  learned: number;
  isDefault: boolean;
  isActive: boolean;
}

export interface CollectionsSnapshot {
  rows: CollectionsRow[];
}

export interface CollectionMessage {
  kind: 'ok' | 'error';
  text: string;
}

/**
 * Pure read-only projection over existing public service getters: every
 * collection with its membership list, per-collection queue counts in the
 * default program scope, and default/active flags. Exported for tests;
 * performs no mutations.
 */
export function summarizeCollections(service: LocalTrainingService): CollectionsSnapshot {
  const activeId = service.getActiveCollectionId();
  return {
    rows: service.listCollections().map((collection) => {
      const summary = service.queueSummary(DEFAULT_PROGRAM_ID, collection.id);
      return {
        id: collection.id,
        name: collection.name,
        puzzleIds: [...collection.puzzleIds],
        total: summary.total,
        due: summary.due,
        learned: summary.learned,
        isDefault: collection.id === DEFAULT_COLLECTION_ID,
        isActive: collection.id === activeId,
      };
    }),
  };
}

/**
 * Per-screen controller: owns the current snapshot plus the `message` /
 * `renamingId` UI state and per-input drafts, and the `redraw` closure the
 * mount site installs. Every mutation path ends in `refresh()` (pure
 * re-projection + `redraw()`), mirroring the S2 History seam. Input elements
 * report into the drafts via `input` events, so the ctrl — and `view` — stay
 * Node-importable; only the mount site touches the DOM.
 */
export class CollectionsCtrl {
  snapshot: CollectionsSnapshot;
  message: CollectionMessage | null = null;
  renamingId: string | null = null;
  newName = '';
  renameValue = '';
  addValues = new Map<string, string>();
  redraw: () => void = () => {};
  private readonly service: LocalTrainingService;

  constructor(service: LocalTrainingService, redraw: () => void = () => {}) {
    this.service = service;
    this.redraw = redraw;
    this.snapshot = summarizeCollections(service);
  }

  /** Re-run the pure projection over the service getters and re-render. */
  refresh(): void {
    this.snapshot = summarizeCollections(this.service);
    this.redraw();
  }

  /**
   * Draft handlers for the create/rename/add inputs. They record keystrokes
   * without redrawing: re-rendering mid-typing would disturb focus, and the
   * drafts are read when the adjacent action button is clicked.
   */
  createInput(event: Event): void {
    this.newName = (event.target as HTMLInputElement | null)?.value ?? '';
  }

  renameInput(event: Event): void {
    this.renameValue = (event.target as HTMLInputElement | null)?.value ?? '';
  }

  addInput(collectionId: string, event: Event): void {
    this.addValues.set(
      collectionId,
      (event.target as HTMLInputElement | null)?.value ?? '',
    );
  }

  private row(collectionId: string): CollectionsRow | undefined {
    return this.snapshot.rows.find((candidate) => candidate.id === collectionId);
  }

  async create(): Promise<void> {
    try {
      const created = await this.service.createCollection(this.newName);
      this.message = { kind: 'ok', text: t('collections.created', { name: created.name }) };
    } catch (error) {
      this.message = {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      };
    }
    // The pre-Snabbdom template rebuilt `innerHTML` on every render, which
    // implicitly cleared the create input; reset the draft to match.
    this.newName = '';
    this.refresh();
  }

  async rename(collectionId: string): Promise<void> {
    if (this.renamingId !== collectionId) {
      this.renamingId = collectionId;
      this.renameValue = this.row(collectionId)?.name ?? '';
      this.message = null;
      this.refresh();
      return;
    }
    try {
      await this.service.renameCollection(collectionId, this.renameValue);
      this.renamingId = null;
      this.message = { kind: 'ok', text: t('collections.renamed') };
    } catch (error) {
      this.message = {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      };
    }
    this.refresh();
  }

  async deleteCollection(collectionId: string): Promise<void> {
    try {
      await this.service.deleteCollection(collectionId);
      if (this.renamingId === collectionId) this.renamingId = null;
      this.message = { kind: 'ok', text: t('collections.deleted') };
    } catch (error) {
      this.message = {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      };
    }
    this.refresh();
  }

  async addMember(collectionId: string): Promise<void> {
    const puzzleId = (this.addValues.get(collectionId) ?? '').trim();
    if (!puzzleId) return;
    try {
      await this.service.addPuzzleToCollection(collectionId, puzzleId);
      this.message = { kind: 'ok', text: t('collections.member.added', { id: puzzleId }) };
    } catch (error) {
      this.message = {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      };
    }
    this.addValues.set(collectionId, '');
    this.refresh();
  }

  async removeMember(collectionId: string, puzzleId: string): Promise<void> {
    await this.service.removePuzzleFromCollection(collectionId, puzzleId);
    this.message = { kind: 'ok', text: t('collections.member.removed', { id: puzzleId }) };
    this.refresh();
  }
}

function memberList(ctrl: CollectionsCtrl, row: CollectionsRow): VNode {
  if (row.puzzleIds.length === 0) return emptyState(t('collections.members.empty'));
  return h(
    'ul.member-list',
    row.puzzleIds.map((puzzleId) =>
      h('li', [
        puzzleId,
        ' ',
        actionButton(t('collections.member.remove'), 'tertiary', {
          onClick: () => void ctrl.removeMember(row.id, puzzleId),
        }),
      ]),
    ),
  );
}

function collectionCard(ctrl: CollectionsCtrl, row: CollectionsRow): VNode {
  const renaming = ctrl.renamingId === row.id;
  const nameNode: VNode | string = renaming
    ? h('input', {
        attrs: { id: `rename-${row.id}` },
        props: { value: ctrl.renameValue },
        on: { input: (event) => void ctrl.renameInput(event) },
      })
    : h('strong', row.name);
  const badges: Array<VNode | string> = [];
  if (row.isDefault) badges.push(h('span.badge', t('collections.badge.default')));
  if (row.isActive) badges.push(h('span.badge', t('collections.badge.active')));
  return h('section.panel', { attrs: { 'data-collection': row.id } }, [
    h('h3', [nameNode, ...badges.flatMap((badge) => [' ', badge])]),
    h(
      'p',
      t('collections.summary', { members: row.total, due: row.due, learned: row.learned }),
    ),
    h('div.button-row', [
      actionButton(
        renaming ? t('collections.rename.save') : t('collections.rename.start'),
        'tertiary',
        { onClick: () => void ctrl.rename(row.id) },
      ),
      actionButton(t('collections.delete'), 'tertiary', {
        disabled: row.isDefault,
        onClick: () => void ctrl.deleteCollection(row.id),
      }),
    ]),
    memberList(ctrl, row),
    h('div.flex-row', [
      h('input', {
        attrs: { id: `add-${row.id}`, placeholder: t('collections.member.add.placeholder') },
        props: { value: ctrl.addValues.get(row.id) ?? '' },
        on: { input: (event) => void ctrl.addInput(row.id, event) },
      }),
      actionButton(t('collections.member.add'), 'primary', {
        compact: true,
        onClick: () => void ctrl.addMember(row.id),
      }),
    ]),
  ]);
}

/**
 * Pure view: same information and same strings as the pre-Snabbdom template
 * (create row + message, one card per collection with badges, summary counts,
 * rename/delete actions, member list, add-member row), composed from the S1
 * `panel`/`actionButton`/`emptyState` primitives. Snabbdom sets copy as text,
 * so no manual HTML escaping is needed.
 */
export function view(ctrl: CollectionsCtrl): VNode {
  const messageNode: VNode | null =
    ctrl.message === null
      ? null
      : h(ctrl.message.kind === 'ok' ? 'p.ok' : 'p.error', ctrl.message.text);
  const header = panel(t('collections.title'), [
    h('p', t('collections.subtitle')),
    h('div.flex-row', [
      h('input', {
        attrs: {
          id: 'collections-new-name',
          placeholder: t('collections.create.placeholder'),
        },
        props: { value: ctrl.newName },
        on: { input: (event) => void ctrl.createInput(event) },
      }),
      actionButton(t('collections.create'), 'primary', {
        compact: true,
        id: 'collections-create',
        onClick: () => void ctrl.create(),
      }),
    ]),
    ...(messageNode === null ? [] : [messageNode]),
  ]);
  const cards = ctrl.snapshot.rows.map((row) => collectionCard(ctrl, row));
  return h('div.collections-screen', [
    header,
    ...(cards.length > 0
      ? cards
      : [h('section.panel', [h('p.muted', t('collections.list.empty'))])]),
  ]);
}

export class CollectionsView implements Screen {
  readonly id = 'collections' as const;

  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private ctrl: CollectionsCtrl | null = null;
  private vnode: VNode | null = null;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  mount(host: HTMLElement): void {
    this.host = host;
    const placeholder = document.createElement('div');
    host.appendChild(placeholder);
    const ctrl = new CollectionsCtrl(this.ctx.service);
    this.ctrl = ctrl;
    this.vnode = patch(placeholder, view(ctrl));
    // The patch replaces the placeholder; track the live root so unmount
    // removes exactly what snabbdom inserted.
    this.root = this.vnode.elm as HTMLElement;
    ctrl.redraw = () => {
      if (this.ctrl === null || this.vnode === null) return;
      this.vnode = patch(this.vnode, view(this.ctrl));
      this.root = this.vnode.elm as HTMLElement;
    };
  }

  unmount(): void {
    // Guarded: safe to call without a prior mount, and drops the vnode ref
    // so any late redraw after teardown is a no-op instead of a crash.
    this.root?.remove();
    this.root = null;
    this.host = null;
    this.ctrl = null;
    this.vnode = null;
  }
}
