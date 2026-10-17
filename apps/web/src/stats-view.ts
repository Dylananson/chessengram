/**
 * STAT-001 Statistics screen. A read-only view over {@link summarizeStats}:
 * headline scored/practice time, a per-mode breakdown, and a per-collection
 * breakdown that reconciles with the overall totals. Range filter (7/30/all)
 * seeds the projection; the view never writes state.
 *
 * Strings are intentionally plain English, matching the other newer screens
 * (Spaced hub, Woodpecker, Dashboard) rather than the older `i18n.ts` surface.
 */

import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import type { AppContext } from './app-context.ts';
import type { Screen } from './router.ts';
import type { LocalTrainingService } from './scheduler-service.ts';
import {
  formatStatDuration,
  statAccuracy,
  summarizeStats,
  type StatsModeRow,
  type StatsRange,
  type StatsSnapshot,
  type StatsCollectionRow,
} from './stats.ts';
import { actionButton, emptyState, panel } from './ui/primitives.ts';
import { screenPatch as patch } from './ui/patch.ts';

const RANGE_LABELS: Array<[StatsRange, string]> = [
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['all', 'All time'],
];

export class StatsCtrl {
  readonly service: LocalTrainingService;
  range: StatsRange = 'all';
  snapshot: StatsSnapshot;
  redraw: () => void = () => {};

  constructor(service: LocalTrainingService) {
    this.service = service;
    this.snapshot = summarizeStats(service, this.range);
  }

  setRange(range: StatsRange): void {
    this.range = range;
    this.refresh();
  }

  refresh(): void {
    this.snapshot = summarizeStats(this.service, this.range);
    this.redraw();
  }
}

function rangePicker(ctrl: StatsCtrl): VNode {
  return h(
    'div.button-row.stats-range',
    { attrs: { role: 'group', 'aria-label': 'Statistics range' } },
    RANGE_LABELS.map(([range, label]) =>
      actionButton(label, ctrl.range === range ? 'primary' : 'secondary', {
        id: `stats-range-${range}`,
        onClick: () => ctrl.setRange(range),
      }),
    ),
  );
}

function summaryCard(label: string, value: string, note: string, hook: string): VNode {
  return h('section.panel.stats-card', { attrs: { [hook]: value } }, [
    h('h2', label),
    h('p.stats-value', value),
    h('p.progress-note', note),
  ]);
}

function summary(ctrl: StatsCtrl): VNode {
  const { totals, cyclesCompleted, cycleWallClockSeconds } = ctrl.snapshot;
  const accuracy = statAccuracy(totals);
  const scoredNote = `${totals.solves} solved · ${totals.failures} failed`;
  return h('section.stats-summary', [
    summaryCard('Scored training', formatStatDuration(totals.scoredSeconds), scoredNote, 'data-stats-scored'),
    summaryCard(
      'Practice (unscored)',
      formatStatDuration(totals.practiceSeconds),
      `${totals.unscored} reveal/skip${ctrl.snapshot.modes.some((m) => m.key === 'practice' && m.totals.attempts > 0) ? ' and review' : ''} attempts`,
      'data-stats-practice',
    ),
    summaryCard('Solves', String(totals.solves), 'scored attempts solved', 'data-stats-solves'),
    summaryCard('Failures', String(totals.failures), 'scored attempts failed', 'data-stats-failures'),
    summaryCard(
      'Accuracy',
      accuracy === undefined ? '—' : `${accuracy.toFixed(0)}%`,
      'solves / scored attempts',
      'data-stats-accuracy',
    ),
    summaryCard(
      'Correction time',
      formatStatDuration(totals.correctionSeconds),
      'after a first failure; never added to active time',
      'data-stats-correction',
    ),
    summaryCard(
      'Woodpecker wall clock',
      formatStatDuration(cycleWallClockSeconds),
      `${cyclesCompleted} completed cycle${cyclesCompleted === 1 ? '' : 's'} · separate from active time`,
      'data-stats-wallclock',
    ),
  ]);
}

function modeTable(modes: StatsModeRow[]): VNode {
  return h('div.table-wrap', [
    h('table.puzzle-table.stats-modes', [
      h('thead', [
        h('tr', [
          h('th', 'Mode'),
          h('th', 'Scored time'),
          h('th', 'Practice time'),
          h('th', 'Solves'),
          h('th', 'Failures'),
          h('th', 'Correction'),
        ]),
      ]),
      h(
        'tbody',
        modes.map((mode) =>
          h('tr', { attrs: { 'data-stats-mode': mode.key } }, [
            h('td', mode.label),
            h('td', formatStatDuration(mode.totals.scoredSeconds)),
            h('td', formatStatDuration(mode.totals.practiceSeconds)),
            h('td', String(mode.totals.solves)),
            h('td', String(mode.totals.failures)),
            h('td', formatStatDuration(mode.totals.correctionSeconds)),
          ]),
        ),
      ),
    ]),
  ]);
}

