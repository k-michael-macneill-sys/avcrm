import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { CreditCard, FileText, Pencil, Printer, Upload } from 'lucide-react';
import type { Contract } from '../../../src/types/models';
import {
  agreementDateLabel,
  SIGNATURE_BOX_LABELS,
  SIGNATURE_BOXES,
  type AgreementModel,
  type SignatureBox,
} from '../../../src/types/serviceAgreement';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { ServiceAgreementDocument } from '@/components/ServiceAgreementDocument';
import { SignaturePad, type SignaturePadHandle } from '@/components/SignaturePad';
import { trimToInk } from '@/components/SignDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AgreementForm } from '@/lib/agreements';
import * as api from '@/lib/api';
import { isoDate } from '@/lib/format';
import { usePublicConfigState } from '@/lib/publicApi';
import { downloadDocument, openFile, uploadBlob } from '@/lib/upload';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';

/**
 * The agreement written from the contract form, for the customer to sign.
 *
 * Electronic: the customer draws their signature once, then taps each box to
 * sign it; a required box still empty has a red border. Signing locks the
 * PDF, stores it with the contract and emails the customer a copy.
 * Paper: print it, have it signed, upload the scan.
 */
export function AgreementSign(): JSX.Element {
  const { quoteId = '' } = useParams();
  const { data, loading, error, reload } = useQuery(
    () =>
      Promise.all([
        api.get<AgreementModel>(`/agreements/${quoteId}/document`),
        api.get<AgreementForm>(`/agreements/${quoteId}`),
      ]),
    [quoteId],
  );
  const [signed, setSigned] = React.useState<Contract | null>(null);
  // Signed at the bottom of a long document: bring them back up to what happens next.
  React.useEffect(() => {
    if (signed) window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [signed]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;
  const [model, form] = data;
  const contractId = signed?.id ?? form.contract_id;

  const header = (
    <PageHeader
      title={model.status === 'signed' || signed ? 'Signed agreement' : 'Review and sign'}
      subtitle={`${model.customer.name} · ${model.contract_type}`}
      actions={
        <>
          <Button asChild variant="secondary">
            <Link to={`/customers/${form.customer_id}`}>Back to customer</Link>
          </Button>
          {!contractId ? (
            <Button asChild variant="secondary">
              <Link to={`/agreements/${quoteId}/edit`}>
                <Pencil className="size-4" /> Edit
              </Link>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            onClick={() => void downloadDocument(`/agreements/${quoteId}/preview.pdf`, 'service-agreement.pdf')}
          >
            <Printer className="size-4" /> {contractId ? 'Unsigned PDF' : 'Print / PDF'}
          </Button>
        </>
      }
    />
  );

  if (contractId) {
    return (
      <>
        {header}
        <AfterSigning contractId={contractId} />
        <div className="mt-4">
          <ServiceAgreementDocument model={model} />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      {model.agreement_medium === 'paper' ? (
        <PaperUpload quoteId={quoteId} model={model} onDone={(c) => {
          setSigned(c);
          reload();
        }} />
      ) : (
        <ElectronicSigning quoteId={quoteId} model={model} onSigned={(c) => {
          setSigned(c);
          reload();
        }} />
      )}
    </>
  );
}

function ElectronicSigning({
  quoteId,
  model,
  onSigned,
}: {
  quoteId: string;
  model: AgreementModel;
  onSigned: (contract: Contract) => void;
}): JSX.Element {
  const required = SIGNATURE_BOXES.filter((box) => box !== 'card_authorization' || model.plan_kind !== 'seasonal_yia');
  const [signature, setSignature] = React.useState<{ blob: Blob; url: string } | null>(null);
  const [boxes, setBoxes] = React.useState<Record<SignatureBox, boolean>>({
    commitment: false,
    service_commitment: false,
    card_authorization: false,
  });
  const [signerName, setSignerName] = React.useState(model.customer.name);
  const [drawingFor, setDrawingFor] = React.useState<SignatureBox | null>(null);
  const { run, pending, error } = useSubmit();
  const missing = required.filter((box) => !boxes[box]);

  const onBoxClick = (box: SignatureBox): void => {
    if (boxes[box]) setBoxes((b) => ({ ...b, [box]: false }));
    else if (signature) setBoxes((b) => ({ ...b, [box]: true }));
    else setDrawingFor(box);
  };

  const submit = () =>
    run(async () => {
      const key = await uploadBlob('signature', signature!.blob, 'signature.png');
      const where = await position();
      const contract = await api.post<Contract>(`/agreements/${quoteId}/sign`, {
        signature_key: key,
        signer_name: signerName,
        boxes: SIGNATURE_BOXES.filter((box) => boxes[box]),
        signed_lat: where?.lat ?? null,
        signed_lng: where?.lng ?? null,
      });
      onSigned(contract);
    });

  return (
    <div className="flex flex-col gap-4">
      <ServiceAgreementDocument
        model={model}
        signing={{
          signatureUrl: signature?.url ?? null,
          signed: boxes,
          required,
          signerName,
          dateLabel: agreementDateLabel(isoDate()),
          onBoxClick,
        }}
      />

      <Section title="Sign">
        <div className="flex flex-col gap-3">
          <div className="flex max-w-sm flex-col gap-1.5">
            <Label htmlFor="signer">Signer's full name</Label>
            <Input id="signer" value={signerName} onChange={(e) => setSignerName(e.target.value)} />
          </div>
          <p className="text-sm text-muted-foreground">
            {missing.length
              ? `Still to sign: ${missing.map((box) => SIGNATURE_BOX_LABELS[box].split(' — ')[1] ?? box).join(', ')}. Tap each box on the agreement.`
              : 'Every required box is signed.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {signature ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setSignature(null);
                  setBoxes({ commitment: false, service_commitment: false, card_authorization: false });
                }}
              >
                Clear signature
              </Button>
            ) : null}
            <Button type="button" disabled={pending || missing.length > 0 || !signature || !signerName.trim()} onClick={submit}>
              {pending ? 'Signing…' : 'Sign agreement'}
            </Button>
          </div>
          {error ? <ErrorNotice message={error} /> : null}
        </div>
      </Section>

      <DrawDialog
        box={drawingFor}
        onClose={() => setDrawingFor(null)}
        onDrawn={(drawn) => {
          setSignature(drawn);
          if (drawingFor) setBoxes((b) => ({ ...b, [drawingFor]: true }));
          setDrawingFor(null);
        }}
      />
    </div>
  );
}

/** Where the rep is standing, if the device will say within a few seconds. */
function position(): Promise<{ lat: number; lng: number } | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { timeout: 4000, maximumAge: 60_000 },
    );
  });
}

