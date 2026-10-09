import * as React from 'react';
import { Check, PenLine } from 'lucide-react';
import {
  BILLING_SCHEDULE_SMALL_PRINT,
  COMPANY,
  COOLING_OFF_BANNER,
  SIGNATURE_BOX_LABELS,
  type AgreementModel,
  type SignatureBox,
} from '../../../src/types/serviceAgreement';
import logo from '@/assets/drift-logo.jpg';
import { cn } from '@/lib/utils';

/**
 * The service agreement on screen, section for section the same as the PDF
 * the server prints from the same model. It is a document rather than part
 * of the CRM, so it keeps its own navy-on-white look whatever theme the app
 * is in.
 *
 * With `signing`, the signature boxes are live: light blue, a red border on
 * one that is required and still empty, and a tap to sign.
 */

export interface SigningState {
  /** The customer's drawn signature, once they have drawn it. */
  signatureUrl: string | null;
  signed: Record<SignatureBox, boolean>;
  required: SignatureBox[];
  signerName: string;
  dateLabel: string;
  onBoxClick: (box: SignatureBox) => void;
}

const NAVY = '#1b2a4a';

function Bar({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-white" style={{ background: NAVY }}>
      {children}
    </div>
  );
}

function Box({ checked }: { checked: boolean }): JSX.Element {
  return (
    <span
      className="inline-flex size-3.5 shrink-0 items-center justify-center border"
      style={{ borderColor: NAVY }}
      aria-hidden="true"
    >
      {checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

function Checks({ items }: { items: { label: string; checked: boolean }[] }): JSX.Element {
  return (
    <ul className="grid gap-x-6 gap-y-1 py-2 sm:grid-cols-2">
      {items.map((item) => (
        <li key={item.label} className={cn('flex items-center gap-2', item.checked && 'font-semibold')}>
          <Box checked={item.checked} />
          <span>
            {item.label}
            <span className="sr-only">{item.checked ? ' (selected)' : ' (not selected)'}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ValueLine({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-end justify-between gap-3 py-0.5">
      <span className="font-semibold">{label}</span>
      <span className="min-w-[45%] border-b text-right" style={{ borderColor: '#9aa6bf' }}>
        {value || ' '}
      </span>
    </div>
  );
}

function SignatureArea({
  box,
  model,
  signing,
}: {
  box: SignatureBox;
  model: AgreementModel;
  signing?: SigningState;
}): JSX.Element {
  const signed = signing ? signing.signed[box] : model.boxes[box];
  const required = signing?.required.includes(box) ?? false;
  const name = signing ? signing.signerName : model.status === 'signed' ? model.signer_name : '';
  const date = signed ? (signing ? signing.dateLabel : (model.signed_date_label ?? '')) : '';

  const area = (
    <div
      className={cn(
        'relative flex h-16 items-center justify-center border-2',
        signing && required && !signed ? 'border-red-600' : 'border-[#1b2a4a]',
      )}
      style={{ background: '#e8f1fb' }}
    >
      <span className="absolute left-1.5 top-0.5 text-[9px] uppercase tracking-wide text-[#5a6782]">
        {SIGNATURE_BOX_LABELS[box].split(' — ')[0]}
        {signing && required ? ' *' : ''}
      </span>
      {signed && signing?.signatureUrl ? (
        <img src={signing.signatureUrl} alt="Signature" className="max-h-12 max-w-[85%] object-contain" />
      ) : signed ? (
        <span className="text-xs italic text-[#5a6782]">Signed electronically</span>
      ) : signing ? (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1b2a4a]">
          <PenLine className="size-3.5" /> Tap to sign
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-1">
      {signing ? (
        <button
          type="button"
          className="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1b2a4a]"
          onClick={() => signing.onBoxClick(box)}
          aria-label={`${SIGNATURE_BOX_LABELS[box]}${signed ? ' (signed — tap to remove)' : ''}`}
        >
          {area}
        </button>
      ) : (
        area
      )}
      <ValueLine label="Name" value={name} />
      <ValueLine label="Date" value={date} />
    </div>
  );
}

export function ServiceAgreementDocument({
  model,
  signing,
}: {
  model: AgreementModel;
  signing?: SigningState;
}): JSX.Element {
  const seasons = [...new Set(model.schedule.map((s) => s.season))];

  return (
    <article
      className="mx-auto w-full max-w-[860px] space-y-3 rounded-sm bg-white p-4 text-[12.5px] leading-snug shadow-xl sm:p-6"
      style={{ color: NAVY }}
      aria-label="Service agreement"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 p-2" style={{ background: NAVY }}>
        <img src={logo} alt={COMPANY.name} className="h-14 w-auto" />
        <div className="text-right text-white">
          <h2 className="text-lg font-bold">SNOW REMOVAL SERVICE AGREEMENT</h2>
          <p className="text-[11px]">{model.contract_type}</p>
          <p className="text-[11px]">
            {model.plan_label} · {model.branch_name} · Ref {model.quote_id.slice(0, 8).toUpperCase()}
          </p>
        </div>
      </header>

      {/* 1 */}
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ['Customer & Service Location', model.customer],
            ['Customer & Billing Address', model.billing],
          ] as const
        ).map(([title, who]) => (
          <section key={title} className="border" style={{ borderColor: NAVY }}>
            <Bar>{title}</Bar>
            <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-0.5 p-2">
              <dt className="text-[10px] font-bold uppercase text-[#5a6782]">Name</dt>
              <dd>{who.name}</dd>
              <dt className="text-[10px] font-bold uppercase text-[#5a6782]">Email</dt>
              <dd className="break-all">{who.email ?? ''}</dd>
              <dt className="text-[10px] font-bold uppercase text-[#5a6782]">Phone</dt>
              <dd>{who.phone ?? ''}</dd>
              <dt className="text-[10px] font-bold uppercase text-[#5a6782]">Address</dt>
              <dd>
                {who.address.map((line) => (
                  <span key={line} className="block">
                    {line}
                  </span>
                ))}
              </dd>
            </dl>
          </section>
        ))}
      </div>

      {/* 2 */}
      <section>
        <Bar>Scope of Service</Bar>
        <Checks items={model.scope} />
        <p className="text-[11px] text-[#5a6782]">{model.service_summary}</p>
      </section>

      {/* 3 */}
      <section>
        <Bar>Available Additional Services</Bar>
        <Checks items={model.addons.map((a) => ({ label: a.price ? `${a.label} — ${a.price}` : a.label, checked: a.checked }))} />
      </section>

      {/* 4 */}
      <section>
        <Bar>Billing Schedule</Bar>
        <p className="flex flex-wrap items-center gap-x-5 gap-y-1 py-2 font-semibold">
          <span>LENGTH OF THE AGREEMENT:</span>
          {(
            [
              ['1 SEASON', model.length.one],
              ['2 SEASONS', model.length.two],
              [model.length.other && model.length.other_label ? `OTHER: ${model.length.other_label}` : 'OTHER', model.length.other],
            ] as const
          ).map(([label, checked]) => (
            <span key={label} className={cn('inline-flex items-center gap-1.5', !checked && 'font-normal')}>
              <Box checked={checked} /> {label}
            </span>
          ))}
        </p>
        <p className="text-[11px] italic text-[#5a6782]">{BILLING_SCHEDULE_SMALL_PRINT}</p>
      </section>

      {/* 5 */}
      <section>
        <Bar>Payment Schedule (amounts include {model.tax_label})</Bar>
        <div className="space-y-2 py-2">
          {model.paid_in_full ? (
            <div className="w-56 border text-center" style={{ borderColor: NAVY }}>
              <div className="py-0.5 text-[10px] font-bold text-white" style={{ background: NAVY }}>
                PAID IN FULL
              </div>
              <div className="py-2 text-base font-bold">{model.schedule[0]?.total}</div>
            </div>
          ) : (
            seasons.map((season) => (
              <div key={season}>
                {seasons.length > 1 ? (
                  <p className="mb-0.5 text-[10px] font-bold text-[#5a6782]">SEASON {season + 1}</p>
                ) : null}
                <div className="grid grid-cols-5 border-l border-t" style={{ borderColor: NAVY }}>
                  {model.schedule
                    .filter((s) => s.season === season)
                    .map((cell) => (
                      <div key={cell.due_on} className="border-b border-r text-center" style={{ borderColor: NAVY }}>
                        <div className="py-0.5 text-[10px] font-bold text-white" style={{ background: NAVY }}>
                          {cell.label}
                        </div>
                        <div className="py-1.5 font-bold">{cell.total}</div>
                      </div>
                    ))}
                </div>
              </div>
            ))
          )}
          {model.plan_kind === 'monthly_recurring' ? (
            <p className="text-[11px] italic text-[#5a6782]">
              Month-to-month: billed on the 1st of each month of the season until cancelled.
            </p>
          ) : null}
        </div>
      </section>

      {/* 6 */}
      <section>
        <Bar>Agreement Period</Bar>
        <p className="py-1.5">{model.wording.agreement_period}</p>
      </section>

      {/* 7 */}
      <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr]">
        <section>
          <Bar>Commitment & Cancellation</Bar>
          <p className="py-1.5">{model.wording.commitment}</p>
        </section>
        <section>
          <Bar>Customer Signature</Bar>
          <div className="pt-1.5">
            <SignatureArea box="commitment" model={model} signing={signing} />
          </div>
        </section>
      </div>

      {/* 8 */}
      <section>
        <Bar>Satisfaction Guarantee</Bar>
        <p className="py-1.5">{model.wording.guarantee}</p>
      </section>

      {/* 9 */}
      <section>
        <Bar>Service Notifications</Bar>
        <p className="py-1.5">{model.wording.notifications}</p>
        <div className="grid gap-x-6 sm:grid-cols-2">
          <ValueLine label="E-CARD/EMAIL:" value={model.notification_email ?? ''} />
          <ValueLine label="AUTOMATED VOICE/TEXT MSGS:" value={model.notification_phone ?? ''} />
        </div>
      </section>

      {/* 10 */}
      <section>
        <Bar>Service Commitment and Payment Information</Bar>
        <div className="grid gap-4 pt-2 sm:grid-cols-[1.2fr_1fr]">
          <div className="flex flex-col gap-2">
            <div>
              {model.pricing_lines.map((line) => (
                <ValueLine key={line.label} label={line.label} value={line.value} />
              ))}
              <ValueLine label="Drift Rep" value={model.rep_name ?? ''} />
            </div>
            <SignatureArea box="service_commitment" model={model} signing={signing} />
          </div>
          <div className="flex flex-col gap-2 border p-2" style={{ borderColor: NAVY }}>
            <p className="font-semibold">Credit/Debit Card or Acct#:</p>
            <p className="text-sm tracking-wide">{model.card.label}</p>
            {model.card.brand ? <p className="text-[11px] text-[#5a6782]">{model.card.brand}</p> : null}
            <p className="text-[10.5px] text-[#5a6782]">
              I authorize {COMPANY.name} to charge this payment method for the payments in the Payment Schedule. Card
              details are held by our payment processor, never by {COMPANY.name}.
            </p>
            <SignatureArea box="card_authorization" model={model} signing={signing} />
          </div>
        </div>
      </section>

      {/* 11 */}
      <section>
        <p className="px-4 py-3 text-center text-base font-bold leading-snug text-white sm:text-lg" style={{ background: NAVY }}>
          {COOLING_OFF_BANNER}
        </p>
        <p className="pt-1.5 text-[11px] italic text-[#5a6782]">{model.wording.continuation}</p>
      </section>

      <section className="pt-3">
        <Bar>Terms and Conditions</Bar>
        <div className="space-y-2 pt-2 text-[11.5px]">
          {model.terms.map((section) => (
            <div key={section.heading}>
              <p className="font-bold">{section.heading}</p>
              {section.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}
