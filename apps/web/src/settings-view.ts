/**
 * Settings screen (PB4/PB5). Hosts scheduler preferences (curated prefs save
 * + take-effect-on-next-attempt) and Data safety: full export, a
 * preview-then-confirm import, and one-click restore of recovery snapshots.
 *
 * Rendering (UI-001 S4 — the S2 ctrl/view/redraw pattern from history-view):
 * mutable state lives in {@link SettingsCtrl} (`message`, `summary`,
 * `backups`, `pending`, `curated`), {@link view} is a pure
 * `(ctrl) => VNode` function built from the S1 primitives, and
 * {@link SettingsView} mounts once via snabbdom `patch` then re-patches
 * through a guarded `redraw` closure. `h`/`init`/modules come from DOM-free
 * `snabbdom/build/*` deep subpaths (never the package root, which touches
 * `window` at load), so this module — ctrl, helpers, and `view` — stays
 * importable under Node. Only `mount` and the thin DOM-reader click handlers
 * touch the DOM.
 *
 * Deviation from the S2 pilot (async first paint): History snapshots are
 * synchronous, but the Settings state (`exportStoreSummary`, `listBackups`,
 * `getCuratedSettings`) needs async service reads, so `mount` installs the
 * guarded `redraw` closure first, awaits `ctrl.refresh()`, then patches the
 * placeholder once. Writers always end in `refresh()` (re-read + redraw).
 */

import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';
import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import type { Screen } from './router.ts';
import { DEFAULT_COLLECTION_ID, DEFAULT_PROGRAM_ID } from './scheduler-service.ts';
import type { LocalTrainingService } from './scheduler-service.ts';
import {
  CURATED_DEFAULTS,
  FAILURE_PRESETS,
  failurePresetLabel,
  parseCurated,
  type CuratedSettings,
} from './settings-preferences.ts';
import { parseExport, summarizeExport } from './storage/data-port.ts';
import type { StoreExport, StoreExportSummary } from './storage/local-store.ts';
import type { TrainingAdapter } from './training-adapter.ts';
import { BOARD_THEMES, getSavedBoardTheme, saveBoardTheme } from './board-theme.ts';
import { formatBytes, pwaSnapshot, promptInstall, type PwaSnapshot } from './pwa.ts';
import { actionButton, checkboxRow, emptyState, formRow, panel, statusLine } from './ui/primitives.ts';
import {
  buildSyncPanelModel,
  parseSyncConfig,
  viewSyncPanel,
  type SyncPanelActions,
  type SyncPanelConfig,
  type SyncPanelMessage,
} from './sync/panel.ts';
import type { SyncRuntime, SyncRuntimeState } from './sync/bootstrap.ts';
import type { SyncState } from './sync/types.ts';
// Shared screen patch (see `./ui/patch.ts`).
import { screenPatch as patch } from './ui/patch.ts';

function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

interface Message {
  kind: 'ok' | 'error';
  text: string;
}

interface PendingImport {
  data: StoreExport;
  summary: StoreExportSummary;
}

/**
 * ONL-003: injectable Sync panel state. Defaults are deliberately inert
 * (unconfigured + local-only); ONL-009 supplies the real config, state and
 * actions once a transport exists. Nothing here performs I/O.
 */
export interface SettingsSyncDeps {
  config?: SyncPanelConfig;
  state?: SyncState;
  pendingCount?: number;
  paused?: boolean;
  busy?: boolean;
  message?: SyncPanelMessage;
  actions?: Partial<SyncPanelActions>;
}

/** ONL-011 auth hooks injected by the mount site (Settings stays DOM/pure). */
export interface SettingsSyncAuthHooks {
  /** Build the authorize URL (PKCE state/verifier are persisted by `auth.ts`). */
  begin?: (config: SyncPanelConfig) => Promise<{ url: string }>;
  /** Navigate to the authorize URL; defaults to `location.assign`. */
  redirect?: (url: string) => void;
}

interface ResolvedSyncDeps {
  config: SyncPanelConfig;
  state: SyncState;
  pendingCount: number;
  paused: boolean;
  busy?: boolean;
  message?: SyncPanelMessage;
  actions: SyncPanelActions;
}

function inertSyncActions(): SyncPanelActions {
  return {
    enable: () => {},
    syncNow: () => {},
    signOut: () => {},
    disable: () => {},
    deleteServerCopy: () => {},
  };
}

