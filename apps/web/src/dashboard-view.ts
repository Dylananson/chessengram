/** Combined progress and launch page for the available training modes. */
import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import { summarizeWoodpeckerCycle } from '@chessreps/scheduler';
import type { AppContext } from './app-context.ts';
import type { Screen } from './router.ts';
import {
  DEFAULT_PROGRAM_ID,
  LocalTrainingService,
  WOODPECKER_CYCLE_PROGRAM_ID,
  WOODPECKER_FAILED_PROGRAM_ID,
  woodpeckerScopeId,
} from './scheduler-service.ts';
import { actionButton, emptyState, progressBar } from './ui/primitives.ts';
import { t } from './i18n.ts';
import { screenPatch as patch } from './ui/patch.ts';

export class DashboardCtrl {
  readonly service: LocalTrainingService;
  redraw: () => void = () => {};
  message = '';

  constructor(service: LocalTrainingService) {
    this.service = service;
  }

  collectionName(collectionId?: string): string {
    return this.service.listCollections().find((collection) => collection.id === collectionId)?.name ?? 'No collection';
  }

  currentSpacedSession() {
    const session = this.service.getActiveSession(DEFAULT_PROGRAM_ID);
    const attempt = session ? this.service.getActiveAttempt(session.sessionId) : undefined;
    return { session, attempt };
  }

  currentWoodpeckerAttempt(programId: string, setId: string) {
    const session = this.service.getActiveSession(programId);
    if (!session || session.collectionId !== woodpeckerScopeId(setId)) return undefined;
    return session.activeAttemptId ? this.service.getActiveAttempt(session.sessionId) : undefined;
  }

  async startSpaced(collectionId: string): Promise<void> {
    await this.service.setActiveCollectionId(collectionId);
    window.location.hash = '/train/session';
  }

  async openCycle(setId: string): Promise<void> {
    try {
      const { cycleId } = await this.service.startWoodpeckerCycle(setId);
      window.location.hash = `/train/woodpecker?setId=${encodeURIComponent(setId)}&cycleId=${encodeURIComponent(cycleId)}`;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
      this.redraw();
    }
  }

  openFailedReview(setId: string): void {
    window.location.hash = `/train/woodpecker?mode=failed&setId=${encodeURIComponent(setId)}`;
  }
}

