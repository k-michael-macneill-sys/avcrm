import * as React from 'react';
import { useParams } from 'react-router-dom';
import logo from '@/assets/drift-logo.jpg';
import { ErrorNotice, Loading } from '@/components/Misc';
import type { AgreementValues } from '../../../src/types/agreement';
import { AgreementPdf } from '@/components/AgreementPdf';
import { SignDialog, type Signature } from '@/components/SignDialog';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { publicGet, publicPost } from '@/lib/publicApi';
import { ThemeToggle } from '@/theme/ThemeToggle';
import { DrawSignatureDialog } from '@/components/DrawSignatureDialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ServiceAgreementDocument } from '@/components/ServiceAgreementDocument';
import {
  agreementDateLabel,
  SIGNATURE_BOXES,
  type AgreementModel,
  type SignatureBox,
} from '../../../src/types/serviceAgreement';
import { isoDate } from '@/lib/format';

/**
 * The page an emailed agreement link opens. No account, no navigation:
 * what they are agreeing to, the boxes to confirm, a signature, and then on
 * to the payment provider's page for the card.
 */

interface Invitation {
  customer_first_name: string;
  customer_name: string;
  branch_name: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  province: string;
  postal_code: string;
  billing_type: string;
  initial_price: string;
  discounted_price: string;
  recurring_price: string | null;
  season_start: string;
  season_end: string;
  addon_salt: boolean;
  addon_vehicle: boolean;
  addon_stairs: boolean;
  terms_version: string;
  checklist: { code: string; label: string; is_required: boolean }[];
  agreement: AgreementValues;
  /** A service agreement from the contract form, drawn and signed box by box. */
  service_agreement: AgreementModel | null;
  required_boxes: SignatureBox[];
}

export function Sign(): JSX.Element {
  const { token = '' } = useParams();
  const [invitation, setInvitation] = React.useState<Invitation | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    publicGet<Invitation>(`/public/sign/${encodeURIComponent(token)}`)
      .then(setInvitation)
      .catch((err: unknown) => setLoadError(err instanceof ApiError ? err.message : 'That link did not work'));
  }, [token]);

  return (
    <div className="min-h-screen px-4 py-8">
      <div className={invitation?.service_agreement ? 'mx-auto w-full max-w-4xl' : 'mx-auto w-full max-w-3xl'}>
        <div className="mb-6 flex items-center justify-between">
          <img src={logo} alt="Drift Property Services" className="h-12 w-auto rounded-md" />
          <ThemeToggle />
        </div>
        {loadError ? (
          <Panel>
            <h1 className="text-xl font-semibold">This link can't be used</h1>
            <p className="mt-2 text-sm text-muted-foreground">{loadError}.</p>
            {/already been signed/i.test(loadError) ? null : (
              <p className="mt-2 text-sm text-muted-foreground">
                If you still need to sign, reply to the email and we will send a fresh one.
              </p>
            )}
          </Panel>
        ) : invitation?.service_agreement ? (
          <ServiceAgreementSigning token={token} invitation={invitation} model={invitation.service_agreement} />
        ) : invitation ? (
          <Agreement token={token} invitation={invitation} />
        ) : (
          <Loading />
        )}
      </div>
    </div>
  );
}