/** Generic, value-free failure copy: never surfaces tokens, keys or server text. */
function syncFailureText(): string {
  return 'Sync could not complete. Your changes stay queued on this device.';
}

class SyncPausedError extends Error {}

/** Navigate to the hosted sign-in page. Injectable in tests (no browser needed). */
function defaultSyncRedirect(url: string): void {
  const location = (globalThis as { location?: { assign?(target: string): void; href?: string } })
    .location;
  if (location && typeof location.assign === 'function') location.assign(url);
  else if (location) location.href = url;
}

/**
 * Per-screen controller: owns the mutable settings state plus the `redraw`
 * closure the mount site installs. Every writer ends in `refresh()`
 * (re-read the async service state, then redraw). View use of
 * `parseCurated` only — no changes to parsing/clamping logic.
 */
export class SettingsCtrl {
  message: Message | null = null;
  summary: StoreExportSummary | null = null;
  backups: string[] = [];
  pending: PendingImport | null = null;
  curated: CuratedSettings = CURATED_DEFAULTS;
  /** APP-001: install/offline snapshot; null until the async load finishes. */
  pwa: PwaSnapshot | null = null;
  /** ONL-003: Sync panel dependencies (pure vnodes; no transport here). */
  sync: ResolvedSyncDeps;
  redraw: () => void = () => {};

  /** ONL-009b: live sync runtime, attached lazily by the mount site. */
  private syncRuntime: SyncRuntime | undefined;
  /** ONL-011: starts the Cognito redirect; navigation is injected for tests. */
  private syncBeginAuth: ((config: SyncPanelConfig) => Promise<{ url: string }>) | undefined;
  private syncRedirect: (url: string) => void = defaultSyncRedirect;
  private syncBusy = false;
  private syncMessage: SyncPanelMessage | undefined;

  private readonly service: LocalTrainingService;
  private readonly adapter: TrainingAdapter;

  constructor(
    service: LocalTrainingService,
    adapter: TrainingAdapter,
    redraw: () => void = () => {},
    sync: SettingsSyncDeps = {},
  ) {
    this.service = service;
    this.adapter = adapter;
    this.redraw = redraw;
    // The current build ships no VITE_SYNC_* values, so this resolves to the
    // honest local-only + not-configured panel. ONL-009 injects the real deps.
    this.sync = {
      config: sync.config ?? parseSyncConfig(import.meta.env),
      state: sync.state ?? { enabled: false },
      pendingCount: sync.pendingCount ?? 0,
      paused: sync.paused ?? false,
      ...(sync.busy === true ? { busy: true } : {}),
      ...(sync.message !== undefined ? { message: sync.message } : {}),
      actions: { ...inertSyncActions(), ...sync.actions },
    };
    // Keep a boot-time auth notice visible across the first runtime refresh.
    this.syncMessage = sync.message;
  }

  /** Re-read the async service state without writes. */
  async load(): Promise<void> {
    this.summary = await this.service.exportStoreSummary();
    this.backups = await this.service.listBackups();
    this.curated = this.service.getCuratedSettings();
  }

  /** Re-read the async service state and re-render. Performs no writes. */
  async refresh(): Promise<void> {
    await this.load();
    this.redraw();
  }

  /**
   * APP-001: read the install/offline snapshot (Cache + Storage APIs). Loaded
   * after the first paint because it is async and non-essential; a failure or
   * an unsupported browser just leaves the panel in its "checking" state.
   */
  async loadPwa(): Promise<void> {
    this.pwa = await pwaSnapshot();
    this.redraw();
  }

  /** Show the captured install prompt (Android/desktop), then re-read state. */
  async install(): Promise<void> {
    await promptInstall();
    await this.loadPwa();
  }

  // --- ONL-009b: live sync runtime ----------------------------------------

  /**
   * Attach the app's sync runtime (if one is available) and wire the panel
   * actions to it. When no runtime is supplied the inert defaults stay, so an
   * unconfigured build renders exactly as before.
   */
  async attachSync(
    runtime: SyncRuntime,
    auth: SettingsSyncAuthHooks = {},
  ): Promise<void> {
    this.syncRuntime = runtime;
    this.syncBeginAuth = auth.begin;
    this.syncRedirect = auth.redirect ?? defaultSyncRedirect;
    if (runtime.isConfigured()) {
      this.sync = { ...this.sync, config: runtime.config, actions: this.syncActions() };
    } else {
      this.sync = { ...this.sync, config: runtime.config };
    }
    await this.refreshSync();
  }

