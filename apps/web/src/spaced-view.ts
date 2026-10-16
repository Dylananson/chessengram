/**
 * Spaced Repetition hub (user request 2026-10-16): the landing page behind the
 * "Spaced Repetition" nav item. Instead of dropping straight onto the board it
 * summarizes every collection (queue counts, active/default badges, in-progress
 * puzzle) and shows spaced-repetition history stats, mirroring the Woodpecker
 * page layout. Starting or resuming a collection opens the board at
 * `#/train/session`.
 *
 * Read-only projections over existing service getters (`summarizeSpaced`), plus
 * two navigation actions (start training / manage collections). No grading, no
 * attempt writes, no schedule mutations.
 *
 * `h` comes from the DOM-free `snabbdom/build/*` deep subpath (never the
 * package root, which touches `window` at load), so `summarizeSpaced` and
 * `viewSpacedHub` stay importable under Node. Only `mount` touches the DOM.
 */

import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import type { AppContext } from './app-context.ts';
import { classifyAttemptOutcome } from './history-view.ts';
import type { Screen } from './router.ts';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_PROGRAM_ID,
  type LocalTrainingService,
} from './scheduler-service.ts';
import { actionButton, emptyState } from './ui/primitives.ts';
// Shared screen patch (see `./ui/patch.ts`).
import { screenPatch as patch } from './ui/patch.ts';

/** Latest attempts counted for the hub's history stat line. */
export const SPACED_RECENT_LIMIT = 100;

export interface SpacedCollectionRow {
  id: string;
  name: string;
  total: number;
  due: number;
  newCount: number;
  learned: number;
  isDefault: boolean;
  isActive: boolean;
  /** Puzzle id of the collection's in-progress attempt, when resumable. */
  inProgressPuzzleId?: string;
}

export interface SpacedRecentStats {
  total: number;
  success: number;
  failure: number;
  unscored: number;
  abandoned: number;
}

export interface SpacedSnapshot {
  activeCollectionId: string;
  collections: SpacedCollectionRow[];
  attemptCount: number;
  recent: SpacedRecentStats;
}

/**
 * Pure read-only projection over existing public service getters: per-collection
 * queue counts (default program scope), the active/default flags, the resumable
 * puzzle for the current session, and history stats (total attempt count plus a
 * breakdown of the latest {@link SPACED_RECENT_LIMIT} recorded attempts).
 * Exported for tests; performs no mutations.
 */
export function summarizeSpaced(service: LocalTrainingService): SpacedSnapshot {
  const activeCollectionId = service.getActiveCollectionId();
  const session = service.getActiveSession(DEFAULT_PROGRAM_ID);
  const attempt = session ? service.getActiveAttempt(session.sessionId) : undefined;
  const inProgressCollectionId = session?.collectionId;

  const collections: SpacedCollectionRow[] = service.listCollections().map((collection) => {
    const summary = service.queueSummary(DEFAULT_PROGRAM_ID, collection.id);
    const inProgressPuzzleId =
      attempt && inProgressCollectionId === collection.id
        ? attempt.progressKey.puzzleId
        : undefined;
    return {
      id: collection.id,
      name: collection.name,
      total: summary.total,
      due: summary.due,
      newCount: summary.newCount,
      learned: summary.learned,
      isDefault: collection.id === DEFAULT_COLLECTION_ID,
      isActive: collection.id === activeCollectionId,
      ...(inProgressPuzzleId !== undefined ? { inProgressPuzzleId } : {}),
    };
  });

  const recent: SpacedRecentStats = { total: 0, success: 0, failure: 0, unscored: 0, abandoned: 0 };
  for (const record of service.listAttempts({ programId: DEFAULT_PROGRAM_ID, limit: SPACED_RECENT_LIMIT })) {
    recent[classifyAttemptOutcome(record)] += 1;
    recent.total += 1;
  }

  return { activeCollectionId, collections, attemptCount: service.getAttemptCount(), recent };
}

/**
 * Per-screen controller: owns the current snapshot and the `redraw` closure the
 * mount site installs. `refresh()` re-runs the pure projection; the two actions
 * navigate to the board (`#/train/session`) or the Collections screen.
 */
