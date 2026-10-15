/**
 * History screen (UX-002/UX-003, HIST-API): read-only progress + history inspection.
 *
 * Renders derived per-puzzle learning state (via `getScheduleState`), queue
 * counts (via `queueSummary`), the total recorded-attempt count (via
 * `getAttemptCount`), a per-puzzle status list (via `listPuzzles()`), and a
 * per-attempt table (via the read-only `listAttempts` getter).
 *
 * Strictly read-only: no grading, no scheduler writes, no storage mutations.
 *
 * Rendering (UI-001 S2 pilot — the ctrl/view/redraw pattern every later
 * screen copies): mutable state lives in {@link HistoryCtrl} (the current
 * `summarizeHistory` snapshot; History has no UI toggles), {@link view} is a
 * pure `(ctrl) => VNode` function built from the S1 primitives, and
 * {@link HistoryView} mounts once via snabbdom `patch` then re-patches
 * through a `redraw` closure. `h`/`init` come from DOM-free
 * `snabbdom/build/*` deep subpaths (never the package root, which touches
 * `window` at load), so this module — ctrl, snapshot helpers, and `view` —
 * stays importable under Node. Only `mount` touches the DOM.
 */

import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import type { AttemptRecord, ScheduleState } from '@chessreps/contracts';
import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import type { Screen } from './router.ts';
import { DEFAULT_PROGRAM_ID, type LocalTrainingService } from './scheduler-service.ts';
import { emptyState, panel } from './ui/primitives.ts';
// Shared screen patch (see `./ui/patch.ts`): History renders static
// selectors + text only, so the extra modules are no-ops here.
import { screenPatch as patch } from './ui/patch.ts';

export interface HistoryRow {
  puzzleId: string;
  rating: number;
  state: ScheduleState;
  dueAt: number | undefined;
}

export interface HistorySnapshot {
  total: number;
  newCount: number;
  due: number;
  learned: number;
  attemptCount: number;
  rows: HistoryRow[];
  attempts: HistoryAttemptRow[];
}

export type HistoryAttemptOutcome = 'success' | 'failure' | 'unscored' | 'abandoned';

export interface HistoryAttemptRow {
  attemptId: string;
  puzzleId: string;
  outcome: HistoryAttemptOutcome;
  activeSolvingSeconds: number;
  correctionSeconds: number;
  eventCount: number;
  startedAt: number;
  completedAt: number | undefined;
}

/** Latest number of per-attempt rows shown on the History screen. */
export const HISTORY_ATTEMPT_LIMIT = 100;

/**
 * Read-only outcome classification for one raw attempt record: committed
 * outcomes pass through; uncommitted attempts with an `abandon` event read as
 * abandoned, all other uncommitted attempts as unscored. Pure, no mutations.
 */
export function classifyAttemptOutcome(attempt: AttemptRecord): HistoryAttemptOutcome {
  if (attempt.outcome === 'success' || attempt.outcome === 'failure') return attempt.outcome;
  if (attempt.events.some((event) => event.type === 'abandon')) return 'abandoned';
  return 'unscored';
}

/**
 * Pure read-only projection over existing public service getters.
 * Exported for tests; performs no mutations.
 */
export function summarizeHistory(
  service: LocalTrainingService,
  programId: string = DEFAULT_PROGRAM_ID,
): HistorySnapshot {
  const summary = service.queueSummary(programId);
  const rows: HistoryRow[] = service.listPuzzles().map((puzzle) => {
    const state = service.getScheduleState(`${programId}:${puzzle.id}`);
    return {
      puzzleId: puzzle.id,
      rating: puzzle.rating,
      state: state?.state ?? 'new',
      dueAt: state?.dueAt,
    };
  });
  const attempts: HistoryAttemptRow[] = service
    .listAttempts({ programId, limit: HISTORY_ATTEMPT_LIMIT })
    .map((attempt) => ({
      attemptId: attempt.attemptId.value,
      puzzleId: attempt.progressKey.puzzleId,
      outcome: classifyAttemptOutcome(attempt),
      activeSolvingSeconds: attempt.timing.activeSolvingSeconds,
      correctionSeconds: attempt.timing.correctionSeconds,
      eventCount: attempt.events.length,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
    }));
  return {
    total: summary.total,
    newCount: summary.newCount,
    due: summary.due,
    learned: summary.learned,
    attemptCount: service.getAttemptCount(),
    rows,
    attempts,
  };
}

