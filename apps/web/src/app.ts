/**
 * Application bootstrap: imports global styles, sets up locale and storage,
 * wires the shared service/adapter, builds the shell navigation and starts the
 * hash router.
 */

import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './theme.css';
import './app.css';
import './design-system.scss';

import type { AppContext } from './app-context.ts';
import { applySavedBoardTheme } from './board-theme.ts';
import { applyTranslations, detectLocale, setLocale, t } from './i18n.ts';
import { migrateLegacyStorageKeys } from './legacy-keys.ts';
import { initPwa } from './pwa.ts';
import { loadBundledBands, loadPuzzlesFromPack, BANDS_PACK_ID } from './pack-loader.ts';
import { navigate, registerScreen, startRouter, type ScreenId } from './router.ts';
import {
  DEFAULT_PROGRAM_ID,
  LocalTrainingService,
} from './scheduler-service.ts';
import type { ScreenFactory } from './router.ts';
import { stubFactories } from './screens.ts';
import { HistoryView } from './history-view.ts';
import { AnalysisView, fenFromHash, openAnalysis, ANALYSIS_START_FEN } from './analysis-view.ts';
import { createAnalysisBoard } from './analysis-board.ts';
import { createLiveAnalysis } from './engine/analysis-live.ts';
import { PuzzlesView } from './puzzles-view.ts';
import { SettingsView } from './settings-view.ts';
import { SpacedView } from './spaced-view.ts';
import { IndexedDbStorageBackend } from './storage/indexeddb-backend.ts';
import { LocalStore, syncKeyStorage, syncStorage } from './storage/local-store.ts';
import { InMemoryStorageBackend } from './storage/memory-backend.ts';
import type { StorageBackend } from './storage/backend.ts';
import {
  createSyncRuntime,
  loadSyncConfig,
  type SyncRuntime,
  type SyncRuntimeState,
} from './sync/bootstrap.ts';
import { beginAuth, completeAuth, isAuthCallback } from './sync/auth.ts';
import { isConfigured, type SyncPanelConfig } from './sync/panel.ts';
import { createSyncApiClient } from './sync/client.ts';
import type { SyncApiClient } from './sync/types.ts';
import { TrainingAdapter } from './training-adapter.ts';
import { TrainView } from './train-view.ts';
import { WoodpeckerView } from './woodpecker-view.ts';
import { DashboardView } from './dashboard-view.ts';
import { StatsView } from './stats-view.ts';

async function createStoreAndService(): Promise<{ store: LocalStore; service: LocalTrainingService }> {
  let backend: StorageBackend;
  if (typeof indexedDB !== 'undefined') {
    try {
      backend = new IndexedDbStorageBackend();
    } catch {
      backend = new InMemoryStorageBackend();
    }
  } else {
    backend = new InMemoryStorageBackend();
  }
  const store = new LocalStore(backend);
  const service = new LocalTrainingService({ store });
  await service.init();

  const params = new URLSearchParams(window.location.search);
  if (params.get('reset') === '1') {
    await service.reset();
  }
  return { store, service };
}

/**
 * ONL-009b: build the sync runtime lazily and offline-safely.
 *
 * Nothing runs here until the Settings screen asks for a runtime. When no
 * `VITE_SYNC_*` value is present `loadSyncConfig` returns without fetching, and
 * with no transport client the factory resolves `undefined` — so a default
 * build makes zero network calls and the Sync panel keeps its honest
 * local-only/"not configured" defaults. The runtime only appears once both
 * configuration and a `SyncApiClient` are available.
 */
function createSyncRuntimeFactory(
  service: LocalTrainingService,
  store: LocalStore,
  createSyncApi: ((config: SyncPanelConfig) => SyncApiClient | undefined) | undefined,
): () => Promise<SyncRuntime | undefined> {
  // One runtime instance per page load: the OAuth callback enables it and the
  // Settings panel must see that same object (a fresh instance would restart
  // from `local-only` and lose the session/key the callback just established).
  let cached: Promise<SyncRuntime | undefined> | undefined;
  return () => {
    cached ??= (async () => {
      const config = await loadSyncConfig();
      if (!createSyncApi || !isConfigured(config)) return undefined;
      const api = createSyncApi(config);
      if (!api) return undefined;
      return createSyncRuntime({
        config,
        api,
        service,
        storage: syncStorage(store),
        keyStorage: syncKeyStorage(store),
      });
    })();
    return cached;
  };
}

