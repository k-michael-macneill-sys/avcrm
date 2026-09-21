import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  ChecklistRequirement,
  Contract,
  Customer,
  Property,
  Quote,
} from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { StatusPill } from '@/components/StatusPill';
import { Field, FieldList, Loading, ErrorNotice } from '@/components/Misc';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SignaturePad, type SignaturePadHandle } from '@/components/SignaturePad';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';
import * as api from '@/lib/api';
import { uploadBlob } from '@/lib/upload';
import { date, money, stamp } from '@/lib/format';

/** What a quote may move to next, mirroring the service's own table. */
const NEXT: Record<string, string[]> = {
  draft: ['presented', 'declined', 'expired'],
  presented: ['accepted', 'declined', 'expired'],
  accepted: [],
  declined: [],
  expired: [],
};

export function QuoteDetail(): JSX.Element {
  const { id = '' } = useParams();
  const { data, loading, error, reload } = useQuery(async () => {
    const quote = await api.get<Quote>(`/quotes/${id}`);
    const [property, contract] = await Promise.all([
      api.get<Property>(`/properties/${quote.property_id}`),
      api.get<Contract | null>(`/quotes/${id}/contract`),
    ]);
    const customer = await api.get<Customer>(`/customers/${property.customer_id}`);
    return { quote, property, contract, customer };
  }, [id]);

  const { run, pending, error: actionError } = useSubmit(reload);

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const { quote, property, contract, customer } = data;
  const moves = NEXT[quote.status] ?? [];
  const discount = Number(quote.initial_price) - Number(quote.discounted_price);

  return (
    <>
      <PageHeader
        title={property.address_line1}
        subtitle={`${customer.first_name} ${customer.last_name} — ${property.city}, ${property.province}`}
      />

      <Section title="Quote" className="mb-4">
        <FieldList>
          <Field label="Status">
            <StatusPill status={quote.status} />
          </Field>
          <Field label="Billing">{quote.billing_type.replace(/_/g, ' ')}</Field>
          <Field label="List price">{money(quote.initial_price)}</Field>
          <Field label="Sold at">{money(quote.discounted_price)}</Field>
          <Field label="Discount">{discount > 0 ? money(discount) : 'none'}</Field>
          <Field label="Season">
            {date(quote.season_start)} – {date(quote.season_end)}
          </Field>
          <Field label="Written">{stamp(quote.created_at)}</Field>
        </FieldList>
        {quote.notes ? (
          <p className="mt-3 rounded-lg bg-accent/40 px-3 py-2 text-sm text-secondary-foreground">
            {quote.notes}
          </p>
        ) : null}
        {actionError ? <ErrorNotice message={actionError} /> : null}
        {moves.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {moves.map((next) => (
              <Button
                key={next}
                type="button"
                variant={next === 'presented' ? 'default' : 'secondary'}
                disabled={pending}
                onClick={() => run(() => api.patch(`/quotes/${id}/status`, { status: next }))}
              >
                {next === 'presented' ? 'Mark presented' : `Mark ${next}`}
              </Button>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            This quote has been answered and is now frozen.
          </p>
        )}
      </Section>

      {contract ? (
        <Section title="Signed">
          <p className="text-sm">
            This quote became{' '}
            <Link className="text-primary hover:underline" to={`/contracts/${contract.id}`}>
              a contract
            </Link>{' '}
            on {stamp(contract.signed_at)}.
          </p>
        </Section>
      ) : quote.status === 'presented' || quote.status === 'accepted' ? (
        <SignaturePanel quote={quote} />
      ) : (
        <Section title="Signing">
          <p className="text-sm text-muted-foreground">
            Present the quote to the customer before it can be signed.
          </p>
        </Section>
      )}
    </>
  );
}

/**
 * Signature capture — the screen this whole app exists to make possible.
 *
 * The required boxes are ticked here or the contract does not submit; the
 * API refuses it either way, and the error names which one is missing.
 */
function SignaturePanel({ quote }: { quote: Quote }): JSX.Element {
  const navigate = useNavigate();
  const { data: requirements, loading, error } = useQuery(
    () => api.get<ChecklistRequirement[]>('/checklist-requirements'),
    [],
  );

  const padRef = React.useRef<SignaturePadHandle>(null);
  const [checked, setChecked] = React.useState<Record<string, boolean>>({});
  const [termsVersion, setTermsVersion] = React.useState('2026-09-01');
  const [token, setToken] = React.useState('');
  const [last4, setLast4] = React.useState('');
  const [brand, setBrand] = React.useState('');

  const { run, pending, error: submitError } = useSubmit(() => undefined);

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!requirements) return <Loading />;

  const onSubmit = (): void => {
    run(async () => {
      const drawn = await padRef.current?.toBlob();
      if (!drawn) {
        throw new api.ApiError(
          400,
          'bad_request',
          'The customer needs to sign before this can be submitted',
          [],
        );
      }
      const signatureKey = await uploadBlob('signature', drawn, `signature-${quote.id}.png`);

      const contract = await api.post<Contract>('/contracts', {
        quote_id: quote.id,
        signature_image_url: signatureKey,
        terms_version: termsVersion,
        payment_method_token: token || null,
        payment_method_last4: last4 || null,
        payment_method_brand: brand || null,
        checklist: requirements.map((r) => ({
          item_code: r.code,
          checked: checked[r.code] ?? false,
        })),
      });
      navigate(`/contracts/${contract.id}`);
    });
  };

  return (
    <Section title="Sign at the door">
      <div className="mb-4 flex flex-col gap-2">
        {requirements.map((requirement) => (
          <label key={requirement.code} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={checked[requirement.code] ?? false}
              onCheckedChange={(v) =>
                setChecked((c) => ({ ...c, [requirement.code]: v === true }))
              }
            />
            {requirement.label}
            {requirement.is_required ? (
              <span className="text-xs text-muted-foreground">required</span>
            ) : null}
          </label>
        ))}
      </div>

      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Customer signature
      </p>
      <SignaturePad ref={padRef} />

      <div className="mb-3 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="terms">Terms version</Label>
          <Input id="terms" value={termsVersion} onChange={(e) => setTermsVersion(e.target.value)} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="token">Processor token</Label>
          <Input
            id="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="tok_… (never a card number)"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="last4">Card last 4</Label>
          <Input id="last4" value={last4} onChange={(e) => setLast4(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brand">Card brand</Label>
          <Input id="brand" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="visa" />
        </div>
      </div>

      {submitError ? <ErrorNotice message={submitError} /> : null}
      <Button type="button" disabled={pending} onClick={onSubmit}>
        {pending ? 'Working…' : 'Capture signature'}
      </Button>
    </Section>
  );
}