function dueText(dueAt: number | undefined): string {
  if (dueAt === undefined) return t('history.due.never');
  return dueAt <= Date.now() ? t('history.due.now') : new Date(dueAt).toLocaleString();
}

function timeText(value: number | undefined): string {
  if (value === undefined) return t('history.attempts.unfinished');
  return new Date(value).toLocaleString();
}

/**
 * Per-screen controller: owns the current read-only snapshot plus the
 * `redraw` closure the mount site installs. `refresh()` re-runs the pure
 * projection over the service read getters and re-renders; History has no
 * writers today, so nothing calls it yet — it exists as the seam later
 * screens copy (every mutation path ends in `redraw()`).
 */
export class HistoryCtrl {
  snapshot: HistorySnapshot;
  private readonly service: LocalTrainingService;
  private readonly programId: string;
  redraw: () => void;

  constructor(
    service: LocalTrainingService,
    programId: string = DEFAULT_PROGRAM_ID,
    redraw: () => void = () => {},
  ) {
    this.service = service;
    this.programId = programId;
    this.redraw = redraw;
    this.snapshot = summarizeHistory(service, programId);
  }

  /** Re-read service getters and re-render. Performs no writes. */
  refresh(): void {
    this.snapshot = summarizeHistory(this.service, this.programId);
    this.redraw();
  }
}

function puzzleTable(rows: HistoryRow[]): VNode {
  if (rows.length === 0) return emptyState(t('history.list.empty'));
  return h('div.table-wrap', [
    h('table.puzzle-table', [
      h('thead', [
        h('tr', [
          h('th', t('puzzle.id')),
          h('th', t('puzzle.rating')),
          h('th', t('status.title')),
          h('th', t('history.list.due')),
        ]),
      ]),
      h(
        'tbody',
        rows.map((row) =>
          h('tr', [
            h('td', row.puzzleId),
            h('td', String(row.rating)),
            h('td', t(`history.state.${row.state}`)),
            h('td.muted', dueText(row.dueAt)),
          ]),
        ),
      ),
    ]),
  ]);
}

function attemptTable(attempts: HistoryAttemptRow[]): VNode {
  if (attempts.length === 0) return emptyState(t('history.attempts.empty'));
  return h('div.table-wrap', [
    h('table.attempt-table', [
      h('thead', [
        h('tr', [
          h('th', t('history.attempts.puzzle')),
          h('th', t('history.attempts.outcome')),
          h('th', t('history.attempts.active')),
          h('th', t('history.attempts.correction')),
          h('th', t('history.attempts.events')),
          h('th', t('history.attempts.started')),
          h('th', t('history.attempts.finished')),
        ]),
      ]),
      h(
        'tbody',
        attempts.map((row) =>
          h('tr', [
            h('td', row.puzzleId),
            h('td', t(`history.outcome.${row.outcome}`)),
            h('td', String(row.activeSolvingSeconds)),
            h('td', String(row.correctionSeconds)),
            h('td', String(row.eventCount)),
            h('td.muted', timeText(row.startedAt)),
            h('td.muted', timeText(row.completedAt)),
          ]),
        ),
      ),
    ]),
  ]);
}

/**
 * Pure view: same information and same strings as the pre-Snabbdom template
 * (summary counts, per-puzzle status list + note, per-attempt table), composed
 * from the S1 `panel`/`emptyState` primitives. Snabbdom sets cell content as
 * text, so no manual HTML escaping is needed.
 */
export function view(ctrl: HistoryCtrl): VNode {
  const snapshot = ctrl.snapshot;
  return h('div.history-screen', [
    panel(t('history.title'), [
      h('p', t('history.subtitle')),
      h(
        'p',
        t('history.queue', {
          total: snapshot.total,
          newCount: snapshot.newCount,
          due: snapshot.due,
          learned: snapshot.learned,
        }),
      ),
      h('p', t('history.attempts', { count: snapshot.attemptCount })),
    ]),
    panel(t('history.list.title'), [
      puzzleTable(snapshot.rows),
      h('p.muted', t('history.note')),
    ]),
    panel(t('history.attempts.title'), attemptTable(snapshot.attempts)),
  ]);
}

export class HistoryView implements Screen {
  readonly id = 'history' as const;

  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private ctrl: HistoryCtrl | null = null;
  private vnode: VNode | null = null;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  mount(host: HTMLElement): void {
    this.host = host;
    const placeholder = document.createElement('div');
    host.appendChild(placeholder);
    const ctrl = new HistoryCtrl(this.ctx.service);
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
