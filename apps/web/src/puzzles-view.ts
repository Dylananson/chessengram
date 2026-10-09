/**
 * Puzzles screen (PB3): the content library. It shows the current pack, imports
 * a JSONL file of normalized puzzles, and creates/edits/removes individual
 * puzzles. All validation goes through the shared chessops validator, and all
 * persistence goes through the training service (never directly to storage).
 */

import type { NormalizedPuzzle } from '@chessreps/contracts';
import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import type { Screen } from './router.ts';
import { DEFAULT_PROGRAM_ID } from './scheduler-service.ts';
import type { ContentSetMeta } from './storage/local-store.ts';
import {
  makeLichessStyleId,
  normalizeUciList,
  parseJsonlPuzzles,
  parseLichessCsv,
  previewPgn,
  solutionToText,
  validateAndNormalize,
  type PgnPreview,
  type PuzzleInput,
} from './validation/puzzle-validation.ts';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Message {
  kind: 'ok' | 'error';
  text: string;
}

export class PuzzlesView implements Screen {
  readonly id = 'puzzles' as const;

  private host: HTMLElement | null = null;
  private message: Message | null = null;
  private editing: NormalizedPuzzle | null = null;
  private showCreator = false;
  private pgnPreview: PgnPreview | null = null;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  async mount(host: HTMLElement): Promise<void> {
    this.host = host;
    await this.render();
  }

  unmount(): void {
    this.host = null;
  }

  private async render(): Promise<void> {
    if (!this.host) return;
    const puzzles = this.ctx.service.listPuzzles();
    const meta = await this.ctx.service.loadContentMeta();
    this.host.innerHTML = this.template(puzzles, meta);
    this.bind(puzzles);
  }

  // --- template ------------------------------------------------------------

  private template(puzzles: NormalizedPuzzle[], meta: ContentSetMeta | undefined): string {
    const message = this.message
      ? `<div class="${this.message.kind === 'ok' ? 'ok' : 'error'}" id="puzzles-message">${escapeHtml(this.message.text)}</div>`
      : '<div id="puzzles-message"></div>';

    const pack = meta
      ? `<p>${t('puzzles.pack.id')}: <strong>${escapeHtml(meta.packId || t('puzzle.none'))}</strong></p>
         <p>${t('puzzles.pack.count', { count: meta.count })}</p>
         <p>${t('puzzles.pack.loaded', { when: new Date(meta.loadedAt).toLocaleString() })}</p>`
      : `<p>${t('puzzles.pack.none')}</p>`;

    const rows = puzzles
      .map((p) => {
        const themes = p.themes.slice(0, 3).join(', ') || t('puzzle.none');
        return `<tr>
          <td>${escapeHtml(p.id)}</td>
          <td>${p.rating}</td>
          <td>${t(`color.${p.solverColor}`)}</td>
          <td>${escapeHtml(themes)}</td>
          <td class="muted">${escapeHtml(this.statusText(p.id))}</td>
          <td class="actions">
            <button type="button" data-edit="${escapeHtml(p.id)}">${t('puzzles.edit')}</button>
            <button type="button" data-remove="${escapeHtml(p.id)}">${t('puzzles.remove')}</button>
          </td>
        </tr>`;
      })
      .join('');

    const table = puzzles.length
      ? `<div class="table-wrap"><table class="puzzle-table">
          <thead><tr>
            <th>${t('puzzle.id')}</th><th>${t('puzzle.rating')}</th><th>${t('puzzle.solver')}</th>
            <th>${t('puzzle.themes')}</th><th>${t('status.title')}</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`
      : `<p class="muted">${t('puzzles.list.none')}</p>`;

    return `
      ${message}
      <div class="panel">
        <h3>${t('puzzles.pack.title')}</h3>
        ${pack}
      </div>
      <div class="panel">
        <h3>${t('puzzles.import.title')}</h3>
        <p>${t('puzzles.import.jsonl.hint')}</p>
        <div class="flex-row">
          <input type="file" id="puzzles-import-file" accept=".jsonl,application/jsonl,text/plain" />
          <button type="button" class="button compact" id="puzzles-import-btn">${t('puzzles.import.button')}</button>
        </div>
        <p>${t('puzzles.import.csv.hint')}</p>
        <div class="flex-row">
          <input type="file" id="puzzles-import-csv-file" accept=".csv,text/csv" />
          <button type="button" class="button compact" id="puzzles-import-csv-btn">${t('puzzles.import.csv.button')}</button>
        </div>
      </div>
      <div class="panel">
        <h3>${t('puzzles.pgn.title')}</h3>
        <p>${t('puzzles.pgn.hint')}</p>
        <div class="flex-row">
          <input type="file" id="puzzles-pgn-file" accept=".pgn,application/x-chess-pgn,text/plain" />
          <button type="button" class="button compact" id="puzzles-pgn-preview-btn">${t('puzzles.pgn.previewButton')}</button>
        </div>
        ${this.pgnPreview ? this.pgnPreviewHtml() : ''}
      </div>
      <div class="panel">
        <h3>${this.showCreator ? (this.editing ? t('puzzles.creator.mode.edit', { id: this.editing.id }) : t('puzzles.creator.mode.create')) : t('puzzles.creator.title')}</h3>
        <button type="button" class="button button-tertiary compact" id="puzzles-new-btn">${this.showCreator ? t('puzzles.creator.cancel') : t('puzzles.creator.open')}</button>
        ${this.showCreator ? this.creatorForm() : ''}
      </div>
      <div class="panel">
        <h3>${t('puzzles.list.title')}</h3>
        <div id="puzzles-list">${table}</div>
      </div>
    `;
  }