  /** Re-read the runtime state and re-render. Never throws. */
  private async refreshSync(): Promise<void> {
    const runtime = this.syncRuntime;
    if (!runtime) return;
    let live: SyncRuntimeState;
    try {
      live = await runtime.state();
    } catch {
      return;
    }
    const enabled = live.mode !== 'local-only';
    const state: SyncState = { enabled };
    if (live.lastSyncedAt !== undefined) state.lastSyncedAt = live.lastSyncedAt;
    this.sync = {
      config: runtime.config,
      state,
      pendingCount: live.pending,
      paused: live.mode === 'paused',
      ...(this.syncBusy ? { busy: true } : {}),
      ...(this.syncMessage !== undefined ? { message: this.syncMessage } : {}),
      actions: this.sync.actions,
    };
    this.redraw();
  }

  private syncActions(): SyncPanelActions {
    return {
      enable: () => void this.enableSync(),
      syncNow: () => void this.runSyncNow(),
      signOut: () =>
        void this.runSyncAction('Signed out. Your training data stayed on this device.', () =>
          this.requireRuntime().signOut(),
        ),
      disable: () =>
        void this.runSyncAction('Sync disabled. Your training data stayed on this device.', () =>
          this.requireRuntime().disable(),
        ),
      deleteServerCopy: () =>
        void this.runSyncAction(
          'Server copy deleted. Your training data stayed on this device.',
          () => this.requireRuntime().deleteServerCopy(),
        ),
    };
  }

  private requireRuntime(): SyncRuntime {
    if (!this.syncRuntime) throw new Error('sync runtime is unavailable');
    return this.syncRuntime;
  }

  /**
   * Enabling is a redirect, not an in-page token prompt: build the PKCE
   * authorize URL and hand navigation to the browser. The callback is completed
   * at boot (`app.ts`), which then calls `enable({ idToken })`.
   */
  private async enableSync(): Promise<void> {
    const runtime = this.syncRuntime;
    if (!runtime) return;
    this.syncBusy = true;
    this.syncMessage = undefined;
    await this.refreshSync();
    try {
      if (!this.syncBeginAuth) {
        this.syncMessage = { tone: 'error', text: 'Sign-in is not available in this build.' };
        this.syncBusy = false;
        await this.refreshSync();
        return;
      }
      const { url } = await this.syncBeginAuth(runtime.config);
      this.syncBusy = false;
      this.syncRedirect(url);
    } catch {
      this.syncMessage = { tone: 'error', text: syncFailureText() };
      this.syncBusy = false;
      await this.refreshSync();
    }
  }

  private async runSyncAction(
    successText: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    if (!this.syncRuntime) return;
    this.syncBusy = true;
    this.syncMessage = undefined;
    await this.refreshSync();
    try {
      await action();
      this.syncMessage = { tone: 'ok', text: successText };
    } catch (error) {
      this.syncMessage = {
        tone: 'error',
        text:
          error instanceof SyncPausedError
            ? 'Sync paused. Your sign-in may have expired; sign in again. Changes remain queued on this device.'
            : syncFailureText(),
      };
    } finally {
      this.syncBusy = false;
    }
    await this.refreshSync();
  }

  /** Report a completed transfer only when the runtime actually converged. */
  private async runSyncNow(): Promise<void> {
    const runtime = this.syncRuntime;
    if (!runtime) return;
    await this.runSyncAction('Sync complete.', async () => {
      const result = await runtime.syncNow();
      const state = await runtime.state();
      if (result.paused === true || state.mode === 'paused') {
        throw new SyncPausedError();
      }
      if ((result.skipped ?? 0) > 0) {
        throw new Error('some records could not be applied');
      }
      return result;
    });
  }

  /** Validate + clamp the raw prefs (via `parseCurated`), persist, confirm. */
  async savePreferences(raw: unknown): Promise<void> {
    this.curated = await this.service.applyCuratedSettings(parseCurated(raw));
    this.message = { kind: 'ok', text: t('settings.prefs.saved') };
    await this.refresh();
  }

  /** Export the full store as a JSON download, then report the total. */
  async exportStore(): Promise<void> {
    const exported = await this.service.exportStore();
    downloadJson(`chessengram-export-${timestamp()}.json`, JSON.stringify(exported));
    this.message = {
      kind: 'ok',
      text: t('settings.data.exported', { total: summarizeExport(exported).total }),
    };
    await this.refresh();
  }

