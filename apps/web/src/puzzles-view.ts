/**
 * Puzzles screen (PB3): the content library. It shows the current pack, imports
 * a JSONL file of normalized puzzles, and creates/edits/removes individual
 * puzzles. All validation goes through the shared chessops validator, and all
 * persistence goes through the training service (never directly to storage).
 *
 * Rendering (UI-001 S5 — the S2 ctrl/view/redraw pattern from history-view):
 * mutable state lives in {@link PuzzlesCtrl} (the current `summarizePuzzles`
 * snapshot plus `message`/`editing`/`showCreator`/`creatorErrors`/`pgnPreview`
 * UI state), {@link view} is a pure `(ctrl) => VNode` function built from the
 * S1 primitives, and {@link PuzzlesView} mounts once via snabbdom `patch`
 * then re-patches through a guarded `redraw` closure. `h`/`init`/modules come
 * from DOM-free `snabbdom/build/*` deep subpaths (never the package root,
 * which touches `window` at load), so this module — ctrl, snapshot helpers,
 * and `view` — stays importable under Node. Only `mount` and the thin
 * DOM-reader click handlers touch the DOM.
 *
 * Deviations from the S2 pilot (both preserve exact pre-Snabbdom hooks):
 * async first paint (the pack meta needs the async `loadContentMeta` read, so
 * `mount` installs the guarded `redraw` closure first, awaits `ctrl.refresh()`,
 * then patches the placeholder once — the S4 shape), and the message +
 * creator-error boxes keep their legacy `.ok`/`.error` classes on the
 * `#puzzles-message` / `#pc-errors` elements themselves instead of the
 * `statusLine` primitive (smoke + CSS hooks depend on them; polish is S7).
 * The compact action buttons are raw `h('button.button.compact', …)` vnodes —
 * see SETTINGS-FOLLOWUP-compact-button (no `actionButton` expression exists
 * for the `.compact` scale).
 */

import { h } from 'snabbdom/build/h.js';
import { init } from 'snabbdom/build/init.js';
import { attributesModule } from 'snabbdom/build/modules/attributes.js';
import { eventListenersModule } from 'snabbdom/build/modules/eventlisteners.js';
import { propsModule } from 'snabbdom/build/modules/props.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import type { NormalizedPuzzle } from '@chessreps/contracts';
import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import type { Screen } from './router.ts';
import { DEFAULT_PROGRAM_ID, type LocalTrainingService } from './scheduler-service.ts';
import type { ContentSetMeta } from './storage/local-store.ts';
import { emptyState, formRow, panel } from './ui/primitives.ts';
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

/**
 * snabbdom patch function for this screen. `attributes` + `props` cover the
 * form controls (ids/accept/placeholders/readonly/disabled via attrs;
 * value/checked via props so redraws update live control state);
 * `eventListeners` covers the `on: { click }` bindings. The `style` module
 * reads `window` at load and must stay out.
 */
const patch = init([attributesModule, eventListenersModule, propsModule]);

export interface PuzzlesMessage {
  kind: 'ok' | 'error';
  text: string;
}

export interface PuzzlesRow {
  id: string;
  rating: number;
  solverColor: 'white' | 'black';
  themes: string[];
  status: string;
}

export interface PuzzlesSnapshot {
  rows: PuzzlesRow[];
  meta: ContentSetMeta | undefined;
}

