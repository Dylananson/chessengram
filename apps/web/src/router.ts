/**
 * Minimal hash router for the app shell.
 *
 * Screens register a factory keyed by id; the URL hash selects the active
 * screen (`#/train`, `#/puzzles`, ...). The router owns mounting and teardown:
 * leaving a screen destroys its DOM and any per-screen listeners so state never
 * leaks between screens.
 */

import type { AppContext } from './app-context.ts';

export type ScreenId = 'train' | 'puzzles' | 'collections' | 'settings' | 'history';

export interface Screen {
  readonly id: ScreenId;
  mount(host: HTMLElement): void | Promise<void>;
  unmount(): void;
}

export type ScreenFactory = (ctx: AppContext) => Screen;

const factories = new Map<ScreenId, ScreenFactory>();
let currentScreen: Screen | null = null;
let hostEl: HTMLElement | null = null;
let registeredNav: (() => void) | null = null;

export function registerScreen(id: ScreenId, factory: ScreenFactory): void {
  factories.set(id, factory);
}

export function parseHash(): ScreenId {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const id = raw.split('/')[0] as ScreenId;
  return factories.has(id) ? id : 'train';
}

export function navigate(id: ScreenId): void {
  window.location.hash = `/${id}`;
}

export function startRouter(ctx: AppContext, host: HTMLElement): () => void {
  hostEl = host;
  const render = async (): Promise<void> => {
    try {
      await currentScreen?.unmount();
    } catch (err) {
      console.warn('screen unmount failed', err);
    }
    currentScreen = null;
    const id = parseHash();
    const factory = factories.get(id);
    if (!factory) throw new Error(`no screen registered for '${id}'`);
    currentScreen = factory(ctx);
    updateNav(id);
    await currentScreen.mount(hostEl!);
  };
  registeredNav = () => void render();
  window.addEventListener('hashchange', registeredNav);
  void render();
  return () => {
    if (registeredNav) window.removeEventListener('hashchange', registeredNav);
  };
}

function updateNav(active: ScreenId): void {
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    const isActive = el.dataset.nav === active;
    el.classList.toggle('nav-active', isActive);
    el.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
}