function Agreement({ token, invitation: inv }: { token: string; invitation: Invitation }): JSX.Element {
  const [signature, setSignature] = React.useState<Signature | null>(null);
  const [signing, setSigning] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    if (!signature) {
      setError('Please sign on the “Customer signature” line — tap it to open the signing pad.');
      return;
    }
    setPending(true);
    try {
      const result = await publicPost<{ contract_id: string; card_url: string | null }>(
        `/public/sign/${encodeURIComponent(token)}`,
        { signature_png: await toDataUrl(signature.blob), confirmed: [] },
      );
      if (result.card_url) {
        window.location.assign(result.card_url);
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not go through. Please try again.');
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return (
      <Panel>
        <h1 className="text-xl font-semibold">Thanks, {inv.customer_first_name} — you're signed up</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your agreement for {inv.address_line1} is signed. {inv.branch_name} will be in touch about payment. You can close
          this page.
        </p>
      </Panel>
    );
  }

  return (
    <>
      <Panel>
        <h1 className="text-2xl font-semibold tracking-tight">Your snow removal agreement</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          For {inv.customer_name} · {inv.branch_name}. Read it through, then tap the highlighted “Customer signature”
          line to sign.
        </p>
      </Panel>

      <div className="my-4">
        <AgreementPdf
          values={inv.agreement}
          signatures={{ customer_signature: signature?.url ?? null }}
          onSign={() => setSigning(true)}
          invalid={error && !signature ? ['customer_signature'] : []}
        />
      </div>

      <Panel>
        <p className="text-xs text-muted-foreground">
          By signing you agree to this agreement, including the Terms & Conditions on page 2. Next you'll add a card on
          our payment provider's secure page — we never see your card number.
        </p>
        {error ? <div className="mt-4"><ErrorNotice message={error} /></div> : null}
        <Button type="button" className="mt-5 w-full" disabled={pending} onClick={() => void submit()}>
          {pending ? 'Signing…' : 'Sign and continue to payment'}
        </Button>
      </Panel>

      <SignDialog
        field={signing ? 'customer_signature' : null}
        onClose={() => setSigning(false)}
        onSigned={(_field, sig) => {
          setSignature(sig);
          setSigning(false);
          setError(null);
        }}
        onClear={() => {
          setSignature(null);
          setSigning(false);
        }}
        hasSignature={!!signature}
      />
    </>
  );
}

/** The service agreement from the contract form: draw once, tap each box, then on to the card. */
function ServiceAgreementSigning({
  token,
  invitation: inv,
  model,
}: {
  token: string;
  invitation: Invitation;
  model: AgreementModel;
}): JSX.Element {
  const [signature, setSignature] = React.useState<{ blob: Blob; url: string } | null>(null);
  const [boxes, setBoxes] = React.useState<Record<SignatureBox, boolean>>({
    commitment: false,
    service_commitment: false,
    card_authorization: false,
  });
  const [drawingFor, setDrawingFor] = React.useState<SignatureBox | null>(null);
  const [signerName, setSignerName] = React.useState(model.customer.name);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const missing = inv.required_boxes.filter((box) => !boxes[box]);

  const submit = async (): Promise<void> => {
    setError(null);
    if (!signature || missing.length) {
      setError('Please sign every box outlined in red — tap a box to sign it.');
      return;
    }
    setPending(true);
    try {
      const result = await publicPost<{ contract_id: string; card_url: string | null }>(
        `/public/sign/${encodeURIComponent(token)}`,
        {
          signature_png: await toDataUrl(signature.blob),
          confirmed: [],
          boxes: SIGNATURE_BOXES.filter((box) => boxes[box]),
          signer_name: signerName,
        },
      );
      if (result.card_url && model.plan_kind !== 'seasonal_yia') {
        window.location.assign(result.card_url);
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not go through. Please try again.');
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return (
      <Panel>
        <h1 className="text-xl font-semibold">Thanks, {inv.customer_first_name} — you're signed up</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your agreement for {inv.address_line1} is signed, and a copy is on its way to your email. {inv.branch_name} will
          be in touch about anything else. You can close this page.
        </p>
      </Panel>
    );
  }

  return (
    <>
      <Panel>
        <h1 className="text-2xl font-semibold tracking-tight">Your snow removal agreement</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          For {inv.customer_name} · {inv.branch_name}. Read it through, then tap each signature box outlined in red to sign
          it. You draw your signature once.
        </p>
      </Panel>

      <div className="my-4">
        <ServiceAgreementDocument
          model={model}
          signing={{
            signatureUrl: signature?.url ?? null,
            signed: boxes,
            required: inv.required_boxes,
            signerName,
            dateLabel: agreementDateLabel(isoDate()),
            onBoxClick: (box) => {
              if (boxes[box]) setBoxes((b) => ({ ...b, [box]: false }));
              else if (signature) setBoxes((b) => ({ ...b, [box]: true }));
              else setDrawingFor(box);
            },
          }}
        />
      </div>

      <Panel>
        <div className="flex max-w-sm flex-col gap-1.5">
          <Label htmlFor="signer">Your full name</Label>
          <Input id="signer" value={signerName} onChange={(e) => setSignerName(e.target.value)} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          By signing you agree to this agreement, including the terms and conditions.{' '}
          {model.plan_kind === 'seasonal_yia'
            ? ''
            : "Next you'll add a card on our payment provider's secure page — we never see your card number."}
        </p>
        <p className="mt-2 text-sm">
          {missing.length ? `${missing.length} signature box${missing.length === 1 ? '' : 'es'} still to sign.` : 'Every box is signed.'}
        </p>
        {error ? (
          <div className="mt-4">
            <ErrorNotice message={error} />
          </div>
        ) : null}
        <Button type="button" className="mt-5 w-full" disabled={pending || !signerName.trim()} onClick={() => void submit()}>
          {pending ? 'Signing…' : model.plan_kind === 'seasonal_yia' ? 'Sign agreement' : 'Sign and continue to payment'}
        </Button>
      </Panel>

      <DrawSignatureDialog
        box={drawingFor}
        onClose={() => setDrawingFor(null)}
        onDrawn={(drawn) => {
          setSignature(drawn);
          if (drawingFor) setBoxes((b) => ({ ...b, [drawingFor]: true }));
          setDrawingFor(null);
          setError(null);
        }}
      />
    </>
  );
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function Panel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="glass-card rounded-2xl border border-border bg-card/60 p-6 shadow-2xl backdrop-blur-xl sm:p-8">
      {children}
    </div>
  );
}