  private pgnPreviewHtml(): string {
    const candidates = this.pgnPreview!.candidates;
    const valid = candidates.filter((c) => c.puzzle).length;
    const rows = candidates
      .map((c) =>
        c.error
          ? `<p class="error">${escapeHtml(t('puzzles.pgn.preview.error', { index: c.index, error: c.error }))}</p>`
          : `<p>${escapeHtml(
              t('puzzles.pgn.preview.row', {
                index: c.index,
                plies: c.plies,
                color: t(`color.${c.solverColor}`),
                variations: c.variations,
              }),
            )}</p>`,
      )
      .join('');
    return `
      <div class="panel">
        <h3>${t('puzzles.pgn.preview.title')}</h3>
        ${rows}
        <div class="button-row">
          <button type="button" class="button compact" id="puzzles-pgn-confirm" ${valid === 0 ? 'disabled' : ''}>${t(
            'puzzles.pgn.confirm',
            { count: valid },
          )}</button>
          <button type="button" class="button button-secondary compact" id="puzzles-pgn-cancel">${t('puzzles.pgn.cancel')}</button>
        </div>
      </div>
    `;
  }

  private creatorForm(): string {
    const p = this.editing;
    const idField = p
      ? `<div class="field"><label for="pc-id">${t('puzzle.id')}</label><input id="pc-id" value="${escapeHtml(p.id)}" readonly /></div>`
      : `<div class="field"><label for="pc-id">${t('puzzle.id')} (${t('puzzles.creator.id.optional')})</label><input id="pc-id" placeholder="${makeLichessStyleId()}" /></div>`;
    return `
      <div id="pc-errors"></div>
      ${idField}
      <div class="field">
        <label for="pc-fen">${t('puzzles.creator.fen')}</label>
        <input id="pc-fen" placeholder="${t('puzzles.creator.fen.placeholder')}" value="${p ? escapeHtml(p.solverFen) : ''}" />
      </div>
      <div class="field">
        <label for="pc-setup-fen">${t('puzzles.creator.setup')}</label>
        <input id="pc-setup-fen" value="${p && p.setupMove ? escapeHtml(p.sourceFen) : ''}" />
      </div>
      <div class="field">
        <label for="pc-setup-move">${t('puzzles.creator.setupMove')}</label>
        <input id="pc-setup-move" value="${p?.setupMove ? escapeHtml(p.setupMove) : ''}" />
      </div>
      <div class="field">
        <label for="pc-solution">${t('puzzles.creator.solution')}</label>
        <textarea id="pc-solution" placeholder="${t('puzzles.creator.solution.placeholder')}">${p ? escapeHtml(solutionToText(p)) : ''}</textarea>
      </div>
      <div class="field">
        <label for="pc-rating">${t('puzzles.creator.rating')}</label>
        <input id="pc-rating" inputmode="numeric" value="${p ? p.rating : ''}" />
      </div>
      <div class="field">
        <label for="pc-themes">${t('puzzles.creator.themes')}</label>
        <input id="pc-themes" value="${p ? escapeHtml(p.themes.join(' ')) : ''}" />
      </div>
      <div class="field">
        <label for="pc-sourceid">${t('puzzles.creator.sourceId')}</label>
        <input id="pc-sourceid" value="${p && p.sourceId !== p.id ? escapeHtml(p.sourceId) : ''}" />
      </div>
      <div class="button-row">
        <button type="button" class="button" id="pc-save">${t('puzzles.creator.save')}</button>
      </div>
    `;
  }

