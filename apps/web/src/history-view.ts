/**
 * History screen (UX-002/UX-003): read-only progress + history inspection.
 *
 * Renders derived per-puzzle learning state (via `getScheduleState`), queue
 * counts (via `queueSummary`), the total recorded-attempt count (via
 * `getAttemptCount`), and a per-puzzle status list (via `listPuzzles()`).
 *
 * Strictly read-only: no grading, no scheduler writes, no storage mutations.
 * Per-attempt rows (outcome/timing/events/timestamps) are NOT shown because
 * the service exposes no list-attempts getter — see HIST-API follow-up below.
 */

import type { ScheduleState } from '@chessreps/contracts';
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
  return {
    total: summary.total,
    newCount: summary.newCount,
    due: summary.due,
    learned: summary.learned,
    attemptCount: service.getAttemptCount(),
    rows,
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
    `;
  }
}
