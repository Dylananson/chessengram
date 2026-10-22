/**
 * Woodpecker page (user request 2026-10-16: no user-facing "sets").
 *
 * The user works in collections: this screen lists every collection with its
 * Woodpecker progress and starts/resumes cycles directly. Fixed "sets" remain an
 * internal snapshot (one canonical set per collection, created on first start
 * from the collection's current members); there is no set-creation UI here.
 *
 * Rendering copies the `spaced-view`/`history-view` pattern: `WoodpeckerCtrl`
 * holds the collection list plus UI message, `viewWoodpecker` is a pure
 * `(ctrl) => VNode`, and `WoodpeckerView` patches once then re-patches through a
 * `redraw` closure. `h` comes from the DOM-free `snabbdom/build/*` subpath, so
 * everything stays importable under Node; only `mount` touches the DOM.
 */
import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import type { AppContext } from './app-context.ts';
import type { Screen } from './router.ts';
import { summarizeWoodpeckerCycle } from '@chessengram/scheduler';
import type { LocalTrainingService } from './scheduler-service.ts';
import { actionButton, emptyState, progressBar } from './ui/primitives.ts';
import { t } from './i18n.ts';
import { screenPatch as patch } from './ui/patch.ts';

interface WoodpeckerMessage {
  tone: 'ok' | 'error';
  text: string;
}

/** Internal set snapshot is capped by the service; gate the action to match. */
const WOODPECKER_MAX_PUZZLES = 500;

export class WoodpeckerCtrl {
  collections: ReturnType<LocalTrainingService['listCollections']>;
  message: WoodpeckerMessage | null = null;
  redraw: () => void = () => {};
  private readonly service: LocalTrainingService;

  constructor(service: LocalTrainingService, redraw: () => void = () => {}) {
    this.service = service;
    this.redraw = redraw;
    this.collections = service.listCollections();
  }

  refresh(): void {
    this.collections = this.service.listCollections();
    this.redraw();
  }

  /** The collection's internal Woodpecker set, if it has ever been started. */
  setFor(collectionId: string) {
    return this.service.getWoodpeckerSetForCollection(collectionId);
  }

  serviceCycles(setId: string) {
    return this.service.listWoodpeckerCycles(setId);
  }

  serviceFailed(setId: string): string[] {
    return this.service.getWoodpeckerFailedPuzzleIds(setId);
  }

  activeCycle(setId: string) {
    return this.service.getActiveWoodpeckerCycle(setId);
  }

  setStats(setId: string) {
    return this.service.getWoodpeckerAttemptStats(setId);
  }

  /**
   * Start or resume a collection's Woodpecker cycle. Creates the internal set
   * snapshot on first use, then opens the board in Woodpecker mode.
   */
  async startCycleFor(collectionId: string): Promise<void> {
    try {
      const set = await this.service.getOrCreateWoodpeckerSetForCollection(collectionId);
      const { cycleId } = await this.service.startWoodpeckerCycle(set.setId);
      window.location.hash = `/train/woodpecker?setId=${encodeURIComponent(set.setId)}&cycleId=${encodeURIComponent(cycleId)}`;
    } catch (error) {
      this.message = { tone: 'error', text: error instanceof Error ? error.message : String(error) };
      this.refresh();
    }
  }

  /** Open the isolated failed-review queue for a collection (needs a set). */
  reviewFailures(collectionId: string): void {
    const set = this.service.getWoodpeckerSetForCollection(collectionId);
    if (!set) return;
    window.location.hash = `/train/woodpecker?mode=failed&setId=${encodeURIComponent(set.setId)}`;
  }
}