function DrawDialog({
  box,
  onClose,
  onDrawn,
}: {
  box: SignatureBox | null;
  onClose: () => void;
  onDrawn: (signature: { blob: Blob; url: string }) => void;
}): JSX.Element {
  const pad = React.useRef<SignaturePadHandle>(null);
  const [empty, setEmpty] = React.useState(false);
  return (
    <Dialog open={!!box} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Customer signature</DialogTitle>
          <DialogDescription>
            Draw your signature once. It is placed in this box, and you tap each other box on the agreement to sign it
            too.
          </DialogDescription>
        </DialogHeader>
        <SignaturePad ref={pad} />
        {empty ? <p className="text-sm text-critical">Sign in the box first.</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => pad.current?.clear()}>
            Clear
          </Button>
          <Button
            type="button"
            onClick={async () => {
              const drawn = pad.current?.isEmpty() ? null : await pad.current?.toBlob();
              if (!drawn) return setEmpty(true);
              setEmpty(false);
              const blob = await trimToInk(drawn);
              onDrawn({ blob, url: URL.createObjectURL(blob) });
            }}
          >
            Sign
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PaperUpload({
  quoteId,
  model,
  onDone,
}: {
  quoteId: string;
  model: AgreementModel;
  onDone: (contract: Contract) => void;
}): JSX.Element {
  const [file, setFile] = React.useState<File | null>(null);
  const [signerName, setSignerName] = React.useState(model.customer.name);
  const { run, pending, error } = useSubmit();
  return (
    <div className="flex flex-col gap-4">
      <Section title="Paper agreement">
        <ol className="mb-4 ml-5 list-decimal text-sm text-muted-foreground">
          <li>Print the agreement (Print / PDF above) and have the customer sign every signature box.</li>
          <li>Scan or photograph it as a PDF and upload it here. The scan becomes the contract's document.</li>
        </ol>
        <div className="grid max-w-xl gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="paper-signer">Signed by</Label>
            <Input id="paper-signer" value={signerName} onChange={(e) => setSignerName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scan">Signed agreement (PDF)</Label>
            <Input id="scan" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <Button
            type="button"
            className="w-fit"
            disabled={pending || !file || !signerName.trim()}
            onClick={() =>
              run(async () => {
                const key = await uploadBlob('contract_pdf', file!, file!.name);
                onDone(await api.post<Contract>(`/agreements/${quoteId}/paper`, { pdf_key: key, signer_name: signerName }));
              })
            }
          >
            <Upload className="size-4" /> {pending ? 'Uploading…' : 'Upload signed agreement'}
          </Button>
          {error ? <ErrorNotice message={error} /> : null}
        </div>
      </Section>
      <ServiceAgreementDocument model={model} />
    </div>
  );
}

/** Signed: the locked PDF, then the card for autopay, the same way every sign-up takes it. */
function AfterSigning({ contractId }: { contractId: string }): JSX.Element {
  const contract = useQuery(() => api.get<Contract>(`/contracts/${contractId}`), [contractId]);
  const { config, error: configError } = usePublicConfigState();
  const [cardUrl, setCardUrl] = React.useState<string | null>(null);
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const { run, pending, error } = useSubmit();
  const c = contract.data;

  return (
    <Section title="Signed">
      <div className="flex flex-col gap-3 text-sm">
        <p>
          {c?.agreement_medium === 'paper'
            ? 'The signed paper agreement is on file with the contract.'
            : 'The agreement is signed and locked. A copy has been emailed to the customer if they have an email on file.'}
        </p>
        <div className="flex flex-wrap gap-2">
          {c?.pdf_url ? (
            <Button type="button" variant="secondary" onClick={() => void openFile(c.pdf_url!, 'Drift-Service-Agreement.pdf')}>
              <FileText className="size-4" /> Signed agreement (PDF)
            </Button>
          ) : null}
          <Button asChild variant="secondary">
            <Link to={`/contracts/${contractId}`}>Open the contract</Link>
          </Button>
        </div>
        {c?.payment_method_last4 ? (
          <p>
            Card on file: {c.payment_method_brand ?? 'card'} ending {c.payment_method_last4}.
          </p>
        ) : configError ? (
          <ErrorNotice message={configError} />
        ) : config && !config.card_capture ? (
          <p className="text-muted-foreground">
            Card payments are not connected yet, so the office will follow up for the card. (Connect Square to take cards
            here.)
          </p>
        ) : cardUrl ? (
          <div className="flex flex-col gap-2">
            <a
              className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground shadow-glow"
              href={cardUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <CreditCard className="size-4" /> Open card form on this device
            </a>
            <p className="text-muted-foreground">
              Hand them the device, or they can use the link we {sentTo ? `sent to ${sentTo}` : 'sent them'}. The card is
              typed on the payment provider's page, never here.
            </p>
          </div>
        ) : (
          <div>
            <p className="mb-2 text-muted-foreground">Next, the card for autopay. It opens the payment provider's secure page.</p>
            <Button
              type="button"
              disabled={pending || !config}
              onClick={() =>
                run(async () => {
                  const result = await api.post<{ url: string; sent_to: string | null }>('/card-setups', {
                    contract_id: contractId,
                  });
                  setCardUrl(result.url);
                  setSentTo(result.sent_to);
                })
              }
            >
              <CreditCard className="size-4" /> {pending ? 'Opening…' : 'Add card'}
            </Button>
          </div>
        )}
        {error ? <ErrorNotice message={error} /> : null}
      </div>
    </Section>
  );
}
