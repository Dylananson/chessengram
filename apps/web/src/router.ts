/**
 * Minimal hash router for the app shell.
 *
 * Screens register a factory keyed by id; the URL hash selects the active
 * screen (`#/train`, `#/puzzles`, ...). The router owns mounting and teardown:
 * leaving a screen destroys its DOM and any per-screen listeners so state never
 * leaks between screens.
 */

import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';

export type ScreenId =
  | 'dashboard'
  | 'train'
  | 'spaced'
  | 'puzzles'
  | 'collections'
  | 'settings'
  | 'history'
  | 'woodpecker'
  | 'stats'
  | 'analysis';

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
  if (!raw) return factories.has('dashboard') ? 'dashboard' : 'train';
  const [head, sub] = raw.split(/[/?]/);
  // `#/train` is the Spaced Repetition hub; the board itself lives at
  // `#/train/session` (and Woodpecker runs at `#/train/woodpecker?...`).
  if (head === 'train') return sub ? 'train' : 'spaced';
  return factories.has(head as ScreenId) ? (head as ScreenId) : 'train';
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
    // Keep the router's host stable. Snabbdom screen views replace their
    // mount node during the initial patch, so mounting directly into hostEl
    // would leave subsequent navigations targeting a detached node.
    hostEl!.replaceChildren();
    const mountHost = document.createElement('div');
    mountHost.className = 'screen-content';
    hostEl!.appendChild(mountHost);
    await currentScreen.mount(mountHost);
  };
  registeredNav = () => void render();
  window.addEventListener('hashchange', registeredNav);
  void render();
  return () => {
    if (registeredNav) window.removeEventListener('hashchange', registeredNav);
  };
}

function updateNav(active: ScreenId): void {
  // Woodpecker cycle and Failed-review sessions share the Train board screen,
  // but belong to the Woodpecker workflow in the app navigation. The Spaced
  // Repetition hub (`spaced`) owns the `train` nav item; the board (`train`)
  // keeps it highlighted while training.
  const route = window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const activeNav = active === 'train' && route.startsWith('train/woodpecker')
    ? 'woodpecker'
    : active === 'spaced'
      ? 'train'
      : active;
  let activeLabel = '';
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    const isActive = el.dataset.nav === activeNav;
    el.classList.toggle('nav-active', isActive);
    el.setAttribute('aria-current', isActive ? 'page' : 'false');
    if (isActive) activeLabel = el.textContent?.trim() ?? '';
  });

  // UX-006: the toggle is icon-only, so the active screen goes into its
  // accessible name — a closed drawer still tells assistive tech where you are
  // (the visible highlight lives on the items inside the drawer).
  const toggle = document.getElementById('nav-toggle');
  if (toggle && activeLabel !== '') {
    const label = `${t('nav.menu')} — ${activeLabel}`;
    if (toggle.getAttribute('aria-label') !== label) toggle.setAttribute('aria-label', label);
  }
}