/**
 * Complete a Cognito redirect callback before the router mounts.
 *
 * Order: validate/exchange the code, call `enable({ idToken })` on the shared
 * runtime (which persists + adopts), remember a generic notice, then strip the
 * query string and route to Settings. Any failure is swallowed into a notice so
 * boot and offline training never break. No token or code is ever logged.
 */
async function handleSyncCallback(ctx: AppContext): Promise<void> {
  if (!isAuthCallback(window.location.href)) return;
  const callbackUrl = window.location.href;
  try {
    const config = await loadSyncConfig();
    if (!isConfigured(config) || !ctx.syncCompleteAuth) {
      throw new Error('sync auth is not configured');
    }
    const { idToken } = await ctx.syncCompleteAuth(callbackUrl, config);
    const runtime = await ctx.sync?.();
    if (!runtime) throw new Error('sync runtime is unavailable');
    await runtime.enable({ idToken });
    ctx.syncAuthNotice = {
      tone: 'ok',
      text: 'Sync enabled. Your progress will follow you to your other devices.',
    };
  } catch {
    ctx.syncAuthNotice = {
      tone: 'error',
      text: 'Sign-in could not be completed. Training stays local on this device.',
    };
  } finally {
    // Keep the path (a configured callback path may differ from `/`) but drop
    // the OAuth query parameters, and land on Settings where sync lives.
    window.history.replaceState(null, '', `${window.location.pathname}#/settings`);
  }
}

function buildNav(ctx: AppContext): void {
  const items: Array<[ScreenId, string]> = [
    ['dashboard', 'nav.dashboard'],
    ['woodpecker', 'nav.woodpecker'],
    ['train', 'nav.train'],
    ['puzzles', 'nav.puzzles'],
    ['collections', 'nav.collections'],
    ['settings', 'nav.settings'],
    ['history', 'nav.history'],
    ['stats', 'nav.stats'],
    ['analysis', 'nav.analysis'],
  ];
  const nav = document.getElementById('nav')!;
  nav.innerHTML = '';
  for (const [id, key] of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.dataset.nav = id;
    button.textContent = t(key);
    // AN-002: "Analysis" is only useful with a position. From the trainer it
    // opens the puzzle you are looking at; elsewhere it falls back to a fresh
    // board.
    button.addEventListener('click', () => {
      if (id === 'analysis' && window.location.hash.startsWith('#/train')) {
        openAnalysis(undefined);
        return;
      }
      navigate(id);
    });
    nav.appendChild(button);
  }
  wireNavDrawer();
}

/**
 * UX-006: the navigation is a drawer on phones (CSS-gated at 760px) instead of
 * a sideways-scrolling strip. The toggle only exists for that case; on desktop
 * CSS hides it and nothing here is reachable.
 *
 * Behaviour: `aria-expanded` mirrors the open state, choosing a destination
 * closes it, Escape closes it and hands focus back to the toggle, and the
 * toggle label always shows the *current* screen so the closed drawer is not a
 * mystery (the router keeps it in sync in `updateNav`).
 */