function collectionTable(snapshot: StatsSnapshot): VNode {
  const rows = snapshot.collections;
  const column = (pick: (row: StatsCollectionRow) => number): number =>
    rows.reduce((sum, row) => sum + pick(row), 0);
  return h('div.table-wrap', [
    h('table.puzzle-table.stats-collections', [
      h('thead', [
        h('tr', [
          h('th', 'Collection'),
          h('th', 'Spaced Repetition'),
          h('th', 'Woodpecker'),
          h('th', 'Failed review'),
          h('th', 'Practice'),
          h('th', 'Total active'),
          h('th', 'Cycles'),
        ]),
      ]),
      h(
        'tbody',
        rows.map((row) =>
          h('tr', { attrs: { 'data-stats-collection': row.id } }, [
            h('td', row.id === '(removed)' ? 'Removed collection' : row.name),
            h('td', formatStatDuration(row.spaced.activeSeconds)),
            h('td', formatStatDuration(row.woodpecker.activeSeconds)),
            h('td', formatStatDuration(row.failed.activeSeconds)),
            h('td', formatStatDuration(row.practice.activeSeconds)),
            h('td', formatStatDuration(row.total.activeSeconds)),
            h('td', row.cyclesStarted > 0 ? `${row.cyclesCompleted}/${row.cyclesStarted}` : '—'),
          ]),
        ),
      ),
      h('tfoot', [
        h('tr', { attrs: { 'data-stats-total-row': 'true' } }, [
          h('th', 'All collections'),
          h('td', formatStatDuration(column((row) => row.spaced.activeSeconds))),
          h('td', formatStatDuration(column((row) => row.woodpecker.activeSeconds))),
          h('td', formatStatDuration(column((row) => row.failed.activeSeconds))),
          h('td', formatStatDuration(column((row) => row.practice.activeSeconds))),
          h('td', formatStatDuration(column((row) => row.total.activeSeconds))),
          h('td', `${snapshot.cyclesCompleted}/${snapshot.cyclesStarted}`),
        ]),
      ]),
    ]),
  ]);
}

export function viewStats(ctrl: StatsCtrl): VNode {
  const snapshot = ctrl.snapshot;
  const hasData = snapshot.totals.attempts > 0 || snapshot.cyclesStarted > 0;
  return h('div.page.stats-page', [
    h('h1', 'Statistics'),
    h('p', 'How much you have trained, where the time went, and how it went.'),
    rangePicker(ctrl),
    summary(ctrl),
    h('section', [
      h('h2', 'By mode'),
      hasData ? modeTable(snapshot.modes) : emptyState('No training recorded in this range yet.'),
    ]),
    h('section', [
      h('h2', 'By collection'),
      hasData ? collectionTable(snapshot) : emptyState('No collections have activity in this range.'),
    ]),
    h('section.panel.stats-definitions', [
      h('h2', 'How these numbers are counted'),
      h('ul', [
        h('li', 'Active solving time only. Correction time, interruption time and Woodpecker wall-clock duration are shown separately and never added in.'),
        h('li', 'Woodpecker time comes from the same attempt records as the rest; cycle records add cycle counts and wall-clock duration, so no seconds are counted twice.'),
        h('li', 'Practice (reveal, skip, abandoned and unscored review) is reported on its own row and never mixed into scored totals.'),
        h('li', 'Attempts still in progress are excluded until they finish.'),
        h('li', 'Range filtering uses attempt start time; a Woodpecker cycle counts by completion time (or start time while it is unfinished).'),
        ...(snapshot.totals.untrustedAttempts > 0
          ? [h('li', `${snapshot.totals.untrustedAttempts} attempt${snapshot.totals.untrustedAttempts === 1 ? '' : 's'} had untrustworthy timing (hidden/interrupted); their seconds are included but flagged here.`)]
          : []),
        ...(snapshot.openAttempts > 0 ? [h('li', `${snapshot.openAttempts} attempt${snapshot.openAttempts === 1 ? '' : 's'} still in progress (excluded).`)] : []),
      ]),
    ]),
  ]);
}

export class StatsView implements Screen {
  readonly id = 'stats' as const;
  private readonly service: LocalTrainingService;
  private vnode: VNode | null = null;
  private ctrl: StatsCtrl | null = null;

  constructor(ctx: AppContext) {
    this.service = ctx.service;
  }

  mount(host: HTMLElement): void {
    this.ctrl = new StatsCtrl(this.service);
    this.ctrl.redraw = () => {
      if (this.vnode && this.ctrl) this.vnode = patch(this.vnode, viewStats(this.ctrl));
    };
    this.vnode = patch(host, viewStats(this.ctrl));
  }

  unmount(): void {
    this.ctrl = null;
    this.vnode = null;
  }
}