export class SpacedCtrl {
  snapshot: SpacedSnapshot;
  redraw: () => void = () => {};
  private readonly service: LocalTrainingService;

  constructor(service: LocalTrainingService, redraw: () => void = () => {}) {
    this.service = service;
    this.redraw = redraw;
    this.snapshot = summarizeSpaced(service);
  }

  /** Re-run the pure projection over the service getters and re-render. */
  refresh(): void {
    this.snapshot = summarizeSpaced(this.service);
    this.redraw();
  }

  /** Make the collection active and open the training board. */
  async startTraining(collectionId: string): Promise<void> {
    await this.service.setActiveCollectionId(collectionId);
    window.location.hash = '/train/session';
  }

  openCollections(): void {
    window.location.hash = '/collections';
  }
}

function badges(row: SpacedCollectionRow): Array<VNode | string> {
  const out: Array<VNode | string> = [];
  if (row.isDefault) out.push(h('span.badge', 'default'));
  if (row.isActive) out.push(h('span.badge', 'active'));
  return out;
}

function collectionCard(ctrl: SpacedCtrl, row: SpacedCollectionRow): VNode {
  const resume = row.inProgressPuzzleId !== undefined;
  return h(
    'section.panel.spaced-collection',
    { attrs: { 'data-spaced-collection': row.id } },
    [
      h('h2', [row.name, ...badges(row).flatMap((badge) => [' ', badge])]),
      h(
        'p',
        `${row.total} puzzles · ${row.due} due now · ${row.newCount} new · ${row.learned} learned`,
      ),
      resume ? h('p.progress-note', `In progress: puzzle ${row.inProgressPuzzleId}`) : '',
      actionButton(resume ? 'Resume Spaced Repetition' : 'Start Spaced Repetition', 'primary', {
        onClick: () => void ctrl.startTraining(row.id),
      }),
    ],
  );
}

/**
 * Pure view: hub header, spaced-repetition history stats, and one card per
 * collection with counts, badges and a start/resume action. Composed from the
 * S1 `actionButton`/`emptyState` primitives; snabbdom sets copy as text, so no
 * manual HTML escaping is needed.
 */
export function viewSpacedHub(ctrl: SpacedCtrl): VNode {
  const snapshot = ctrl.snapshot;
  return h('div.page.spaced-page', [
    h('h1', 'Spaced Repetition'),
    h('p', 'Review due puzzles collection by collection. Each collection keeps its own schedule.'),
    h('p.progress-note', 'Pick a collection to start or resume; manage membership from Collections.'),
    actionButton('Manage collections', 'secondary', {
      onClick: () => ctrl.openCollections(),
    }),
    h('section', [
      h('div.spaced-progress', { attrs: { id: 'spaced-progress' } }, [
        h('h3', 'Progress'),
        h('p', `${snapshot.attemptCount} attempts recorded`),
        h(
          'p',
          `Latest ${snapshot.recent.total}: ${snapshot.recent.success} successful · ${snapshot.recent.failure} lapses · ${snapshot.recent.unscored} unscored`,
        ),
      ]),
    ]),
    h('section', [
      h('h2', 'Your collections'),
      ...(snapshot.collections.length > 0
        ? snapshot.collections.map((row) => collectionCard(ctrl, row))
        : [emptyState('No collections yet.')]),
    ]),
  ]);
}

export class SpacedView implements Screen {
  readonly id = 'spaced' as const;

  private host: HTMLElement | null = null;
  private ctrl: SpacedCtrl | null = null;
  private vnode: VNode | null = null;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  mount(host: HTMLElement): void {
    this.host = host;
    const ctrl = new SpacedCtrl(this.ctx.service);
    this.ctrl = ctrl;
    this.vnode = patch(host, viewSpacedHub(ctrl));
    ctrl.redraw = () => {
      if (this.ctrl === null || this.vnode === null) return;
      this.vnode = patch(this.vnode, viewSpacedHub(this.ctrl));
    };
  }

  unmount(): void {
    // Guarded: safe without a prior mount; drops refs so a late redraw is a no-op.
    this.host = null;
    this.ctrl = null;
    this.vnode = null;
  }
}
