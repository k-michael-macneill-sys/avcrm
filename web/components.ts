import { h, type Attrs } from './dom.js';

/**
 * The pieces screens are assembled from.
 *
 * A dashboard's headline numbers are stat tiles and tables, not charts: two
 * branches and a handful of figures is exactly the case where a one-bar bar
 * chart says less than the number itself. Charts arrive when there is a trend
 * worth a shape.
 */

/**
 * The one number a screen leads with. Exactly one per view — a second hero is
 * two headlines, which is none.
 */
export function hero(label: string, value: string, note?: string): HTMLElement {
  return h(
    'div',
    { class: 'hero' },
    h('p', { class: 'hero-label' }, label),
    h('p', { class: 'hero-value' }, value),
    note ? h('p', { class: 'hero-note' }, note) : null,
  );
}

/** label · value · optional note. Sentence case, no trailing colon. */
export function statTile(label: string, value: string, note?: string): HTMLElement {
  return h(
    'div',
    { class: 'stat' },
    h('p', { class: 'stat-label' }, label),
    h('p', { class: 'stat-value' }, value),
    note ? h('p', { class: 'stat-note' }, note) : null,
  );
}

export function statRow(...tiles: HTMLElement[]): HTMLElement {
  return h('div', { class: 'stat-row' }, ...tiles);
}

export function pageHeader(
  title: string,
  subtitle?: string,
  ...actions: (HTMLElement | null)[]
): HTMLElement {
  return h(
    'header',
    { class: 'page-head' },
    h(
      'div',
      {},
      h('h1', {}, title),
      subtitle ? h('p', { class: 'page-sub' }, subtitle) : null,
    ),
    actions.length > 0 ? h('div', { class: 'page-actions' }, ...actions) : null,
  );
}

/** A row of filters, above whatever they filter. */
export function filterBar(...controls: (HTMLElement | null)[]): HTMLElement {
  return h('div', { class: 'filters' }, ...controls);
}

export function labelled(label: string, control: HTMLElement): HTMLElement {
  const id = `f-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  control.setAttribute('id', id);
  return h('div', { class: 'filter' }, h('label', { for: id }, label), control);
}

export function select(
  options: { value: string; label: string }[],
  value: string,
  onchange: (value: string) => void,
): HTMLSelectElement {
  const node = h('select', {
    onchange: (event: Event) => onchange((event.target as HTMLSelectElement).value),
  });
  for (const option of options) {
    const element = h('option', { value: option.value }, option.label);
    if (option.value === value) element.setAttribute('selected', '');
    node.appendChild(element);
  }
  node.value = value;
  return node;
}

export function input(attrs: Attrs = {}): HTMLInputElement {
  return h('input', { type: 'text', ...attrs });
}

/** A short banner for the result of an action, replacing whatever was there. */
export function flash(
  container: HTMLElement,
  message: string,
  tone: 'good' | 'critical' = 'good',
): void {
  container.className = `flash flash-${tone}`;
  container.textContent = message;
}
