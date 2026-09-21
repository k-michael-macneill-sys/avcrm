import * as api from './api.js';
import { clear, h, link } from './dom.js';
import * as router from './router.js';
import { renderContract, renderContracts } from './views/contracts.js';
import { renderCustomer, renderCustomers } from './views/customers.js';
import { renderDashboard } from './views/dashboard.js';
import { renderInvoice, renderInvoices } from './views/invoices.js';
import { renderLogin } from './views/login.js';
import { renderOperator, renderOperators } from './views/operators.js';
import { renderQuote, renderQuotes } from './views/quotes.js';
import { renderReports } from './views/reports.js';
import { renderAdmin } from './views/admin.js';
import { renderSettings } from './views/settings.js';
import { renderWorkOrder, renderWorkOrders } from './views/workOrders.js';

/**
 * The shell: sign-in state, the frame around every screen, and the route
 * table. Screens themselves know nothing about navigation.
 */

interface NavItem {
  key: string;
  href: string;
  label: string;
  corporateOnly?: boolean;
}

const NAV: NavItem[] = [
  { key: 'dashboard', href: '/', label: 'Dashboard' },
  { key: 'customers', href: '/customers', label: 'Customers' },
  { key: 'quotes', href: '/quotes', label: 'Quotes' },
  { key: 'contracts', href: '/contracts', label: 'Contracts' },
  { key: 'work-orders', href: '/work-orders', label: 'Dispatch' },
  { key: 'invoices', href: '/invoices', label: 'Invoices', corporateOnly: true },
  { key: 'operators', href: '/operators', label: 'Crew' },
  { key: 'reports', href: '/reports', label: 'Reports', corporateOnly: true },
  { key: 'admin', href: '/admin', label: 'Company', corporateOnly: true },
  { key: 'settings', href: '/settings', label: 'Settings', corporateOnly: true },
];

/** Detail patterns come first: /customers/:id must not match /customers. */
const UUID = '([0-9a-f-]{36})';

const ROUTES: router.Route[] = [
  { pattern: /^\/$/, nav: 'dashboard', view: renderDashboard },

  { pattern: new RegExp(`^/customers/${UUID}$`), nav: 'customers', view: renderCustomer },
  { pattern: /^\/customers$/, nav: 'customers', view: renderCustomers },

  { pattern: new RegExp(`^/quotes/${UUID}$`), nav: 'quotes', view: renderQuote },
  { pattern: /^\/quotes$/, nav: 'quotes', view: renderQuotes },

  { pattern: new RegExp(`^/contracts/${UUID}$`), nav: 'contracts', view: renderContract },
  { pattern: /^\/contracts$/, nav: 'contracts', view: renderContracts },

  {
    pattern: new RegExp(`^/work-orders/${UUID}$`),
    nav: 'work-orders',
    view: renderWorkOrder,
  },
  { pattern: /^\/work-orders$/, nav: 'work-orders', view: renderWorkOrders },

  {
    pattern: new RegExp(`^/invoices/${UUID}$`),
    nav: 'invoices',
    corporateOnly: true,
    view: renderInvoice,
  },
  {
    pattern: /^\/invoices$/,
    nav: 'invoices',
    corporateOnly: true,
    view: renderInvoices,
  },

  { pattern: new RegExp(`^/operators/${UUID}$`), nav: 'operators', view: renderOperator },
  { pattern: /^\/operators$/, nav: 'operators', view: renderOperators },

  {
    pattern: /^\/reports$/,
    nav: 'reports',
    corporateOnly: true,
    deniedMessage: 'Roll-up reporting is corporate work. Your own visits are under Dispatch.',
    view: renderReports,
  },
  {
    pattern: /^\/admin$/,
    nav: 'admin',
    corporateOnly: true,
    deniedMessage: 'Adding branches and staff is corporate work.',
    view: renderAdmin,
  },
  {
    pattern: /^\/settings$/,
    nav: 'settings',
    corporateOnly: true,
    deniedMessage: 'Connecting outside services is corporate work.',
    view: renderSettings,
  },
];

function mustFind(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`No #${id} element`);
  return node;
}

const app = mustFind('app');

let navLinks: HTMLAnchorElement[] = [];

function markCurrent(nav: string | undefined): void {
  for (const anchor of navLinks) {
    const isCurrent = anchor.dataset.nav === nav;
    if (isCurrent) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
}

function showLogin(): void {
  clear(app);
  navLinks = [];
  document.body.classList.add('signed-out');
  app.appendChild(renderLogin(() => start()));
}

function showApp(): void {
  const user = api.currentUser();
  if (!user) {
    showLogin();
    return;
  }

  document.body.classList.remove('signed-out');
  clear(app);

  const items = NAV.filter((item) => !item.corporateOnly || api.isCorporate());
  navLinks = items.map((item) => {
    const anchor = link(item.href, item.label);
    anchor.dataset.nav = item.key;
    return anchor;
  });

  const outlet = h('main', { class: 'outlet' });

  app.appendChild(
    h(
      'div',
      { class: 'shell' },
      h(
        'aside',
        { class: 'sidebar' },
        h('p', { class: 'brand' }, 'Avalanche CRM'),
        h('nav', { 'aria-label': 'Sections' }, ...navLinks),
        h(
          'div',
          { class: 'whoami' },
          h('p', { class: 'whoami-name' }, `${user.first_name} ${user.last_name}`),
          h(
            'p',
            { class: 'whoami-role' },
            user.role === 'corporate' ? 'Corporate' : 'Operator',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'linkish',
              onclick: () => {
                api.signOut();
                router.navigate('/', true);
                showLogin();
              },
            },
            'Sign out',
          ),
        ),
      ),
      outlet,
    ),
  );

  router.configure({
    routes: ROUTES,
    outlet,
    onUnauthenticated: showLogin,
    onNavigate: markCurrent,
  });

  void router.render();
}

function start(): void {
  if (api.token()) showApp();
  else showLogin();
}

router.interceptLinks();
start();
