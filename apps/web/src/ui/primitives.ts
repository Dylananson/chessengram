/**
 * Shared Snabbdom view primitives (UI-001 S1).
 *
 * Clean-room glue over `snabbdom`'s `h()`: tiny vnode factories for the
 * shapes every training screen needs (panel, action button, form row,
 * status line, empty state). Pure functions only — no state, no services,
 * no side effects. Event callbacks are caller-provided and passed through
 * untouched. First consumers land in S2.
 *
 * NOTE: `h` is imported from the DOM-free `snabbdom/build/h.js` subpath so
 * these helpers (and their node tests) load without a browser. The package
 * root must not be imported here: it pulls in modules that touch `window`
 * at load time.
 */

import { h } from 'snabbdom/build/h.js';
import type { VNode } from 'snabbdom/build/vnode.js';

/** Visual variant of an action button; maps onto existing `.button*` classes. */
export type ButtonVariant = 'primary' | 'secondary' | 'tertiary';

/**
 * Tone of a status line; maps onto the existing `.status` modifier classes.
 * `'info'` renders the neutral base `.status` with no modifier.
 */
export type StatusTone =
  | 'info'
  | 'correct'
  | 'wrong'
  | 'failed-but-solving'
  | 'completed'
  | 'revealed';

export interface ActionButtonOptions {
  disabled?: boolean;
  onClick?: (ev: MouseEvent) => void;
}

export interface FormRowOptions {
  /** Renders `for` on the label; the caller owns matching control ids. */
  htmlFor?: string;
  /** Small grey helper copy under the control. */
  help?: string;
  /** Error copy under the control, styled with `.error`. */
  error?: string;
}

/**
 * Card section: `section.panel` with an `h3` title, caller-supplied body,
 * and optional trailing actions laid out in a `.button-row`.
 */
export function panel(
  title: string,
  body: VNode | string | Array<VNode | string>,
  actions?: VNode[],
): VNode {
  const content: Array<VNode | string> = Array.isArray(body) ? [...body] : [body];
  const children: Array<VNode | string> = [h('h3', title), ...content];
  if (actions !== undefined && actions.length > 0) {
    children.push(h('div.button-row', actions));
  }
  return h('section.panel', children);
}

/** Button using the existing `.button` vocabulary. */
export function actionButton(
  label: string,
  variant: ButtonVariant = 'primary',
  options: ActionButtonOptions = {},
): VNode {
  const sel = variant === 'primary' ? 'button.button' : `button.button.button-${variant}`;
  return h(
    sel,
    {
      attrs: {
        type: 'button',
        ...(options.disabled === true ? { disabled: true } : {}),
      },
      ...(options.onClick !== undefined ? { on: { click: options.onClick } } : {}),
    },
    label,
  );
}

/** Labelled form row: `div.field` with label, control, optional help/error. */
export function formRow(labelText: string, control: VNode, options: FormRowOptions = {}): VNode {
  const children: Array<VNode | string> = [
    h(
      'label',
      options.htmlFor !== undefined ? { attrs: { for: options.htmlFor } } : null,
      labelText,
    ),
    control,
  ];
  if (options.help !== undefined) {
    children.push(h('p.progress-note', options.help));
  }
  if (options.error !== undefined) {
    children.push(h('div.error', options.error));
  }
  return h('div.field', children);
}

/** One-line status readout; tone selects the `.status` modifier class. */
export function statusLine(text: string, tone: StatusTone = 'info'): VNode {
  return h(tone === 'info' ? 'div.status' : `div.status.${tone}`, text);
}

/** Centered empty-list placeholder. */
export function emptyState(message: string, hint?: string): VNode {
  const children: Array<VNode | string> = [h('p.muted', message)];
  if (hint !== undefined) {
    children.push(h('p.muted', hint));
  }
  return h('div.empty-state', children);
}
