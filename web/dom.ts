/**
 * Enough DOM helpers to build screens, and no more.
 *
 * Everything here returns real nodes and sets text through textContent, so a
 * customer's name or an operator's note cannot become markup. There is no
 * innerHTML in this codebase for that reason.
 */

import { appHref } from './base.js';

type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  class?: string;
  id?: string;
  type?: string;
  href?: string;
  value?: string;
  name?: string;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  selected?: boolean;
  checked?: boolean;
  required?: boolean;
  min?: string;
  max?: string;
  step?: string;
  rows?: string;
  colspan?: string;
  autocomplete?: string;
  'data-link'?: string;
  'data-testid'?: string;
  'aria-label'?: string;
  'aria-hidden'?: string;
  for?: string;
  'aria-current'?: string;
  'aria-live'?: string;
  onclick?: (event: MouseEvent) => void;
  onsubmit?: (event: SubmitEvent) => void;
  onchange?: (event: Event) => void;
  oninput?: (event: Event) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;

    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value as EventListener);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

export function fragment(...children: Child[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  append(frag, children);
  return frag;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * An internal link. The href is a real, openable URL — the router intercepts
 * a plain left-click, but middle-click, ctrl-click and "copy link address"
 * all have to work, which means the prefix belongs in the attribute rather
 * than only in the click handler.
 */
export function link(href: string, ...children: Child[]): HTMLAnchorElement {
  return h('a', { href: appHref(href), 'data-link': 'true' }, ...children);
}

export interface Column<T> {
  header: string;
  /** Right-aligns and switches on tabular figures, for columns of numbers. */
  numeric?: boolean;
  cell: (row: T) => Child;
}

/**
 * A table, or a sentence explaining why there isn't one. An empty state that
 * says nothing is the most common way a dashboard lies about having no data.
 */
export function table<T>(
  columns: Column<T>[],
  rows: T[],
  emptyMessage = 'Nothing here yet.',
): HTMLElement {
  if (rows.length === 0) return empty(emptyMessage);

  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...columns.map((column) =>
            h('th', { class: column.numeric ? 'num' : '' }, column.header),
          ),
        ),
      ),
      h(
        'tbody',
        {},
        ...rows.map((row) =>
          h(
            'tr',
            {},
            ...columns.map((column) =>
              h('td', { class: column.numeric ? 'num' : '' }, column.cell(row)),
            ),
          ),
        ),
      ),
    ),
  );
}

export function empty(message: string): HTMLElement {
  return h('p', { class: 'empty' }, message);
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'card' }, h('h2', {}, title), ...children);
}

/** Label above value, the way every detail screen here shows a field. */
export function field(label: string, value: Child): HTMLElement {
  return h('div', { class: 'field' }, h('dt', {}, label), h('dd', {}, value));
}

export function fieldList(...fields: Child[]): HTMLElement {
  return h('dl', { class: 'fields' }, ...fields);
}

export function button(
  label: string,
  onclick: (event: MouseEvent) => void,
  variant: 'primary' | 'secondary' | 'danger' = 'secondary',
): HTMLButtonElement {
  return h('button', { class: `btn btn-${variant}`, type: 'button', onclick }, label);
}

export function spinner(): HTMLElement {
  return h('p', { class: 'loading', 'aria-live': 'polite' }, 'Loading…');
}
