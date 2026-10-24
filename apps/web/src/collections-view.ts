/**
 * Collections screen (B4, user decision 2026-10-15; user request 2026-10-16).
 *
 * The screen has two routes under the same `collections` screen id:
 *   - `#/collections` — a compact grid of collection cards (name, badges,
 *     counts, progress and start/resume actions). The add-puzzle input no
 *     longer lives here.
 *   - `#/collections/<id>` — a collection detail page with the full picture:
 *     spaced-repetition and Woodpecker progress, membership management
 *     (add/remove), rename and delete.
 *
 * Collections are real static puzzle sets with multi-membership. One puzzle may
 * live in many collections; schedule progress is per-collection (the same
 * puzzle trains independently in each collection). Cards and the detail page
 * label the primary actions "Resume" instead of "Start" once a collection has
 * progress (learned puzzles / an in-flight attempt for Spaced Repetition, or a
 * Woodpecker set snapshot for Woodpecker).
 *
 * Deleting a collection removes its membership list and its scoped derived
 * schedules; puzzles, other collections' schedules and all raw attempt
 * history are kept. The default collection cannot be deleted. The
 * active-collection picker lives on the Train screen; this screen only shows
 * which collection is active. Strictly membership management: no grading, no
 * attempt writes.
 *
 * Puzzle lists start collapsed on the detail page: a Show/Hide toggle
 * (per-collection, session-only) only renders the member list while expanded,
 * so the page stays compact by default.
 *
 * Rendering (UI-001 S3, copying the S2 History pattern): mutable state lives
 * in {@link CollectionsCtrl} (the current `summarizeCollections` snapshot,
 * the routed `selectedId`, plus `message`/`renamingId` UI state and per-input
 * drafts), {@link view} is a pure `(ctrl) => VNode` function built from the S1
 * primitives, and {@link CollectionsView} mounts once via snabbdom `patch` then
 * re-patches through a guarded `redraw` closure. `h`/`init`/modules come from
 * DOM-free `snabbdom/build/*` deep subpaths (never the package root, which
 * touches `window` at load), so this module — ctrl, snapshot helpers, and
 * `view` — stays importable under Node. Only `mount` touches the DOM.
 */

import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import { summarizeWoodpeckerCycle } from '@chessengram/scheduler';
import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import type { Screen } from './router.ts';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_PROGRAM_ID,
  type LocalTrainingService,
} from './scheduler-service.ts';
import { actionButton, emptyState, progressBar } from './ui/primitives.ts';
// Shared screen patch (see `./ui/patch.ts`).
import { screenPatch as patch } from './ui/patch.ts';