function statusText(service: LocalTrainingService, puzzleId: string): string {
  const state = service.getScheduleState(`${DEFAULT_PROGRAM_ID}:${puzzleId}`);
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

/**
 * Pure read-only projection over existing public service getters: every
 * library puzzle with its per-puzzle status line, plus the pack meta passed
 * in by the caller (it needs the async `loadContentMeta` read). Exported for
 * tests; performs no mutations.
 */
export function summarizePuzzles(
  service: LocalTrainingService,
  meta: ContentSetMeta | undefined,
): PuzzlesSnapshot {
  return {
    rows: service.listPuzzles().map((puzzle) => ({
      id: puzzle.id,
      rating: puzzle.rating,
      solverColor: puzzle.solverColor,
      themes: [...puzzle.themes],
      status: statusText(service, puzzle.id),
    })),
    meta,
  };
}

/**
 * Per-screen controller: owns the current snapshot plus the `message` /
 * `editing` / `showCreator` / `creatorErrors` / `pgnPreview` UI state and the
 * `redraw` closure the mount site installs. Every writer ends in `refresh()`
 * (pure re-projection + `redraw()`), mirroring the S2 seam. Form and file
 * inputs are read from the DOM by the thin click handlers below, so the ctrl
 * itself takes plain data and stays Node-testable. Validation logic lives in
 * `validation/` — this file only calls it.
 */
export class PuzzlesCtrl {
  snapshot: PuzzlesSnapshot;
  message: PuzzlesMessage | null = null;
  editing: NormalizedPuzzle | null = null;
  showCreator = false;
  creatorErrors: string[] = [];
  pgnPreview: PgnPreview | null = null;
  redraw: () => void = () => {};
  private readonly service: LocalTrainingService;

  constructor(service: LocalTrainingService, redraw: () => void = () => {}) {
    this.service = service;
    this.redraw = redraw;
    this.snapshot = summarizePuzzles(service, undefined);
  }

  /** Re-run the pure projection over the service getters and re-render. */
  async refresh(): Promise<void> {
    this.snapshot = summarizePuzzles(this.service, await this.service.loadContentMeta());
    this.redraw();
  }

  /** Toggle the creator panel, discarding any in-progress edit. */
  async toggleCreator(): Promise<void> {
    if (this.showCreator) {
      this.showCreator = false;
      this.editing = null;
    } else {
      this.showCreator = true;
    }
    await this.refresh();
  }

  /** Open the creator panel prefilled with one library puzzle. */
  async edit(puzzleId: string): Promise<void> {
    const puzzle = this.service.listPuzzles().find((p) => p.id === puzzleId) ?? null;
    if (!puzzle) return;
    this.editing = puzzle;
    this.showCreator = true;
    this.message = null;
    await this.refresh();
  }

  /**
   * Validate creator input (via `validateAndNormalize`) and persist it.
   * Returns false when validation fails: the errors render into `#pc-errors`
   * and nothing is written. Removal drops content + the derived schedule and
   * keeps raw history (service D09 semantics, covered by content-management
   * tests).
   */
  async save(input: PuzzleInput): Promise<boolean> {
    const result = validateAndNormalize(input);
    if (!result.ok) {
      this.creatorErrors = result.errors;
      this.redraw();
      return false;
    }
    const { added } = await this.service.upsertPuzzles([result.puzzle]);
    this.showCreator = false;
    this.editing = null;
    this.creatorErrors = [];
    this.message = {
      kind: 'ok',
      text: t('puzzles.creator.saved', {
        id: result.puzzle.id,
        kind: t(added > 0 ? 'puzzles.creator.saved.added' : 'puzzles.creator.saved.replaced'),
      }),
    };
    await this.refresh();
    return true;
  }

  /** Remove one puzzle after the caller confirms; reports the same string. */
  async remove(puzzleId: string): Promise<void> {
    await this.service.removePuzzle(puzzleId);
    this.message = { kind: 'ok', text: t('puzzles.remove.done', { id: puzzleId }) };
    await this.refresh();
  }

  /** Validate dropped/pasted PGN text into a preview-confirm flow. */
  async previewPgnText(text: string | null): Promise<void> {
    if (text === null) {
      this.message = { kind: 'error', text: t('puzzles.import.none') };
      await this.refresh();
      return;
    }
    const preview = previewPgn(text);
    if (preview.candidates.length === 0) {
      this.message = { kind: 'error', text: t('puzzles.pgn.none') };
      this.pgnPreview = null;
      await this.refresh();
      return;
    }
    this.pgnPreview = preview;
    this.message = null;
    await this.refresh();
  }

  /** Confirm the pending PGN preview: import the valid games as a pack. */
  async confirmPgn(): Promise<void> {
    if (!this.pgnPreview) return;
    const puzzles = this.pgnPreview.candidates.flatMap((c) => (c.puzzle ? [c.puzzle] : []));
    const { added, replaced } = await this.service.upsertPuzzles(puzzles, { packId: 'pgn' });
    this.pgnPreview = null;
    this.message = { kind: 'ok', text: t('puzzles.pgn.imported', { added, replaced }) };
    await this.refresh();
  }

  /** Discard the pending PGN preview without writing. */
  async cancelPgn(): Promise<void> {
    this.pgnPreview = null;
    await this.refresh();
  }

  /**
   * Import one JSONL/CSV file's text under its filename as pack id. `null`
   * means no file was chosen. Additive imports: valid records merge, rejected
   * lines are reported with the same strings (never silently dropped).
   */
  async importText(kind: 'jsonl' | 'csv', text: string | null, filename: string): Promise<void> {
    if (text === null) {
      this.message = { kind: 'error', text: t('puzzles.import.none') };
      await this.refresh();
      return;
    }
    const parsed = kind === 'csv' ? parseLichessCsv(text) : parseJsonlPuzzles(text);
    if (parsed.puzzles.length === 0) {
      this.message = {
        kind: 'error',
        text: t('puzzles.import.errors', {
          n: parsed.errors.length,
          sample: parsed.errors.slice(0, 3).join(' | ') || t('puzzles.list.none'),
        }),
      };
      await this.refresh();
      return;
    }
    const { added, replaced } = await this.service.upsertPuzzles(parsed.puzzles, {
      packId: filename,
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
    await this.refresh();
  }
}

/**
 * Thin DOM readers for the creator form and file inputs. Called only from the
 * browser click handlers; the ctrl itself takes plain data so it stays
 * Node-testable.
 */
function readCreatorForm(editing: NormalizedPuzzle | null): PuzzleInput {
  const value = (id: string): string =>
    (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() ??
    '';
  const ratingRaw = value('pc-rating');
  const idRaw = value('pc-id');
  return {
    id: editing ? editing.id : idRaw || undefined,
    solverFen: value('pc-fen'),
    sourceFen: value('pc-setup-fen') || undefined,
    setupMove: value('pc-setup-move') || undefined,
    solution: normalizeUciList(value('pc-solution')),
    rating: ratingRaw === '' ? undefined : Number(ratingRaw),
    themes: normalizeUciList(value('pc-themes')),
    sourceId: value('pc-sourceid') || undefined,
    source: editing?.source,
  };
}

function readChosenFileText(inputId: string): Promise<string | null> {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!file) return Promise.resolve(null);
  return file.text().then(
    (text) => text,
    () => null,
  );
}

function onImportClick(ctrl: PuzzlesCtrl, kind: 'jsonl' | 'csv'): void {
  const inputId = kind === 'csv' ? 'puzzles-import-csv-file' : 'puzzles-import-file';
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!file) {
    void ctrl.importText(kind, null, '');
    return;
  }
  const name = file.name;
  void file
    .text()
    .then((text) => ctrl.importText(kind, text, name));
}

function onPreviewPgnClick(ctrl: PuzzlesCtrl): void {
  void readChosenFileText('puzzles-pgn-file').then((text) => ctrl.previewPgnText(text));
}

function onSaveClick(ctrl: PuzzlesCtrl): void {
  const input = readCreatorForm(ctrl.editing);
  void ctrl.save(input).then((ok) => {
    if (!ok) document.getElementById('pc-errors')?.scrollIntoView({ block: 'nearest' });
  });
}

function onRemoveClick(ctrl: PuzzlesCtrl, puzzleId: string): void {
  if (!window.confirm(t('puzzles.remove.confirm', { id: puzzleId }))) return;
  void ctrl.remove(puzzleId);
}

function messageNode(ctrl: PuzzlesCtrl): VNode {
  // Legacy `.ok`/`.error` classes stay on `#puzzles-message` itself (smoke +
  // CSS hooks); polish is S7's job.
  if (!ctrl.message) return h('div', { attrs: { id: 'puzzles-message' } }, []);
  const tone = ctrl.message.kind === 'ok' ? 'div.ok' : 'div.error';
  return h(tone, { attrs: { id: 'puzzles-message' } }, ctrl.message.text);
}

function packPanel(ctrl: PuzzlesCtrl): VNode {
  const meta = ctrl.snapshot.meta;
  if (!meta) return panel(t('puzzles.pack.title'), [h('p', t('puzzles.pack.none'))]);
  return panel(t('puzzles.pack.title'), [
    h('p', [`${t('puzzles.pack.id')}: `, h('strong', meta.packId || t('puzzle.none'))]),
    h('p', t('puzzles.pack.count', { count: meta.count })),
    h('p', t('puzzles.pack.loaded', { when: new Date(meta.loadedAt).toLocaleString() })),
  ]);
}

function fileRow(fileId: string, accept: string, buttonId: string, label: string, onClick: () => void): VNode {
  return h('div.flex-row', [
    h('input', { attrs: { type: 'file', id: fileId, accept } }),
    h(
      'button.button.compact',
      { attrs: { type: 'button', id: buttonId }, on: { click: onClick } },
      label,
    ),
  ]);
}

function importPanel(ctrl: PuzzlesCtrl): VNode {
  return panel(t('puzzles.import.title'), [
    h('p', t('puzzles.import.jsonl.hint')),
    fileRow(
      'puzzles-import-file',
      '.jsonl,application/jsonl,text/plain',
      'puzzles-import-btn',
      t('puzzles.import.button'),
      () => onImportClick(ctrl, 'jsonl'),
    ),
    h('p', t('puzzles.import.csv.hint')),
    fileRow(
      'puzzles-import-csv-file',
      '.csv,text/csv',
      'puzzles-import-csv-btn',
      t('puzzles.import.csv.button'),
      () => onImportClick(ctrl, 'csv'),
    ),
  ]);
}

function pgnPreviewView(ctrl: PuzzlesCtrl, preview: PgnPreview): VNode {
  const valid = preview.candidates.filter((c) => c.puzzle).length;
  const rows = preview.candidates.map((c) =>
    c.error
      ? h('p.error', t('puzzles.pgn.preview.error', { index: c.index, error: c.error }))
      : h(
          'p',
          t('puzzles.pgn.preview.row', {
            index: c.index,
            plies: c.plies,
            color: t(`color.${c.solverColor}`),
            variations: c.variations,
          }),
        ),
  );
  return panel(t('puzzles.pgn.preview.title'), [
    ...rows,
    h('div.button-row', [
      h(
        'button.button.compact',
        {
          attrs: {
            type: 'button',
            id: 'puzzles-pgn-confirm',
            ...(valid === 0 ? { disabled: true } : {}),
          },
          on: { click: () => void ctrl.confirmPgn() },
        },
        t('puzzles.pgn.confirm', { count: valid }),
      ),
      h(
        'button.button.button-secondary.compact',
        {
          attrs: { type: 'button', id: 'puzzles-pgn-cancel' },
          on: { click: () => void ctrl.cancelPgn() },
        },
        t('puzzles.pgn.cancel'),
      ),
    ]),
  ]);
}

function pgnPanel(ctrl: PuzzlesCtrl): VNode {
  return panel(t('puzzles.pgn.title'), [
    h('p', t('puzzles.pgn.hint')),
    fileRow(
      'puzzles-pgn-file',
      '.pgn,application/x-chess-pgn,text/plain',
      'puzzles-pgn-preview-btn',
      t('puzzles.pgn.previewButton'),
      () => onPreviewPgnClick(ctrl),
    ),
    ...(ctrl.pgnPreview ? [pgnPreviewView(ctrl, ctrl.pgnPreview)] : []),
  ]);
}

function creatorForm(ctrl: PuzzlesCtrl): VNode[] {
  const p = ctrl.editing;
  const errors =
    ctrl.creatorErrors.length > 0
      ? h('div.error', { attrs: { id: 'pc-errors' } }, ctrl.creatorErrors.join(' · '))
      : h('div', { attrs: { id: 'pc-errors' } }, []);
  const idControl = p
    ? h('input', { attrs: { id: 'pc-id', readonly: true }, props: { value: p.id } })
    : h('input', {
        attrs: { id: 'pc-id', placeholder: makeLichessStyleId() },
        props: { value: '' },
      });
  const idLabel = p
    ? t('puzzle.id')
    : `${t('puzzle.id')} (${t('puzzles.creator.id.optional')})`;
  return [
    errors,
    formRow(idLabel, idControl, { htmlFor: 'pc-id' }),
    formRow(
      t('puzzles.creator.fen'),
      h('input', {
        attrs: { id: 'pc-fen', placeholder: t('puzzles.creator.fen.placeholder') },
        props: { value: p ? p.solverFen : '' },
      }),
      { htmlFor: 'pc-fen' },
    ),
    formRow(
      t('puzzles.creator.setup'),
      h('input', {
        attrs: { id: 'pc-setup-fen' },
        props: { value: p && p.setupMove ? p.sourceFen : '' },
      }),
      { htmlFor: 'pc-setup-fen' },
    ),
    formRow(
      t('puzzles.creator.setupMove'),
      h('input', {
        attrs: { id: 'pc-setup-move' },
        props: { value: p?.setupMove ?? '' },
      }),
      { htmlFor: 'pc-setup-move' },
    ),
    formRow(
      t('puzzles.creator.solution'),
      h('textarea', {
        attrs: { id: 'pc-solution', placeholder: t('puzzles.creator.solution.placeholder') },
        props: { value: p ? solutionToText(p) : '' },
      }),
      { htmlFor: 'pc-solution' },
    ),
    formRow(
      t('puzzles.creator.rating'),
      h('input', {
        attrs: { id: 'pc-rating', inputmode: 'numeric' },
        props: { value: p ? String(p.rating) : '' },
      }),
      { htmlFor: 'pc-rating' },
    ),
    formRow(
      t('puzzles.creator.themes'),
      h('input', {
        attrs: { id: 'pc-themes' },
        props: { value: p ? p.themes.join(' ') : '' },
      }),
      { htmlFor: 'pc-themes' },
    ),
    formRow(
      t('puzzles.creator.sourceId'),
      h('input', {
        attrs: { id: 'pc-sourceid' },
        props: { value: p && p.sourceId !== p.id ? p.sourceId : '' },
      }),
      { htmlFor: 'pc-sourceid' },
    ),
    h('div.button-row', [
      h(
        'button.button',
        { attrs: { type: 'button', id: 'pc-save' }, on: { click: () => onSaveClick(ctrl) } },
        t('puzzles.creator.save'),
      ),
    ]),
  ];
}

function creatorPanel(ctrl: PuzzlesCtrl): VNode {
  const title = ctrl.showCreator
    ? ctrl.editing
      ? t('puzzles.creator.mode.edit', { id: ctrl.editing.id })
      : t('puzzles.creator.mode.create')
    : t('puzzles.creator.title');
  return panel(title, [
    h(
      'button.button.button-tertiary.compact',
      {
        attrs: { type: 'button', id: 'puzzles-new-btn' },
        on: { click: () => void ctrl.toggleCreator() },
      },
      ctrl.showCreator ? t('puzzles.creator.cancel') : t('puzzles.creator.open'),
    ),
    ...(ctrl.showCreator ? creatorForm(ctrl) : []),
  ]);
}

function libraryBody(ctrl: PuzzlesCtrl): VNode {
  const rows = ctrl.snapshot.rows;
  if (rows.length === 0) return emptyState(t('puzzles.list.none'));
  return h('div.table-wrap', [
    h('table.puzzle-table', [
      h('thead', [
        h('tr', [
          h('th', t('puzzle.id')),
          h('th', t('puzzle.rating')),
          h('th', t('puzzle.solver')),
          h('th', t('puzzle.themes')),
          h('th', t('status.title')),
          h('th', ''),
        ]),
      ]),
      h(
        'tbody',
        rows.map((row) =>
          h('tr', [
            h('td', row.id),
            h('td', String(row.rating)),
            h('td', t(`color.${row.solverColor}`)),
            h('td', row.themes.slice(0, 3).join(', ') || t('puzzle.none')),
            h('td.muted', row.status),
            h('td.actions', [
              h(
                'button',
                {
                  attrs: { type: 'button', 'data-edit': row.id },
                  on: { click: () => void ctrl.edit(row.id) },
                },
                t('puzzles.edit'),
              ),
              h(
                'button',
                {
                  attrs: { type: 'button', 'data-remove': row.id },
                  on: { click: () => onRemoveClick(ctrl, row.id) },
                },
                t('puzzles.remove'),
              ),
            ]),
          ]),
        ),
      ),
    ]),
  ]);
}

/**
 * Pure view: same information and same strings as the pre-Snabbdom template
 * (pack panel, JSONL/CSV import rows, PGN preview-confirm flow, creator/editor
 * form, library table with edit/remove hooks, message box), composed from the
 * S1 `panel`/`formRow`/`emptyState` primitives. Snabbdom sets copy as text,
 * so no manual HTML escaping is needed. Control ids match the previous
 * template (smoke + CSS hooks).
 */
export function view(ctrl: PuzzlesCtrl): VNode {
  return h('div.puzzles-screen', [
    messageNode(ctrl),
    packPanel(ctrl),
    importPanel(ctrl),
    pgnPanel(ctrl),
    creatorPanel(ctrl),
    panel(t('puzzles.list.title'), [h('div', { attrs: { id: 'puzzles-list' } }, [libraryBody(ctrl)])]),
  ]);
}

export class PuzzlesView implements Screen {
  readonly id = 'puzzles' as const;

  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private ctrl: PuzzlesCtrl | null = null;
  private vnode: VNode | null = null;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  async mount(host: HTMLElement): Promise<void> {
    this.host = host;
    const placeholder = document.createElement('div');
    host.appendChild(placeholder);
    // Track the placeholder so an unmount during the async load below still
    // removes exactly what this screen inserted.
    this.root = placeholder;
    const ctrl = new PuzzlesCtrl(this.ctx.service);
    this.ctrl = ctrl;
    ctrl.redraw = () => {
      if (this.ctrl === null || this.vnode === null) return;
      this.vnode = patch(this.vnode, view(this.ctrl));
      this.root = this.vnode.elm as HTMLElement;
    };
    await ctrl.refresh();
    // Unmounted while loading: teardown already ran; never patch.
    if (this.ctrl === null) return;
    this.vnode = patch(placeholder, view(ctrl));
    // The patch replaces the placeholder; track the live root so unmount
    // removes exactly what snabbdom inserted.
    this.root = this.vnode.elm as HTMLElement;
  }

  unmount(): void {
    // Guarded: safe to call without a prior mount, and drops the ctrl/vnode
    // refs so any late redraw after teardown is a no-op instead of a crash.
    this.root?.remove();
    this.root = null;
    this.host = null;
    this.ctrl = null;
    this.vnode = null;
  }
}
