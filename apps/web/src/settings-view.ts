/**
 * Settings screen (PB4/PB5). Currently hosts Data safety: full export, a
 * preview-then-confirm import, and one-click restore of recovery snapshots.
 * Scheduler preferences arrive in the next build step on this same screen.
 */

import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import type { Screen } from './router.ts';
import { DEFAULT_COLLECTION_ID, DEFAULT_PROGRAM_ID } from './scheduler-service.ts';
import {
  CURATED_DEFAULTS,
  FAILURE_PRESETS,
  failurePresetLabel,
  parseCurated,
  type CuratedSettings,
} from './settings-preferences.ts';
import { parseExport, summarizeExport } from './storage/data-port.ts';
import type { StoreExport, StoreExportSummary } from './storage/local-store.ts';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

export class SettingsView implements Screen {
  readonly id = 'settings' as const;

  private host: HTMLElement | null = null;
  private message: Message | null = null;
  private summary: StoreExportSummary | null = null;
  private backups: string[] = [];
  private pending: PendingImport | null = null;
  private curated: CuratedSettings = CURATED_DEFAULTS;
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
    this.summary = await this.ctx.service.exportStoreSummary();
    this.backups = await this.ctx.service.listBackups();
    this.curated = this.ctx.service.getCuratedSettings();
    this.host.innerHTML = this.template();
    this.bind();
  }

  private preferencesHtml(): string {
    const c = this.curated;
    const options = FAILURE_PRESETS.map(
      (preset) =>
        `<option value="${preset}" ${preset === c.failurePreset ? 'selected' : ''}>${escapeHtml(
          failurePresetLabel(preset),
        )}</option>`,
    ).join('');
    return `
      <section class="panel">
        <h3>${t('settings.prefs.title')}</h3>
        <p>${t('settings.prefs.body')}</p>
        <div class="field">
          <label for="set-failure">${t('settings.prefs.failurePreset')}</label>
          <select id="set-failure">${options}</select>
        </div>
        <div class="field">
          <label for="set-step-back">${t('settings.prefs.stepBack')}</label>
          <input id="set-step-back" type="number" min="1" max="10" value="${c.stepBackAmount}" />
        </div>
        <div class="field">
          <label for="set-retry-retain">${t('settings.prefs.retryRetain')}</label>
          <input id="set-retry-retain" type="number" min="0" max="10" value="${c.retryRetainAmount}" />
        </div>
        <div class="field">
          <label for="set-new-per-day">${t('settings.prefs.newPerDay')}</label>
          <input id="set-new-per-day" type="number" min="0" max="999" value="${c.newIntroductionLimitPerDay}" />
        </div>
        <div class="field">
          <label for="set-relearning">${t('settings.prefs.relearning')}</label>
          <input id="set-relearning" type="number" min="1" max="1440" value="${c.relearningMinutes}" />
        </div>
        <div class="field checkbox">
          <label><input id="set-timing" type="checkbox" ${c.timingEnabled ? 'checked' : ''} /> ${t(
            'settings.prefs.timing',
          )}</label>
        </div>
        <div class="button-row">
          <button type="button" class="button compact" id="settings-save-prefs">${t('settings.prefs.save')}</button>
        </div>
      </section>
    `;
  }

  private countsLine(summary: StoreExportSummary): string {
    return t('settings.data.current', {
      total: summary.total,
      content: summary.counts.content ?? 0,
      schedules: summary.counts.schedules ?? 0,
      attempts: summary.counts.attempts ?? 0,
    });
  }

  private template(): string {
    const summary = this.summary;
    const message = this.message
      ? `<p class="${this.message.kind === 'error' ? 'error' : 'ok'}">${escapeHtml(this.message.text)}</p>`
      : '';
    const backups =
      this.backups.length === 0
        ? `<p>${t('settings.data.noBackups')}</p>`
        : this.backups
            .map(
              (label) =>
                `<div class="flex-row"><span>${escapeHtml(label)}</span><button type="button" class="button compact" data-restore="${escapeHtml(
                  label,
                )}">${t('settings.data.restore')}</button></div>`,
            )
            .join('');

    return `
      <h2>${t('screen.settings.title')}</h2>
      ${this.preferencesHtml()}
      <section class="panel">
        <h3>${t('settings.data.title')}</h3>
        <p>${t('settings.data.body')}</p>
        ${summary ? `<p>${escapeHtml(this.countsLine(summary))}</p>` : ''}
        <div class="button-row">
          <button type="button" class="button compact" id="settings-export">${t('settings.data.export')}</button>
        </div>
      </section>
      <section class="panel">
        <h3>${t('settings.data.import')}</h3>
        <div class="flex-row">
          <input type="file" id="settings-import-file" accept=".json,application/json" />
          <button type="button" class="button compact" id="settings-import-preview">${t('settings.data.previewButton')}</button>
        </div>
        ${this.pending ? this.pendingHtml(this.pending) : ''}
      </section>
      <section class="panel">
        <h3>${t('settings.data.backups')}</h3>
        ${backups}
      </section>
      <div id="settings-message">${message}</div>
    `;
  }

  private pendingHtml(pending: PendingImport): string {
    const s = pending.summary;
    const date = new Date(s.exportedAt).toLocaleString();
    return `
      <div class="panel">
        <p>${escapeHtml(
          t('settings.data.importSummary', {
            date,
            total: s.total,
            content: s.counts.content ?? 0,
            schedules: s.counts.schedules ?? 0,
            attempts: s.counts.attempts ?? 0,
          }),
        )}</p>
        <div class="button-row">
          <button type="button" class="button compact" id="settings-import-confirm">${t('settings.data.confirm')}</button>
          <button type="button" class="button button-secondary compact" id="settings-import-cancel">${t('settings.data.cancel')}</button>
        </div>
      </div>
    `;
  }

  private bind(): void {
    document
      .getElementById('settings-save-prefs')
      ?.addEventListener('click', () => void this.onSavePreferences());
    document
      .getElementById('settings-export')
      ?.addEventListener('click', () => void this.onExport());
    document
      .getElementById('settings-import-preview')
      ?.addEventListener('click', () => void this.onPreviewImport());
    document
      .getElementById('settings-import-confirm')
      ?.addEventListener('click', () => void this.onConfirmImport());
    document
      .getElementById('settings-import-cancel')
      ?.addEventListener('click', () => {
        this.pending = null;
        void this.render();
      });
    document.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((button) => {
      button.addEventListener('click', () => void this.onRestore(button.dataset.restore!));
    });
  }

  private async onSavePreferences(): Promise<void> {
    const number = (id: string, fallback: number): number => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      const value = input ? Number(input.value) : NaN;
      return Number.isFinite(value) ? value : fallback;
    };
    const preset = (document.getElementById('set-failure') as HTMLSelectElement | null)?.value;
    const curated = parseCurated({
      failurePreset: preset,
      stepBackAmount: number('set-step-back', CURATED_DEFAULTS.stepBackAmount),
      retryRetainAmount: number('set-retry-retain', CURATED_DEFAULTS.retryRetainAmount),
      newIntroductionLimitPerDay: number(
        'set-new-per-day',
        CURATED_DEFAULTS.newIntroductionLimitPerDay,
      ),
      relearningMinutes: number('set-relearning', CURATED_DEFAULTS.relearningMinutes),
      timingEnabled: (document.getElementById('set-timing') as HTMLInputElement | null)?.checked,
    });
    this.curated = await this.ctx.service.applyCuratedSettings(curated);
    this.message = { kind: 'ok', text: t('settings.prefs.saved') };
    await this.render();
  }

  private async onExport(): Promise<void> {
    const exported = await this.ctx.service.exportStore();
    downloadJson(`chessreps-export-${timestamp()}.json`, JSON.stringify(exported));
    this.message = {
      kind: 'ok',
      text: t('settings.data.exported', { total: summarizeExport(exported).total }),
    };
    await this.render();
  }

  private async onPreviewImport(): Promise<void> {
    const input = document.getElementById('settings-import-file') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      this.message = { kind: 'error', text: t('settings.data.invalid') };
      await this.render();
      return;
    }
    const parsed = parseExport(await file.text());
    if (!parsed.ok) {
      this.message = { kind: 'error', text: t('settings.data.importError', { error: parsed.errors.join('; ') }) };
      this.pending = null;
      await this.render();
      return;
    }
    this.pending = { data: parsed.data, summary: summarizeExport(parsed.data) };
    this.message = null;
    await this.render();
  }

  private async onConfirmImport(): Promise<void> {
    if (!this.pending) return;
    const label = `pre-import-${timestamp()}`;
    const summary = await this.ctx.service.importStore(this.pending.data, label);
    this.pending = null;
    await this.ctx.adapter.reloadAfterDataChange(DEFAULT_PROGRAM_ID, DEFAULT_COLLECTION_ID);
    this.message = { kind: 'ok', text: t('settings.data.imported', { total: summary.total, label }) };
    await this.render();
  }

  private async onRestore(label: string): Promise<void> {
    const summary = await this.ctx.service.restoreBackup(label);
    if (!summary) {
      this.message = { kind: 'error', text: t('settings.data.restoreMissing') };
      await this.render();
      return;
    }
    await this.ctx.adapter.reloadAfterDataChange(DEFAULT_PROGRAM_ID, DEFAULT_COLLECTION_ID);
    this.message = { kind: 'ok', text: t('settings.data.restored', { label }) };
    await this.render();
  }
}