function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${remainder}s`
    : minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function collectionCard(
  ctrl: WoodpeckerCtrl,
  collection: ReturnType<LocalTrainingService['listCollections']>[number],
): VNode {
  const set = ctrl.setFor(collection.id);
  const cycles = set ? ctrl.serviceCycles(set.setId) : [];
  const failed = set ? ctrl.serviceFailed(set.setId) : [];
  const active = set ? ctrl.activeCycle(set.setId) : undefined;
  const stats = set
    ? ctrl.setStats(set.setId)
    : { scoredAttempts: 0, cleanSolves: 0, failedAttempts: 0, activeSeconds: 0 };
  const activeSummary = active ? summarizeWoodpeckerCycle(active.cycle) : null;
  const completedCycles = cycles.filter(({ cycle }) => summarizeWoodpeckerCycle(cycle).complete);
  const elapsedAcrossCycles = completedCycles.reduce((sum, { cycle }) =>
    sum + Math.max(0, ((cycle.completedAt ?? cycle.startedAt) - cycle.startedAt) / 1000), 0);
  const size = set ? set.puzzleIds.length : collection.puzzleIds.length;
  const startDisabled = size === 0 || size > WOODPECKER_MAX_PUZZLES;
  return h(
    'section.panel.woodpecker-set',
    { attrs: { 'data-woodpecker-collection': collection.id } },
    [
      h('h2', collection.name),
      h('p', set
        ? `${size} puzzles · fixed snapshot · ${cycles.length} cycles`
        : `${size} puzzles · not started yet`),
      h('div.woodpecker-set-progress', { attrs: { id: `woodpecker-progress-${collection.id}` } }, [
        h('h3', 'Progress'),
        ...(active && activeSummary
          ? [
              progressBar(activeSummary.attempted, activeSummary.total, {
                id: `woodpecker-active-progress-${collection.id}`,
                label: t('woodpecker.cycle.progress', { scored: activeSummary.attempted, total: activeSummary.total }),
              }),
              h('p.progress-note', `Cycle ${active.cycle.cycleNumber}: ${activeSummary.attempted}/${activeSummary.total} scored`),
            ]
          : []),
        h('p', `${stats.scoredAttempts} scored attempts · ${stats.cleanSolves} clean solves · ${stats.failedAttempts} errors`),
        h('p', `${formatDuration(stats.activeSeconds)} total active solving time · ${completedCycles.length} completed cycles`),
        ...(completedCycles.length > 0 ? [h('p', `Elapsed time across completed cycles: ${formatDuration(elapsedAcrossCycles)}`)] : []),
      ]),
      actionButton(active ? `Resume cycle ${active.cycle.cycleNumber}` : 'Start Woodpecker', 'primary', {
        disabled: startDisabled,
        onClick: () => void ctrl.startCycleFor(collection.id),
      }),
      ...(size > WOODPECKER_MAX_PUZZLES
        ? [h('p.progress-note', `Woodpecker snapshots at most ${WOODPECKER_MAX_PUZZLES} puzzles; make a smaller collection first.`)]
        : []),
      failed.length
        ? actionButton(`Failed review (${failed.length})`, 'secondary', { onClick: () => ctrl.reviewFailures(collection.id) })
        : set
          ? h('p.progress-note', 'No failed puzzles yet.')
          : '',
      h('h3', 'Cycles'),
      cycles.length
        ? h('ol.woodpecker-cycles', cycles.map(({ cycleId, cycle }) => {
            const summary = summarizeWoodpeckerCycle(cycle);
            const prior = cycles.find(({ cycle: candidate }) => candidate.cycleNumber === cycle.cycleNumber - 1);
            const previous = prior ? summarizeWoodpeckerCycle(prior.cycle) : null;
            const compare = previous?.complete && summary.complete
              ? ` · ${Math.round(summary.activeSeconds - previous.activeSeconds)}s vs previous · ${summary.failed - previous.failed} errors`
              : '';
            const accuracy = summary.attempted === 0 ? 0 : Math.round(summary.accuracy * 100);
            const endAt = cycle.completedAt;
            const wallSeconds = endAt === undefined ? (Date.now() - cycle.startedAt) / 1000 : (endAt - cycle.startedAt) / 1000;
            return h('li', { key: cycleId }, [
              h('p', `Cycle ${cycle.cycleNumber}: ${summary.attempted}/${summary.total} covered · ${accuracy}% accuracy · ${summary.clean} clean · ${summary.failed} failed · ${formatDuration(summary.activeSeconds)} active${summary.complete ? ' · complete' : ' · in progress'}${compare}`),
              progressBar(summary.attempted, summary.total, {
                label: t('woodpecker.cycle.progress', { scored: summary.attempted, total: summary.total }),
              }),
              h('p.progress-note', `Started ${formatDateTime(cycle.startedAt)}${endAt === undefined ? ' · still running' : ` · ended ${formatDateTime(endAt)}`} · elapsed ${formatDuration(wallSeconds)}`),
            ]);
          }))
        : h('p.progress-note', set ? 'No cycles started.' : 'Start Woodpecker to snapshot this collection.'),
    ],
  );
}

export function viewWoodpecker(ctrl: WoodpeckerCtrl): VNode {
  return h('div.page.woodpecker-page', [
    h('h1', 'Woodpecker training'),
    h('p', 'Repeat a collection’s puzzles in cycles. Missed puzzles go to a separate spaced-review queue.'),
    h('p.progress-note', 'Woodpecker runs on a collection; the puzzle set is snapshotted the first time you start it. Manage membership from Collections.'),
    actionButton('Manage collections', 'secondary', { onClick: () => { window.location.hash = '/collections'; } }),
    ctrl.message ? h(`p.status.${ctrl.message.tone}`, ctrl.message.text) : '',
    h('section', [
      h('h2', 'Your collections'),
      ...(ctrl.collections.length
        ? ctrl.collections.map((collection) => collectionCard(ctrl, collection))
        : [emptyState('No collections yet.')]),
    ]),
  ]);
}

export class WoodpeckerView implements Screen {
  readonly id = 'woodpecker' as const;
  private readonly service: LocalTrainingService;
  private host: HTMLElement | null = null;
  private vnode: VNode | null = null;
  private ctrl: WoodpeckerCtrl | null = null;

  constructor(ctx: AppContext) {
    this.service = ctx.service;
  }

  mount(host: HTMLElement): void {
    this.host = host;
    this.ctrl = new WoodpeckerCtrl(this.service);
    this.ctrl.redraw = () => {
      if (this.vnode && this.ctrl) this.vnode = patch(this.vnode, viewWoodpecker(this.ctrl));
    };
    this.vnode = patch(host, viewWoodpecker(this.ctrl));
  }

  unmount(): void {
    this.ctrl = null;
    this.vnode = null;
    this.host = null;
  }
}