  /**
   * Validate pasted/uploaded export text into a pending preview. `null`
   * means no file was chosen. Never writes to the store.
   */
  async previewImportText(text: string | null): Promise<void> {
    if (text === null) {
      this.message = { kind: 'error', text: t('settings.data.invalid') };
      await this.refresh();
      return;
    }
    const parsed = parseExport(text);
    if (!parsed.ok) {
      this.message = {
        kind: 'error',
        text: t('settings.data.importError', { error: parsed.errors.join('; ') }),
      };
      this.pending = null;
      await this.refresh();
      return;
    }
    this.pending = { data: parsed.data, summary: summarizeExport(parsed.data) };
    this.message = null;
    await this.refresh();
  }

  /** Confirm the pending preview: snapshot, import, reload, report. */
  async confirmImport(): Promise<void> {
    if (!this.pending) return;
    const label = `pre-import-${timestamp()}`;
    const summary = await this.service.importStore(this.pending.data, label);
    this.pending = null;
    await this.adapter.reloadAfterDataChange(DEFAULT_PROGRAM_ID, DEFAULT_COLLECTION_ID);
    this.message = { kind: 'ok', text: t('settings.data.imported', { total: summary.total, label }) };
    await this.refresh();
  }

  /** Discard the pending import preview without writing. */
  cancelImport(): void {
    this.pending = null;
    this.redraw();
  }

  /** Restore one recovery snapshot by label, then reload and report. */
  async restoreBackup(label: string): Promise<void> {
    const summary = await this.service.restoreBackup(label);
    if (!summary) {
      this.message = { kind: 'error', text: t('settings.data.restoreMissing') };
      await this.refresh();
      return;
    }
    await this.adapter.reloadAfterDataChange(DEFAULT_PROGRAM_ID, DEFAULT_COLLECTION_ID);
    this.message = { kind: 'ok', text: t('settings.data.restored', { label }) };
    await this.refresh();
  }
}

function countsLine(summary: StoreExportSummary): string {
  return t('settings.data.current', {
    total: summary.total,
    content: summary.counts.content ?? 0,
    schedules: summary.counts.schedules ?? 0,
    attempts: summary.counts.attempts ?? 0,
  });
}

/**
 * Thin DOM readers for the prefs form. Called only from the browser save
 * click handler; the ctrl itself takes plain data so it stays Node-testable.
 */
function readPrefsFromDom(): Record<string, unknown> {
  const number = (id: string, fallback: number): number => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    const value = input ? Number(input.value) : NaN;
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    failurePreset: (document.getElementById('set-failure') as HTMLSelectElement | null)?.value,
    stepBackAmount: number('set-step-back', CURATED_DEFAULTS.stepBackAmount),
    retryRetainAmount: number('set-retry-retain', CURATED_DEFAULTS.retryRetainAmount),
    newIntroductionLimitPerDay: number('set-new-per-day', CURATED_DEFAULTS.newIntroductionLimitPerDay),
    relearningMinutes: number('set-relearning', CURATED_DEFAULTS.relearningMinutes),
    timingEnabled: (document.getElementById('set-timing') as HTMLInputElement | null)?.checked,
  };
}

function onSaveClick(ctrl: SettingsCtrl): void {
  void ctrl.savePreferences(readPrefsFromDom());
}

function onExportClick(ctrl: SettingsCtrl): void {
  void ctrl.exportStore();
}

function onPreviewClick(ctrl: SettingsCtrl): void {
  const input = document.getElementById('settings-import-file') as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!file) {
    void ctrl.previewImportText(null);
    return;
  }
  void file.text().then((text) => ctrl.previewImportText(text));
}

function numberField(
  ctrl: SettingsCtrl,
  id: string,
  labelKey: string,
  value: number,
  min: number,
  max: number,
): VNode {
  return formRow(t(labelKey), h('input', {
    attrs: { id, type: 'number', min, max },
    props: { value: String(value) },
  }), { htmlFor: id });
}

/** ONL-003: Settings → Sync. Pure model + pure view; actions stay injected. */
function syncPanel(ctrl: SettingsCtrl): VNode {
  const deps = ctrl.sync;
  const model = buildSyncPanelModel({
    config: deps.config,
    state: deps.state,
    pendingCount: deps.pendingCount,
    paused: deps.paused,
    busy: deps.busy,
    message: deps.message,
  });
  return viewSyncPanel(model, deps.actions);
}

