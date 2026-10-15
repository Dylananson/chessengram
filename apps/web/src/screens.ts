/**
 * Screen-stub registry. Train, Puzzles, Settings, and History are real screens;
 * only `collections` remains a stub until the T13-followup (B4, needs user scope).
 * Each stub is a real exported screen so navigation and per-screen teardown
 * are exercised from day one.
 */

import type { AppContext } from './app-context.ts';
import { t } from './i18n.ts';
import type { Screen, ScreenId } from './router.ts';

function stub(id: ScreenId): Screen {
  return {
    id,
    mount(host: HTMLElement): void {
      host.innerHTML = `
        <div class="info">
          <h2 data-i18n="screen.${id}.title"></h2>
          <p data-i18n="screen.${id}.body"></p>
        </div>
      `;
      host.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n');
        if (key) el.textContent = t(key);
      });
    },
    unmount(): void {
      // stub screens own no listeners.
    },
  };
}

export function registerStubScreens(_ctx: AppContext): void {
  // Registration happens in app.ts; the map below is the single source of ids.
}

/** Factory registry used by app.ts. The collections stub stays until T13-followup. */
export function stubFactories(): { id: ScreenId; factory: (ctx: AppContext) => Screen }[] {
  return (['collections'] as ScreenId[]).map((id) => ({
    id,
    factory: () => stub(id),
  }));
}