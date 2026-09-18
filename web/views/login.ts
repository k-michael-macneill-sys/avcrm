import * as api from '../api.js';
import { h } from '../dom.js';

/**
 * The sign-in screen. Seeded accounts are listed because this is a
 * development build and guessing them from the README while looking at a
 * login box is nobody's idea of a good time.
 */
const SEED_ACCOUNTS: [string, string][] = [
  ['corporate@avcrm.test', 'Corporate — every branch'],
  ['kingston.manager@avcrm.test', 'Kingston branch manager'],
  ['otto@avcrm.test', 'Operator — Kingston'],
];

export function renderLogin(onSignedIn: () => void): HTMLElement {
  const error = h('p', { class: 'form-error', 'aria-live': 'polite' });
  const email = h('input', {
    type: 'email',
    id: 'email',
    name: 'email',
    value: 'corporate@avcrm.test',
    required: true,
    autocomplete: 'username',
  });
  const password = h('input', {
    type: 'password',
    id: 'password',
    name: 'password',
    value: 'Password123!',
    required: true,
    autocomplete: 'current-password',
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Sign in');

  const form = h(
    'form',
    {
      class: 'login-form',
      onsubmit: (event: SubmitEvent) => {
        event.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        submit.textContent = 'Signing in…';

        api
          .signIn(email.value.trim(), password.value)
          .then(onSignedIn)
          .catch((err: unknown) => {
            error.textContent =
              err instanceof api.ApiError ? err.message : 'Could not sign in';
          })
          .finally(() => {
            submit.disabled = false;
            submit.textContent = 'Sign in';
          });
      },
    },
    h('label', { for: 'email' }, 'Email'),
    email,
    h('label', { for: 'password' }, 'Password'),
    password,
    error,
    submit,
  );

  return h(
    'div',
    { class: 'login' },
    h(
      'div',
      { class: 'login-card' },
      h('p', { class: 'brand' }, 'Avalanche CRM'),
      h('h1', {}, 'Sign in'),
      form,
      h(
        'div',
        { class: 'login-hint' },
        h('p', {}, 'Seeded accounts, all with the password above:'),
        h(
          'ul',
          {},
          ...SEED_ACCOUNTS.map(([address, label]) =>
            h(
              'li',
              {},
              h(
                'button',
                {
                  type: 'button',
                  class: 'linkish',
                  onclick: () => {
                    email.value = address;
                    password.value = 'Password123!';
                  },
                },
                address,
              ),
              ` — ${label}`,
            ),
          ),
        ),
      ),
    ),
  );
}
