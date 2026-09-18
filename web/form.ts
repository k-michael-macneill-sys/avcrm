import * as api from './api.js';
import { h } from './dom.js';

/**
 * Small forms, built from a spec.
 *
 * Every submit goes through `submitter`, which turns an ApiError back into
 * text on the screen — including the `details` array, so the checklist gate
 * and the field validators say exactly which field they mean rather than
 * "something went wrong".
 */

export interface FieldSpec {
  name: string;
  label: string;
  type?:
    | 'text'
    | 'number'
    | 'date'
    | 'datetime-local'
    | 'email'
    | 'password'
    | 'textarea'
    | 'select';
  value?: string;
  placeholder?: string;
  required?: boolean;
  step?: string;
  options?: { value: string; label: string }[];
  /** Shown under the control: where to find this value, what it means. */
  help?: string;
}

export interface Form {
  node: HTMLElement;
  values: () => Record<string, string>;
  set: (name: string, value: string) => void;
  focus: (name: string) => void;
}

export function buildForm(specs: FieldSpec[]): Form {
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();

  const rows = specs.map((spec) => {
    const id = `field-${spec.name}`;
    let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

    if (spec.type === 'select') {
      const node = h('select', { id, name: spec.name });
      for (const option of spec.options ?? []) {
        node.appendChild(h('option', { value: option.value }, option.label));
      }
      node.value = spec.value ?? spec.options?.[0]?.value ?? '';
      control = node;
    } else if (spec.type === 'textarea') {
      const node = h('textarea', { id, name: spec.name, rows: '3' });
      node.value = spec.value ?? '';
      control = node;
    } else {
      control = h('input', {
        id,
        name: spec.name,
        type: spec.type ?? 'text',
        value: spec.value ?? '',
        placeholder: spec.placeholder,
        required: spec.required,
        step: spec.step,
      });
    }

    controls.set(spec.name, control);
    return h(
      'div',
      { class: 'form-row' },
      h('label', { for: id }, spec.label),
      control,
      spec.help ? h('p', { class: 'form-help' }, spec.help) : null,
    );
  });

  return {
    node: h('div', { class: 'form-grid' }, ...rows),
    values: () => {
      const out: Record<string, string> = {};
      for (const [name, control] of controls) out[name] = control.value.trim();
      return out;
    },
    set: (name, value) => {
      const control = controls.get(name);
      if (control) control.value = value;
    },
    focus: (name) => controls.get(name)?.focus(),
  };
}

/**
 * Wraps an action so the button disables while it runs and any API error
 * lands on the screen instead of the console.
 */
export function submitter(
  errorNode: HTMLElement,
  onDone: () => void,
): (label: string, run: () => Promise<unknown>, variant?: 'primary' | 'secondary' | 'danger') => HTMLButtonElement {
  return (label, run, variant = 'secondary') => {
    const node = h(
      'button',
      {
        type: 'button',
        class: `btn btn-${variant}`,
        onclick: () => {
          errorNode.textContent = '';
          node.disabled = true;
          const original = node.textContent;
          node.textContent = 'Working…';

          run()
            .then(() => onDone())
            .catch((err: unknown) => {
              if (err instanceof api.Unauthenticated) {
                location.reload();
                return;
              }
              errorNode.textContent =
                err instanceof api.ApiError ? err.full : String(err);
              node.disabled = false;
              node.textContent = original;
            });
        },
      },
      label,
    );
    return node;
  };
}

export function errorLine(): HTMLElement {
  return h('p', { class: 'form-error', 'aria-live': 'polite' });
}

/** A collapsible panel, so a screen is not a wall of forms. */
export function disclosure(label: string, build: () => HTMLElement): HTMLElement {
  const body = h('div', { class: 'disclosure-body' });
  let open = false;

  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-secondary',
      onclick: () => {
        open = !open;
        toggle.textContent = open ? 'Cancel' : label;
        body.replaceChildren(...(open ? [build()] : []));
      },
    },
    label,
  );

  return h('div', { class: 'disclosure' }, toggle, body);
}
