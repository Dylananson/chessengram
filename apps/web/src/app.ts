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

import type { AppContext } from './app-context.ts';
import { applyTranslations, detectLocale, setLocale, t } from './i18n.ts';
import { loadPuzzlesFromPack } from './pack-loader.ts';
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
import { IndexedDbStorageBackend } from './storage/indexeddb-backend.ts';
import { LocalStore } from './storage/local-store.ts';
import { InMemoryStorageBackend } from './storage/memory-backend.ts';
import type { StorageBackend } from './storage/backend.ts';
import { TrainingAdapter } from './training-adapter.ts';
import { TrainView } from './train-view.ts';

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
  registerScreen('train', trainFactory);
  registerScreen('puzzles', (ctx) => new PuzzlesView(ctx));
  registerScreen('settings', (ctx) => new SettingsView(ctx));
  registerScreen('history', (ctx) => new HistoryView(ctx));
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

  const adapter = new TrainingAdapter(service);
  // B4: train the persisted active collection (defaults on first boot).
  await adapter.startSession(DEFAULT_PROGRAM_ID, service.getActiveCollectionId());

  const ctx: AppContext = { service, adapter };
  buildNav(ctx);
  registerScreens();
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