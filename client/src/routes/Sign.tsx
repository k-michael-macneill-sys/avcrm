import * as React from 'react';
import { useParams } from 'react-router-dom';
import logo from '@/assets/drift-logo.jpg';
import { ErrorNotice, Loading } from '@/components/Misc';
import { SignaturePad, type SignaturePadHandle } from '@/components/SignaturePad';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { publicGet, publicPost } from '@/lib/publicApi';
import { ADDONS } from '@/lib/sales';
import { ThemeToggle } from '@/theme/ThemeToggle';

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
      <div className="mx-auto w-full max-w-2xl">
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
  const padRef = React.useRef<SignaturePadHandle>(null);
  const [confirmed, setConfirmed] = React.useState<Record<string, boolean>>({});
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  const monthly = inv.billing_type === 'monthly';
  const includes = ADDONS.filter((a) => inv[a.key]).map((a) => a.label);
  const missing = inv.checklist.filter((c) => c.is_required && !confirmed[c.code]);

  const submit = async (): Promise<void> => {
    setError(null);
    if (missing.length > 0) {
      setError(`Please confirm: ${missing.map((m) => m.label.toLowerCase()).join(', ')}.`);
      return;
    }
    const blob = await padRef.current?.toBlob();
    if (!blob) {
      setError('Please sign in the box above.');
      return;
    }
    setPending(true);
    try {
      const result = await publicPost<{ contract_id: string; card_url: string | null }>(
        `/public/sign/${encodeURIComponent(token)}`,
        {
          signature_png: await toDataUrl(blob),
          confirmed: Object.keys(confirmed).filter((code) => confirmed[code]),
        },
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
    <Panel>
      <h1 className="text-2xl font-semibold tracking-tight">Snow clearing agreement</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        For {inv.customer_name} · {inv.branch_name}
      </p>

      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Item label="Service address">
          {inv.address_line1}
          {inv.address_line2 ? `, Unit ${inv.address_line2}` : ''}
          <br />
          {inv.city}, {inv.province} {inv.postal_code}
        </Item>
        <Item label="Season">
          {inv.season_start} to {inv.season_end}
        </Item>
        <Item label="Includes">{['Driveway clearing', ...includes].join(', ')}</Item>
        <Item label={monthly ? 'Price' : 'Season price'}>
          {Number(inv.initial_price) > Number(inv.discounted_price) ? (
            <span className="mr-1 text-muted-foreground line-through">{money(inv.initial_price)}</span>
          ) : null}
          {money(inv.discounted_price)}
          {monthly && inv.recurring_price ? (
            <span className="block text-muted-foreground">
              first month, then {money(inv.recurring_price)} per month, charged to your card automatically
            </span>
          ) : (
            <span className="block text-muted-foreground">one payment for the season</span>
          )}
        </Item>
      </dl>

      <div className="mt-6 flex flex-col gap-2 border-t border-border pt-5">
        {inv.checklist.map((c) => (
          <label key={c.code} className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={confirmed[c.code] ?? false}
              onCheckedChange={(v) => setConfirmed((s) => ({ ...s, [c.code]: v === true }))}
            />
            <span>
              {c.label}
              {c.is_required ? <span className="text-critical"> *</span> : null}
            </span>
          </label>
        ))}
      </div>

      <p className="mb-1.5 mt-6 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Your signature
      </p>
      <SignaturePad ref={padRef} />
      <p className="text-xs text-muted-foreground">
        By signing you agree to the service agreement (version {inv.terms_version}). Next you'll add a card on our
        payment provider's secure page — we never see your card number.
      </p>

      {error ? <div className="mt-4"><ErrorNotice message={error} /></div> : null}
      <Button type="button" className="mt-5 w-full" disabled={pending} onClick={() => void submit()}>
        {pending ? 'Signing…' : 'Sign and continue to payment'}
      </Button>
    </Panel>
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

function Item({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  );
}