  // --- wiring --------------------------------------------------------------

  private bind(puzzles: NormalizedPuzzle[]): void {
    document
      .getElementById('puzzles-import-btn')
      ?.addEventListener('click', () => void this.onImport('jsonl'));
    document
      .getElementById('puzzles-import-csv-btn')
      ?.addEventListener('click', () => void this.onImport('csv'));
    document
      .getElementById('puzzles-pgn-preview-btn')
      ?.addEventListener('click', () => void this.onPreviewPgn());
    document
      .getElementById('puzzles-pgn-confirm')
      ?.addEventListener('click', () => void this.onConfirmPgn());
    document
      .getElementById('puzzles-pgn-cancel')
      ?.addEventListener('click', () => void this.onCancelPgn());
    document
      .getElementById('puzzles-new-btn')
      ?.addEventListener('click', () => void this.onToggleCreator());
    document.getElementById('pc-save')?.addEventListener('click', () => void this.onSave());

    const list = document.getElementById('puzzles-list');
    list?.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((button) => {
      button.addEventListener('click', () => void this.onEdit(button.dataset.edit!));
    });
    list?.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => void this.onRemove(button.dataset.remove!));
    });

    void puzzles;
  }

  private readForm(): PuzzleInput {
    const value = (id: string): string =>
      (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() ??
      '';
    const ratingRaw = value('pc-rating');
    const idRaw = value('pc-id');
    return {
      id: this.editing ? this.editing.id : idRaw || undefined,
      solverFen: value('pc-fen'),
      sourceFen: value('pc-setup-fen') || undefined,
      setupMove: value('pc-setup-move') || undefined,
      solution: normalizeUciList(value('pc-solution')),
      rating: ratingRaw === '' ? undefined : Number(ratingRaw),
      themes: normalizeUciList(value('pc-themes')),
      sourceId: value('pc-sourceid') || undefined,
      source: this.editing?.source,
    };
  }

  private statusText(puzzleId: string): string {
    const state = this.ctx.service.getScheduleState(`${DEFAULT_PROGRAM_ID}:${puzzleId}`);
    const stateName = state?.state ?? 'new';
    const when =
      state?.dueAt === undefined
        ? t('puzzles.puzzle.dueNever')
        : state.dueAt <= Date.now()
          ? t('puzzles.puzzle.dueNow')
          : new Date(state.dueAt).toLocaleString();
    return t('puzzles.puzzle.status', {
      state: t(`puzzles.state.${stateName}`),
      when,
    });
  }

  // --- actions -------------------------------------------------------------

  private async onToggleCreator(): Promise<void> {
    if (this.showCreator) {
      this.showCreator = false;
      this.editing = null;
    } else {
      this.showCreator = true;
    }
    await this.render();
  }

  private async onEdit(puzzleId: string): Promise<void> {
    const puzzle = this.ctx.service.listPuzzles().find((p) => p.id === puzzleId) ?? null;
    if (!puzzle) return;
    this.editing = puzzle;
    this.showCreator = true;
    this.message = null;
    await this.render();
  }

  private async onSave(): Promise<void> {
    const result = validateAndNormalize(this.readForm());
    if (!result.ok) {
      const box = document.getElementById('pc-errors');
      if (box) {
        box.className = 'error';
        box.textContent = result.errors.join(' · ');
        box.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    const { added } = await this.ctx.service.upsertPuzzles([result.puzzle]);
    this.showCreator = false;
    this.editing = null;
    this.message = {
      kind: 'ok',
      text: t('puzzles.creator.saved', {
        id: result.puzzle.id,
        kind: t(added > 0 ? 'puzzles.creator.saved.added' : 'puzzles.creator.saved.replaced'),
      }),
    };
    await this.render();
  }

  private async onRemove(puzzleId: string): Promise<void> {
    if (!window.confirm(t('puzzles.remove.confirm', { id: puzzleId }))) return;
    await this.ctx.service.removePuzzle(puzzleId);
    this.message = { kind: 'ok', text: t('puzzles.remove.done', { id: puzzleId }) };
    await this.render();
  }

  private async onPreviewPgn(): Promise<void> {
    const input = document.getElementById('puzzles-pgn-file') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      this.message = { kind: 'error', text: t('puzzles.import.none') };
      await this.render();
      return;
    }
    const preview = previewPgn(await file.text());
    if (preview.candidates.length === 0) {
      this.message = { kind: 'error', text: t('puzzles.pgn.none') };
      this.pgnPreview = null;
      await this.render();
      return;
    }
    this.pgnPreview = preview;
    this.message = null;
    await this.render();
  }

  private async onConfirmPgn(): Promise<void> {
    if (!this.pgnPreview) return;
    const puzzles = this.pgnPreview.candidates.flatMap((c) => (c.puzzle ? [c.puzzle] : []));
    const { added, replaced } = await this.ctx.service.upsertPuzzles(puzzles, { packId: 'pgn' });
    this.pgnPreview = null;
    this.message = { kind: 'ok', text: t('puzzles.pgn.imported', { added, replaced }) };
    await this.render();
  }

  private async onCancelPgn(): Promise<void> {
    this.pgnPreview = null;
    await this.render();
  }

  private async onImport(kind: 'jsonl' | 'csv'): Promise<void> {
    const inputId = kind === 'csv' ? 'puzzles-import-csv-file' : 'puzzles-import-file';
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      this.message = { kind: 'error', text: t('puzzles.import.none') };
      await this.render();
      return;
    }
    const text = await file.text();
    const parsed = kind === 'csv' ? parseLichessCsv(text) : parseJsonlPuzzles(text);
    if (parsed.puzzles.length === 0) {
      this.message = {
        kind: 'error',
        text: t('puzzles.import.errors', {
          n: parsed.errors.length,
          sample: parsed.errors.slice(0, 3).join(' | ') || t('puzzles.list.none'),
        }),
      };
      await this.render();
      return;
    }
    const { added, replaced } = await this.ctx.service.upsertPuzzles(parsed.puzzles, {
      packId: file.name,
    });
    const parts = [t('puzzles.import.result', { added, replaced })];
    if (parsed.errors.length > 0) {
      parts.push(
        t('puzzles.import.errors', {
          n: parsed.errors.length,
          sample: parsed.errors.slice(0, 3).join(' | '),
        }),
      );
    }
    this.message = { kind: parsed.errors.length > 0 ? 'error' : 'ok', text: parts.join(' — ') };
    await this.render();
  }
}