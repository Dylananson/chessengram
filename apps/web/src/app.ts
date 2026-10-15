/**
 * Application bootstrap: imports global styles, sets up locale and storage,
 * wires the shared service/adapter, builds the shell navigation and starts the
 * hash router.
 */

import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './app.css';

import type { AppContext } from './app-context.ts';
import { applyTranslations, detectLocale, setLocale, t } from './i18n.ts';
import { loadPuzzlesFromPack } from './pack-loader.ts';
import { navigate, registerScreen, startRouter, type ScreenId } from './router.ts';
import {
  DEFAULT_COLLECTION_ID,
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
  await adapter.startSession(DEFAULT_PROGRAM_ID, DEFAULT_COLLECTION_ID);

  const ctx: AppContext = { service, adapter };
  buildNav(ctx);
  registerScreens();
  startRouter(ctx, document.getElementById('screen')!);
}

/**
 * Register the offline app-shell service worker (production builds only).
 * Called before any awaited work so it does not depend on the page load event.
 */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Offline caching is a progressive enhancement; ignore registration failures.
  });
}

registerServiceWorker();
void init();