function wireNavDrawer(): void {
  const toggle = document.getElementById('nav-toggle');
  const nav = document.getElementById('nav');
  if (!toggle || !nav) return;

  const setOpen = (open: boolean): void => {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    nav.classList.toggle('nav-open', open);
  };

  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });
  // A chosen destination closes the drawer and returns focus to the toggle so
  // the next Tab continues from a predictable place.
  nav.addEventListener('click', (event) => {
    if ((event.target as HTMLElement | null)?.closest('[data-nav]')) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
  setOpen(false);
}

/**
 * UX-007: a real sign-in entry point in the shell, not only in Settings.
 *
 * Rendered **only** when sync is configured: an unconfigured build keeps its
 * inert local-only shell (and its zero-network promise) untouched. The button
 * reuses `ctx.syncBeginAuth`, the single owner of the Cognito authorization
 * flow — there is no second auth path, and the redirect is the same one
 * Settings uses.
 */
async function buildAuthEntry(ctx: AppContext): Promise<void> {
  const slot = document.getElementById('auth-slot');
  if (!slot) return;
  slot.replaceChildren();

  let runtime: SyncRuntime | undefined;
  try {
    runtime = await ctx.sync?.();
  } catch {
    return; // never let the shell depend on sync boot
  }
  if (!runtime?.isConfigured()) return;

  let mode: SyncRuntimeState['mode'] = 'local-only';
  try {
    mode = (await runtime.state()).mode;
  } catch {
    return;
  }

  // Signed in already: nothing to offer here. The status lives in Settings →
  // Sync (and the panel there is the place that explains it), so the shell stays
  // quiet rather than carrying a chip that says what the app already is.
  if (mode !== 'local-only') return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'auth-button';
  button.id = 'auth-sign-in';
  button.textContent = t('auth.signIn');
  button.title = t('auth.signInHint');
  button.addEventListener('click', () => void startSignInFromShell(ctx, runtime));
  slot.appendChild(button);
}

/** Start the Cognito authorization-code flow from the shell entry point. */
async function startSignInFromShell(ctx: AppContext, runtime: SyncRuntime): Promise<void> {
  const begin = ctx.syncBeginAuth;
  if (!begin) return;
  const { url } = await begin(runtime.config);
  window.location.assign(url);
}


/**
 * AN-002: build the analysis screen. The board host is created outside the
 * patched vnode tree (chessground owns its DOM), and the live-analysis handle
 * reports snapshots back into the view so the eval bar/lines update as the
 * engine climbs.
 */
function createAnalysisScreen(ctx: AppContext): AnalysisView {
  const initialFen = fenFromHash(window.location.hash) ?? ANALYSIS_START_FEN;
  let view: AnalysisView | undefined;
  const live = createLiveAnalysis({
    multiPv: 3,
    onSnapshot: (snapshot) => view?.onSnapshot(snapshot),
  });
  view = new AnalysisView({
    // chessground must be created on an element that is in the document, so the
    // board host is created here and handed over at mount time.
    createBoard: (host) => createAnalysisBoard(host, { onMove: (from, to) => view?.playMove(from, to) }),
    live,
    initialFen,
    prepareHost: (host) => {
      host.replaceChildren();
      const root = document.createElement('div');
      root.className = 'analysis-screen';
      const boardHost = document.createElement('div');
      boardHost.className = 'analysis-board';
      boardHost.id = 'analysis';
      const panelHost = document.createElement('div');
      panelHost.className = 'analysis-panel-screen';
      root.append(boardHost, panelHost);
      host.appendChild(root);
      return { boardHost, panelHost };
    },
  });
  return view;
}

function registerScreens(): void {
  const trainFactory: ScreenFactory = (ctx) => new TrainView(ctx);
  registerScreen('dashboard', (ctx) => new DashboardView(ctx));
  // `#/train` is the Spaced Repetition hub; the board is `#/train/session`.
  registerScreen('spaced', (ctx) => new SpacedView(ctx));
  registerScreen('train', trainFactory);
  registerScreen('puzzles', (ctx) => new PuzzlesView(ctx));
  registerScreen('settings', (ctx) => new SettingsView(ctx));
  registerScreen('history', (ctx) => new HistoryView(ctx));
  registerScreen('woodpecker', (ctx) => new WoodpeckerView(ctx));
  registerScreen('stats', (ctx) => new StatsView(ctx));
  // AN-002: continuous analysis on a free board (`#/analysis`, optionally `?fen=`).
  registerScreen('analysis', (ctx) => createAnalysisScreen(ctx));
  for (const { id, factory } of stubFactories()) {
    registerScreen(id, factory);
  }
}

async function init(): Promise<void> {
  // REN-001b: carry the old namespaced preferences over before anything reads
  // them (language, board theme).
  migrateLegacyStorageKeys();
  const locale = detectLocale();
  setLocale(locale);
  document.documentElement.lang = locale;
  applyTranslations(document);

  const { store, service } = await createStoreAndService();
  if (!service.hasContent()) {
    const pack = await loadPuzzlesFromPack();
    await service.seedContent(pack.puzzles, { packId: pack.packId });
  }

  // F02: add the bundled rating-band collections once per pack. Additive only —
  // the starter collection keeps its membership and existing progress stands.
  if ((await service.bundledBandsPackId()) !== BANDS_PACK_ID) {
    try {
      const bands = await loadBundledBands();
      await service.seedBundledCollections(
        bands.packId,
        bands.puzzles,
        bands.bands.map((band) => ({ id: band.id, name: band.name, puzzleIds: band.puzzleIds })),
      );
    } catch {
      // Bundled content is an enhancement; a fetch failure must not block boot.
    }
  }

  const adapter = new TrainingAdapter(service);
  // B4: train the persisted active collection (defaults on first boot).
  await adapter.startSession(DEFAULT_PROGRAM_ID, service.getActiveCollectionId());

  const ctx: AppContext = {
    service,
    adapter,
    store,
    sync: createSyncRuntimeFactory(
      service,
      store,
      (config) => createSyncApiClient({ baseUrl: config.apiBase! }),
    ),
    syncBeginAuth: async (config) =>
      beginAuth({ config: config ?? (await loadSyncConfig()) }),
    syncCompleteAuth: async (callbackUrl, config) =>
      completeAuth({ config: config ?? (await loadSyncConfig()), callbackUrl }),
  };
  buildNav(ctx);
  registerScreens();
  // ONL-011: finish an OAuth redirect before the first screen mounts, so the
  // Settings panel already sees the enabled runtime.
  await handleSyncCallback(ctx);
  // ONL-013: attach the online/visibility flush triggers at boot — but only
  // when a runtime actually exists. `ctx.sync()` resolves `undefined` for an
  // unconfigured build (no network, no listeners), so local-only stays inert.
  const syncRuntime = await ctx.sync?.();
  syncRuntime?.attachFlushTriggers?.(window);
  // UX-007: fill the header entry point with the real sync state.
  await buildAuthEntry(ctx);
  applySavedBoardTheme();
  startRouter(ctx, document.getElementById('screen')!);
}

/**
 * Register the offline app-shell service worker (production builds only).
 * Called before any awaited work so it does not depend on the page load event.
 *
 * REL-001 remainder: when a new worker finishes installing while this page is
 * still controlled by the old one, show a minimal "update available — reload"
 * toast. Clicking reload posts SKIP_WAITING to the waiting worker; the page
 * reloads on `controllerchange`. Pure progressive enhancement: failures are
 * ignored and boot never depends on it.
 * NOTE I18N-FOLLOWUP: strings below are hardcoded English until `review.*`
 * work lands; add keys `app.update.available` / `app.update.reload` in i18n.ts
 * and swap `textContent` for `t(...)` then.
 */
function showUpdateToast(worker: ServiceWorker): void {
  if (document.getElementById('update-toast')) return;
  const toast = document.createElement('div');
  toast.id = 'update-toast';
  toast.setAttribute('role', 'status');
  toast.style.cssText =
    'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);' +
    'display:flex;gap:12px;align-items:center;padding:10px 14px;' +
    'background:#222;color:#fff;border-radius:8px;z-index:1000;' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.3);font-size:14px;';
  const label = document.createElement('span');
  label.textContent = t('app.update.available');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = t('app.update.reload');
  button.style.cssText = 'cursor:pointer;padding:4px 12px;border-radius:4px;border:none;';
  button.addEventListener('click', () => {
    worker.postMessage({ type: 'SKIP_WAITING' });
  });
  toast.append(label, button);
  document.body.appendChild(toast);
}

function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  navigator.serviceWorker
    .register('/sw.js')
    .then((registration) => {
      if (registration.waiting) showUpdateToast(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast(worker);
          }
        });
      });
      // REL-002: long-lived tabs never discover updates without a reload, so
      // poll hourly plus whenever the tab becomes visible again. Same toast
      // path as above; failures swallowed, offline-first preserved.
      const checkForUpdate = (): void => {
        registration.update().catch(() => {
          // No network or no update — ignore.
        });
      };
      window.setInterval(checkForUpdate, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
    })
    .catch(() => {
      // Offline caching is a progressive enhancement; ignore registration failures.
    });
}

registerServiceWorker();
initPwa();
void init();
