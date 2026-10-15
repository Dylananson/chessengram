/**
 * Collections screen (B4, user decision 2026-10-15): real static puzzle sets
 * with multi-membership. Lists every collection with membership and due
 * counts, and supports create/rename/delete plus adding/removing puzzle
 * references. One puzzle may live in many collections; schedule progress is
 * per-collection (the same puzzle trains independently in each collection).
 *
 * Deleting a collection removes its membership list and its scoped derived
 * schedules; puzzles, other collections' schedules and all raw attempt
 * history are kept. The default collection cannot be deleted. The
 * active-collection picker lives on the Train screen; this screen only shows
 * which collection is active. Strictly membership management: no grading, no
 * attempt writes.
 */

import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import type { Screen } from './router.ts';
import { DEFAULT_COLLECTION_ID, DEFAULT_PROGRAM_ID } from './scheduler-service.ts';

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

export class CollectionsView implements Screen {
  readonly id = 'collections' as const;

  private readonly ctx: AppContext;
  private host: HTMLElement | null = null;
  private message: Message | null = null;
  private renamingId: string | null = null;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  mount(host: HTMLElement): void {
    this.host = host;
    this.render();
  }

  unmount(): void {
    this.host = null;
  }

  private render(): void {
    if (!this.host) return;
    const service = this.ctx.service;
    const activeId = service.getActiveCollectionId();
    const cards = service
      .listCollections()
      .map((collection) => {
        const summary = service.queueSummary(DEFAULT_PROGRAM_ID, collection.id);
        const isDefault = collection.id === DEFAULT_COLLECTION_ID;
        const isActive = collection.id === activeId;
        const badges = [
          isDefault ? `<span class="badge">${escapeHtml(t('collections.badge.default'))}</span>` : '',
          isActive ? `<span class="badge">${escapeHtml(t('collections.badge.active'))}</span>` : '',
        ].join(' ');
        const nameRow =
          this.renamingId === collection.id
            ? `<input id="rename-${escapeHtml(collection.id)}" value="${escapeHtml(collection.name)}" />`
            : `<strong>${escapeHtml(collection.name)}</strong>`;
        const members =
          collection.puzzleIds.length > 0
            ? `<ul class="member-list">${collection.puzzleIds
                .map(
                  (puzzleId) =>
                    `<li>${escapeHtml(puzzleId)} <button type="button" data-unmember="${escapeHtml(collection.id)}" data-puzzle="${escapeHtml(puzzleId)}">${escapeHtml(t('collections.member.remove'))}</button></li>`,
                )
                .join('')}</ul>`
            : `<p class="muted">${escapeHtml(t('collections.members.empty'))}</p>`;
        return `<div class="panel" data-collection="${escapeHtml(collection.id)}">
          <h3>${nameRow} ${badges}</h3>
          <p>${escapeHtml(t('collections.summary', { members: summary.total, due: summary.due, learned: summary.learned }))}</p>
          <div class="button-row">
            <button type="button" data-rename="${escapeHtml(collection.id)}">${escapeHtml(this.renamingId === collection.id ? t('collections.rename.save') : t('collections.rename.start'))}</button>
            <button type="button" data-delete="${escapeHtml(collection.id)}" ${isDefault ? 'disabled' : ''}>${escapeHtml(t('collections.delete'))}</button>
          </div>
          ${members}
          <div class="flex-row">
            <input id="add-${escapeHtml(collection.id)}" placeholder="${escapeHtml(t('collections.member.add.placeholder'))}" />
            <button type="button" class="button compact" data-add="${escapeHtml(collection.id)}">${escapeHtml(t('collections.member.add'))}</button>
          </div>
        </div>`;
      })
      .join('');

    this.host.innerHTML = `
      <div class="panel">
        <h3>${escapeHtml(t('collections.title'))}</h3>
        <p>${escapeHtml(t('collections.subtitle'))}</p>
        <div class="flex-row">
          <input id="collections-new-name" placeholder="${escapeHtml(t('collections.create.placeholder'))}" />
          <button type="button" class="button compact" id="collections-create">${escapeHtml(t('collections.create'))}</button>
        </div>
        ${this.message ? `<p class="${this.message.kind}">${escapeHtml(this.message.text)}</p>` : ''}
      </div>
      ${cards || `<div class="panel"><p class="muted">${escapeHtml(t('collections.list.empty'))}</p></div>`}`;
    this.bind();
  }

  private bind(): void {
    const host = this.host!;
    // Plain `{ innerHTML }` stub hosts (node tests) have no selectors.
    if (typeof host.querySelector !== 'function') return;
    host.querySelector('#collections-create')?.addEventListener('click', () => void this.onCreate());
    host.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach((button) => {
      button.addEventListener('click', () => void this.onDelete(button.dataset.delete!));
    });
    host.querySelectorAll<HTMLButtonElement>('[data-rename]').forEach((button) => {
      button.addEventListener('click', () => void this.onRename(button.dataset.rename!));
    });
    host.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((button) => {
      button.addEventListener('click', () => void this.onAdd(button.dataset.add!));
    });
    host.querySelectorAll<HTMLButtonElement>('[data-unmember]').forEach((button) => {
      button.addEventListener('click', () =>
        void this.onRemove(button.dataset.unmember!, button.dataset.puzzle!),
      );
    });
  }

  private async onCreate(): Promise<void> {
    const input = this.host!.querySelector<HTMLInputElement>('#collections-new-name');
    try {
      const created = await this.ctx.service.createCollection(input?.value ?? '');
      this.message = { kind: 'ok', text: t('collections.created', { name: created.name }) };
    } catch (error) {
      this.message = { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    }
    this.render();
  }

  private async onRename(collectionId: string): Promise<void> {
    if (this.renamingId !== collectionId) {
      this.renamingId = collectionId;
      this.message = null;
      this.render();
      return;
    }
    const input = this.host!.querySelector<HTMLInputElement>(`#rename-${CSS.escape(collectionId)}`);
    try {
      await this.ctx.service.renameCollection(collectionId, input?.value ?? '');
      this.renamingId = null;
      this.message = { kind: 'ok', text: t('collections.renamed') };
    } catch (error) {
      this.message = { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    }
    this.render();
  }

  private async onDelete(collectionId: string): Promise<void> {
    try {
      await this.ctx.service.deleteCollection(collectionId);
      if (this.renamingId === collectionId) this.renamingId = null;
      this.message = { kind: 'ok', text: t('collections.deleted') };
    } catch (error) {
      this.message = { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    }
    this.render();
  }

  private async onAdd(collectionId: string): Promise<void> {
    const input = this.host!.querySelector<HTMLInputElement>(`#add-${CSS.escape(collectionId)}`);
    const puzzleId = (input?.value ?? '').trim();
    if (!puzzleId) return;
    try {
      await this.ctx.service.addPuzzleToCollection(collectionId, puzzleId);
      this.message = { kind: 'ok', text: t('collections.member.added', { id: puzzleId }) };
    } catch (error) {
      this.message = { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    }
    this.render();
  }

  private async onRemove(collectionId: string, puzzleId: string): Promise<void> {
    await this.ctx.service.removePuzzleFromCollection(collectionId, puzzleId);
    this.message = { kind: 'ok', text: t('collections.member.removed', { id: puzzleId }) };
    this.render();
  }
}
