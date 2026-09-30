import * as React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FileText, Mail, PenLine } from 'lucide-react';
import {
  CURRENT_TERMS_VERSION,
  type Branch,
  type Contract,
  type Customer,
  type Property,
  type Quote,
} from '../../../src/types/models';
import { defaultAgreementYears, type AgreementValues } from '../../../src/types/agreement';
import { useAuth } from '@/auth/AuthContext';
import { AgreementPdf, type SignatureField } from '@/components/AgreementPdf';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { SignDialog, type Signature } from '@/components/SignDialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import * as api from '@/lib/api';
import { usePublicConfig } from '@/lib/publicApi';
import { openFile, uploadBlob } from '@/lib/upload';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';

/**
 * Signing up a customer on the company's own agreement. The rep fills the
 * PDF in by tapping its fields, the customer signs on its signature line, and
 * the server prints both into the signed copy it keeps with the contract.
 * Nothing is written until the agreement is signed or sent for signing.
 */

interface Deal {
  customer: Customer;
  property: Property;
  quote: Quote;
}


export function NewCustomer(): JSX.Element {
  const { isCorporate } = useAuth();
  const [params] = useSearchParams();
  const leadId = params.get('lead');

  const { data, loading, error } = useQuery(
    () =>
      Promise.all([
        api.get<Branch[]>('/branches'),
        leadId ? api.get<Customer>(`/customers/${leadId}`) : Promise.resolve(null),
      ]),
    [leadId],
  );

  if (loading || !data) return error ? <ErrorNotice message={error} /> : <Loading />;
  const [branches, lead] = data;

  if (branches.length === 0) {
    return (
      <>
        <PageHeader title="Add customer" />
        <p className="text-sm text-muted-foreground">
          {isCorporate ? (
            <>
              There are no branches yet. <Link className="text-primary hover:underline" to="/admin">Add one under Company</Link>{' '}
              first — every customer belongs to a branch.
            </>
          ) : (
            'Your account is not attached to a branch yet. Ask the office to add you to one.'
          )}
        </p>
      </>
    );
  }

  return <AgreementSignup branches={branches} lead={lead} prefill={params} />;
}

function startingValues(lead: Customer | null, prefill: URLSearchParams, branch: Branch | undefined): AgreementValues {
  return {
    customer_name: lead ? `${lead.first_name} ${lead.last_name}`.trim() : '',
    customer_email: lead?.email ?? '',
    customer_phone: lead?.phone ?? '',
    // The map hands an address over when a rep taps a house.
    customer_street: prefill.get('address_line1') ?? '',
    customer_city: prefill.get('city') ?? '',
    customer_province: prefill.get('province') ?? branch?.province ?? '',
    customer_postal: prefill.get('postal_code') ?? '',
    ...defaultAgreementYears(),
  };
}

