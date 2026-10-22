import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { VNode } from 'snabbdom/build/vnode.js';
import {
  buildSyncPanelModel,
  isConfigured,
  parseSyncConfig,
  viewSyncPanel,
  type SyncPanelActions,
  type SyncPanelConfig,
} from '../src/sync/panel.ts';
import type { SyncState } from '../src/sync/types.ts';

const FULL_ENV = {
  VITE_SYNC_API_BASE: 'https://sync.example.test',
  VITE_SYNC_AUTH_AUTHORITY: 'https://auth.example.test',
  VITE_SYNC_AUTH_CLIENT_ID: 'client-123',
  VITE_SYNC_AUTH_REDIRECT_URI: 'https://app.example.test/sync/callback',
};

const CONFIGURED: SyncPanelConfig = {
  apiBase: 'https://sync.example.test',
  authAuthority: 'https://auth.example.test',
  authClientId: 'client-123',
};

/** Actions that record every call: proves the view only calls the injected bag. */
function recordingActions(): { actions: SyncPanelActions; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      enable: () => calls.push('enable'),
      syncNow: () => calls.push('syncNow'),
      signOut: () => calls.push('signOut'),
      disable: () => calls.push('disable'),
      deleteServerCopy: () => calls.push('deleteServerCopy'),
    },
  };
}

function collectText(node: VNode | string | null | undefined): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  const out: string[] = [];
  if (typeof node.text === 'string') out.push(node.text);
  for (const child of node.children ?? []) out.push(...collectText(child as VNode | string));
  return out;
}

function findById(
  node: VNode | string | null | undefined,
  id: string,
): VNode | null {
  if (node === null || node === undefined || typeof node === 'string') return null;
  if ((node.data?.attrs as Record<string, unknown> | undefined)?.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findById(child as VNode | string, id);
    if (found) return found;
  }
  return null;
}

function hasSelector(node: VNode | string | null | undefined, match: (sel: string) => boolean): boolean {
  if (node === null || node === undefined || typeof node === 'string') return false;
  if (typeof node.sel === 'string' && match(node.sel)) return true;
  return (node.children ?? []).some((child) => hasSelector(child as VNode | string, match));
}

function clickListener(node: VNode): ((ev: unknown, vnode: VNode) => void) | undefined {
  const on = node.data?.on as Record<string, (ev: unknown, vnode: VNode) => void> | undefined;
  return on?.click;
}

// --- config parsing ---

test('parseSyncConfig reads every VITE_SYNC_* value', () => {
  assert.deepEqual(parseSyncConfig(FULL_ENV), {
    apiBase: FULL_ENV.VITE_SYNC_API_BASE,
    authAuthority: FULL_ENV.VITE_SYNC_AUTH_AUTHORITY,
    authClientId: FULL_ENV.VITE_SYNC_AUTH_CLIENT_ID,
    authRedirectUri: FULL_ENV.VITE_SYNC_AUTH_REDIRECT_URI,
  });
});

test('parseSyncConfig keeps only the present values for a partial env', () => {
  const parsed = parseSyncConfig({ VITE_SYNC_API_BASE: ' https://sync.example.test ' });
  assert.deepEqual(parsed, {
    apiBase: 'https://sync.example.test',
    authAuthority: undefined,
    authClientId: undefined,
    authRedirectUri: undefined,
  });
});

test('parseSyncConfig is safe when import.meta.env is undefined under Node', () => {
  assert.deepEqual(parseSyncConfig(undefined), {
    apiBase: undefined,
    authAuthority: undefined,
    authClientId: undefined,
    authRedirectUri: undefined,
  });
});

test('parseSyncConfig ignores blank and non-string values', () => {
  assert.deepEqual(
    parseSyncConfig({ VITE_SYNC_API_BASE: '   ', VITE_SYNC_AUTH_CLIENT_ID: 42 }),
    {
      apiBase: undefined,
      authAuthority: undefined,
      authClientId: undefined,
      authRedirectUri: undefined,
    },
  );
});

