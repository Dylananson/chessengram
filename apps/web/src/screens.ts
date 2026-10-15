/**
 * Screen registry. Train, Puzzles, Settings, History, and Collections are
 * real screens; no stubs remain (B4 landed the T13-followup Collections
 * screen: static sets with multi-membership and per-collection progress).
 */

import type { AppContext } from './app-context.ts';
import { CollectionsView } from './collections-view.ts';
import type { Screen, ScreenId } from './router.ts';

/** Factory registry used by app.ts. */
export function stubFactories(): { id: ScreenId; factory: (ctx: AppContext) => Screen }[] {
  return [{ id: 'collections' as ScreenId, factory: (ctx) => new CollectionsView(ctx) }];
}

export function registerStubScreens(_ctx: AppContext): void {
  // Registration happens in app.ts; the map below is the single source of ids.
}