function AgreementSignup({
  branches,
  lead,
  prefill,
}: {
  branches: Branch[];
  lead: Customer | null;
  prefill: URLSearchParams;
}): JSX.Element {
  const { isCorporate } = useAuth();
  const [branchId, setBranchId] = React.useState(lead?.branch_id ?? branches[0]?.id ?? '');
  const [values, setValues] = React.useState<AgreementValues>(() => startingValues(lead, prefill, branches[0]));
  const [signatures, setSignatures] = React.useState<Partial<Record<SignatureField, Signature>>>({});
  const [signing, setSigning] = React.useState<SignatureField | null>(null);
  const [invalid, setInvalid] = React.useState<string[]>([]);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [contract, setContract] = React.useState<Contract | null>(null);
  const [emailed, setEmailed] = React.useState<{ url: string; sent_to: string; quote: Quote } | null>(null);

  // The deal already written for these exact values, so a retry after a
  // failed signature upload does not write a second one.
  const written = React.useRef<{ key: string; deal: Deal } | null>(null);

  const edit = (next: AgreementValues): void => {
    setValues(next);
    if (invalid.length) setInvalid([]);
    setProblem(null);
  };

  const ensureDeal = async (): Promise<Deal> => {
    const key = JSON.stringify(values);
    if (written.current?.key === key) return written.current.deal;

    // Written for different values, then changed: that quote is withdrawn
    // and the same customer carried over rather than duplicated.
    const earlier = written.current?.deal;
    if (earlier) await api.del(`/quotes/${earlier.quote.id}`).catch(() => undefined);

    const params = new URLSearchParams(window.location.search);
    const number = (name: string): number | null => {
      const n = Number(params.get(name));
      return params.get(name) !== null && Number.isFinite(n) ? n : null;
    };
    const deal = await api.post<Deal>('/sales/agreement-deals', {
      agreement: values,
      ...(lead ? { customer_id: lead.id } : earlier ? { customer_id: earlier.customer.id } : {}),
      ...(isCorporate && !lead ? { branch_id: branchId } : {}),
      ...(params.get('pin') ? { lead_pin_id: params.get('pin') } : {}),
      latitude: number('lat'),
      longitude: number('lng'),
    });
    written.current = { key, deal };
    return deal;
  };

  const attempt = async (work: () => Promise<void>): Promise<void> => {
    setPending(true);
    setProblem(null);
    setInvalid([]);
    try {
      await work();
    } catch (err) {
      if (err instanceof api.ApiError) {
        const fields = err.details.map((d) => d.path?.replace(/^agreement\./, '')).filter((p): p is string => !!p);
        setInvalid(fields);
        setProblem(err.message);
      } else {
        setProblem(String(err));
      }
    } finally {
      setPending(false);
    }
  };

  const saveSigned = (): void => {
    const customer = signatures.customer_signature;
    if (!customer) {
      setInvalid(['customer_signature']);
      setProblem('The customer signs on the “Customer signature” line first — tap it to open the signing pad.');
      return;
    }
    void attempt(async () => {
      const deal = await ensureDeal();
      const customerKey = await uploadBlob('signature', customer.blob, `signature-${deal.quote.id}.png`);
      const provider = signatures.provider_signature;
      const providerKey = provider
        ? await uploadBlob('signature', provider.blob, `provider-signature-${deal.quote.id}.png`)
        : null;
      setContract(
        await api.post<Contract>('/contracts', {
          quote_id: deal.quote.id,
          signature_image_url: customerKey,
          provider_signature_image_url: providerKey,
          terms_version: CURRENT_TERMS_VERSION,
          checklist: [],
        }),
      );
    });
  };

  const emailForSigning = (): void => {
    if (!String(values.customer_email ?? '').trim()) {
      setInvalid(['customer_email']);
      setProblem('Add the customer’s email on the agreement to send it to them.');
      return;
    }
    void attempt(async () => {
      const deal = await ensureDeal();
      const sent = await api.post<{ url: string; sent_to: string }>(`/sales/quotes/${deal.quote.id}/signing-request`);
      setEmailed({ ...sent, quote: deal.quote });
    });
  };

  if (contract) return <AfterSigning contract={contract} />;
  if (emailed) return <EmailSent sent={emailed} />;

  return (
    <>
      <PageHeader
        title={lead ? `Sign up ${lead.first_name} ${lead.last_name}` : 'Add customer'}
        subtitle="Tap any field on the agreement to fill it in. The customer signs on the line at the bottom."
      />

      {isCorporate && !lead && branches.length > 1 ? (
        <div className="mb-4 flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="branch">Branch</Label>
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger id="branch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-3xl">
        <AgreementPdf
          values={values}
          onChange={edit}
          signatures={{
            customer_signature: signatures.customer_signature?.url ?? null,
            provider_signature: signatures.provider_signature?.url ?? null,
          }}
          onSign={setSigning}
          invalid={invalid}
        />
      </div>

      <div className="sticky bottom-0 z-10 mx-auto mt-4 w-full max-w-3xl rounded-xl border border-border bg-background/95 p-3 backdrop-blur max-[720px]:bottom-[calc(4.5rem+env(safe-area-inset-bottom))]">
        {problem ? (
          <div className="mb-3">
            <ErrorNotice message={problem} />
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={pending} onClick={emailForSigning}>
            <Mail className="size-4" /> Email it to them to sign
          </Button>
          <Button type="button" disabled={pending} onClick={saveSigned}>
            <PenLine className="size-4" /> {pending ? 'Saving…' : 'Save signed agreement'}
          </Button>
        </div>
      </div>

      <SignDialog
        field={signing}
        onClose={() => setSigning(null)}
        onSigned={(field, signature) => {
          setSignatures((s) => ({ ...s, [field]: signature }));
          setInvalid((i) => i.filter((f) => f !== field));
          setProblem(null);
          setSigning(null);
        }}
        onClear={(field) => {
          setSignatures((s) => ({ ...s, [field]: undefined }));
          setSigning(null);
        }}
        hasSignature={!!(signing && signatures[signing])}
      />
    </>
  );
}

function EmailSent({ sent }: { sent: { url: string; sent_to: string; quote: Quote } }): JSX.Element {
  const [copied, setCopied] = React.useState(false);
  return (
    <>
      <PageHeader title="Agreement sent" />
      <Section title="Email completion">
        <p className="text-sm text-foreground">
          Sent to <strong>{sent.sent_to}</strong>. They open the same agreement, sign it on the line, and set up card
          autopay. The link works for 14 days and stops working once used.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">The customer shows as active once they sign.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(sent.url).then(() => setCopied(true));
            }}
          >
            {copied ? 'Link copied' : 'Copy link to text it'}
          </Button>
          <Button asChild variant="secondary">
            <Link to={`/quotes/${sent.quote.id}`}>Open the quote</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/customers/new" reloadDocument>
              Add another customer
            </Link>
          </Button>
        </div>
      </Section>
    </>
  );
}

/** Signed: the document, then the card for autopay. */
function AfterSigning({ contract }: { contract: Contract }): JSX.Element {
  const config = usePublicConfig();
  const [cardUrl, setCardUrl] = React.useState<string | null>(null);
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const { run, pending, error } = useSubmit();

  return (
    <>
      <PageHeader title="Agreement signed" />
      <Section title="Signed">
        <p className="mb-3 text-sm text-foreground">
          The agreement is signed and saved with the contract.{' '}
          <Link className="text-primary hover:underline" to={`/contracts/${contract.id}`}>
            Open the contract
          </Link>
        </p>
        {contract.pdf_url ? (
          <Button
            type="button"
            variant="secondary"
            className="mb-5"
            onClick={() => void openFile(contract.pdf_url!, 'signed-agreement.pdf')}
          >
            <FileText className="size-4" /> Download signed agreement (PDF)
          </Button>
        ) : null}

        {config && !config.card_capture ? (
          <p className="text-sm text-muted-foreground">
            Card payments are not connected yet, so the office will follow up for the card. (Connect Square to take
            cards here.)
          </p>
        ) : cardUrl ? (
          <div className="flex flex-col gap-2 text-sm">
            <a
              className="inline-flex w-fit items-center rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground shadow-glow"
              href={cardUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open card form on this device
            </a>
            <p className="text-muted-foreground">
              Hand them the phone, or they can use the link we {sentTo ? `sent to ${sentTo}` : 'sent them'}. The card
              is typed on the payment provider's page, never here.
            </p>
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              Next, the card for autopay. It opens the payment provider's secure page.
            </p>
            <Button
              type="button"
              disabled={pending || !config}
              onClick={() =>
                run(async () => {
                  const result = await api.post<{ url: string; sent_to: string | null }>('/card-setups', {
                    contract_id: contract.id,
                  });
                  setCardUrl(result.url);
                  setSentTo(result.sent_to);
                })
              }
            >
              {pending ? 'Opening…' : 'Add card'}
            </Button>
          </>
        )}

        {error ? (
          <div className="mt-3">
            <ErrorNotice message={error} />
          </div>
        ) : null}
        <div className="mt-6 flex gap-2">
          <Button asChild variant="secondary">
            <Link to="/customers/new" reloadDocument>
              Add another customer
            </Link>
          </Button>
        </div>
      </Section>
    </>
  );
}