export interface CollectionsRow {
  id: string;
  name: string;
  puzzleIds: string[];
  total: number;
  due: number;
  newCount: number;
  learned: number;
  isDefault: boolean;
  isActive: boolean;
  /** Learned puzzles or an in-flight attempt exist for this collection. */
  hasSpacedProgress: boolean;
  /** A Woodpecker set snapshot has been created for this collection. */
  hasWoodpeckerProgress: boolean;
  /** Puzzle id of the collection's in-progress attempt, when resumable. */
  inProgressPuzzleId?: string;
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
 * default program scope, default/active flags, and progress signals used to
 * pick "Start" vs "Resume". Exported for tests; performs no mutations.
 */
export function summarizeCollections(service: LocalTrainingService): CollectionsSnapshot {
  const activeId = service.getActiveCollectionId();
  const session = service.getActiveSession(DEFAULT_PROGRAM_ID);
  const attempt = session ? service.getActiveAttempt(session.sessionId) : undefined;
  const inProgressCollectionId = session?.collectionId;
  return {
    rows: service.listCollections().map((collection) => {
      const summary = service.queueSummary(DEFAULT_PROGRAM_ID, collection.id);
      const inProgressPuzzleId =
        attempt && inProgressCollectionId === collection.id
          ? attempt.progressKey.puzzleId
          : undefined;
      return {
        id: collection.id,
        name: collection.name,
        puzzleIds: [...collection.puzzleIds],
        total: summary.total,
        due: summary.due,
        newCount: summary.newCount,
        learned: summary.learned,
        isDefault: collection.id === DEFAULT_COLLECTION_ID,
        isActive: collection.id === activeId,
        hasSpacedProgress: summary.learned > 0 || inProgressPuzzleId !== undefined,
        hasWoodpeckerProgress:
          service.getWoodpeckerSetForCollection(collection.id) !== undefined,
        ...(inProgressPuzzleId !== undefined ? { inProgressPuzzleId } : {}),
      };
    }),
  };
}

/** Route target for `#/collections/<id>`; `null` for the grid list. */
export function collectionIdFromHash(hash: string): string | null {
  const raw = hash.replace(/^#\/?/, '');
  const [head, ...rest] = raw.split('/');
  if (head !== 'collections') return null;
  const id = rest.join('/').split('?')[0];
  return id ? decodeURIComponent(id) : null;
}

/**
 * Per-screen controller: owns the current snapshot, the routed `selectedId`,
 * the `message` / `renamingId` UI state and per-input drafts, and the `redraw`
 * closure the mount site installs. Every mutation path ends in `refresh()`
 * (pure re-projection + `redraw()`), mirroring the S2 History seam. Input
 * elements report into the drafts via `input` events, so the ctrl — and
 * `view` — stay Node-importable; only the mount site touches the DOM.
 */
export class CollectionsCtrl {
  snapshot: CollectionsSnapshot;
  selectedId: string | null = null;
  message: CollectionMessage | null = null;
  renamingId: string | null = null;
  newName = '';
  renameValue = '';
  addValues = new Map<string, string>();
  /** Collections whose puzzle lists are expanded; collapsed by default. */
  expandedIds = new Set<string>();
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

  /** Select the collection shown on the detail page (`null` = grid list). */
  select(collectionId: string | null): void {
    this.selectedId = collectionId;
    this.renamingId = null;
    this.message = null;
    this.refresh();
  }

  /** The row for the currently routed collection, if it still exists. */
  selectedRow(): CollectionsRow | undefined {
    return this.selectedId === null ? undefined : this.row(this.selectedId);
  }

  /** Navigate back to the collections grid. */
  backToList(): void {
    window.location.hash = '/collections';
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
      if (this.selectedId === collectionId) {
        // Return to the grid. Update the hash without a hashchange remount so
        // the "Deleted." confirmation below is not lost.
        this.selectedId = null;
        if (typeof window !== 'undefined') {
          window.history.replaceState(null, '', '#/collections');
        }
      }
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

  /**
   * Show/hide one collection's puzzle list. Purely presentational UI state
   * (session-only, never persisted) that ends in `refresh()` like every other
   * mutation path.
   */
  toggleMembers(collectionId: string): void {
    if (this.expandedIds.has(collectionId)) this.expandedIds.delete(collectionId);
    else this.expandedIds.add(collectionId);
    this.refresh();
  }

  /**
   * Start (or resume) Woodpecker for this collection. The fixed-set snapshot is
   * an internal detail: the service creates it on first use from the
   * collection's current members, then opens the board in Woodpecker mode.
   */
  async startWoodpecker(collectionId: string): Promise<void> {
    try {
      const set = await this.service.getOrCreateWoodpeckerSetForCollection(collectionId);
      const { cycleId } = await this.service.startWoodpeckerCycle(set.setId);
      window.location.hash = `/train/woodpecker?setId=${encodeURIComponent(set.setId)}&cycleId=${encodeURIComponent(cycleId)}`;
    } catch (error) {
      this.message = { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      this.refresh();
    }
  }

  async trainCollection(collectionId: string): Promise<void> {
    await this.service.setActiveCollectionId(collectionId);
    window.location.hash = '/train/session';
  }

  /** Open the isolated failed-review queue for a collection (needs a set). */
  reviewFailures(collectionId: string): void {
    const set = this.service.getWoodpeckerSetForCollection(collectionId);
    if (!set) return;
    window.location.hash = `/train/woodpecker?mode=failed&setId=${encodeURIComponent(set.setId)}`;
  }

  // --- detail-page read-only projections -----------------------------------

  woodpeckerSet(collectionId: string) {
    return this.service.getWoodpeckerSetForCollection(collectionId);
  }

  woodpeckerCycles(setId: string) {
    return this.service.listWoodpeckerCycles(setId);
  }

  woodpeckerActiveCycle(setId: string) {
    return this.service.getActiveWoodpeckerCycle(setId);
  }

  woodpeckerStats(setId: string) {
    return this.service.getWoodpeckerAttemptStats(setId);
  }

  woodpeckerFailed(setId: string): string[] {
    return this.service.getWoodpeckerFailedPuzzleIds(setId);
  }
}

function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours > 0
    ? `${hours}h ${minutes}m ${remainder}s`
    : minutes > 0
      ? `${minutes}m ${remainder}s`
      : `${remainder}s`;
}

/** A badge with a tooltip so the marker is self-explanatory. */
function badge(text: string, title: string): VNode {
  return h('span.badge', { attrs: { title } }, text);
}

function badges(row: CollectionsRow): Array<VNode | string> {
  const out: Array<VNode | string> = [];
  if (row.isDefault) {
    out.push(badge(t('collections.badge.default'), t('collections.badge.default.title')));
  }
  if (row.isActive) {
    out.push(badge(t('collections.badge.active'), t('collections.badge.active.title')));
  }
  return out;
}

function spacedLabel(row: CollectionsRow): string {
  return row.hasSpacedProgress
    ? t('collections.resume.spaced')
    : t('collections.start.spaced');
}

function woodpeckerLabel(row: CollectionsRow): string {
  return row.hasWoodpeckerProgress
    ? t('collections.resume.woodpecker')
    : t('collections.start.woodpecker');
}

/** Compact grid card: summary + train actions; the title links to the detail page. */
function collectionCard(ctrl: CollectionsCtrl, row: CollectionsRow): VNode {
  return h(
    'section.panel.collection-card',
    { key: row.id, attrs: { 'data-collection': row.id } },
    [
      h('h3.collection-card-title', [
        h(
          'a.collection-card-link',
          {
            attrs: {
              id: `collection-view-${row.id}`,
              href: `#/collections/${encodeURIComponent(row.id)}`,
            },
          },
          row.name,
        ),
        ...badges(row).flatMap((badge) => [' ', badge]),
        h('span.collection-card-chevron', '›'),
      ]),
      h(
        'p.collection-card-counts',
        t('collections.summary', { members: row.total, due: row.due, learned: row.learned }),
      ),
      ...(row.inProgressPuzzleId !== undefined
        ? [h('p.progress-note', t('collections.resume.note', { id: row.inProgressPuzzleId }))]
        : []),
      h('div.collection-card-actions', [
        actionButton(spacedLabel(row), 'primary', {
          disabled: row.total === 0,
          onClick: () => void ctrl.trainCollection(row.id),
        }),
        h('div.woodpecker-create-from-collection', [
          actionButton(woodpeckerLabel(row), 'secondary', {
            disabled: row.total === 0,
            onClick: () => void ctrl.startWoodpecker(row.id),
          }),
        ]),
      ]),
    ],
  );
}

/** Message line shared by the grid and the detail page. */
function messageNode(ctrl: CollectionsCtrl): VNode | null {
  if (ctrl.message === null) return null;
  return h(ctrl.message.kind === 'ok' ? 'p.ok' : 'p.error', ctrl.message.text);
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

/**
 * Puzzle membership under the detail page. Non-empty collections render a
 * Show/Hide toggle and keep the list collapsed until expanded; empty
 * collections keep their plain empty-state hint (nothing to collapse).
 */
function membersSection(ctrl: CollectionsCtrl, row: CollectionsRow): VNode {
  if (row.puzzleIds.length === 0) return memberList(ctrl, row);
  const expanded = ctrl.expandedIds.has(row.id);
  return h('div.members-section', [
    actionButton(
      expanded
        ? t('collections.members.hide', { count: row.puzzleIds.length })
        : t('collections.members.show', { count: row.puzzleIds.length }),
      'tertiary',
      {
        compact: true,
        id: `members-toggle-${row.id}`,
        onClick: () => void ctrl.toggleMembers(row.id),
      },
    ),
    ...(expanded ? [memberList(ctrl, row)] : []),
  ]);
}

/** Grid view: page header (title, subtitle, create row) plus one card per collection. */
export function viewCollectionsList(ctrl: CollectionsCtrl): VNode {
  const message = messageNode(ctrl);
  const header = h('header.collections-header', [
    h('h1', t('collections.title')),
    h('p.collections-subtitle', t('collections.subtitle')),
    h('div.collections-create', [
      h('input', {
        attrs: {
          id: 'collections-new-name',
          placeholder: t('collections.create.placeholder'),
        },
        props: { value: ctrl.newName },
        on: { input: (event) => void ctrl.createInput(event) },
      }),
      actionButton(t('collections.create'), 'primary', {
        id: 'collections-create',
        onClick: () => void ctrl.create(),
      }),
    ]),
    h('p.collections-legend', [
      h('span.collections-legend-item', [
        badge(t('collections.badge.active'), t('collections.badge.active.title')),
        t('collections.legend.active'),
      ]),
      h('span.collections-legend-item', [
        badge(t('collections.badge.default'), t('collections.badge.default.title')),
        t('collections.legend.default'),
      ]),
    ]),
    ...(message === null ? [] : [message]),
  ]);
  const cards = ctrl.snapshot.rows.map((row) => collectionCard(ctrl, row));
  return h('div.collections-screen', [
    header,
    cards.length > 0
      ? h('div.collections-grid', cards)
      : emptyState(t('collections.list.empty')),
  ]);
}

/** Spaced-repetition panel on the detail page. */
function spacedDetail(ctrl: CollectionsCtrl, row: CollectionsRow): VNode {
  const children: Array<VNode | string> = [
    h('h3', t('collections.details.spaced.title')),
    h('p', t('collections.summary', { members: row.total, due: row.due, learned: row.learned })),
    h('p', t('collections.details.spaced.queue', { newCount: row.newCount, due: row.due })),
    ...(row.isActive ? [h('p.progress-note', t('collections.active.hint'))] : []),
    ...(row.inProgressPuzzleId !== undefined
      ? [h('p.progress-note', t('collections.resume.note', { id: row.inProgressPuzzleId }))]
      : []),
    actionButton(spacedLabel(row), 'primary', {
      disabled: row.total === 0,
      onClick: () => void ctrl.trainCollection(row.id),
    }),
  ];
  return h('section.panel.collection-detail-spaced', children);
}

/** Woodpecker panel on the detail page: snapshot, active-cycle progress, stats. */
function woodpeckerDetail(ctrl: CollectionsCtrl, row: CollectionsRow): VNode {
  const set = ctrl.woodpeckerSet(row.id);
  const cycles = set ? ctrl.woodpeckerCycles(set.setId) : [];
  const active = set ? ctrl.woodpeckerActiveCycle(set.setId) : undefined;
  const stats = set
    ? ctrl.woodpeckerStats(set.setId)
    : { scoredAttempts: 0, cleanSolves: 0, failedAttempts: 0, activeSeconds: 0 };
  const activeSummary = active ? summarizeWoodpeckerCycle(active.cycle) : null;
  const failed = set ? ctrl.woodpeckerFailed(set.setId) : [];
  const size = set ? set.puzzleIds.length : row.total;

  return h('section.panel.collection-detail-woodpecker', [
    h('h3', t('collections.details.woodpecker.title')),
    h(
      'p',
      set
        ? t('collections.details.woodpecker.started', { members: size, cycles: cycles.length })
        : t('collections.details.woodpecker.notStarted', { members: row.total }),
    ),
    ...(active && activeSummary
      ? [
          progressBar(activeSummary.attempted, activeSummary.total, {
            id: `collection-woodpecker-progress-${row.id}`,
            label: t('woodpecker.cycle.progress', {
              scored: activeSummary.attempted,
              total: activeSummary.total,
            }),
          }),
          h(
            'p.progress-note',
            t('collections.details.woodpecker.activeCycle', {
              cycle: active.cycle.cycleNumber,
              scored: activeSummary.attempted,
              total: activeSummary.total,
            }),
          ),
        ]
      : []),
    h(
      'p',
      t('collections.details.woodpecker.stats', {
        scored: stats.scoredAttempts,
        clean: stats.cleanSolves,
        errors: stats.failedAttempts,
        time: formatDuration(stats.activeSeconds),
      }),
    ),
    h('div.button-row', [
      actionButton(woodpeckerLabel(row), 'secondary', {
        disabled: size === 0,
        onClick: () => void ctrl.startWoodpecker(row.id),
      }),
      ...(failed.length > 0
        ? [
            actionButton(t('collections.failedReview', { count: failed.length }), 'tertiary', {
              onClick: () => ctrl.reviewFailures(row.id),
            }),
          ]
        : []),
    ]),
  ]);
}

/** Membership management panel: add input, collapse toggle, member list. */
function membersDetail(ctrl: CollectionsCtrl, row: CollectionsRow): VNode {
  return h('section.panel.collection-detail-members', [
    h('h3', t('collections.details.members.title')),
    h('div.flex-row', [
      h('input', {
        attrs: { id: `add-${row.id}`, placeholder: t('collections.member.add.placeholder') },
        props: { value: ctrl.addValues.get(row.id) ?? '' },
        on: { input: (event) => void ctrl.addInput(row.id, event) },
      }),
      actionButton(t('collections.member.add'), 'primary', {
        compact: true,
        id: `collection-add-${row.id}`,
        onClick: () => void ctrl.addMember(row.id),
      }),
    ]),
    membersSection(ctrl, row),
  ]);
}

/** Rename/delete actions for a collection (delete disabled for the default). */
function manageDetail(ctrl: CollectionsCtrl, row: CollectionsRow): VNode {
  const renaming = ctrl.renamingId === row.id;
  return h('div.button-row', [
    actionButton(
      renaming ? t('collections.rename.save') : t('collections.rename.start'),
      'tertiary',
      { id: `collection-rename-${row.id}`, onClick: () => void ctrl.rename(row.id) },
    ),
    actionButton(t('collections.delete'), 'tertiary', {
      id: `collection-delete-${row.id}`,
      disabled: row.isDefault,
      onClick: () => void ctrl.deleteCollection(row.id),
    }),
  ]);
}

/**
 * Collection detail page (`#/collections/<id>`): name/badges, rename/delete,
 * spaced-repetition and Woodpecker progress, and membership management.
 */
export function viewCollectionDetail(ctrl: CollectionsCtrl, row: CollectionsRow): VNode {
  const renaming = ctrl.renamingId === row.id;
  const message = messageNode(ctrl);
  const nameNode: VNode = renaming
    ? h('input', {
        attrs: { id: `rename-${row.id}` },
        props: { value: ctrl.renameValue },
        on: { input: (event) => void ctrl.renameInput(event) },
      })
    : h('h1', [row.name, ...badges(row).flatMap((badge) => [' ', badge])]);
  return h('div.collections-screen.collection-detail', { attrs: { 'data-collection-detail': row.id } }, [
    h('div.collection-detail-back', [
      actionButton(t('collections.details.back'), 'tertiary', {
        compact: true,
        id: 'collection-detail-back',
        onClick: () => ctrl.backToList(),
      }),
    ]),
    h('section.panel.collection-detail-header', [
      nameNode,
      h('p', t('collections.details.identity', { id: row.id, members: row.total })),
      manageDetail(ctrl, row),
      ...(message === null ? [] : [message]),
    ]),
    h('div.collection-detail-modes', [
      spacedDetail(ctrl, row),
      woodpeckerDetail(ctrl, row),
    ]),
    membersDetail(ctrl, row),
  ]);
}

/** Fallback when `#/collections/<id>` points at a collection that no longer exists. */
function viewMissingCollection(ctrl: CollectionsCtrl): VNode {
  return h('div.collections-screen.collection-detail', [
    h('div.collection-detail-back', [
      actionButton(t('collections.details.back'), 'tertiary', {
        compact: true,
        id: 'collection-detail-back',
        onClick: () => ctrl.backToList(),
      }),
    ]),
    h('section.panel', [h('p.error', t('collections.details.missing'))]),
  ]);
}

/**
 * Pure view: dispatches to the detail page for the routed collection, else the
 * grid. Snabbdom sets copy as text, so no manual HTML escaping is needed.
 */
export function view(ctrl: CollectionsCtrl): VNode {
  const row = ctrl.selectedRow();
  if (ctrl.selectedId !== null) {
    return row ? viewCollectionDetail(ctrl, row) : viewMissingCollection(ctrl);
  }
  return viewCollectionsList(ctrl);
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
    ctrl.select(collectionIdFromHash(window.location.hash));
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
