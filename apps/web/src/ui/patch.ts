/**
 * Shared snabbdom patch setup (UI-001 S7).
 *
 * Every screen mounts once via `patch` then re-patches through its guarded
 * `redraw` closure. The module set is the union all five screens need:
 * `attributes` (ids, placeholders, disabled), `eventListeners`
 * (`on: { click/input/change }` wiring), and `props` (live input
 * values/checked/selected). Screens whose vnodes carry none of that data
 * (e.g. History's static text) are unaffected: modules only act on vnode
 * data fields that exist, so sharing one setup is behavior-neutral.
 *
 * NOTE: `style` stays out — it reads `window` at load and would break Node
 * imports. All imports use the Node-safe `snabbdom/build/*` deep subpaths
 * (never the package root, which touches `window` at load).
 */

import { init } from 'snabbdom/build/init.js';
import { attributesModule } from 'snabbdom/build/modules/attributes.js';
import { eventListenersModule } from 'snabbdom/build/modules/eventlisteners.js';
import { propsModule } from 'snabbdom/build/modules/props.js';

/**
 * Shared screen patch function. Import it under the per-screen `patch` name
 * the S2 pattern uses at each mount site:
 * `import { screenPatch as patch } from './ui/patch.ts';`
 */
export const screenPatch = init([attributesModule, eventListenersModule, propsModule]);
