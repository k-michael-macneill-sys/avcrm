import * as api from '../api.js';
import { filterBar, labelled, pageHeader, select } from '../components.js';
import { field, fieldList, fragment, h, link, section, table } from '../dom.js';
import { buildForm, errorLine, submitter } from '../form.js';
import { date, money, statusPill, stamp } from '../format.js';
import * as router from '../router.js';
import { signaturePad } from '../signature.js';
import { uploadBlob } from '../upload.js';
import { QUOTE_STATUSES } from '../../src/types/models.js';
import type {
  ChecklistRequirement,
  Contract,
  Customer,
  Property,
  Quote,
} from '../../src/types/models.js';

/** What a quote may move to next, mirroring the service's own table. */
const NEXT: Record<string, string[]> = {
  draft: ['presented', 'declined', 'expired'],
  presented: ['accepted', 'declined', 'expired'],
  accepted: [],
  declined: [],
  expired: [],
};

export async function renderQuotes(root: HTMLElement): Promise<void> {
  const query = new URLSearchParams(location.search);
  const status = query.get('status') ?? '';

  const quotes = await api.list<Quote>('/quotes', { status, page_size: 50 });

  root.appendChild(
    fragment(
      pageHeader('Quotes', `${quotes.meta.total} written`),
      filterBar(
        labelled(
          'Status',
          select(
            [
              { value: '', label: 'Any status' },
              ...QUOTE_STATUSES.map((s) => ({ value: s, label: s })),
            ],
            status,
            (value) => {
              const next = new URLSearchParams(location.search);
              if (value) next.set('status', value);
              else next.delete('status');
              const qs = next.toString();
              router.navigate(`/quotes${qs ? `?${qs}` : ''}`, true);
            },
          ),
        ),
      ),
      table<Quote>(
        [
          {
            header: 'Quote',
            cell: (row) => link(`/quotes/${row.id}`, stamp(row.created_at)),
          },
          { header: 'Billing', cell: (row) => row.billing_type.replace(/_/g, ' ') },
          { header: 'List', numeric: true, cell: (row) => money(row.initial_price) },
          { header: 'Sold at', numeric: true, cell: (row) => money(row.discounted_price) },
          {
            header: 'Season',
            cell: (row) => `${date(row.season_start)} – ${date(row.season_end)}`,
          },
          { header: 'Status', cell: (row) => statusPill(row.status) },
        ],
        quotes.data,
        'No quotes match those filters.',
      ),
    ),
  );
}

export async function renderQuote(root: HTMLElement, params: string[]): Promise<void> {
  const id = params[0] ?? '';
  const quote = await api.get<Quote>(`/quotes/${id}`);
  const [property, contract] = await Promise.all([
    api.get<Property>(`/properties/${quote.property_id}`),
    api.get<Contract | null>(`/quotes/${id}/contract`),
  ]);
  const customer = await api.get<Customer>(`/customers/${property.customer_id}`);

  const error = errorLine();
  const run = submitter(error, () => router.render());

  const moves = NEXT[quote.status] ?? [];
  const discount = Number(quote.initial_price) - Number(quote.discounted_price);

  root.appendChild(
    fragment(
      pageHeader(
        property.address_line1,
        `${customer.first_name} ${customer.last_name} — ${property.city}, ${property.province}`,
      ),
      section(
        'Quote',
        fieldList(
          field('Status', statusPill(quote.status)),
          field('Billing', quote.billing_type.replace(/_/g, ' ')),
          field('List price', money(quote.initial_price)),
          field('Sold at', money(quote.discounted_price)),
          field('Discount', discount > 0 ? money(discount) : 'none'),
          field('Season', `${date(quote.season_start)} – ${date(quote.season_end)}`),
          field('Written', stamp(quote.created_at)),
        ),
        quote.notes ? h('p', { class: 'notes' }, quote.notes) : null,
        error,
        moves.length > 0
          ? h(
              'div',
              { class: 'actions' },
              ...moves.map((next) =>
                run(
                  next === 'presented' ? 'Mark presented' : `Mark ${next}`,
                  () => api.patch(`/quotes/${id}/status`, { status: next }),
                  next === 'presented' ? 'primary' : 'secondary',
                ),
              ),
            )
          : h('p', { class: 'empty' }, 'This quote has been answered and is now frozen.'),
      ),
      contract
        ? section(
            'Signed',
            h(
              'p',
              {},
              'This quote became ',
              link(`/contracts/${contract.id}`, 'a contract'),
              ` on ${stamp(contract.signed_at)}.`,
            ),
          )
        : quote.status === 'presented' || quote.status === 'accepted'
          ? await signaturePanel(quote)
          : section(
              'Signing',
              h(
                'p',
                { class: 'empty' },
                'Present the quote to the customer before it can be signed.',
              ),
            ),
    ),
  );
}

/**
 * Signature capture — the screen this whole app exists to make possible.
 *
 * The required boxes are ticked here or the contract does not submit; the API
 * refuses it either way, and the error names which one is missing.
 */
async function signaturePanel(quote: Quote): Promise<HTMLElement> {
  const requirements = await api.get<ChecklistRequirement[]>('/checklist-requirements');
  const error = errorLine();
  const run = submitter(error, () => router.render());

  const boxes = new Map<string, HTMLInputElement>();
  const rows = requirements.map((requirement) => {
    const box = h('input', { type: 'checkbox', id: `chk-${requirement.code}` });
    boxes.set(requirement.code, box);
    return h(
      'div',
      { class: 'checkbox-row' },
      box,
      h(
        'label',
        { for: `chk-${requirement.code}` },
        requirement.label,
        requirement.is_required
          ? h('span', { class: 'required-flag' }, ' required')
          : null,
      ),
    );
  });

  const pad = signaturePad();

  const form = buildForm([
    { name: 'terms_version', label: 'Terms version', value: '2026-09-01', required: true },
    {
      name: 'payment_method_token',
      label: 'Processor token',
      placeholder: 'tok_… (never a card number)',
    },
    { name: 'payment_method_last4', label: 'Card last 4' },
    { name: 'payment_method_brand', label: 'Card brand', placeholder: 'visa' },
  ]);

  return section(
    'Sign at the door',
    h('div', { class: 'checklist' }, ...rows),
    h('p', { class: 'sig-label' }, 'Customer signature'),
    pad.node,
    form.node,
    error,
    h(
      'div',
      { class: 'actions' },
      run(
        'Capture signature',
        async () => {
          const values = form.values();

          // The signature is uploaded first: a contract without one is not a
          // contract, so there is no point sending the rest if this fails.
          const drawn = await pad.toBlob();
          if (!drawn) {
            throw new api.ApiError(
              400,
              'bad_request',
              'The customer needs to sign before this can be submitted',
              [],
            );
          }
          const signatureKey = await uploadBlob(
            'signature',
            drawn,
            `signature-${quote.id}.png`,
          );

          const contract = await api.post<Contract>('/contracts', {
            quote_id: quote.id,
            signature_image_url: signatureKey,
            terms_version: values.terms_version,
            payment_method_token: values.payment_method_token || null,
            payment_method_last4: values.payment_method_last4 || null,
            payment_method_brand: values.payment_method_brand || null,
            checklist: [...boxes].map(([item_code, box]) => ({
              item_code,
              checked: box.checked,
            })),
          });
          router.navigate(`/contracts/${contract.id}`);
        },
        'primary',
      ),
    ),
  );
}