test('isConfigured requires apiBase, authAuthority and authClientId', () => {
  assert.equal(isConfigured(CONFIGURED), true);
  assert.equal(isConfigured({ ...CONFIGURED, authRedirectUri: undefined }), true);
  assert.equal(isConfigured({ ...CONFIGURED, apiBase: undefined }), false);
  assert.equal(isConfigured({ ...CONFIGURED, authAuthority: undefined }), false);
  assert.equal(isConfigured({ ...CONFIGURED, authClientId: undefined }), false);
  assert.equal(isConfigured({ ...CONFIGURED, apiBase: '   ' }), false);
});

// --- mode mapping ---

test('buildSyncPanelModel maps the three sync states', () => {
  const localOnly = buildSyncPanelModel({ config: CONFIGURED, state: { enabled: false } });
  assert.equal(localOnly.mode, 'local-only');
  assert.equal(localOnly.configured, true);

  const syncing = buildSyncPanelModel({
    config: CONFIGURED,
    state: { enabled: true, deviceId: 'dev-1', lastSyncedAt: 1000 },
    now: 1000,
  });
  assert.equal(syncing.mode, 'syncing');
  assert.equal(syncing.deviceId, 'dev-1');
  assert.equal(syncing.lastSyncedText, 'just now');

  // There is no locked state to unlock by hand any more (ONL-020): enabled is
  // enabled, and only the engine's own hint moves it to `paused`.
  const enabled = buildSyncPanelModel({ config: CONFIGURED, state: { enabled: true } });
  assert.equal(enabled.mode, 'syncing');

  const paused = buildSyncPanelModel({
    config: CONFIGURED,
    state: { enabled: true },
    paused: true,
  });
  assert.equal(paused.mode, 'paused');
});

// --- rendering ---

test('unconfigured local-only panel explains itself and disables enable', () => {
  const { actions, calls } = recordingActions();
  const model = buildSyncPanelModel({ config: {}, state: { enabled: false }, pendingCount: 0 });
  assert.equal(model.configured, false);
  const tree = viewSyncPanel(model, actions);

  assert.ok(tree.sel?.includes('sync-panel'), 'renders section.panel.sync-panel');
  const mode = findById(tree, 'sync-mode')!;
  assert.equal((mode.data?.attrs as Record<string, unknown>)['data-sync-mode'], 'local-only');

  const texts = collectText(tree);
  assert.ok(
    texts.some((text) => /not configured/i.test(text)),
    'explains that sync is not configured',
  );
  assert.ok(texts.some((text) => /stays on this device/i.test(text)));

  const enable = findById(tree, 'sync-enable');
  assert.ok(enable !== null, 'enable button is rendered, not hidden');
  assert.equal((enable!.data?.attrs as Record<string, unknown>).disabled, true);
  assert.equal(clickListener(enable!), undefined, 'disabled enable has no handler');
  assert.deepEqual(calls, [], 'no action fires while unconfigured');
});

test('configured panel passes the Enable action through with no direct side effects', () => {
  const { actions, calls } = recordingActions();
  const tree = viewSyncPanel(buildSyncPanelModel({ config: CONFIGURED }), actions);
  const enable = findById(tree, 'sync-enable')!;
  assert.equal((enable.data?.attrs as Record<string, unknown>).disabled, undefined);
  const listener = clickListener(enable);
  assert.ok(listener !== undefined);
  listener!({}, enable);
  assert.deepEqual(calls, ['enable']);
});

test('enabled panel shows sync/sign-out/disable and the delete-server-copy action', () => {
  const { actions } = recordingActions();
  const tree = viewSyncPanel(
    buildSyncPanelModel({ config: CONFIGURED, state: { enabled: true, keyVersion: 1 } }),
    actions,
  );
  assert.ok(findById(tree, 'sync-now') !== null);
  assert.ok(findById(tree, 'sync-sign-out') !== null);
  assert.ok(findById(tree, 'sync-disable') !== null);
  assert.ok(findById(tree, 'sync-delete-server-copy') !== null);
  assert.equal(findById(tree, 'sync-enable'), null);
  assert.ok(
    collectText(tree).some((text) => /never deleted/i.test(text)),
    'delete warning says local data is never deleted',
  );
});