function prefsPanel(ctrl: SettingsCtrl): VNode {
  const c = ctrl.curated;
  return panel(t('settings.prefs.title'), [
    h('p', t('settings.prefs.body')),
    formRow(
      t('settings.prefs.failurePreset'),
      h(
        'select',
        { attrs: { id: 'set-failure' }, props: { value: c.failurePreset } },
        FAILURE_PRESETS.map((preset) =>
          h(
            'option',
            { props: { value: preset, selected: preset === c.failurePreset } },
            failurePresetLabel(preset),
          ),
        ),
      ),
      { htmlFor: 'set-failure' },
    ),
    numberField(ctrl, 'set-step-back', 'settings.prefs.stepBack', c.stepBackAmount, 1, 10),
    numberField(ctrl, 'set-retry-retain', 'settings.prefs.retryRetain', c.retryRetainAmount, 0, 10),
    numberField(
      ctrl,
      'set-new-per-day',
      'settings.prefs.newPerDay',
      c.newIntroductionLimitPerDay,
      0,
      999,
    ),
    numberField(ctrl, 'set-relearning', 'settings.prefs.relearning', c.relearningMinutes, 1, 1440),
    checkboxRow(t('settings.prefs.timing'), { id: 'set-timing', checked: c.timingEnabled }),
  ], [
    actionButton(t('settings.prefs.save'), 'primary', {
      compact: true,
      id: 'settings-save-prefs',
      onClick: () => onSaveClick(ctrl),
    }),
  ]);
}

function boardThemePanel(): VNode {
  const theme = getSavedBoardTheme();
  return panel('Board appearance', [
    formRow(
      'Board square colors',
      h('select', {
        attrs: { id: 'settings-board-theme' },
        props: { value: theme },
        on: { change: (event: Event) => saveBoardTheme((event.target as HTMLSelectElement).value) },
      }, BOARD_THEMES.map((name) => h('option', { props: { value: name, selected: name === theme } },
        name[0]!.toUpperCase() + name.slice(1))),
      ),
      { htmlFor: 'settings-board-theme' },
    ),
  ]);
}

function pendingPreview(ctrl: SettingsCtrl, pending: PendingImport): VNode {
  const s = pending.summary;
  const date = new Date(s.exportedAt).toLocaleString();
  return h('div.panel', [
    h('p', t('settings.data.importSummary', {
      date,
      total: s.total,
      content: s.counts.content ?? 0,
      schedules: s.counts.schedules ?? 0,
      attempts: s.counts.attempts ?? 0,
    })),
    h('div.button-row', [
      actionButton(t('settings.data.confirm'), 'primary', {
        compact: true,
        id: 'settings-import-confirm',
        onClick: () => void ctrl.confirmImport(),
      }),
      actionButton(t('settings.data.cancel'), 'secondary', {
        compact: true,
        id: 'settings-import-cancel',
        onClick: () => ctrl.cancelImport(),
      }),
    ]),
  ]);
}

function backupsBody(ctrl: SettingsCtrl): VNode | VNode[] {
  if (ctrl.backups.length === 0) return emptyState(t('settings.data.noBackups'));
  return ctrl.backups.map((label) =>
    h('div.flex-row', [
      h('span', label),
      // Raw vnode: `actionButton` has no `data-*` attr passthrough, so the
      // restore hook id stays expressed here (same classes/strings in the DOM).
      h('button.button.compact', {
        attrs: { type: 'button', 'data-restore': label },
        on: { click: () => void ctrl.restoreBackup(label) },
      }, t('settings.data.restore')),
    ]),
  );
}

/**
 * APP-001: install + offline status. Read-only except the install action.
 * Makes the "download it once, play offline" promise visible: whether the app
 * is installed, whether every asset needed to train offline is cached, and how
 * much storage is in use.
 */
