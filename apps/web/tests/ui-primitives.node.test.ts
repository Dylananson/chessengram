import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { h } from 'snabbdom/build/h.js';
import {
  actionButton,
  checkboxRow,
  emptyState,
  formRow,
  panel,
  statusLine,
} from '../src/ui/primitives.ts';
import { screenPatch } from '../src/ui/patch.ts';

test('panel renders section.panel with h3 title, body and action row', () => {
  const body = h('p', 'hello');
  const actions = [h('button.button', 'Go')];
  const vnode = panel('My panel', body, actions);

  assert.equal(vnode.sel, 'section.panel');
  assert.ok(Array.isArray(vnode.children));
  assert.equal(vnode.children.length, 3);

  const [title, content, row] = vnode.children;
  assert.equal(title.sel, 'h3');
  assert.equal(title.text, 'My panel');
  assert.equal(content, body);
  assert.equal(row.sel, 'div.button-row');
  assert.deepEqual(row.children, actions);
});

test('panel without actions omits the button row', () => {
  const vnode = panel('T', [h('p', 'a'), h('p', 'b')]);
  assert.equal(vnode.sel, 'section.panel');
  assert.equal(vnode.children?.length, 3);
  assert.ok(vnode.children?.every((child) => child.sel !== 'div.button-row'));
});

test('actionButton maps variants onto button classes', () => {
  assert.equal(actionButton('Save').sel, 'button.button');
  assert.equal(actionButton('Cancel', 'secondary').sel, 'button.button.button-secondary');
  assert.equal(actionButton('More', 'tertiary').sel, 'button.button.button-tertiary');
  assert.equal(actionButton('Save').text, 'Save');
});

test('actionButton passes type, disabled and click handler through', () => {
  let clicked = 0;
  const vnode = actionButton('Go', 'primary', {
    disabled: true,
    onClick: () => {
      clicked += 1;
    },
  });
  assert.equal(vnode.data?.attrs?.type, 'button');
  assert.equal(vnode.data?.attrs?.disabled, true);
  assert.equal(typeof vnode.data?.on?.click, 'function');
  vnode.data?.on?.click({} as MouseEvent);
  assert.equal(clicked, 1);

  const plain = actionButton('Go');
  assert.equal(plain.data?.attrs?.disabled, undefined);
  assert.equal(plain.data?.on, undefined);
});

test('actionButton compact scale appends .compact without changing labels', () => {
  assert.equal(actionButton('Add', 'primary', { compact: true }).sel, 'button.button.compact');
  assert.equal(
    actionButton('Cancel', 'secondary', { compact: true }).sel,
    'button.button.button-secondary.compact',
  );
  assert.equal(
    actionButton('More', 'tertiary', { compact: true }).sel,
    'button.button.button-tertiary.compact',
  );
  assert.equal(actionButton('Add', 'primary', { compact: true }).text, 'Add');
  assert.equal(actionButton('Plain').sel, 'button.button', 'compact defaults off');
});

test('actionButton carries smoke-hook ids via attrs', () => {
  const vnode = actionButton('Save', 'primary', { id: 'settings-save-prefs' });
  assert.equal(vnode.sel, 'button.button');
  assert.equal(vnode.data?.attrs?.id, 'settings-save-prefs');
  assert.equal(vnode.data?.attrs?.type, 'button');

  const plain = actionButton('Save');
  assert.equal(plain.data?.attrs?.id, undefined);
});

test('checkboxRow renders the wrapped-checkbox shape with id and checked state', () => {
  const vnode = checkboxRow('Enable timing', { id: 'set-timing', checked: true });
  assert.equal(vnode.sel, 'div.field.checkbox');
  assert.equal(vnode.children?.length, 1);
  const label = vnode.children?.[0];
  assert.equal(label.sel, 'label');
  assert.equal(label.children?.length, 2);
  const [input, text] = label.children ?? [];
  assert.equal(input.sel, 'input');
  assert.equal(input.data?.attrs?.id, 'set-timing');
  assert.equal(input.data?.attrs?.type, 'checkbox');
  assert.equal(input.data?.props?.checked, true);
  assert.equal(text.text, ' Enable timing');
});

test('checkboxRow omits id, props, and listeners when absent', () => {
  const vnode = checkboxRow('Label');
  const input = vnode.children?.[0].children?.[0];
  assert.deepEqual(input.data?.attrs, { type: 'checkbox' });
  assert.equal(input.data?.props, undefined);
  assert.equal(input.data?.on, undefined);
});

test('screenPatch is a shared patch function', () => {
  assert.equal(typeof screenPatch, 'function');
});

test('formRow renders label, control, help and error', () => {
  const control = h('input', { attrs: { id: 'name' } });
  const vnode = formRow('Name', control, {
    htmlFor: 'name',
    help: 'Helper copy',
    error: 'Required',
  });

  assert.equal(vnode.sel, 'div.field');
  assert.equal(vnode.children?.length, 4);
  const [label, slot, help, error] = vnode.children ?? [];
  assert.equal(label.sel, 'label');
  assert.equal(label.text, 'Name');
  assert.equal(label.data?.attrs?.for, 'name');
  assert.equal(slot, control);
  assert.equal(help.sel, 'p.progress-note');
  assert.equal(help.text, 'Helper copy');
  assert.equal(error.sel, 'div.error');
  assert.equal(error.text, 'Required');
});

test('formRow omits help and error when absent', () => {
  const control = h('input');
  const vnode = formRow('Name', control);
  assert.equal(vnode.sel, 'div.field');
  assert.equal(vnode.children?.length, 2);
  assert.equal(vnode.children?.[0].sel, 'label');
  assert.equal(vnode.children?.[1], control);
});

test('statusLine maps tones onto status modifier classes', () => {
  assert.equal(statusLine('ok').sel, 'div.status');
  assert.equal(statusLine('good', 'correct').sel, 'div.status.correct');
  assert.equal(statusLine('bad', 'wrong').sel, 'div.status.wrong');
  assert.equal(statusLine('retry', 'failed-but-solving').sel, 'div.status.failed-but-solving');
  assert.equal(statusLine('done', 'completed').sel, 'div.status.completed');
  assert.equal(statusLine('shown', 'revealed').sel, 'div.status.revealed');
  assert.equal(statusLine('hello', 'correct').text, 'hello');
});

test('emptyState renders message and optional hint', () => {
  const vnode = emptyState('Nothing here', 'Add something');
  assert.equal(vnode.sel, 'div.empty-state');
  assert.equal(vnode.children?.length, 2);
  assert.equal(vnode.children?.[0].sel, 'p.muted');
  assert.equal(vnode.children?.[0].text, 'Nothing here');
  assert.equal(vnode.children?.[1].text, 'Add something');

  const bare = emptyState('Nothing here');
  assert.equal(bare.children?.length, 1);
});

test('helpers are pure: same inputs produce equal vnodes', () => {
  assert.deepEqual(panel('T', 'body'), panel('T', 'body'));
  assert.deepEqual(actionButton('Go', 'secondary'), actionButton('Go', 'secondary'));
  assert.deepEqual(statusLine('x', 'wrong'), statusLine('x', 'wrong'));
  assert.deepEqual(emptyState('m', 'h'), emptyState('m', 'h'));
});
