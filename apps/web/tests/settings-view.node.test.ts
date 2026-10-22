import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { VNode } from 'snabbdom/build/vnode.js';
import { SettingsCtrl, SettingsView, view } from '../src/settings-view.ts';
import { CURATED_DEFAULTS } from '../src/settings-preferences.ts';
import { setLocale, t } from '../src/i18n.ts';
import type { TrainingAdapter } from '../src/training-adapter.ts';
import type { SyncPanelConfig } from '../src/sync/panel.ts';
import type { SyncRuntime } from '../src/sync/bootstrap.ts';
import { makeService } from './fixtures.ts';

const SYNC_CONFIG: SyncPanelConfig = {
  apiBase: 'https://api.example.test',
  authAuthority: 'https://auth.example.test',
  authClientId: 'client-123',
  authRedirectUri: 'https://app.example.test/',
};

/** Runtime stub for the ONL-011 Settings wiring tests. */
function syncRuntimeStub(
  mode: 'local-only' | 'syncing' | 'paused',
  calls: string[] = [],
): SyncRuntime {
  return {
    config: SYNC_CONFIG,
    isConfigured: () => true,
    state: async () => ({ mode, pending: 0 }),
    enable: async () => {
      calls.push('enable');
    },
    syncNow: async () => {
      calls.push('syncNow');
      return { pushed: 0, accepted: 0 };
    },
    disable: async () => {
      calls.push('disable');
    },
    signOut: async () => {
      calls.push('signOut');
    },
    deleteServerCopy: async () => {
      calls.push('deleteServerCopy');
    },
  };
}

function stubAdapter(calls: string[]): TrainingAdapter {
  return {
    reloadAfterDataChange: async () => {
      calls.push('reload');
    },
  } as unknown as TrainingAdapter;
}

/** Collect every text node in a vnode tree (snabbdom sets copy as text). */
function collectText(node: VNode | string | null | undefined): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  const out: string[] = [];
  if (typeof node.text === 'string') out.push(node.text);
  for (const child of node.children ?? []) out.push(...collectText(child as VNode | string));
  return out;
}

/** True when any vnode in the tree matches the selector predicate. */
function hasSelector(node: VNode | string | null | undefined, match: (sel: string) => boolean): boolean {
  if (node === null || node === undefined || typeof node === 'string') return false;
  if (typeof node.sel === 'string' && match(node.sel)) return true;
  return (node.children ?? []).some((child) => hasSelector(child as VNode | string, match));
}

/** Find a vnode by its `id` attribute (smoke + CSS hook ids are preserved). */
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

async function makeCtrl() {
  const service = await makeService();
  const reloads: string[] = [];
  const ctrl = new SettingsCtrl(service, stubAdapter(reloads));
  return { service, reloads, ctrl };
}

test('view renders the prefs form with curated values and smoke-hook ids', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  await ctrl.load();
  const tree = view(ctrl);
  const texts = collectText(tree);

  assert.ok(texts.includes(t('settings.prefs.title')));
  assert.ok(texts.includes(t('settings.prefs.save')));
  for (const id of [
    'set-failure',
    'set-step-back',
    'set-retry-retain',
    'set-new-per-day',
    'set-relearning',
    'set-timing',
    'settings-save-prefs',
    'settings-export',
    'settings-import-file',
    'settings-import-preview',
    'settings-message',
  ]) {
    assert.ok(findById(tree, id) !== null, `control #${id} renders`);
  }
  const stepBack = findById(tree, 'set-step-back')!;
  assert.equal((stepBack.data?.props as Record<string, unknown>)?.value, String(CURATED_DEFAULTS.stepBackAmount));
  const timing = findById(tree, 'set-timing')!;
  assert.equal((timing.data?.props as Record<string, unknown>)?.checked, CURATED_DEFAULTS.timingEnabled);
});

test('view renders the Sync panel in local-only, not-configured mode by default', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  await ctrl.load();
  const tree = view(ctrl);
  const mode = findById(tree, 'sync-mode')!;
  assert.equal(
    (mode.data?.attrs as Record<string, unknown>)['data-sync-mode'],
    'local-only',
  );
  const enable = findById(tree, 'sync-enable')!;
  assert.equal((enable.data?.attrs as Record<string, unknown>).disabled, true);
  assert.ok(collectText(tree).some((text) => /not configured/i.test(text)));
});

test('empty backups render the empty-state message', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  await ctrl.load();
  assert.deepEqual(ctrl.backups, []);
  assert.ok(collectText(view(ctrl)).includes(t('settings.data.noBackups')));
});

test('backup labels render with restore actions', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  ctrl.backups = ['snap-a'];
  const texts = collectText(view(ctrl));
  assert.ok(texts.includes('snap-a'));
  assert.ok(texts.includes(t('settings.data.restore')));
});

test('message renders as a status line with the same string', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  ctrl.message = { kind: 'ok', text: t('settings.prefs.saved') };
  const tree = view(ctrl);
  assert.ok(collectText(tree).includes(t('settings.prefs.saved')));
  assert.ok(
    hasSelector(tree, (sel) => sel.startsWith('div.status')),
    'message uses the statusLine primitive',
  );
});