function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${secs}s` : `${secs}s`;
}

function spacedPanel(ctrl: DashboardCtrl): VNode {
  const { session, attempt } = ctrl.currentSpacedSession();
  const collectionId = session?.collectionId ?? ctrl.service.getActiveCollectionId();
  const collection = ctrl.service.listCollections().find((item) => item.id === collectionId);
  const queue = ctrl.service.queueSummary(DEFAULT_PROGRAM_ID, collectionId);
  const puzzleId = attempt?.progressKey.puzzleId;
  return h('section.dashboard-column', { attrs: { 'data-dashboard-mode': 'spaced-repetition' } }, [
    h('h2', 'Spaced Repetition'),
    h('section.panel.dashboard-mode-card', [
      h('p', `Collection: ${collection?.name ?? 'No collection'}`),
      h('p', puzzleId ? `In progress: puzzle ${puzzleId}` : 'No puzzle currently in progress.'),
      h('p', `${queue.total} puzzles · ${queue.due} due · ${queue.newCount} new · ${queue.learned} learned`),
      actionButton(puzzleId ? 'Resume Spaced Repetition' : 'Start Spaced Repetition', 'primary', {
        onClick: () => void ctrl.startSpaced(collectionId ?? ctrl.service.getActiveCollectionId()),
      }),
    ]),
  ]);
}

function woodpeckerCollectionCard(ctrl: DashboardCtrl, collection: ReturnType<LocalTrainingService['listCollections']>[number], set: NonNullable<ReturnType<LocalTrainingService['getWoodpeckerSetForCollection']>>): VNode {
  const cycles = ctrl.service.listWoodpeckerCycles(set.setId);
  const active = ctrl.service.getActiveWoodpeckerCycle(set.setId);
  const cycle = active?.cycle ?? cycles.at(-1)?.cycle;
  const summary = cycle ? summarizeWoodpeckerCycle(cycle) : null;
  const currentCycleAttempt = ctrl.currentWoodpeckerAttempt(WOODPECKER_CYCLE_PROGRAM_ID, set.setId);
  return h('section.panel.dashboard-woodpecker-set', { attrs: { 'data-dashboard-woodpecker': collection.id } }, [
    h('h3', collection.name),
    h('p', `${set.puzzleIds.length} puzzles · ${cycles.length} cycles`),
    h('p', summary
      ? `Cycle ${cycle!.cycleNumber}: ${summary.attempted}/${summary.total} scored · ${summary.clean} clean · ${summary.failed} errors · ${duration(summary.activeSeconds)} active`
      : 'No cycle started yet.'),
    ...(summary ? [progressBar(summary.attempted, summary.total, {
      id: `dashboard-set-progress-${set.setId}`,
      label: t('woodpecker.cycle.progress', { scored: summary.attempted, total: summary.total }),
    })] : []),
    ...(currentCycleAttempt ? [h('p.progress-note', `Currently solving ${currentCycleAttempt.progressKey.puzzleId} in this cycle.`)] : []),
    actionButton(currentCycleAttempt ? 'Resume current cycle' : active ? `Resume cycle ${active.cycle.cycleNumber}` : 'Start next cycle', 'primary', {
      onClick: () => void ctrl.openCycle(set.setId),
    }),
  ]);
}

function failedReviewCard(ctrl: DashboardCtrl, collection: ReturnType<LocalTrainingService['listCollections']>[number], set: NonNullable<ReturnType<LocalTrainingService['getWoodpeckerSetForCollection']>>): VNode | null {
  const failedIds = ctrl.service.getWoodpeckerFailedPuzzleIds(set.setId);
  if (!failedIds.length) return null;
  const selection = ctrl.service.selectWoodpeckerFailed(set.setId);
  const attempt = ctrl.currentWoodpeckerAttempt(WOODPECKER_FAILED_PROGRAM_ID, set.setId);
  return h('section.panel.dashboard-failed-card', { attrs: { 'data-dashboard-failed': collection.id } }, [
    h('h3', collection.name),
    h('p', `${failedIds.length} ${failedIds.length === 1 ? 'puzzle' : 'puzzles'} to review`),
    ...(attempt ? [h('p.progress-note', `Currently reviewing ${attempt.progressKey.puzzleId}.`)] : []),
    ...(selection.nextDueAt ? [h('p.progress-note', `Next due ${new Date(selection.nextDueAt).toLocaleString()}.`)] : []),
    actionButton(attempt ? 'Resume review' : 'Open Failed review', 'secondary', {
      onClick: () => ctrl.openFailedReview(set.setId),
    }),
  ]);
}

export function viewDashboard(ctrl: DashboardCtrl): VNode {
  // Woodpecker is a collection workflow: surface collections that already have
  // an internal set snapshot (started at least once). New ones start from
  // Collections or the Woodpecker screen.
  const started: Array<{
    collection: ReturnType<LocalTrainingService['listCollections']>[number];
    set: NonNullable<ReturnType<LocalTrainingService['getWoodpeckerSetForCollection']>>;
    lastActivityAt: number | undefined;
  }> = [];
  for (const collection of ctrl.service.listCollections()) {
    const set = ctrl.service.getWoodpeckerSetForCollection(collection.id);
    if (set !== undefined) {
      started.push({ collection, set, lastActivityAt: ctrl.service.getWoodpeckerLastActivityAt(set.setId) });
    }
  }
  // Most recently trained collection first (user request 2026-10-16). Sort is
  // stable, so collections with no activity keep their creation order at the
  // end. Both the Woodpecker and Failed-review columns share this order.
  started.sort((a, b) => (b.lastActivityAt ?? -Infinity) - (a.lastActivityAt ?? -Infinity));
  return h('div.page.dashboard-page', [
    h('h1', 'Training Dashboard'),
    h('p', 'Continue a session, review progress, or choose a collection to train.'),
    ctrl.message ? h('p.status.error', ctrl.message) : '',
    h('div.dashboard-columns', [
    spacedPanel(ctrl),
    h('section.dashboard-column.dashboard-woodpecker-column', [
      h('h2', 'Woodpecker'),
      ...(started.length ? started.map(({ collection, set }) => woodpeckerCollectionCard(ctrl, collection, set)) : [emptyState('No Woodpecker cycles yet. Start one from a collection.')]),
      actionButton('Manage collections', 'secondary', { onClick: () => { window.location.hash = '/collections'; } }),
    ]),
    h('section.dashboard-column.dashboard-failed-column', [
      h('h2', 'Failed reviews'),
      ...(started.map(({ collection, set }) => failedReviewCard(ctrl, collection, set)).filter((node): node is VNode => node !== null)),
      ...(started.every(({ set }) => ctrl.service.getWoodpeckerFailedPuzzleIds(set.setId).length === 0) ? [emptyState('No failed puzzles waiting for review.')] : []),
    ]),
    ]),
  ]);
}

export class DashboardView implements Screen {
  readonly id = 'dashboard' as const;
  private readonly service: LocalTrainingService;
  private vnode: VNode | null = null;
  private ctrl: DashboardCtrl | null = null;

  constructor(ctx: AppContext) {
    this.service = ctx.service;
  }

  mount(host: HTMLElement): void {
    this.ctrl = new DashboardCtrl(this.service);
    this.ctrl.redraw = () => {
      if (this.vnode && this.ctrl) this.vnode = patch(this.vnode, viewDashboard(this.ctrl));
    };
    this.vnode = patch(host, viewDashboard(this.ctrl));
  }

  unmount(): void {
    this.ctrl = null;
    this.vnode = null;
  }
}