function pwaPanel(ctrl: SettingsCtrl): VNode {
  const pwa = ctrl.pwa;
  const body: VNode[] = [];
  const actions: VNode[] = [];

  if (pwa === null) {
    body.push(h('p.progress-note', 'Checking install and offline status…'));
  } else {
    body.push(
      h(
        'p#pwa-installed-state',
        { attrs: { 'data-pwa-installed': String(pwa.installed) } },
        pwa.installed
          ? 'Installed as an app on this device.'
          : pwa.ios
            ? 'On iPhone/iPad: Share → Add to Home Screen to install.'
            : 'Open the browser menu and choose “Install app” (or “Add to Home screen”).',
      ),
    );
    body.push(
      h(
        'p#pwa-offline-state',
        pwa.offlineReady
          ? 'Offline ready — the app and all bundled puzzles are saved on this device.'
          : `Not ready offline yet (${pwa.missing.length} file${pwa.missing.length === 1 ? '' : 's'} missing). Open the app once while online to finish downloading.`,
      ),
    );
    const usage = formatBytes(pwa.usageBytes);
    const quota = formatBytes(pwa.quotaBytes);
    body.push(
      h(
        'p#pwa-storage',
        pwa.usageBytes === undefined
          ? 'Storage used: —'
          : `Storage used: ${usage}${pwa.quotaBytes === undefined ? '' : ` of ${quota} available`}${pwa.persisted ? ' · marked persistent' : ''}`,
      ),
    );
    body.push(
      h(
        'p.progress-note',
        'Training data lives in this browser only (IndexedDB); installing or updating the app never clears it. Export a backup from Data safety before clearing site data.',
      ),
    );
    if (pwa.canInstall) {
      actions.push(
        actionButton('Install app', 'primary', {
          compact: true,
          id: 'pwa-install',
          onClick: () => void ctrl.install(),
        }),
      );
    }
  }
  return panel('App & offline', body, actions);
}

/**
 * Pure view: same information and same strings as the pre-Snabbdom template
 * (prefs form, export summary, import preview/confirm, backup list, message),
 * composed from the S1 `panel`/`formRow`/`statusLine`/`emptyState`
 * primitives. Snabbdom sets copy as text, so no manual HTML escaping is
 * needed. Control ids match the previous template (smoke + CSS hooks).
 */
export function view(ctrl: SettingsCtrl): VNode {
  return h('div.settings-screen', [
    h('h2', t('screen.settings.title')),
    boardThemePanel(),
    pwaPanel(ctrl),
    syncPanel(ctrl),
    prefsPanel(ctrl),
    panel(t('settings.data.title'), [
      h('p', t('settings.data.body')),
      ...(ctrl.summary ? [h('p', countsLine(ctrl.summary))] : []),
    ], [
      actionButton(t('settings.data.export'), 'primary', {
        compact: true,
        id: 'settings-export',
        onClick: () => onExportClick(ctrl),
      }),
    ]),
    panel(t('settings.data.import'), [
      h('div.flex-row', [
        h('input', {
          attrs: { type: 'file', id: 'settings-import-file', accept: '.json,application/json' },
        }),
        actionButton(t('settings.data.previewButton'), 'primary', {
          compact: true,
          id: 'settings-import-preview',
          onClick: () => onPreviewClick(ctrl),
        }),
      ]),
      ...(ctrl.pending ? [pendingPreview(ctrl, ctrl.pending)] : []),
    ]),
    panel(t('settings.data.backups'), backupsBody(ctrl)),
    h('div', { attrs: { id: 'settings-message' } }, [
      ...(ctrl.message
        ? [statusLine(ctrl.message.text, ctrl.message.kind === 'error' ? 'wrong' : 'correct')]
        : []),
    ]),
  ]);
}

export class SettingsView implements Screen {
  readonly id = 'settings' as const;

  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private ctrl: SettingsCtrl | null = null;
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
    const ctrl = new SettingsCtrl(
      this.ctx.service,
      this.ctx.adapter,
      undefined,
      this.ctx.syncAuthNotice ? { message: this.ctx.syncAuthNotice } : {},
    );
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
    // APP-001: install/offline state is async and non-essential — load it after
    // the first paint and let the guarded redraw update just this panel.
    void ctrl.loadPwa();
    // ONL-009b: resolve the lazy sync runtime after first paint. A default build
    // resolves to `undefined` (no fetch), leaving the panel untouched.
    this.loadSync(ctrl);
    // The patch replaces the placeholder; track the live root so unmount
    // removes exactly what snabbdom inserted.
    this.root = this.vnode.elm as HTMLElement;
  }

  /**
   * Lazily resolve the app's sync runtime and, when one is available, hand it to
   * the controller. Failures are swallowed: sync wiring is an enhancement and
   * must never break the Settings screen (or boot).
   */
  private loadSync(ctrl: SettingsCtrl): void {
    const factory = this.ctx.sync;
    if (!factory) return;
    void factory()
      .then((runtime) => {
        if (!runtime || this.ctrl !== ctrl) return undefined;
        return ctrl.attachSync(runtime, {
          ...(this.ctx.syncBeginAuth ? { begin: this.ctx.syncBeginAuth } : {}),
        });
      })
      .catch(() => {
        // No sync runtime or a transient failure: keep the inert panel.
      });
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
