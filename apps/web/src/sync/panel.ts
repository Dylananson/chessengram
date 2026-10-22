/**
 * ONL-003 — Settings → Sync panel (pure model + view).
 *
 * Sync is an **opt-in add-on**: with no `VITE_SYNC_*` values the panel reports
 * `local-only` + "not configured" and the app makes no network calls. This
 * module therefore does no I/O, touches no storage and never imports a
 * transport: the caller injects a {@link SyncPanelActions} bag, and ONL-009 can
 * wire the real enable/sync/sign-out flows without rewriting the view.
 *
 * `h` comes from the DOM-free `snabbdom/build/h.js` subpath (never the package
 * root, which touches `window` at load), so this file is Node-importable.
 */

import { h } from 'snabbdom/build/h.js';
import type { VNode, VNodeData } from 'snabbdom/build/vnode.js';
import type { SyncMode, SyncState } from './types.ts';

/** Build-time sync configuration (all fields optional; absent ⇒ not configured). */
export interface SyncPanelConfig {
  apiBase?: string;
  authAuthority?: string;
  authClientId?: string;
  authRedirectUri?: string;
}

/** Read one `VITE_SYNC_*` value defensively from an env-like object. */
function readEnv(envLike: Record<string, unknown> | undefined, key: string): string | undefined {
  if (envLike === null || typeof envLike !== 'object') return undefined;
  const raw = envLike[key];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/**
 * Parse the build-time config from `import.meta.env` (or any plain object).
 * Missing, blank and non-string values become `undefined`, so an unconfigured
 * build stays fully local.
 */
export function parseSyncConfig(envLike: Record<string, unknown> | undefined): SyncPanelConfig {
  return {
    apiBase: readEnv(envLike, 'VITE_SYNC_API_BASE'),
    authAuthority: readEnv(envLike, 'VITE_SYNC_AUTH_AUTHORITY'),
    authClientId: readEnv(envLike, 'VITE_SYNC_AUTH_CLIENT_ID'),
    authRedirectUri: readEnv(envLike, 'VITE_SYNC_AUTH_REDIRECT_URI'),
  };
}

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * True only when the API base and both auth values are present. The redirect
 * URI is optional (the auth client can use its registered default).
 */
export function isConfigured(config: SyncPanelConfig): boolean {
  return hasText(config.apiBase) && hasText(config.authAuthority) && hasText(config.authClientId);
}

export interface SyncPanelMessage {
  tone: 'ok' | 'error';
  text: string;
}

/** Everything the pure view renders. No stores, no clients, no key material. */
export interface SyncPanelModel {
  mode: SyncMode;
  configured: boolean;
  deviceId?: string;
  lastSyncedAt?: number;
  /** Human-readable age for `lastSyncedAt`, derived from the injected `now`. */
  lastSyncedText?: string;
  pendingCount: number;
  busy?: boolean;
  message?: SyncPanelMessage;
}

export interface BuildSyncPanelModelInput {
  config: SyncPanelConfig;
  state?: SyncState;
  pendingCount?: number;
  /** Injected clock for a deterministic "last synced" label. */
  now?: number;
  /** Hint from the sync engine: session expired, offline, or no key on this device yet. */
  paused?: boolean;
  busy?: boolean;
  message?: SyncPanelMessage;
}

function lastSyncedText(lastSyncedAt: number | undefined, now: number): string | undefined {
  if (lastSyncedAt === undefined || !Number.isFinite(lastSyncedAt)) return undefined;
  const elapsed = Math.max(0, now - lastSyncedAt);
  const minute = 60_000;
  if (elapsed < minute) return 'just now';
  if (elapsed < 60 * minute) return `${Math.floor(elapsed / minute)} min ago`;
  if (elapsed < 48 * 60 * minute) return `${Math.floor(elapsed / (60 * minute))} h ago`;
  return new Date(lastSyncedAt).toISOString().slice(0, 10);
}

/**
 * Map persisted {@link SyncState} onto the three user-visible modes:
 * `local-only` (not enabled), `paused` (the engine signalled offline/expired,
 * or this device has no signing key yet) and `syncing`.
 */
export function buildSyncPanelModel(input: BuildSyncPanelModelInput): SyncPanelModel {
  const state = input.state;
  const enabled = state?.enabled === true;
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();

  let mode: SyncMode = 'local-only';
  if (enabled) mode = input.paused === true ? 'paused' : 'syncing';

  const rawPending = input.pendingCount;
  const pendingCount =
    typeof rawPending === 'number' && Number.isFinite(rawPending) && rawPending > 0
      ? Math.floor(rawPending)
      : 0;

  const syncedText = lastSyncedText(state?.lastSyncedAt, now);
  return {
    mode,
    configured: isConfigured(input.config),
    ...(state?.deviceId !== undefined ? { deviceId: state.deviceId } : {}),
    ...(state?.lastSyncedAt !== undefined ? { lastSyncedAt: state.lastSyncedAt } : {}),
    ...(syncedText !== undefined ? { lastSyncedText: syncedText } : {}),
    pendingCount,
    ...(input.busy === true ? { busy: true } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
  };
}

/** Every side effect is injected; the view never calls a transport or clipboard directly. */
export interface SyncPanelActions {
  enable: () => void;
  syncNow: () => void;
  signOut: () => void;
  disable: () => void;
  deleteServerCopy: () => void;
}

const MODE_LABELS: Record<SyncMode, string> = {
  'local-only': 'Local only',
  syncing: 'Syncing',
  paused: 'Paused',
};

function statusText(model: SyncPanelModel): string {
  const base = (() => {
    switch (model.mode) {
      case 'syncing':
        return 'Syncs automatically — changes follow you across devices, and training keeps working offline.';
      case 'paused':
        return 'Sync is paused (offline or signed out). Queued changes send themselves as soon as it can resume.';
      case 'local-only':
      default:
        return model.configured
          ? 'Training stays on this device. Enable sync only if you want your progress on another device.'
          : 'Sync is not configured in this build. Training stays on this device.';
    }
  })();
  return model.lastSyncedText ? `${base} Last synced ${model.lastSyncedText}.` : base;
}

function pendingText(count: number): string {
  if (count === 0) return 'Nothing waiting to sync.';
  return `${count} change${count === 1 ? '' : 's'} waiting to sync — they will go out on their own.`;
}

interface ButtonOptions {
  variant?: 'primary' | 'secondary' | 'tertiary';
  disabled?: boolean;
  onClick?: () => void;
}

function panelButton(label: string, id: string, options: ButtonOptions = {}): VNode {
  const variant = options.variant ?? 'primary';
  const sel =
    variant === 'primary'
      ? 'button.button'
      : variant === 'secondary'
        ? 'button.button.button-secondary'
        : 'button.button.button-tertiary';
  const data: VNodeData = { attrs: { type: 'button', id } };
  if (options.disabled === true) {
    (data.attrs as Record<string, string | number | boolean>).disabled = true;
  } else if (options.onClick !== undefined) {
    data.on = { click: options.onClick };
  }
  return h(sel, data, label);
}

/**
 * Pure view: `section.panel.sync-panel` with smoke hooks (`#sync-mode`,
 * `#sync-status`, `#sync-pending`, `#sync-storage-note`, `#sync-enable`,
 * `#sync-now`). Actions are passed straight through.
 */
export function viewSyncPanel(model: SyncPanelModel, actions: SyncPanelActions): VNode {
  const children: Array<VNode | string> = [
    h('h3', 'Sync'),
    h('p', [
      h(
        'strong',
        { attrs: { id: 'sync-mode', 'data-sync-mode': model.mode } },
        MODE_LABELS[model.mode],
      ),
    ]),
    h('p', { attrs: { id: 'sync-status' } }, statusText(model)),
    h('p', { attrs: { id: 'sync-pending' } }, pendingText(model.pendingCount)),
  ];

  if (!model.configured) {
    children.push(
      h(
        'p.sync-not-configured',
        'Sync is not configured in this build. Your training stays on this device — no account, no server, no uploads.',
      ),
    );
  }

  children.push(
    h(
      'p.progress-note',
      { attrs: { id: 'sync-storage-note' } },
      'Training data stays on this device until you enable sync. Disabling sync never deletes local training data.',
    ),
  );

  if (model.message !== undefined) {
    children.push(
      h(
        'p.sync-message',
        { class: { ok: model.message.tone === 'ok', error: model.message.tone === 'error' } },
        model.message.text,
      ),
    );
  }

  const buttons: VNode[] = [];
  if (model.mode === 'local-only') {
    // Rendered (and visibly disabled) even when unconfigured, so the promise is
    // honest instead of hiding the feature. No click handler while disabled.
    const available = model.configured && model.busy !== true;
    buttons.push(
      panelButton('Enable sync', 'sync-enable', {
        disabled: !available,
        onClick: actions.enable,
      }),
    );
  } else {
    buttons.push(
      panelButton('Sync now', 'sync-now', {
        disabled: model.busy === true,
        onClick: actions.syncNow,
      }),
    );
    buttons.push(
      panelButton('Sign out', 'sync-sign-out', {
        variant: 'secondary',
        disabled: model.busy === true,
        onClick: actions.signOut,
      }),
    );
    buttons.push(
      panelButton('Disable sync', 'sync-disable', {
        variant: 'secondary',
        disabled: model.busy === true,
        onClick: actions.disable,
      }),
    );
    // Signed in (enabled): offer the separate, explicit server-copy deletion.
    buttons.push(
      panelButton('Delete server copy', 'sync-delete-server-copy', {
        variant: 'tertiary',
        disabled: model.busy === true,
        onClick: actions.deleteServerCopy,
      }),
    );
  }
  children.push(h('div.sync-actions.button-row', buttons));

  if (model.mode !== 'local-only') {
    // UX-008: "Sync now" reads like the only way to sync, which is not true —
    // sync runs automatically (10 s debounce + online/visibility flushes).
    children.push(
      h(
        'p.progress-note',
        { attrs: { id: 'sync-auto-note' } },
        'Sync runs automatically, so you never have to press Sync now — use it only when you want a change pushed immediately.',
      ),
    );
  }

  if (model.mode !== 'local-only') {
    children.push(
      h(
        'p.progress-note.sync-warning',
        'Delete server copy erases the copy stored on the server. Training data on this device is never deleted.',
      ),
    );
  }

  return h('section.panel.sync-panel', children);
}