test('pending preview renders the import summary with confirm/cancel', async () => {
  setLocale('en');
  const { service, ctrl } = await makeCtrl();
  const payload = JSON.stringify(await service.exportStore());
  await ctrl.previewImportText(payload);
  assert.ok(ctrl.pending !== null, 'valid export becomes pending');
  const tree = view(ctrl);
  assert.ok(findById(tree, 'settings-import-confirm') !== null);
  assert.ok(findById(tree, 'settings-import-cancel') !== null);
  ctrl.cancelImport();
  assert.equal(ctrl.pending, null);
  assert.ok(findById(view(ctrl), 'settings-import-confirm') === null);
});

test('preview with no file or garbage reports the same error strings', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  await ctrl.previewImportText(null);
  assert.equal(ctrl.message?.text, t('settings.data.invalid'));
  assert.equal(ctrl.message?.kind, 'error');
  await ctrl.previewImportText('not json');
  assert.equal(ctrl.pending, null);
  assert.equal(ctrl.message?.kind, 'error');
  assert.ok(collectText(view(ctrl)).includes(ctrl.message!.text));
});

test('savePreferences clamps raw input and confirms with the saved string', async () => {
  setLocale('en');
  const { service, ctrl } = await makeCtrl();
  let redraws = 0;
  ctrl.redraw = () => {
    redraws += 1;
  };
  await ctrl.savePreferences({
    failurePreset: 'bogus',
    stepBackAmount: 999,
    retryRetainAmount: -5,
    newIntroductionLimitPerDay: 100000,
    relearningMinutes: 0,
    timingEnabled: 'yes',
  });
  assert.deepEqual(service.getCuratedSettings(), {
    ...CURATED_DEFAULTS,
    stepBackAmount: 10,
    newIntroductionLimitPerDay: 999,
    relearningMinutes: 1,
  });
  assert.equal(ctrl.message?.text, t('settings.prefs.saved'));
  assert.ok(redraws >= 1, 'save ends in redraw');
});

test('confirmImport without pending is a no-op', async () => {
  const { reloads, ctrl } = await makeCtrl();
  await ctrl.confirmImport();
  assert.deepEqual(reloads, []);
  assert.equal(ctrl.message, null);
});

test('confirmImport imports, reloads the adapter, and reports label + total', async () => {
  setLocale('en');
  const { service, reloads, ctrl } = await makeCtrl();
  const payload = JSON.stringify(await service.exportStore());
  await ctrl.previewImportText(payload);
  await ctrl.confirmImport();
  assert.equal(ctrl.pending, null);
  assert.deepEqual(reloads, ['reload']);
  assert.equal(ctrl.message?.kind, 'ok');
  assert.ok(ctrl.message!.text.includes('pre-import-'));
});

test('restore of a missing backup reports the same error string', async () => {
  setLocale('en');
  const { reloads, ctrl } = await makeCtrl();
  await ctrl.restoreBackup('no-such-backup');
  assert.equal(ctrl.message?.text, t('settings.data.restoreMissing'));
  assert.deepEqual(reloads, [], 'failed restore never reloads');
});

test('refresh re-reads service state and ends in redraw', async () => {
  const { ctrl } = await makeCtrl();
  let redraws = 0;
  ctrl.redraw = () => {
    redraws += 1;
  };
  await ctrl.refresh();
  assert.equal(redraws, 1);
  assert.ok(ctrl.summary !== null);
});

test('no key-entry controls exist anywhere in the panel (nothing for the user to copy)', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  await ctrl.load();
  const unconfigured = view(ctrl);
  assert.equal(findById(unconfigured, 'sync-recovery-input'), null);
  assert.equal(findById(unconfigured, 'sync-unlock'), null);
  assert.equal(findById(unconfigured, 'sync-recovery-code'), null);

  // Enabled but with no key cached on this device: a paused panel, and still
  // nothing to type — the key comes from the server (design #6 revised).
  const { ctrl: ctrl2 } = await makeCtrl();
  await ctrl2.attachSync(syncRuntimeStub('paused'));
  const paused = view(ctrl2);
  assert.equal(
    (findById(paused, 'sync-mode')!.data?.attrs as Record<string, unknown>)['data-sync-mode'],
    'paused',
  );
  assert.equal(findById(paused, 'sync-recovery-input'), null);
  assert.equal(findById(paused, 'sync-unlock'), null);
});

test('Enable starts the OAuth redirect instead of requesting a token in-page', async () => {
  setLocale('en');
  const { ctrl } = await makeCtrl();
  const begun: SyncPanelConfig[] = [];
  const redirects: string[] = [];
  await ctrl.attachSync(syncRuntimeStub('local-only'), {
    begin: async (config) => {
      begun.push(config);
      return { url: 'https://auth.example.test/oauth2/authorize?state=s' };
    },
    redirect: (url) => redirects.push(url),
  });

  const tree = view(ctrl);
  const enable = findById(tree, 'sync-enable')!;
  assert.equal((enable.data?.attrs as Record<string, unknown>).disabled, undefined);
  const onClick = (enable.data?.on as { click?: () => void } | undefined)?.click;
  onClick!();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(redirects, ['https://auth.example.test/oauth2/authorize?state=s']);
  assert.equal(begun.length, 1);
  assert.equal(begun[0]?.authAuthority, SYNC_CONFIG.authAuthority);
});

test('unmount without mount is safe', async () => {
  const service = await makeService();
  const screen = new SettingsView({ service, adapter: undefined as never });
  screen.unmount();
});
