/**
 * History screen (UX-002/UX-003, HIST-API): read-only progress + history inspection.
 *
 * Renders derived per-puzzle learning state (via `getScheduleState`), queue
 * counts (via `queueSummary`), the total recorded-attempt count (via
 * `getAttemptCount`), a per-puzzle status list (via `listPuzzles()`), and a
 * per-attempt table (via the read-only `listAttempts` getter).
 *
 * Strictly read-only: no grading, no scheduler writes, no storage mutations.
 */

import type { AttemptRecord, ScheduleState } from '@chessreps/contracts';
import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import type { Screen } from './router.ts';
import { DEFAULT_PROGRAM_ID, type LocalTrainingService } from './scheduler-service.ts';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

export class HistoryView implements Screen {
  readonly id = 'history' as const;

  private host: HTMLElement | null = null;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  mount(host: HTMLElement): void {
    this.host = host;
    const snapshot = summarizeHistory(this.ctx.service);
    this.host.innerHTML = this.template(snapshot);
  }

  unmount(): void {
    this.host = null;
  }

  private dueText(dueAt: number | undefined): string {
    if (dueAt === undefined) return t('history.due.never');
    return dueAt <= Date.now() ? t('history.due.now') : new Date(dueAt).toLocaleString();
  }

  private timeText(value: number | undefined): string {
    if (value === undefined) return t('history.attempts.unfinished');
    return new Date(value).toLocaleString();
  }

  private attemptTable(attempts: HistoryAttemptRow[]): string {
    if (attempts.length === 0) return `<p class="muted">${t('history.attempts.empty')}</p>`;
    const rows = attempts
      .map(
        (row) => `<tr>
          <td>${escapeHtml(row.puzzleId)}</td>
          <td>${t(`history.outcome.${row.outcome}`)}</td>
          <td>${row.activeSolvingSeconds}</td>
          <td>${row.correctionSeconds}</td>
          <td>${row.eventCount}</td>
          <td class="muted">${escapeHtml(this.timeText(row.startedAt))}</td>
          <td class="muted">${escapeHtml(this.timeText(row.completedAt))}</td>
        </tr>`,
      )
      .join('');
    return `<div class="table-wrap"><table class="attempt-table">
        <thead><tr>
          <th>${t('history.attempts.puzzle')}</th><th>${t('history.attempts.outcome')}</th>
          <th>${t('history.attempts.active')}</th><th>${t('history.attempts.correction')}</th>
          <th>${t('history.attempts.events')}</th><th>${t('history.attempts.started')}</th>
          <th>${t('history.attempts.finished')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  private template(snapshot: HistorySnapshot): string {
    const rows = snapshot.rows
      .map(
        (row) => `<tr>
          <td>${escapeHtml(row.puzzleId)}</td>
          <td>${row.rating}</td>
          <td>${t(`history.state.${row.state}`)}</td>
          <td class="muted">${escapeHtml(this.dueText(row.dueAt))}</td>
        </tr>`,
      )
      .join('');
    const table = snapshot.rows.length
      ? `<div class="table-wrap"><table class="puzzle-table">
          <thead><tr>
            <th>${t('puzzle.id')}</th><th>${t('puzzle.rating')}</th>
            <th>${t('status.title')}</th><th>${t('history.list.due')}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`
      : `<p class="muted">${t('history.list.empty')}</p>`;
    return `
      <div class="panel">
        <h3>${t('history.title')}</h3>
        <p>${t('history.subtitle')}</p>
        <p>${escapeHtml(t('history.queue', {
          total: snapshot.total,
          newCount: snapshot.newCount,
          due: snapshot.due,
          learned: snapshot.learned,
        }))}</p>
        <p>${escapeHtml(t('history.attempts', { count: snapshot.attemptCount }))}</p>
      </div>
      <div class="panel">
        <h3>${t('history.list.title')}</h3>
        ${table}
        <p class="muted">${t('history.note')}</p>
      </div>
      <div class="panel">
        <h3>${t('history.attempts.title')}</h3>
        ${this.attemptTable(snapshot.attempts)}
      </div>
    `;
  }
}
