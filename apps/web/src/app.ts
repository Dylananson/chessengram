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
import { loadBundledBands, loadPuzzlesFromPack, BANDS_PACK_ID } from './pack-loader.ts';
import { navigate, registerScreen, startRouter, type ScreenId } from './router.ts';
import {
  DEFAULT_PROGRAM_ID,
  LocalTrainingService,
} from './scheduler-service.ts';
import type { ScreenFactory } from './router.ts';
import { stubFactories } from './screens.ts';
import { HistoryView } from './history-view.ts';
import { PuzzlesView } from './puzzles-view.ts';
import { SettingsView } from './settings-view.ts';
import { SpacedView } from './spaced-view.ts';
import { IndexedDbStorageBackend } from './storage/indexeddb-backend.ts';
import { LocalStore } from './storage/local-store.ts';
import { InMemoryStorageBackend } from './storage/memory-backend.ts';
import type { StorageBackend } from './storage/backend.ts';
import { TrainingAdapter } from './training-adapter.ts';
import { TrainView } from './train-view.ts';
import { WoodpeckerView } from './woodpecker-view.ts';
import { DashboardView } from './dashboard-view.ts';

async function createService(): Promise<LocalTrainingService> {
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
  const service = new LocalTrainingService({ store: new LocalStore(backend) });
  await service.init();

  const params = new URLSearchParams(window.location.search);
  if (params.get('reset') === '1') {
    await service.reset();
  }
  return service;
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
  ];
  const nav = document.getElementById('nav')!;
  nav.innerHTML = '';
  for (const [id, key] of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.dataset.nav = id;
    button.textContent = t(key);
    button.addEventListener('click', () => navigate(id));
    nav.appendChild(button);
  }
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
  for (const { id, factory } of stubFactories()) {
    registerScreen(id, factory);
  }
}

async function init(): Promise<void> {
  const locale = detectLocale();
  setLocale(locale);
  document.documentElement.lang = locale;
  applyTranslations(document);

  const service = await createService();
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

  const ctx: AppContext = { service, adapter };
  buildNav(ctx);
  registerScreens();
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
void init();