test('local-only panel does not offer delete-server-copy', () => {
  const { actions } = recordingActions();
  const tree = viewSyncPanel(
    buildSyncPanelModel({ config: CONFIGURED, state: { enabled: false } }),
    actions,
  );
  assert.equal(findById(tree, 'sync-delete-server-copy'), null);
});

test('pending count text is rendered and pluralized', () => {
  const { actions } = recordingActions();
  const none = collectText(viewSyncPanel(buildSyncPanelModel({ config: {}, pendingCount: 0 }), actions));
  assert.ok(none.includes('Nothing waiting to sync.'));

  // NB: collectText returns an array of text nodes, so these are substring
  // checks over the joined text rather than exact-element lookups.
  const textOf = (node: VNode): string => collectText(node).join(' ');
  const one = viewSyncPanel(buildSyncPanelModel({ config: {}, pendingCount: 1 }), actions);
  assert.ok(textOf(one).includes('1 change waiting to sync'));

  const many = viewSyncPanel(buildSyncPanelModel({ config: {}, pendingCount: 7 }), actions);
  assert.ok(textOf(many).includes('7 changes waiting to sync'));
  assert.match(String(findById(many, 'sync-pending')!.text), /^7 changes waiting to sync/);
});

test('UX-008: the panel says sync is automatic and that the button is optional', () => {
  const { actions } = recordingActions();
  const enabled = viewSyncPanel(
    buildSyncPanelModel({ config: CONFIGURED, state: { enabled: true }, pendingCount: 3 }),
    actions,
  );

  // The status line and the note both answer "does this sync by itself?".
  assert.match(String(findById(enabled, 'sync-status')!.text), /Syncs automatically/);
  const note = findById(enabled, 'sync-auto-note');
  assert.ok(note !== null, 'the optional-button note renders once sync is on');
  assert.match(String(note!.text), /never have to press Sync now/);

  // Queued changes say they will go out on their own; paused says it resumes.
  assert.match(String(findById(enabled, 'sync-pending')!.text), /go out on their own/);
  const paused = viewSyncPanel(
    buildSyncPanelModel({ config: CONFIGURED, state: { enabled: true }, paused: true }),
    actions,
  );
  assert.match(String(findById(paused, 'sync-status')!.text), /send themselves/);

  // The unconfigured/local-only panel keeps its promise untouched (no auto note).
  const inert = viewSyncPanel(buildSyncPanelModel({ config: {}, state: { enabled: false } }), actions);
  assert.equal(findById(inert, 'sync-auto-note'), null);
});

test('busy panel disables its actions', () => {
  const { actions } = recordingActions();
  const tree = viewSyncPanel(
    buildSyncPanelModel({ config: CONFIGURED, state: { enabled: true, keyVersion: 1 }, busy: true }),
    actions,
  );
  for (const id of ['sync-now', 'sync-sign-out', 'sync-disable', 'sync-delete-server-copy']) {
    const button = findById(tree, id)!;
    assert.equal((button.data?.attrs as Record<string, unknown>).disabled, true, `${id} disabled`);
    assert.equal(clickListener(button), undefined, `${id} has no handler while busy`);
  }
});

test('message renders with the requested tone', () => {
  const { actions } = recordingActions();
  const ok = viewSyncPanel(
    buildSyncPanelModel({ config: CONFIGURED, message: { tone: 'ok', text: 'Sync complete.' } }),
    actions,
  );
  const error = viewSyncPanel(
    buildSyncPanelModel({ config: CONFIGURED, message: { tone: 'error', text: 'Sync failed.' } }),
    actions,
  );
  assert.ok(collectText(ok).includes('Sync complete.'));
  assert.ok(collectText(error).includes('Sync failed.'));
  assert.ok(hasSelector(ok, (sel) => sel.includes('sync-message')));
});
